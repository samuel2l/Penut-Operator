import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const DATA_DIR = path.join(ROOT, "data");
const TASK_FILE = path.join(DATA_DIR, "active-task.json");
const SEED_FILE = path.join(ROOT, "fixtures", "sample-task.json");
const MAX_EVENTS = 100;
const MAX_TASKS = 50;
let cachedState;
let writeQueue = Promise.resolve();

export function createTaskStore() {
  return {
    getState,
    getActiveTask,
    selectTask,
    createTask,
    mergeRemoteTasks,
    setSyncError,
    updateTask,
    updateActiveTask,
    resetActiveTask,
    appendEvent,
  };
}

async function getState() {
  try {
    await ensureTaskFile();
    cachedState = normalizeState(await readTaskFile());
    return cachedState;
  } catch {
    if (cachedState) return cachedState;
    return resetActiveTask();
  }
}

async function getActiveTask() {
  const state = await getState();
  return getSelectedTask(state);
}

async function selectTask(taskId) {
  return enqueueTaskWrite(async () => {
    const state = await readState();
    const exists = state.tasks.some((task) => task.id === taskId);
    if (!exists) return state;
    const next = {
      ...state,
      selectedTaskId: taskId,
      updatedAt: new Date().toISOString(),
    };
    await writeState(next);
    return next;
  });
}

async function createTask(prompt = "") {
  return enqueueTaskWrite(async () => {
    const state = await readState();
    const now = new Date().toISOString();
    const task = {
      id: `task_${crypto.randomUUID()}`,
      status: "pending",
      requestedBy: "Penut Agent",
      accountOwner: "Account owner",
      prompt: String(prompt || "").trim(),
      createdAt: now,
      updatedAt: now,
      events: [
        makeEvent({
          type: "system",
          message: "Task added.",
          at: now,
        }),
      ],
    };
    const next = {
      ...state,
      selectedTaskId: task.id,
      syncError: null,
      tasks: [task, ...state.tasks].slice(0, MAX_TASKS),
      updatedAt: now,
    };
    await writeState(next);
    return next;
  });
}

async function mergeRemoteTasks(remoteTasks = []) {
  return enqueueTaskWrite(async () => {
    const state = await readState();
    const now = new Date().toISOString();
    const remote = remoteTasks.map((remoteTask) => {
      const existing = findExistingRemoteTask(state.tasks, remoteTask.id);
      return normalizeRemoteTask(remoteTask, existing);
    });
    const selectedTaskId = remote.some((task) => task.id === state.selectedTaskId)
      ? state.selectedTaskId
      : remote[0]?.id || null;
    const next = {
      ...state,
      selectedTaskId,
      syncError: null,
      tasks: remote.slice(0, MAX_TASKS),
      updatedAt: now,
    };
    await writeState(next);
    return next;
  });
}

function findExistingRemoteTask(tasks, remoteId) {
  return tasks.find((task) => task.remoteId === remoteId || task.id === `remote_${remoteId}`);
}

async function setSyncError(message) {
  return enqueueTaskWrite(async () => {
    const state = await readState();
    const now = new Date().toISOString();
    const next = {
      ...state,
      selectedTaskId: null,
      syncError: message,
      tasks: [],
      updatedAt: now,
    };
    await writeState(next);
    return next;
  });
}

async function updateActiveTask(patch) {
  const state = await getState();
  return updateTask(state.selectedTaskId, patch);
}

async function updateTask(taskId, patch) {
  return enqueueTaskWrite(async () => {
    const state = await readState();
    const task = state.tasks.find((item) => item.id === taskId) || getSelectedTask(state);
    const now = new Date().toISOString();
    const nextTask = {
      ...task,
      ...patch,
      updatedAt: now,
    };
    const next = replaceTask(state, nextTask, now);
    await writeState(next);
    return nextTask;
  });
}

async function resetActiveTask() {
  return enqueueTaskWrite(async () => {
    const task = await makeSeedTask();
    const state = {
      version: 2,
      selectedTaskId: task.id,
      syncError: null,
      tasks: [task],
      updatedAt: new Date().toISOString(),
    };
    await writeState(state);
    return state;
  });
}

async function appendEvent(event, taskId) {
  return enqueueTaskWrite(async () => {
    const state = await readState();
    const task = taskId
      ? state.tasks.find((item) => item.id === taskId) || getSelectedTask(state)
      : getSelectedTask(state);
    const now = new Date().toISOString();
    const nextTask = {
      ...task,
      events: [makeEvent(event), ...(task.events || [])].slice(0, MAX_EVENTS),
      updatedAt: now,
    };
    const next = replaceTask(state, nextTask, now);
    await writeState(next);
    return nextTask;
  });
}

async function ensureTaskFile() {
  try {
    await readTaskFile();
  } catch {
    if (!cachedState) await resetActiveTask();
  }
}

