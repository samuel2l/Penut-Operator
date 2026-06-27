import path from "node:path";
import "dotenv/config";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createTaskStore } from "../storage/task-store.js";
import { createSettingsStore } from "../storage/settings-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { app, BrowserWindow, ipcMain } = require("electron");
const taskStore = createTaskStore();
const settingsStore = createSettingsStore();
let mainWindow;
let activeRun;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1160,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    title: "Penut Operator",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(() => {
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

ipcMain.handle("tasks:reset", async () => taskStore.resetActiveTask());

ipcMain.handle("settings:get", async () => {
  const settings = await settingsStore.getSettings();
  return {
    settings,
    chromeProfiles: await settingsStore.listChromeProfiles(),
    readiness: await getRunReadiness(settings),
  };
});

ipcMain.handle("settings:update", async (_event, patch) => {
  const settings = await settingsStore.updateSettings(patch);
  return {
    settings,
    chromeProfiles: await settingsStore.listChromeProfiles(),
    readiness: await getRunReadiness(settings),
  };
});

ipcMain.handle("agent:run", async (_event, prompt) => {
  if (activeRun) {
    return { ok: false, error: "An Operator run is already active." };
  }

  const settings = await settingsStore.getSettings();
  const readiness = await getRunReadiness(settings);
  const blocker = readiness.checks.find((check) => !check.ready);
  if (blocker) {
    return { ok: false, error: blocker.action };
  }

  const currentTask = await taskStore.getActiveTask();
  const cleanPrompt = String(prompt || currentTask.prompt || "").trim();
  const task = await taskStore.updateActiveTask({
    prompt: cleanPrompt,
    status: "approved",
  });

  activeRun = { taskId: task.id, stop: () => {} };
  await taskStore.updateActiveTask({ status: "running" });
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
    const status = result.ok ? "completed" : "failed";
    const updatedTask = await taskStore.updateTask(task.id, { status });
    const state = await taskStore.getState();
    return { ...result, task: updatedTask, state };
  } catch (error) {
    await taskStore.appendEvent({
      type: "agent",
      message: error.message,
      detail: { failed: true },
    }, task.id);
    const updatedTask = await taskStore.updateTask(task.id, { status: "failed" });
    const state = await taskStore.getState();
    return { ok: false, error: error.message, task: updatedTask, state };
  } finally {
    activeRun = null;
    mainWindow?.webContents.send("tasks:changed", await taskStore.getState());
  }
});

ipcMain.handle("agent:stop", async () => {
  if (!activeRun) return { ok: true };
  const runningTaskId = activeRun.taskId;
  activeRun.stop();
  activeRun = null;
  await taskStore.updateTask(runningTaskId, { status: "stopped" });
  const state = await taskStore.getState();
  mainWindow?.webContents.send("tasks:changed", state);
  return { ok: true, state };
});

function runBrowserUseWorker(task, settings, onEvent) {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, "../../python/browser_use_worker.py");
    const localPythonPath = path.join(__dirname, "../../.venv/bin/python");
    const pythonPath = existsSync(localPythonPath) ? localPythonPath : "python3";
    const browserUseTerminalBinary = path.join(os.homedir(), ".local/bin/browser-use-terminal");
    const env = {
      ...process.env,
      BROWSER_USE_TERMINAL_BINARY: browserUseTerminalBinary,
      BROWSER_USE_CHROME_USER_DATA_DIR: settings.chromeUserDataDir,
      BROWSER_USE_CHROME_PROFILE_DIRECTORY: settings.chromeProfileDirectory,
    };
    const child = execFile(
      pythonPath,
      [workerPath, task.prompt || ""],
      {
        env,
      },
    );

    let lastEvent = null;

    const handleLine = (line, source) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const event = JSON.parse(trimmed);
        lastEvent = event;
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
      stdoutReader.close();
      stderrReader.close();
      reject(error);
    });

    child.on("close", (code) => {
      stdoutReader.close();
      stderrReader.close();

      if (code !== 0 && !lastEvent) {
        reject(new Error(`browser-use worker exited with code ${code}.`));
        return;
      }

      resolve({
        ok: lastEvent?.type === "complete" || code === 0,
        result: lastEvent?.message || "Task finished.",
      });
    });

    activeRun = {
      taskId: task.id,
      stop: () => child.kill("SIGTERM"),
    };
  });
}

async function getRunReadiness(settings) {
  const paths = getRuntimePaths();
  const checks = [
    checkChromeProfile(settings),
    checkOpenAiKey(),
    await checkPython(paths.pythonPath),
    checkTerminal(paths.browserUseTerminalBinary),
    checkWorker(paths.workerPath),
    await checkBrowserUse(paths.pythonPath),
  ];

  return {
    ready: checks.every((check) => check.ready),
    checks,
  };
}

function getRuntimePaths() {
  const workerPath = path.join(__dirname, "../../python/browser_use_worker.py");
  const localPythonPath = path.join(__dirname, "../../.venv/bin/python");
  const pythonPath = existsSync(localPythonPath) ? localPythonPath : "python3";
  const browserUseTerminalBinary = path.join(os.homedir(), ".local/bin/browser-use-terminal");
  return {
    workerPath,
    pythonPath,
    browserUseTerminalBinary,
  };
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

function checkOpenAiKey() {
  const ready = Boolean(process.env.OPENAI_API_KEY);
  return {
    id: "modelAccess",
    label: "Model access",
    ready,
    message: ready ? "Model access is configured." : "Model access is not configured yet.",
    action: "Add model access before running tasks.",
  };
}

async function checkPython(pythonPath) {
  const ready = await commandSucceeds(pythonPath, ["--version"]);
  return {
    id: "pythonWorker",
    label: "Local worker",
    ready,
    message: ready ? "Local worker can start." : "Local worker is not available yet.",
    action: "Install the local worker before running tasks.",
  };
}

function checkTerminal(browserUseTerminalBinary) {
  const ready = existsSync(browserUseTerminalBinary);
  return {
    id: "automationTerminal",
    label: "Browser control",
    ready,
    message: ready ? "Browser control is installed." : "Browser control needs setup.",
    action: "Install browser control before running tasks.",
  };
}

function checkWorker(workerPath) {
  const ready = existsSync(workerPath);
  return {
    id: "workerScript",
    label: "Task runner",
    ready,
    message: ready ? "Task runner is available." : "Task runner is missing.",
    action: "Install the task runner before running tasks.",
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
    action: "Install the automation engine before running tasks.",
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

function formatWorkerLog(line, source) {
  const normalized = String(line || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (/^\[Agent\]/.test(normalized)) return friendlyWorkerLine(normalized.replace(/^\[Agent\]\s*/, ""));
  if (/^\[BrowserSession\]/.test(normalized)) return "Browser is ready.";
  if (/^\[service\]/.test(normalized)) return "";
  if (/^INFO\s+\[/.test(normalized)) return "";
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
  if (/page opened/i.test(normalized)) return "Opened the page.";
  if (/task started/i.test(normalized)) return "Task started.";
  if (/stopped by you/i.test(normalized)) return "Stopped by you.";
  if (/run time/i.test(normalized)) return "Task is moving along.";
  return normalized.replace(/\b(browser-use|worker|session|service)\b/gi, "").replace(/\s+/g, " ").trim();
}
