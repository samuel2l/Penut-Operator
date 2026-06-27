import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const DATA_DIR = path.join(ROOT, "data");
const TASK_FILE = path.join(DATA_DIR, "active-task.json");
const SEED_FILE = path.join(ROOT, "fixtures", "sample-task.json");
let cachedTask;
let writeQueue = Promise.resolve();

export function createTaskStore() {
  return {
    getActiveTask,
    updateActiveTask,
    resetActiveTask,
    appendEvent,
  };
}

async function getActiveTask() {
  try {
    await ensureTaskFile();
    cachedTask = await readTaskFile();
    return cachedTask;
  } catch (error) {
    if (cachedTask) return cachedTask;
    return resetActiveTask();
  }
}

async function updateActiveTask(patch) {
  return enqueueTaskWrite(async () => {
    const current = cachedTask || await readTaskFile().catch(makeSeedTask);
    const next = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await writeTask(next);
    return next;
  });
}

async function resetActiveTask() {
  return enqueueTaskWrite(async () => {
    const task = await makeSeedTask();
    await writeTask(task);
    cachedTask = task;
    return task;
  });
}

async function appendEvent(event) {
  return enqueueTaskWrite(async () => {
    const current = cachedTask || await readTaskFile().catch(makeSeedTask);
    const next = {
      ...current,
      events: [makeEvent(event), ...(current.events || [])].slice(0, 100),
      updatedAt: new Date().toISOString(),
    };
    await writeTask(next);
    return next;
  });
}

async function ensureTaskFile() {
  try {
    await readTaskFile();
  } catch {
    if (!cachedTask) await resetActiveTask();
  }
}

async function readTaskFile() {
  const raw = await readFile(TASK_FILE, "utf8");
  return JSON.parse(raw);
}

async function makeSeedTask() {
  await mkdir(DATA_DIR, { recursive: true });
  const seed = JSON.parse(await readFile(SEED_FILE, "utf8"));
  return {
    ...seed,
    updatedAt: new Date().toISOString(),
    events: [
      makeEvent({
        type: "system",
        message: "Loaded sample task.",
      }),
    ],
  };
}

async function writeTask(task) {
  await mkdir(DATA_DIR, { recursive: true });
  const tempFile = `${TASK_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  cachedTask = task;
  await writeFile(tempFile, `${JSON.stringify(task, null, 2)}\n`);
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
    message: event.message || "Operator event.",
    detail: event.detail,
    at: event.at || new Date().toISOString(),
  };
}
