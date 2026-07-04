import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const timeoutMs = 30_000;
const electronPath = resolveElectronPath();

const child = spawn(electronPath, [root], {
  cwd: root,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "",
    PENUT_OPERATOR_SMOKE_STARTUP: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
  shell: process.platform === "win32" && electronPath.endsWith(".cmd"),
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

function resolveElectronPath() {
  const packagePath = require("electron");
  if (typeof packagePath === "string" && existsSync(packagePath)) {
    return packagePath;
  }

  const binName = process.platform === "win32" ? "electron.cmd" : "electron";
  const binPath = join(root, "node_modules", ".bin", binName);
  if (existsSync(binPath)) {
    return binPath;
  }

  return packagePath;
}
