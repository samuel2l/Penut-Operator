import path from "node:path";
import dotenv from "dotenv";
import { existsSync, mkdirSync } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createTaskStore } from "../storage/task-store.js";
import { createSettingsStore } from "../storage/settings-store.js";
import { shouldLoadDotenv } from "../config/environment.js";

if (shouldLoadDotenv()) {
  dotenv.config();
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { app, BrowserWindow, ipcMain } = require("electron");
const taskStore = createTaskStore();
const settingsStore = createSettingsStore();
const STARTUP_SMOKE_TEST = process.env.OPERATOR_SMOKE_STARTUP === "1";
const BROWSER_OPEN_TIMEOUT_MS = 90000;
let mainWindow;
let activeRun;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1160,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    title: "Browser Operator",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.once("did-fail-load", (_event, _errorCode, errorDescription) => {
    if (STARTUP_SMOKE_TEST) {
      console.error(`[smoke] renderer failed to load: ${errorDescription}`);
      app.exit(1);
    }
  });
  mainWindow.webContents.once("did-finish-load", () => {
    if (STARTUP_SMOKE_TEST) {
      console.log("[smoke] electron startup ok");
      app.quit();
    }
  });

  void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(() => {
  console.log("[operator] runtime", sanitizeLogDetail({
    dotenvLoaded: shouldLoadDotenv(),
    hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY),
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
  }));
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("tasks:get", async () => taskStore.getState());

ipcMain.handle("tasks:select", async (_event, taskId) => {
  const state = await taskStore.selectTask(taskId);
  mainWindow?.webContents.send("tasks:changed", state);
  return state;
});

ipcMain.handle("tasks:create", async (_event, prompt) => {
  const state = await taskStore.createTask(prompt);
  mainWindow?.webContents.send("tasks:changed", state);
  return state;
});

ipcMain.handle("tasks:update", async (_event, patch) => {
  await taskStore.updateActiveTask(patch);
  const state = await taskStore.getState();
  mainWindow?.webContents.send("tasks:changed", state);
  return state;
});

ipcMain.handle("tasks:approve", async () => {
  await taskStore.updateActiveTask({ status: "approved" });
  const state = await taskStore.getState();
  mainWindow?.webContents.send("tasks:changed", state);
  return state;
});

ipcMain.handle("settings:get", async () => settingsPayload());

ipcMain.handle("settings:update", async (_event, patch) => {
  await settingsStore.updateSettings(patch);
  return settingsPayload();
});

ipcMain.handle("runtime:repair", async () => {
  try {
    await repairRuntime();
    return {
      ok: true,
      settings: await settingsPayload(),
    };
  } catch (error) {
    return {
      ok: false,
      error: friendlyRuntimeRepairError(error),
      settings: await settingsPayload(),
    };
  }
});

ipcMain.handle("agent:run", async (_event, prompt) => {
  if (activeRun) {
    return { ok: false, error: "An Operator run is already active." };
  }
  const currentTask = await taskStore.getActiveTask();
  if (!currentTask) {
    return { ok: false, error: "Create or select a task before running it." };
  }
  return runSelectedTasks([currentTask.id], { [currentTask.id]: prompt });
});

ipcMain.handle("agent:run-tasks", async (_event, taskIds, promptByTaskId = {}) => {
  if (activeRun) {
    return { ok: false, error: "An Operator run is already active." };
  }
  return runSelectedTasks(taskIds, promptByTaskId);
});

async function runSelectedTasks(taskIds, promptByTaskId = {}) {
  const selectedIds = Array.isArray(taskIds)
    ? [...new Set(taskIds.filter((id) => typeof id === "string" && id))]
    : [];
  if (!selectedIds.length) {
    return { ok: false, error: "Select at least one ready task to run." };
  }

  const state = await taskStore.getState();
  const tasksById = new Map(state.tasks.map((task) => [task.id, task]));
  const tasks = selectedIds.map((id) => tasksById.get(id)).filter(Boolean);
  const blockedTask = tasks.find((task) => !taskCanRun(task));
  if (blockedTask) {
    return {
      ok: false,
      error: "Only ready or retryable tasks can be selected.",
      state,
    };
  }

  const settings = await settingsStore.getSettings();
  const readiness = await getRunReadiness(settings);
  const blocker = readiness.checks.find((check) => !check.ready);
  if (blocker) {
    return { ok: false, error: blocker.action, state };
  }

  const results = [];
  for (const task of tasks) {
    await taskStore.selectTask(task.id);
    const prompt = promptByTaskId && typeof promptByTaskId === "object"
      ? promptByTaskId[task.id]
      : undefined;
    const result = await runOneTask(task.id, prompt, settings);
    results.push(result);
    if (result.stopped) {
      return {
        ok: false,
        stopped: true,
        results,
        state: await taskStore.getState(),
      };
    }
  }

  return {
    ok: results.every((result) => result.ok),
    results,
    state: await taskStore.getState(),
  };
}

function taskCanRun(task) {
  return ["pending", "approved", "failed", "stopped", "expired"].includes(task?.status);
}

async function runOneTask(taskId, prompt, settings) {
  const existing = (await taskStore.getState()).tasks.find((task) => task.id === taskId);
  if (!existing) {
    return { ok: false, error: "Task is no longer available." };
  }

  const cleanPrompt = String(prompt || existing.prompt || "").trim();
  const task = await taskStore.updateTask(taskId, {
    prompt: cleanPrompt,
    status: "running",
  });

  activeRun = {
    taskId: task.id,
    stopped: false,
    stop: () => {},
  };
  mainWindow?.webContents.send("tasks:changed", await taskStore.getState());

  try {
    const result = await runBrowserUseWorker(task, settings, async (event) => {
      try {
        await taskStore.appendEvent(event, task.id);
        mainWindow?.webContents.send("tasks:changed", await taskStore.getState());
      } catch (error) {
        await taskStore.appendEvent({
          type: "agent",
          message: "Something went wrong while saving the activity log.",
          detail: { error: error.message },
        }, task.id).catch(() => {});
      }
    });
    if (activeRun?.taskId === task.id && activeRun.stopped) {
      return { ok: false, stopped: true, state: await taskStore.getState() };
    }
    const status = result.ok ? "completed" : "failed";
    const updatedTask = await taskStore.updateTask(task.id, { status });
    return { ...result, task: updatedTask, state: await taskStore.getState() };
  } catch (error) {
    if (activeRun?.taskId === task.id && activeRun.stopped) {
      return { ok: false, stopped: true, state: await taskStore.getState() };
    }
    await taskStore.appendEvent({
      type: "agent",
      message: error.message,
      detail: { failed: true },
    }, task.id);
    const updatedTask = await taskStore.updateTask(task.id, { status: "failed" });
    return { ok: false, error: error.message, task: updatedTask, state: await taskStore.getState() };
  } finally {
    activeRun = null;
    mainWindow?.webContents.send("tasks:changed", await taskStore.getState());
  }
}

ipcMain.handle("agent:stop", async () => {
  if (!activeRun) return { ok: true };
  const runningTask = activeRun;
  runningTask.stopped = true;
  runningTask.stop();
  await taskStore.appendEvent({
    type: "status",
    message: "Stopped by you.",
  }, runningTask.taskId).catch(() => {});
  activeRun = runningTask;
  await taskStore.updateTask(runningTask.taskId, { status: "stopped" });
  const state = await taskStore.getState();
  mainWindow?.webContents.send("tasks:changed", state);
  return { ok: true, state };
});

async function settingsPayload() {
  const settings = await settingsStore.getSettings();
  return {
    settings,
    chromeProfiles: await settingsStore.listChromeProfiles(),
    readiness: await getRunReadiness(settings),
  };
}

function sanitizeLogDetail(detail) {
  if (!detail || typeof detail !== "object") return {};
  return Object.fromEntries(
    Object.entries(detail).map(([key, value]) => {
      if (/^(token|accessToken|refreshToken|secret|key|authorization|apiKey)$/i.test(key)) {
        return [key, "[redacted]"];
      }
      if (value instanceof Error) return [key, value.message];
      if (typeof value === "string" && value.length > 160) {
        return [key, `${value.slice(0, 157)}...`];
      }
      return [key, value];
    }),
  );
}

function workerScratchDir() {
  const workerDir = path.join(app.getPath("userData"), "worker");
  mkdirSync(workerDir, { recursive: true });
  return workerDir;
}

function buildWorkerEnv(settings) {
  const workerCwd = workerScratchDir();
  return {
    ...process.env,
    PATH: process.env.PATH || "",
    HOME: process.env.HOME || os.homedir(),
    USER: process.env.USER || "",
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    LANG: process.env.LANG || "",
    ...(process.platform === "win32"
      ? {
          SystemRoot: process.env.SystemRoot || "",
          PATHEXT: process.env.PATHEXT || "",
          USERPROFILE: process.env.USERPROFILE || "",
        }
      : {}),
    OPERATOR_WORKER_CWD: workerCwd,
    BROWSER_USE_CHROME_USER_DATA_DIR: settings.chromeUserDataDir,
    BROWSER_USE_CHROME_PROFILE_DIRECTORY: settings.chromeProfileDirectory,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
    OPENAI_MODEL: process.env.OPENAI_MODEL || "gpt-4.1-mini",
  };
}

function looksLikeFalseFileListing(message) {
  return String(message || "").trim().startsWith("Result files:");
}

function runBrowserUseWorker(task, settings, onEvent) {
  return new Promise((resolve, reject) => {
    const paths = getRuntimePaths();
    const workerPath = paths.workerPath;
    const pythonPath = paths.pythonPath;
    const env = buildWorkerEnv(settings);
    const workerCwd = env.OPERATOR_WORKER_CWD;
    console.log("[worker] launch", sanitizeLogDetail({
      pythonPath,
      workerPath,
      workerCwd,
      hasOpenAiKey: Boolean(env.OPENAI_API_KEY),
      model: env.OPENAI_MODEL,
    }));
    const child = execFile(
      pythonPath,
      [workerPath, task.prompt || ""],
      {
        cwd: workerCwd,
        env,
      },
    );

    let lastEvent = null;
    let browserOpenTimer = null;
    let browserOpenTimedOut = false;

    const clearBrowserOpenTimer = () => {
      if (!browserOpenTimer) return;
      clearTimeout(browserOpenTimer);
      browserOpenTimer = null;
    };

    const startBrowserOpenTimer = () => {
      clearBrowserOpenTimer();
      browserOpenTimer = setTimeout(() => {
        browserOpenTimedOut = true;
        const message = browserOpenTimeoutMessage(settings);
        void onEvent({
          type: "agent",
          message,
        });
        child.kill("SIGTERM");
      }, BROWSER_OPEN_TIMEOUT_MS);
    };

    const handleLine = (line, source) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const event = JSON.parse(trimmed);
        lastEvent = event;
        if (event.type === "complete") {
          clearBrowserOpenTimer();
        } else if (event.message === "Opening Chrome.") {
          startBrowserOpenTimer();
        } else if (browserOpenTimer && event.message !== "Opening Chrome.") {
          clearBrowserOpenTimer();
        }
        void onEvent(event);
        return;
      } catch {
        const message = formatWorkerLog(trimmed, source);
        if (message) {
          void onEvent({
            type: "agent",
            message,
          });
        }
      }
    };

    const stdoutReader = readline.createInterface({ input: child.stdout });
    stdoutReader.on("line", (line) => handleLine(line, "stdout"));

    const stderrReader = readline.createInterface({ input: child.stderr });
    stderrReader.on("line", (line) => handleLine(line, "stderr"));

    child.on("error", (error) => {
      clearBrowserOpenTimer();
      stdoutReader.close();
      stderrReader.close();
      reject(error);
    });

    child.on("close", (code) => {
      clearBrowserOpenTimer();
      stdoutReader.close();
      stderrReader.close();

      if (browserOpenTimedOut) {
        reject(new Error(browserOpenTimeoutMessage(settings)));
        return;
      }

      if (code !== 0 && !lastEvent) {
        reject(new Error(`browser-use worker exited with code ${code}.`));
        return;
      }

      resolve({
        ok: lastEvent?.type === "complete" &&
          !looksLikeFalseFileListing(lastEvent?.message) &&
          code === 0,
        result: lastEvent?.message || "Task finished.",
      });
    });

    if (activeRun?.taskId === task.id) {
      activeRun.stop = () => child.kill("SIGTERM");
    }
  });
}

