import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runtimeRoot = join(root, "build", "runtime-work");
const archiveDir = join(root, "build", "runtime-archives");
const requirementsPath = join(root, "python", "requirements.txt");
const standaloneArchiveUrl = process.env.OPERATOR_STANDALONE_PYTHON_ARCHIVE_URL;
const standaloneArchiveFile = process.env.OPERATOR_STANDALONE_PYTHON_ARCHIVE_FILE;
const standaloneArchiveSha256 = process.env.OPERATOR_STANDALONE_PYTHON_ARCHIVE_SHA256;
const platform = process.platform;
const arch = process.arch;
const archiveBaseName = `browser-operator-python-runtime-${platform}-${arch}`;
const archivePath =
  platform === "win32"
    ? join(archiveDir, `${archiveBaseName}.zip`)
    : join(archiveDir, `${archiveBaseName}.tar.gz`);

rmSync(runtimeRoot, { recursive: true, force: true });
mkdirSync(runtimeRoot, { recursive: true });
mkdirSync(archiveDir, { recursive: true });

if (!standaloneArchiveUrl && !standaloneArchiveFile) {
  throw new Error(
    "Set OPERATOR_STANDALONE_PYTHON_ARCHIVE_URL or OPERATOR_STANDALONE_PYTHON_ARCHIVE_FILE to build a portable runtime.",
  );
}

const seedArchivePath = standaloneArchiveFile
  ? join(runtimeRoot, basename(standaloneArchiveFile))
  : join(runtimeRoot, basename(new URL(standaloneArchiveUrl).pathname));
if (standaloneArchiveFile) {
  if (!existsSync(standaloneArchiveFile)) {
    throw new Error(`Standalone Python archive does not exist: ${standaloneArchiveFile}`);
  }
  copyFileSync(standaloneArchiveFile, seedArchivePath);
} else {
  console.log(`Downloading standalone Python runtime from ${standaloneArchiveUrl}`);
  const response = await fetch(standaloneArchiveUrl);
  if (!response.ok || !response.body) {
    throw new Error(`Could not download standalone Python runtime (${response.status}).`);
  }
  await pipeline(response.body, createWriteStream(seedArchivePath));
}

if (standaloneArchiveSha256) {
  const actualSha256 = await sha256(seedArchivePath);
  const expectedSha256 = standaloneArchiveSha256.replace(/^sha256:/, "");
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `Standalone Python archive checksum mismatch. Expected ${expectedSha256}, got ${actualSha256}.`,
    );
  }
}

extractArchive(seedArchivePath, runtimeRoot);
rmSync(seedArchivePath, { force: true });

const runtimePython = findPython(runtimeRoot);
if (!runtimePython) {
  throw new Error("Could not find Python executable in prepared runtime.");
}
assertPortable(runtimePython, runtimeRoot);

run(runtimePython, ["-m", "pip", "install", "--upgrade", "pip"]);
run(runtimePython, ["-m", "pip", "install", "-r", requirementsPath]);
run(runtimePython, ["-c", "import browser_use; import openai"]);

rmSync(archivePath, { force: true });
if (platform === "win32") {
  run("powershell", [
    "-NoProfile",
    "-Command",
    `Compress-Archive -Path '${runtimeRoot}\\*' -DestinationPath '${archivePath}' -Force`,
  ]);
} else {
  run("tar", ["-czf", archivePath, "-C", runtimeRoot, "."]);
}

const sizeMb = Math.round((statSync(archivePath).size / 1024 / 1024) * 10) / 10;
console.log(`Built ${archivePath} (${sizeMb} MB)`);

function extractArchive(archivePath, destination) {
  if (archivePath.endsWith(".zip")) {
    if (platform === "win32") {
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
  throw new Error("Unsupported standalone Python archive format.");
}

function findPython(searchRoot) {
  const candidates = [
    join(searchRoot, "python", "bin", "python3"),
    join(searchRoot, "python", "bin", "python"),
    join(searchRoot, "install", "bin", "python3"),
    join(searchRoot, "python", "install", "bin", "python3"),
    join(searchRoot, "bin", "python3"),
    join(searchRoot, "bin", "python"),
    join(searchRoot, "python", "python.exe"),
    join(searchRoot, "Scripts", "python.exe"),
    join(searchRoot, "python.exe"),
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

async function sha256(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}
