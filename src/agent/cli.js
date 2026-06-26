import { createTaskStore } from "../storage/task-store.js";
import { OperatorAgentRuntime } from "./runtime.js";

const dryRun = process.argv.includes("--dry-run");
const taskStore = createTaskStore();
const task = await taskStore.getActiveTask();

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
