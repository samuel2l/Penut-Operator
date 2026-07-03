import { readFile, writeFile, mkdir, rename, unlink, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { app } = require("electron");
const ROOT = path.resolve(__dirname, "../..");
const CHROME_USER_DATA_DIR = path.join(
  os.homedir(),
  "Library/Application Support/Google/Chrome",
);
let cachedSettings;
let writeQueue = Promise.resolve();

export function createSettingsStore() {
  return {
    getSettings,
    updateSettings,
    listChromeProfiles,
  };
}

async function getSettings() {
  if (cachedSettings) return cachedSettings;
  try {
    cachedSettings = normalizeSettings(JSON.parse(await readFile(settingsFilePath(), "utf8")));
    return cachedSettings;
  } catch {
    cachedSettings = normalizeSettings({});
    return cachedSettings;
  }
}

async function updateSettings(patch) {
  return enqueueWrite(async () => {
    const current = await getSettings();
    const next = normalizeSettings({
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    await writeSettings(next);
    return next;
  });
}

async function listChromeProfiles() {
  if (!existsSync(CHROME_USER_DATA_DIR)) {
    return {
      userDataDir: CHROME_USER_DATA_DIR,
      profiles: [],
    };
  }

  const localStateProfiles = await readLocalStateProfiles().catch(() => []);
  const profileDirs = await readProfileDirs().catch(() => []);
  const merged = new Map();

  for (const profile of profileDirs) {
    merged.set(profile.directory, profile);
  }

  for (const profile of localStateProfiles) {
    merged.set(profile.directory, {
      ...merged.get(profile.directory),
      ...profile,
    });
  }

  return {
    userDataDir: CHROME_USER_DATA_DIR,
    profiles: [...merged.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

async function readLocalStateProfiles() {
  const localStatePath = path.join(CHROME_USER_DATA_DIR, "Local State");
  const raw = await readFile(localStatePath, "utf8");
  const parsed = JSON.parse(raw);
  const infoCache = parsed?.profile?.info_cache || {};
  return Object.entries(infoCache).map(([directory, info]) => ({
    directory,
    name: info?.name || readableProfileName(directory),
    email: info?.user_name || "",
  }));
}

async function readProfileDirs() {
  const entries = await readdir(CHROME_USER_DATA_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name === "Default" || /^Profile \d+$/.test(name))
    .map((directory) => ({
      directory,
      name: readableProfileName(directory),
      email: "",
    }));
}

function normalizeSettings(settings) {
  return {
    chromeUserDataDir: settings.chromeUserDataDir || CHROME_USER_DATA_DIR,
    chromeProfileDirectory: settings.chromeProfileDirectory || "",
    chromeProfileName: settings.chromeProfileName || "",
    updatedAt: settings.updatedAt || new Date().toISOString(),
  };
}

function readableProfileName(directory) {
  if (directory === "Default") return "Default";
  return directory;
}

async function writeSettings(settings) {
  const settingsFile = settingsFilePath();
  await mkdir(dataDir(), { recursive: true });
  const tempFile = `${settingsFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  cachedSettings = settings;
  await writeFile(tempFile, `${JSON.stringify(settings, null, 2)}\n`);
  try {
    await rename(tempFile, settingsFile);
  } catch (error) {
    await unlink(tempFile).catch(() => {});
    throw error;
  }
}

function dataDir() {
  return app?.isPackaged
    ? path.join(app.getPath("userData"), "data")
    : path.join(ROOT, "data");
}

function settingsFilePath() {
  return path.join(dataDir(), "settings.json");
}

function enqueueWrite(operation) {
  const next = writeQueue.then(operation, operation);
  writeQueue = next.catch(() => {});
  return next;
}