function browserOpenTimeoutMessage(settings) {
  const profileName = settings.chromeProfileDirectory || "the selected Chrome profile";
  if (process.platform === "win32") {
    return [
      `Operator could not open Chrome with ${profileName}.`,
      "Close Chrome completely from Task Manager, then run the task again.",
    ].join(" ");
  }
  return `Operator could not open Chrome with ${profileName}. Close Chrome completely, then run the task again.`;
}

async function getRunReadiness(settings) {
  const paths = getRuntimePaths();
  const checks = [
    checkChromeProfile(settings),
    checkModelAccess(),
    await checkPython(paths.pythonPath),
    checkWorker(paths.workerPath),
    await checkBrowserUse(paths.pythonPath),
  ];

  return {
    ready: checks.every((check) => check.ready),
    checks,
  };
}

async function repairRuntime() {
  const paths = getRuntimePaths();
  if (app.isPackaged && !paths.bundledPythonPath) {
    throw new Error("This installer does not include a Windows-compatible Operator runtime. Install a Windows build that was packaged with the Windows runtime.");
  }
  if (!existsSync(paths.workerPath)) {
    throw new Error("Operator task runner is missing from this app.");
  }
  if (!existsSync(paths.requirementsPath)) {
    throw new Error("Operator runtime requirements are missing from this app.");
  }

  await runCommand(hostPythonCommand(), ["-m", "venv", paths.venvRoot]);
  await runCommand(paths.venvPythonPath, [
    "-m",
    "pip",
    "install",
    "--upgrade",
    "pip",
  ]);
  await runCommand(paths.venvPythonPath, [
    "-m",
    "pip",
    "install",
    "-r",
    paths.requirementsPath,
  ]);
}

