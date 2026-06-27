import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const DATA_DIR = path.join(ROOT, "data");
const TASK_FILE = path.join(DATA_DIR, "active-task.json");
const SEED_FILE = path.join(ROOT, "fixtures", "sample-task.json");

export function createTaskStore() {
  return {
    getActiveTask,
    updateActiveTask,
    resetActiveTask,
    appendEvent,
  };
}

async function getActiveTask() {
  await ensureTaskFile();
  const raw = await readFile(TASK_FILE, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    return resetActiveTask();
  }
}

async function updateActiveTask(patch) {
  const current = await getActiveTask();
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await writeTask(next);
  return next;
}

async function resetActiveTask() {
  await mkdir(DATA_DIR, { recursive: true });
  const seed = JSON.parse(await readFile(SEED_FILE, "utf8"));
  const task = {
    ...seed,
    updatedAt: new Date().toISOString(),
    events: [
      makeEvent({
        type: "system",
        message: "Loaded sample browser task seed.",
      }),
    ],
  };
  await writeTask(task);
  return task;
}

async function appendEvent(event) {
  const current = await getActiveTask();
  const next = {
    ...current,
    events: [makeEvent(event), ...(current.events || [])].slice(0, 100),
    updatedAt: new Date().toISOString(),
  };
  await writeTask(next);
  return next;
}

async function ensureTaskFile() {
  try {
    const raw = await readFile(TASK_FILE, "utf8");
    JSON.parse(raw);
  } catch {
    await resetActiveTask();
  }
}

async function writeTask(task) {
  await mkdir(DATA_DIR, { recursive: true });
  const tempFile = `${TASK_FILE}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(task, null, 2)}\n`);
  try {
    await rename(tempFile, TASK_FILE);
  } catch (error) {
    await unlink(tempFile).catch(() => {});
    throw error;
  }
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
