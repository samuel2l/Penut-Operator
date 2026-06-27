import path from "node:path";
import { execFile } from "node:child_process";
import os from "node:os";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createTaskStore } from "../storage/task-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { app, BrowserWindow, ipcMain } = require("electron");
const taskStore = createTaskStore();
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

ipcMain.handle("tasks:get", async () => taskStore.getActiveTask());

ipcMain.handle("tasks:update", async (_event, patch) => {
  const task = await taskStore.updateActiveTask(patch);
  return task;
});

ipcMain.handle("tasks:approve", async () => {
  const task = await taskStore.updateActiveTask({ status: "approved" });
  return task;
});

ipcMain.handle("tasks:reset", async () => taskStore.resetActiveTask());

ipcMain.handle("agent:run", async () => {
  if (activeRun) {
    return { ok: false, error: "An Operator run is already active." };
  }

  const currentTask = await taskStore.getActiveTask();
  const task =
    currentTask.status === "approved" || currentTask.status === "failed"
      ? currentTask
      : await taskStore.updateActiveTask({ status: "approved" });

  activeRun = { stop: () => {} };
  await taskStore.updateActiveTask({ status: "running" });
  mainWindow?.webContents.send("tasks:changed", await taskStore.getActiveTask());

  try {
    const result = await runBrowserUseWorker(task, async (event) => {
      const updatedTask = await taskStore.appendEvent(event);
      mainWindow?.webContents.send("tasks:changed", updatedTask);
    });
    const status = result.ok ? "completed" : "failed";
    const updatedTask = await taskStore.updateActiveTask({ status });
    return { ...result, task: updatedTask };
  } catch (error) {
    await taskStore.appendEvent({
      type: "agent",
      message: error.message,
      detail: { failed: true },
    });
    const updatedTask = await taskStore.updateActiveTask({ status: "failed" });
    return { ok: false, error: error.message, task: updatedTask };
  } finally {
    activeRun = null;
    mainWindow?.webContents.send("tasks:changed", await taskStore.getActiveTask());
  }
});

ipcMain.handle("agent:stop", async () => {
  if (!activeRun) return { ok: true };
  activeRun.stop();
  activeRun = null;
  const task = await taskStore.updateActiveTask({ status: "stopped" });
  return { ok: true, task };
});

function runBrowserUseWorker(task, onEvent) {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, "../../python/browser_use_worker.py");
    const browserUseTerminalBinary = path.join(os.homedir(), ".local/bin/browser-use-terminal");
    const chromeUserDataDir = path.join(
      os.homedir(),
      "Library/Application Support/Google/Chrome",
    );
    const env = {
      ...process.env,
      BROWSER_USE_TERMINAL_BINARY: browserUseTerminalBinary,
      BROWSER_USE_CHROME_USER_DATA_DIR: chromeUserDataDir,
      BROWSER_USE_CHROME_PROFILE_DIRECTORY: "Default",
    };
    const child = execFile(
      "python3",
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
      stop: () => child.kill("SIGTERM"),
    };
  });
}

function formatWorkerLog(line, source) {
  const normalized = String(line || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (/^\[Agent\]/.test(normalized)) return friendlyWorkerLine(normalized.replace(/^\[Agent\]\s*/, ""));
  if (/^\[BrowserSession\]/.test(normalized)) return "Browser is ready.";
  if (/^\[service\]/.test(normalized)) return "";
  if (/^INFO\s+\[/.test(normalized)) return "";
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
  return normalized.replace(/\b(browser-use|worker|session|service)\b/gi, "").replace(/\s+/g, " ").trim();
}