function friendlyRuntimeRepairError(error) {
  const message = String(error?.message || "");
  if (/does not include a Windows-compatible Operator runtime|Windows runtime/i.test(message)) {
    return "This Windows installer is missing the Windows automation runtime. Download the Windows build again after it has been rebuilt.";
  }
  if (/ENOENT|python3/i.test(message)) {
    return "Python is not available on this computer yet. Install Python 3, then repair the Operator runtime again.";
  }
  if (/requirements|task runner/i.test(message)) return message;
  if (/network|ENOTFOUND|ETIMEDOUT|fetch|Could not find/i.test(message)) {
    return "Operator could not download the runtime packages. Check your internet connection, then try again.";
  }
  return "Operator could not repair the runtime. Try again, or contact support if it keeps happening.";
}

function getRuntimePaths() {
  const projectRoot = path.resolve(__dirname, "../..");
  const resourcesRoot = app.isPackaged ? process.resourcesPath : projectRoot;
  const runtimeRoot = app.isPackaged
    ? path.join(app.getPath("userData"), "runtime")
    : projectRoot;
  const bundledRuntimeRoot = path.join(resourcesRoot, "python-runtime");
  const bundledPythonPath = findRuntimePython(bundledRuntimeRoot);
  const venvRoot = path.join(runtimeRoot, ".venv");
  const venvPythonPath = process.platform === "win32"
    ? path.join(venvRoot, "Scripts", "python.exe")
    : path.join(venvRoot, "bin", "python");
  const workerPath = path.join(resourcesRoot, "python", "browser_use_worker.py");
  const requirementsPath = path.join(resourcesRoot, "python", "requirements.txt");
  const pythonPath = bundledPythonPath ||
    (existsSync(venvPythonPath) ? venvPythonPath : hostPythonCommand());
  return {
    workerPath,
    pythonPath,
    bundledPythonPath,
    venvRoot,
    venvPythonPath,
    requirementsPath,
  };
}