async function readState() {
  if (cachedState) return cachedState;
  return normalizeState(await readTaskFile());
}

async function readTaskFile() {
  const raw = await readFile(TASK_FILE, "utf8");
  return JSON.parse(raw);
}

function normalizeState(raw) {
  if (raw?.version === 2 && Array.isArray(raw.tasks)) {
    const tasks = raw.tasks.map(normalizeTask);
    const selectedTaskId = tasks.some((task) => task.id === raw.selectedTaskId)
      ? raw.selectedTaskId
      : tasks[0]?.id || null;
    return {
      version: 2,
      selectedTaskId,
      syncError: raw.syncError || null,
      tasks,
      updatedAt: raw.updatedAt || new Date().toISOString(),
    };
  }

  const task = normalizeTask(raw || makeEmptyTask());
  return {
    version: 2,
    selectedTaskId: task.id,
    syncError: null,
    tasks: [task],
    updatedAt: task.updatedAt || new Date().toISOString(),
  };
}

function normalizeTask(task) {
  const now = new Date().toISOString();
  return {
    id: task.id || `task_${crypto.randomUUID()}`,
    remoteId: task.remoteId || null,
    approvalRequestId: task.approvalRequestId || null,
    approvalActionId: task.approvalActionId || null,
    status: task.status || "pending",
    requestedBy: task.requestedBy || "Penut Agent",
    accountOwner: task.accountOwner || "Account owner",
    prompt: task.prompt || "",
    createdAt: task.createdAt || now,
    updatedAt: task.updatedAt || task.createdAt || now,
    events: Array.isArray(task.events) ? task.events : [],
  };
}

function normalizeRemoteTask(task, existingTask) {
  const now = new Date().toISOString();
  const remoteStatus = normalizeRemoteStatus(task.status);
  const status = terminalStatus(existingTask?.status) && ["running", "approved"].includes(remoteStatus)
    ? existingTask.status
    : remoteStatus;
  const prompt = task.editedPrompt || task.prompt || "";
  return normalizeTask({
    ...existingTask,
    id: `remote_${task.id}`,
    remoteId: task.id,
    approvalRequestId: task.approvalRequestId || null,
    approvalActionId: task.approvalActionId || null,
    status,
    requestedBy: task.requestedByMemberId ? "Penut" : "Penut Agent",
    accountOwner: "Assigned to you",
    prompt,
    createdAt: task.createdAt || now,
    updatedAt: task.updatedAt || task.createdAt || now,
    events: existingTask?.events || [],
  });
}

function terminalStatus(status) {
  return ["completed", "failed", "stopped", "rejected"].includes(status);
}

function normalizeRemoteStatus(status) {
  const map = {
    pending_approval: "pending",
    approved: "approved",
    claimed: "running",
    running: "running",
    completed: "completed",
    failed: "failed",
    cancelled: "stopped",
    rejected: "rejected",
    expired: "failed",
  };
  return map[status] || status || "pending";
}

function getSelectedTask(state) {
  return state.tasks.find((task) => task.id === state.selectedTaskId) || state.tasks[0];
}

function replaceTask(state, nextTask, updatedAt) {
  return {
    ...state,
    tasks: state.tasks.map((task) => task.id === nextTask.id ? nextTask : task),
    updatedAt,
  };
}

async function makeSeedTask() {
  await mkdir(DATA_DIR, { recursive: true });
  const seed = JSON.parse(await readFile(SEED_FILE, "utf8"));
  return normalizeTask({
    ...seed,
    updatedAt: new Date().toISOString(),
    events: [
      makeEvent({
        type: "system",
        message: "Loaded sample task.",
      }),
    ],
  });
}

function makeEmptyTask() {
  const now = new Date().toISOString();
  return {
    id: `task_${crypto.randomUUID()}`,
    status: "pending",
    requestedBy: "Penut Agent",
    accountOwner: "Account owner",
    prompt: "",
    createdAt: now,
    updatedAt: now,
    events: [],
  };
}

async function writeState(state) {
  await mkdir(DATA_DIR, { recursive: true });
  const normalized = normalizeState(state);
  const tempFile = `${TASK_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  cachedState = normalized;
  await writeFile(tempFile, `${JSON.stringify(normalized, null, 2)}\n`);
  try {
    await rename(tempFile, TASK_FILE);
  } catch (error) {
    await unlink(tempFile).catch(() => {});
    throw error;
  }
}

function enqueueTaskWrite(operation) {
  const next = writeQueue.then(operation, operation);
  writeQueue = next.catch(() => {});
  return next;
}

function makeEvent(event) {
  return {
    id: crypto.randomUUID(),
    type: event.type || "agent",
    message: event.message || "Operator update.",
    detail: event.detail,
    at: event.at || new Date().toISOString(),
  };
}
