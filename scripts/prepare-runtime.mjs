import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runtimeDir = join(root, "build", "python-runtime");
const archiveUrl = process.env.PENUT_PYTHON_RUNTIME_ARCHIVE_URL;
const archiveFile = process.env.PENUT_PYTHON_RUNTIME_ARCHIVE_FILE;

if (!archiveUrl && !archiveFile) {
  console.log(
    "No runtime archive configured; creating an empty runtime placeholder.",
  );
  rmSync(runtimeDir, { recursive: true, force: true });
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(
    join(runtimeDir, "README.txt"),
    "Set PENUT_PYTHON_RUNTIME_ARCHIVE_URL to prepare a bundled runtime.\n",
  );
  process.exit(0);
}

rmSync(runtimeDir, { recursive: true, force: true });
mkdirSync(runtimeDir, { recursive: true });

const archivePath = archiveFile
  ? join(runtimeDir, basename(archiveFile))
  : join(runtimeDir, basename(new URL(archiveUrl).pathname));

if (archiveFile) {
  if (!existsSync(archiveFile)) {
    throw new Error(`Python runtime archive does not exist: ${archiveFile}`);
  }
  console.log(`Using Python runtime archive ${archiveFile}`);
  copyFileSync(archiveFile, archivePath);
} else {
  console.log(`Downloading Python runtime from ${archiveUrl}`);
  const response = await fetch(archiveUrl);
  if (!response.ok || !response.body) {
    throw new Error(`Could not download Python runtime (${response.status}).`);
  }
  await pipeline(response.body, createWriteStream(archivePath));
}

extractArchive(archivePath, runtimeDir);
rmSync(archivePath, { force: true });
const pythonPath = findPython(runtimeDir);
if (!pythonPath) {
  throw new Error("Prepared runtime does not contain a Python executable.");
}
assertPortable(pythonPath, runtimeDir);

run(pythonPath, ["-m", "pip", "install", "--upgrade", "pip"]);
run(pythonPath, [
  "-m",
  "pip",
  "install",
  "-r",
  join(root, "python", "requirements.txt"),
]);
run(pythonPath, ["-c", "import browser_use"]);
console.log(`Prepared Operator Python runtime at ${runtimeDir}`);

function extractArchive(archivePath, destination) {
  if (archivePath.endsWith(".zip")) {
    if (process.platform === "win32") {
      run("powershell", [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path '${archivePath}' -DestinationPath '${destination}' -Force`,
      ]);
      return;
    }
    run("ditto", ["-x", "-k", archivePath, destination]);
    return;
  }
  if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
    run("tar", ["-xzf", archivePath, "-C", destination]);
    return;
  }
  if (archivePath.endsWith(".tar.zst")) {
    run("tar", ["--zstd", "-xf", archivePath, "-C", destination]);
    return;
  }
  throw new Error("Unsupported Python runtime archive format.");
}

function findPython(searchRoot) {
  const candidates = [
    join(searchRoot, "bin", "python3"),
    join(searchRoot, "python", "bin", "python3"),
    join(searchRoot, "install", "bin", "python3"),
    join(searchRoot, "python", "install", "bin", "python3"),
    join(searchRoot, "python.exe"),
    join(searchRoot, "python", "python.exe"),
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
