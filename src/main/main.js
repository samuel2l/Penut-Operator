import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createTaskStore } from "../storage/task-store.js";
import { OperatorAgentRuntime } from "../agent/runtime.js";

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

  const task = await taskStore.getActiveTask();
  if (task.status !== "approved" && task.status !== "failed") {
    return { ok: false, error: "Task must be approved before Operator can run." };
  }

  const runtime = new OperatorAgentRuntime({
    onEvent: async (event) => {
      const updatedTask = await taskStore.appendEvent(event);
      mainWindow?.webContents.send("tasks:changed", updatedTask);
    },
  });

  activeRun = runtime;
  await taskStore.updateActiveTask({ status: "running" });
  mainWindow?.webContents.send("tasks:changed", await taskStore.getActiveTask());

  try {
    const result = await runtime.run(task);
    const status = result.ok ? "draft_ready" : "failed";
    const updatedTask = await taskStore.updateActiveTask({ status });
    return { ...result, task: updatedTask };
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
