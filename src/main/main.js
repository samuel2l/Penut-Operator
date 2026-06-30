import path from "node:path";
import "dotenv/config";
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createTaskStore } from "../storage/task-store.js";
import { createSettingsStore } from "../storage/settings-store.js";
import { createOperatorAuthStore } from "../storage/auth-store.js";
import { createPenutApiClient } from "../penut/penut-api-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const taskStore = createTaskStore();
const settingsStore = createSettingsStore();
const authStore = createOperatorAuthStore();
const DATA_DIR = path.join(path.resolve(__dirname, "../.."), "data");
const PENDING_DEVICE_LOGIN_FILE = path.join(DATA_DIR, "pending-device-login.json");
let mainWindow;
let activeRun;
let pendingDeviceLogin;

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

ipcMain.handle("tasks:get", async () => syncTasksFromPenut());

ipcMain.handle("tasks:select", async (_event, taskId) => {
  let state = await taskStore.selectTask(taskId);
  const task = state.tasks.find((item) => item.id === state.selectedTaskId);
  const settings = await settingsStore.getSettings();
  const client = createPenutApiClient(settings, { authStore });
  if (task?.remoteId && client.isConfigured) {
    try {
      const payload = await client.readTask(task.remoteId);
      await taskStore.updateTask(task.id, {
        events: mapRemoteEvents(payload.events || []),
      });
      state = await taskStore.getState();
    } catch {
      // Keep the cached task visible even if event refresh fails.
    }
  }
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

ipcMain.handle("settings:get", async () => {
  return settingsPayload();
});

ipcMain.handle("settings:update", async (_event, patch) => {
  await settingsStore.updateSettings(patch);
  return settingsPayload();
});

ipcMain.handle("auth:start", async () => {
  const settings = await settingsStore.getSettings();
  const client = createPenutApiClient(settings, { authStore });
  logAuth("start_requested", {
    apiConfigured: client.hasBaseUrl,
    hasExistingAccessToken: client.hasAccessToken,
  });
  let authorization;
  try {
    authorization = await client.initDeviceLogin();
  } catch (error) {
    logAuth("start_failed", {
      error: friendlyPenutConnectionError(error),
      action: friendlyPenutConnectionAction(error),
    });
    return {
      ok: false,
      error: friendlyPenutConnectionAction(error),
      detail: friendlyPenutConnectionError(error),
    };
  }
  const deviceCode = authorization.deviceCode || authorization.device_code;
  const verifyUrl =
    authorization.verificationUriComplete ||
    authorization.verification_uri_complete ||
    authorization.verificationUri ||
    authorization.verification_uri;
  pendingDeviceLogin = {
    deviceCode,
    userCode: authorization.userCode || authorization.user_code || "",
    verificationUrl: verifyUrl || "",
    expiresAt:
      Date.now() +
      Math.max(1, authorization.expiresIn || authorization.expires_in || 600) *
        1000,
  };
  savePendingDeviceLogin(pendingDeviceLogin);
  logAuth("pending_saved", {
    userCode: pendingDeviceLogin.userCode,
    hasVerificationUrl: Boolean(verifyUrl),
    expiresAt: new Date(pendingDeviceLogin.expiresAt).toISOString(),
  });
  if (verifyUrl) {
    await shell.openExternal(verifyUrl);
    logAuth("browser_opened", {
      userCode: pendingDeviceLogin.userCode,
    });
  }
  return {
    ok: true,
    userCode: pendingDeviceLogin.userCode,
    verificationUrl: verifyUrl || "",
    expiresAt: new Date(pendingDeviceLogin.expiresAt).toISOString(),
  };
});

ipcMain.handle("auth:pending", async () => {
  const pending = getPendingDeviceLogin();
  if (!pending) return { pending: false };
  if (Date.now() > pending.expiresAt) {
    clearPendingDeviceLogin();
    logAuth("pending_expired", {
      userCode: pending.userCode || "",
    });
    return { pending: false, expired: true };
  }
  return {
    pending: true,
    userCode: pending.userCode || "",
    verificationUrl: pending.verificationUrl || "",
    expiresAt: new Date(pending.expiresAt).toISOString(),
  };
});

ipcMain.handle("auth:open-pending", async () => {
  const pending = getPendingDeviceLogin();
  if (!pending?.verificationUrl) {
    logAuth("reopen_missing_url");
    return { ok: false, error: "No approval page is available. Start sign-in again." };
  }
  await shell.openExternal(pending.verificationUrl);
  logAuth("browser_reopened", {
    userCode: pending.userCode || "",
  });
  return { ok: true };
});

ipcMain.handle("auth:cancel", async () => {
  const pending = getPendingDeviceLogin();
  clearPendingDeviceLogin();
  logAuth("cancelled", {
    userCode: pending?.userCode || "",
  });
  return settingsPayload();
});

ipcMain.handle("auth:poll", async () => {
  const pending = getPendingDeviceLogin();
  if (!pending?.deviceCode) {
    logAuth("poll_no_pending");
    return { authenticated: false, pending: false };
  }
  if (Date.now() > pending.expiresAt) {
    clearPendingDeviceLogin();
    logAuth("poll_expired", {
      userCode: pending.userCode || "",
    });
    return {
      authenticated: false,
      pending: false,
      error: "Sign-in expired. Try again.",
    };
  }
  const settings = await settingsStore.getSettings();
  const client = createPenutApiClient(settings, { authStore });
  try {
    logAuth("poll_requested", {
      userCode: pending.userCode || "",
    });
    await client.pollDeviceLogin(pending.deviceCode);
    logAuth("poll_approved_token_saved", {
      userCode: pending.userCode || "",
    });
    const payload = await settingsPayload();
    if (!payload.auth) {
      logAuth("session_verify_failed", {
        userCode: pending.userCode || "",
      });
      return {
        authenticated: false,
        pending: false,
        error: "Operator received approval, but could not verify your Penut session. Try signing in again.",
      };
    }
    clearPendingDeviceLogin();
    logAuth("connected_verified", {
      account: payload.auth.account || "Signed in",
      project: payload.auth.project || null,
    });
    return { authenticated: true, settings: payload };
  } catch (error) {
    if (isAuthorizationPending(error)) {
      logAuth("poll_pending", {
        userCode: pending.userCode || "",
      });
      return { authenticated: false, pending: true };
    }
    clearPendingDeviceLogin();
    logAuth("poll_failed", {
      userCode: pending.userCode || "",
      error: friendlyPenutConnectionError(error),
      raw: safeErrorSummary(error),
    });
    return {
      authenticated: false,
      pending: false,
      error: friendlyPenutConnectionError(error),
    };
  }
});

ipcMain.handle("auth:logout", async () => {
  const settings = await settingsStore.getSettings();
  const client = createPenutApiClient(settings, { authStore });
  await client.logout();
  clearPendingDeviceLogin();
  logAuth("logged_out");
  return settingsPayload();
});

ipcMain.handle("agent:run", async (_event, prompt) => {
  if (activeRun) {
    return { ok: false, error: "An Operator run is already active." };
  }
  const currentTask = await taskStore.getActiveTask();
  if (!currentTask) {
    return { ok: false, error: "Create or select a task before approving it." };
  }
  return runSelectedTasks([currentTask.id], { [currentTask.id]: prompt }, {
    allowDetailRun: true,
  });
});

ipcMain.handle("agent:run-tasks", async (_event, taskIds, promptByTaskId = {}) => {
  if (activeRun) {
    return { ok: false, error: "An Operator run is already active." };
  }
  return runSelectedTasks(taskIds, promptByTaskId);
});

async function runSelectedTasks(taskIds, promptByTaskId = {}, options = {}) {
  const selectedIds = Array.isArray(taskIds)
    ? [...new Set(taskIds.filter((id) => typeof id === "string" && id))]
    : [];
  if (!selectedIds.length) {
    return { ok: false, error: "Select at least one ready task to run." };
  }

  const state = await taskStore.getState();
  const tasksById = new Map(state.tasks.map((task) => [task.id, task]));
  const tasks = selectedIds.map((id) => tasksById.get(id)).filter(Boolean);
  const blockedTask = tasks.find((task) => !taskCanRun(task, options));
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

function taskCanRun(task, options = {}) {
  if (options.allowDetailRun) {
    return ["pending", "approved", "failed", "stopped"].includes(task?.status);
  }
  return ["approved", "failed", "stopped", "expired"].includes(task?.status);
}

async function runOneTask(taskId, prompt, settings) {
  const existing = (await taskStore.getState()).tasks.find((task) => task.id === taskId);
  if (!existing) {
    return { ok: false, error: "Task is no longer available." };
  }

  const cleanPrompt = String(prompt || existing.prompt || "").trim();
  const shouldApproveRemoteTask =
    existing.remoteId &&
    existing.status === "pending";
  const shouldRetryRemoteTask =
    existing.remoteId &&
    ["failed", "stopped", "expired"].includes(existing.status);
  let task = await taskStore.updateTask(taskId, {
    prompt: cleanPrompt,
    status: "approved",
  });

  const penutClient = createPenutApiClient(settings, { authStore });
  if (task.remoteId && penutClient.isConfigured) {
    if (shouldRetryRemoteTask) {
      await penutClient.retryTask(task.remoteId, { editedPrompt: cleanPrompt });
    } else if (shouldApproveRemoteTask) {
      await penutClient.approveTask(task.remoteId, { editedPrompt: cleanPrompt });
    }
  } else if (!task.remoteId && penutClient.isConfigured) {
    const session = await penutClient.readSession();
    const assignedMemberId = session.currentMemberId;
    if (!assignedMemberId) {
      throw new Error("Penut could not find your current member. Sign in again, then reopen Operator.");
    }
    const created = await penutClient.createTask({
      title: "Operator task",
      prompt: cleanPrompt,
      assignedMemberId,
    });
    const remoteTask = created.task || {};
    task = await taskStore.updateTask(task.id, {
      remoteId: remoteTask.id,
      approvalRequestId: remoteTask.approvalRequestId || null,
      approvalActionId: remoteTask.approvalActionId || null,
      status: "approved",
    });
  }

  if (task.remoteId && penutClient.isConfigured) {
    await penutClient.claimTask(task.remoteId, { leaseSeconds: 900 });
    await penutClient.updateStatus(task.remoteId, { status: "running" });
    task = await taskStore.updateTask(task.id, { status: "running" });
  }

  activeRun = {
    taskId: task.id,
    remoteId: task.remoteId || null,
    stopped: false,
    stop: () => {},
  };
  await taskStore.updateTask(task.id, { status: "running" });
  mainWindow?.webContents.send("tasks:changed", await taskStore.getState());

  try {
    const result = await runBrowserUseWorker(task, settings, async (event) => {
      try {
        await taskStore.appendEvent(event, task.id);
        await sendRemoteEventIfNeeded(penutClient, task, event);
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
    if (task.remoteId && penutClient.isConfigured) {
      const terminalUpdate = {
        status,
        ...(result.ok ? { result: { message: result.result } } : { error: { message: result.result } }),
      };
      await penutClient.updateStatus(task.remoteId, terminalUpdate).then(async () => {
        await taskStore.updateTask(task.id, { pendingTerminalUpdate: null });
      }).catch(async (error) => {
        await taskStore.updateTask(task.id, { pendingTerminalUpdate: terminalUpdate });
        await taskStore.appendEvent({
          type: "system",
          message: "Task finished locally, but Penut could not be updated.",
          detail: { error: error.message },
        }, task.id).catch(() => {});
      });
    }
    const updatedTask = await taskStore.updateTask(task.id, { status });
    return { ...result, task: updatedTask, state: await taskStore.getState() };
  } catch (error) {
    if (activeRun?.taskId === task.id && activeRun.stopped) {
      return { ok: false, stopped: true, state: await taskStore.getState() };
    }
    if (task.remoteId && penutClient.isConfigured) {
      const terminalUpdate = {
        status: "failed",
        error: { message: error.message },
      };
      await penutClient.updateStatus(task.remoteId, terminalUpdate).then(async () => {
        await taskStore.updateTask(task.id, { pendingTerminalUpdate: null });
      }).catch(async () => {
        await taskStore.updateTask(task.id, { pendingTerminalUpdate: terminalUpdate });
      });
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
  const settings = await settingsStore.getSettings();
  const penutClient = createPenutApiClient(settings, { authStore });
  if (runningTask.remoteId && penutClient.isConfigured) {
    await penutClient.updateStatus(runningTask.remoteId, {
      status: "cancelled",
    }).catch(() => {});
  }
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

async function syncTasksFromPenut() {
  const settings = await settingsStore.getSettings();
  const client = createPenutApiClient(settings, { authStore });
  if (!client.isConfigured) {
    return taskStore.setSyncError(
      "Sign in to Penut to load browser tasks.",
      "auth_required",
    );
  }

  try {
    const payload = await client.listTasks();
    await reconcileTerminalLocalTasks(client, payload.tasks || []);
    const state = await taskStore.mergeRemoteTasks(payload.tasks || []);
    return state;
  } catch (error) {
    return taskStore.setSyncError(
      `Could not sync tasks from Penut. ${friendlyPenutConnectionError(error)}`,
      isAuthError(error) ? "auth_required" : "connection_error",
    );
  }
}

async function settingsPayload() {
  const settings = await settingsStore.getSettings();
  return {
    settings,
    chromeProfiles: await settingsStore.listChromeProfiles(),
    readiness: await getRunReadiness(settings),
    auth: await readAuthSummary(settings),
  };
}

async function readAuthSummary(settings) {
  const client = createPenutApiClient(settings, { authStore });
  if (!client.isConfigured) return null;
  try {
    const session = await client.readSession();
    const identity = session.currentMember || session.members?.find((member) => {
      return member.id === session.currentMemberId;
    });
    const account = identity?.email || identity?.name || "Signed in";
    const project = session.currentProject?.name;
    return {
      label: project ? `Signed in as ${account} · ${project}` : `Signed in as ${account}`,
      account,
      project: project || null,
    };
  } catch {
    return null;
  }
}

async function reconcileTerminalLocalTasks(client, remoteTasks) {
  const state = await taskStore.getState();
  const remoteById = new Map(remoteTasks.map((task) => [task.id, task]));
  await Promise.all((state.tasks || []).map(async (task) => {
    if (!task.remoteId || !["completed", "failed", "stopped"].includes(task.status)) return;
    const remote = remoteById.get(task.remoteId);
    if (!remote || !["claimed", "running", "approved"].includes(remote.status)) return;
    const status = task.status === "stopped" ? "cancelled" : task.status;
    const terminalUpdate = task.pendingTerminalUpdate || {
      status,
      ...(status === "completed"
        ? { result: { message: "Task completed locally." } }
        : { error: { message: "Task did not complete locally." } }),
    };
    await client.updateStatus(task.remoteId, terminalUpdate).then(async () => {
      await taskStore.updateTask(task.id, { pendingTerminalUpdate: null });
    }).catch(() => {});
  }));
}

function getPendingDeviceLogin() {
  if (pendingDeviceLogin?.deviceCode) return pendingDeviceLogin;
  try {
    const raw = JSON.parse(readFileSync(PENDING_DEVICE_LOGIN_FILE, "utf8"));
    if (!raw?.deviceCode || !raw?.expiresAt) return null;
    pendingDeviceLogin = {
      deviceCode: String(raw.deviceCode),
      userCode: typeof raw.userCode === "string" ? raw.userCode : "",
      verificationUrl:
        typeof raw.verificationUrl === "string" ? raw.verificationUrl : "",
      expiresAt: Number(raw.expiresAt),
    };
    return pendingDeviceLogin;
  } catch {
    return null;
  }
}

function savePendingDeviceLogin(login) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PENDING_DEVICE_LOGIN_FILE, `${JSON.stringify(login, null, 2)}\n`, {
    mode: 0o600,
  });
}

function clearPendingDeviceLogin() {
  pendingDeviceLogin = null;
  try {
    unlinkSync(PENDING_DEVICE_LOGIN_FILE);
  } catch {
    // Nothing to clear.
  }
}

function logAuth(event, detail = {}) {
  const payload = sanitizeLogDetail(detail);
  const suffix = Object.keys(payload).length ? ` ${JSON.stringify(payload)}` : "";
  console.log(`[auth] ${event}${suffix}`);
}

function sanitizeLogDetail(detail) {
  if (!detail || typeof detail !== "object") return {};
  return Object.fromEntries(
    Object.entries(detail).map(([key, value]) => {
      if (/^(token|accessToken|refreshToken|deviceCode|secret|key|authorization)$/i.test(key)) {
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

function isAuthorizationPending(error) {
  const message = String(error?.message || "");
  const body = error?.body || {};
  return /authorization[\s_-]?pending/i.test(message) ||
    /authorization[\s_-]?pending/i.test(String(body.error || "")) ||
    /authorization[\s_-]?pending/i.test(String(body.error_description || ""));
}

function safeErrorSummary(error) {
  const body = error?.body || {};
  return {
    status: error?.status || null,
    message: error?.message || "",
    error: body.error || null,
    errorDescription: body.error_description || null,
  };
}

async function sendRemoteEventIfNeeded(client, task, event) {
  if (!task.remoteId || !client.isConfigured) return;
  await client.addEvent(task.remoteId, {
    eventType: mapEventType(event.type),
    message: event.message || "Task update.",
    detail: event.detail || {},
  }).catch(() => {});
}

function mapEventType(type) {
  if (["system", "status", "browser", "agent", "result", "error"].includes(type)) {
    return type;
  }
  if (type === "complete") return "result";
  return "agent";
}

function mapRemoteEvents(events) {
  return events.map((event) => ({
    id: event.id || `event_${crypto.randomUUID()}`,
    type: event.eventType || "agent",
    message: event.message || "Task update.",
    detail: event.detail || {},
    at: event.createdAt || new Date().toISOString(),
  })).reverse();
}

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

    if (activeRun?.taskId === task.id) {
      activeRun.stop = () => child.kill("SIGTERM");
      activeRun.remoteId = task.remoteId || null;
    }
  });
}

async function getRunReadiness(settings) {
  const paths = getRuntimePaths();
  const checks = [
    await checkPenutConnection(settings),
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

async function checkPenutConnection(settings) {
  const client = createPenutApiClient(settings, { authStore });
  if (!client.hasBaseUrl) {
    return {
      id: "penutConnection",
      label: "Penut connection",
      ready: false,
      message: "Penut is not configured on this computer.",
      action: "Sign in to Penut in Operator settings.",
    };
  }

  if (!client.hasAccessToken) {
    return {
      id: "penutConnection",
      label: "Penut connection",
      ready: false,
      message: "You need to sign in to Penut.",
      action: "Sign in to Penut in Operator settings.",
    };
  }

  try {
    await client.readSession();
  } catch (error) {
    return {
      id: "penutConnection",
      label: "Penut connection",
      ready: false,
      message: friendlyPenutConnectionError(error),
      action: friendlyPenutConnectionAction(error),
    };
  }

  return {
    id: "penutConnection",
    label: "Penut connection",
    ready: true,
    message: "Signed in to Penut.",
    action: "No action needed.",
  };
}

function friendlyPenutConnectionError(error) {
  const message = String(error?.message || "");
  if (/expired|401|unauthorized|sign in|login/i.test(message)) {
    return "Your Penut session expired. Sign in again to continue.";
  }
  if (/404|not found/i.test(message)) {
    return "This Penut server does not support Operator sign-in yet.";
  }
  if (/secure storage|cannot save|could not save/i.test(message)) {
    return "Operator connected, but this computer could not save the sign-in securely.";
  }
  if (/fetch failed|network|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(message)) {
    return "Cannot reach Penut right now. Check your connection and try again.";
  }
  return "Penut could not verify your session.";
}

function isAuthError(error) {
  return /expired|401|unauthorized|sign in|login/i.test(
    String(error?.message || ""),
  );
}

function friendlyPenutConnectionAction(error) {
  const message = String(error?.message || "");
  if (/expired|401|unauthorized|sign in|login/i.test(message)) {
    return "Sign in to Penut again from Operator settings.";
  }
  if (/404|not found/i.test(message)) {
    return "Operator sign-in is not available on this Penut server yet. Update the server, then try again.";
  }
  if (/secure storage|cannot save|could not save/i.test(message)) {
    return "Restart Operator and try signing in again. If it keeps happening, check macOS Keychain access.";
  }
  if (/fetch failed|network|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(message)) {
    return "Check your internet connection, then refresh Operator.";
  }
  return "Refresh Operator or sign in to Penut again from Operator settings.";
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