function findRuntimePython(runtimeRoot) {
  const candidates = process.platform === "win32"
    ? [
        path.join(runtimeRoot, "python.exe"),
        path.join(runtimeRoot, "python", "python.exe"),
        path.join(runtimeRoot, "install", "python.exe"),
        path.join(runtimeRoot, "python", "install", "python.exe"),
      ]
    : [
        path.join(runtimeRoot, "bin", "python3"),
        path.join(runtimeRoot, "python", "bin", "python3"),
        path.join(runtimeRoot, "install", "bin", "python3"),
        path.join(runtimeRoot, "python", "install", "bin", "python3"),
      ];
  return candidates.find((candidate) => existsSync(candidate)) || "";
}

function hostPythonCommand() {
  return process.platform === "win32" ? "python" : "python3";
}

function checkChromeProfile(settings) {
  const profilePath = settings.chromeProfileDirectory
    ? path.join(settings.chromeUserDataDir, settings.chromeProfileDirectory)
    : "";
  const ready = Boolean(settings.chromeProfileDirectory && existsSync(profilePath));
  return {
    id: "chromeProfile",
    label: "Chrome profile",
    ready,
    message: ready
      ? `Using ${settings.chromeProfileName || settings.chromeProfileDirectory}.`
      : "Choose the Chrome profile Operator should use.",
    action: "Choose a Chrome profile in Settings before running tasks.",
  };
}

function checkModelAccess() {
  const ready = Boolean(process.env.OPENAI_API_KEY);
  return {
    id: "modelAccess",
    label: "OpenAI access",
    ready,
    message: ready
      ? `Using ${process.env.OPENAI_MODEL || "gpt-4.1-mini"}.`
      : "OPENAI_API_KEY is not set.",
    action: "Add OPENAI_API_KEY to your .env file, then restart Operator.",
  };
}

