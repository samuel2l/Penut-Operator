import { spawn } from "node:child_process";
import { resolve } from "node:path";
import electronPath from "electron";

const root = resolve(new URL("..", import.meta.url).pathname);
const timeoutMs = 30_000;

const child = spawn(electronPath, [root], {
  cwd: root,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "",
    PENUT_OPERATOR_SMOKE_STARTUP: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
const timeout = setTimeout(() => {
  child.kill("SIGTERM");
  console.error(`[smoke] electron startup timed out after ${timeoutMs}ms`);
  if (output.trim()) console.error(output.trim());
  process.exit(1);
}, timeoutMs);

child.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  output += text;
  process.stdout.write(text);
});

child.stderr.on("data", (chunk) => {
  const text = chunk.toString();
  output += text;
  process.stderr.write(text);
});

child.on("error", (error) => {
  clearTimeout(timeout);
  console.error(`[smoke] failed to launch Electron: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  clearTimeout(timeout);
  if (code === 0) return;
  console.error(
    `[smoke] electron exited unsuccessfully with code ${code ?? "null"} signal ${signal ?? "null"}`,
  );
  process.exit(code || 1);
});
