import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runtimeRoot = join(root, "build", "python-runtime");
const pythonPath = findPython(runtimeRoot);

if (!pythonPath) {
  throw new Error(
    "No bundled Python runtime found. Run npm run prepare:runtime with a runtime archive before verifying.",
  );
}

assertPortable(pythonPath, runtimeRoot);
run(pythonPath, ["-c", "import browser_use; import openai"]);
console.log(`Verified Operator Python runtime at ${runtimeRoot}`);

function findPython(searchRoot) {
  const candidates = [
    join(searchRoot, "bin", "python3"),
    join(searchRoot, "bin", "python"),
    join(searchRoot, "python", "bin", "python3"),
    join(searchRoot, "python", "bin", "python"),
    join(searchRoot, "install", "bin", "python3"),
    join(searchRoot, "python", "install", "bin", "python3"),
    join(searchRoot, "python.exe"),
    join(searchRoot, "python", "python.exe"),
    join(searchRoot, "Scripts", "python.exe"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || "";
}

function assertPortable(pythonPath, searchRoot) {
  const resolvedPython = realpathSync(pythonPath);
  const resolvedRoot = realpathSync(searchRoot);
  if (!resolvedPython.startsWith(resolvedRoot)) {
    throw new Error(
      `Prepared Python is not portable: ${pythonPath} resolves to ${resolvedPython}`,
    );
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed.`);
  }
}