async function checkPython(pythonPath) {
  const ready = await commandSucceeds(pythonPath, ["--version"]);
  const paths = getRuntimePaths();
  const missingBundledRuntime = app.isPackaged && !paths.bundledPythonPath;
  return {
    id: "pythonWorker",
    label: "Local worker",
    ready: ready && !missingBundledRuntime,
    message: missingBundledRuntime
      ? "This build is missing the Windows automation runtime."
      : ready
        ? "Local worker can start."
        : "Local worker is not available yet.",
    action: missingBundledRuntime
      ? "Install a Windows build packaged with the Windows runtime."
      : "Install the local worker before running tasks.",
  };
}

function checkWorker(workerPath) {
  const ready = existsSync(workerPath);
  return {
    id: "workerScript",
    label: "Task runner",
    ready,
    message: ready ? "Task runner is available." : "Task runner is missing.",
    action: "Repair the Operator runtime before running tasks.",
  };
}

async function checkBrowserUse(pythonPath) {
  const ready = await commandSucceeds(pythonPath, [
    "-c",
    "import browser_use",
  ]);
  return {
    id: "automationEngine",
    label: "Automation engine",
    ready,
    message: ready ? "Automation engine is ready." : "Automation engine needs setup.",
    action: "Repair the Operator runtime before running tasks.",
  };
}

function commandSucceeds(command, args) {
  return new Promise((resolve) => {
    const child = execFile(command, args, { timeout: 10000 }, (error) => {
      resolve(!error);
    });
    child.on("error", () => resolve(false));
  });
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 120000 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout || error.message || "").trim();
        reject(new Error(detail || error.message));
        return;
      }
      resolve();
    });
  });
}

function formatWorkerLog(line, source) {
  const normalized = String(line || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (/^<!doctype html|^<html|<\/html>|<\/body>|<\/head>|<\/pre>|<body>|<head>|^<meta|^<title>/i.test(normalized)) {
    return "";
  }
  if (/payload too large|request entity too large/i.test(normalized)) {
    return "The planning request was too large.";
  }
  if (/^RuntimeError:/i.test(normalized)) return "";
  if (/^During handling of the above exception/i.test(normalized)) return "";
  if (/^asyncgen:/i.test(normalized)) return "";
  if (/^an error occurred during closing of asynchronous generator/i.test(normalized)) return "";
  if (/^File "/.test(normalized)) return "";
  if (/^raise RuntimeError/i.test(normalized)) return "";
  if (/^\[Agent\]/.test(normalized)) return friendlyWorkerLine(normalized.replace(/^\[Agent\]\s*/, ""));
  if (/^\[BrowserSession\]/.test(normalized)) return "";
  if (/^\[service\]/.test(normalized)) return "";
  if (/^INFO\s+\[/.test(normalized)) return "";
  if (/^WARNING\s+\[/.test(normalized)) return "";
  if (/^ERROR\s+\[/.test(normalized)) return "";
  if (/^\(node:/.test(normalized)) return "";
  if (/UnhandledPromiseRejectionWarning/i.test(normalized)) return "";
  if (/Traceback/i.test(normalized)) return "";
  if (/^at\s+/.test(normalized)) return "";
  if (source === "stderr") return friendlyWorkerLine(normalized);
  return friendlyWorkerLine(normalized);
}

function friendlyWorkerLine(line) {
  const normalized = String(line || "").trim();
  if (!normalized) return "";
  if (/browser-use worker started/i.test(normalized)) return "Task started.";
  if (/starting browser task/i.test(normalized)) return "Getting the browser ready.";
  if (/browser session initialized/i.test(normalized)) return "Browser is ready.";
  if (/browser-use worker finished/i.test(normalized)) return "Task finished.";
  if (/browser-use worker failed/i.test(normalized)) return "Task could not finish.";
  if (/result failed/i.test(normalized)) return "";
  if (/stopping due to/i.test(normalized)) return "";
  if (/^result files:/i.test(normalized)) return "";
  if (/page opened/i.test(normalized)) return "Opened the page.";
  if (/task started/i.test(normalized)) return "Task started.";
  if (/stopped by you/i.test(normalized)) return "Stopped by you.";
  if (/run time/i.test(normalized)) return "Task is moving along.";
  return normalized.replace(/\b(browser-use|worker|session|service)\b/gi, "").replace(/\s+/g, " ").trim();
}
