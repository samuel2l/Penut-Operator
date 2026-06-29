import { createTaskStore } from "../storage/task-store.js";
import { OperatorAgentRuntime } from "./runtime.js";

const dryRun = process.argv.includes("--dry-run");
const taskStore = createTaskStore();
const task = (await taskStore.getActiveTask()) || (dryRun ? makeDryRunTask() : null);
if (!task) {
  throw new Error("No task is available to run.");
}

const runtime = new OperatorAgentRuntime({
  allowDryRun: dryRun,
  onEvent: async (event) => {
    const line = `[${event.type}] ${event.message}`;
    console.log(line);
    if (!dryRun) await taskStore.appendEvent(event);
  },
});

const result = await runtime.run(task);
console.log(JSON.stringify(result, null, 2));

function makeDryRunTask() {
  const now = new Date().toISOString();
  return {
    id: "dry_run_task",
    status: "approved",
    prompt: "Dry-run browser task",
    createdAt: now,
    updatedAt: now,
    events: [],
  };
}
