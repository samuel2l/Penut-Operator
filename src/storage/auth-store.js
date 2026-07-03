import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { app, safeStorage } = require("electron");
const ROOT = path.resolve(__dirname, "../..");

export function createOperatorAuthStore() {
  return {
    readSession,
    saveSession,
    clearSession,
  };
}

function readSession() {
  const payload = readJson(sessionFilePath());
  if (!payload) return null;
  if (payload.mode === "safeStorage" && typeof payload.data === "string") {
    if (!safeStorage.isEncryptionAvailable()) return null;
    try {
      return normalizeSession(
        JSON.parse(
          safeStorage.decryptString(Buffer.from(payload.data, "base64")),
        ),
      );
    } catch {
      return null;
    }
  }
  return null;
}

function saveSession(session) {
  mkdirSync(dataDir(), { recursive: true });
  const normalized = normalizeSession(session);
  if (!normalized) return;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Secure storage is unavailable. Operator cannot save your Penut sign-in on this computer.");
  }
  const payload = {
    mode: "safeStorage",
    data: safeStorage
      .encryptString(JSON.stringify(normalized))
      .toString("base64"),
  };
  writeFileSync(sessionFilePath(), `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600,
  });
}

function clearSession() {
  const sessionFile = sessionFilePath();
  if (!existsSync(sessionFile)) return;
  try {
    unlinkSync(sessionFile);
  } catch {
    // A stale local auth file should not block sign-out UX.
  }
}

function dataDir() {
  return app?.isPackaged
    ? path.join(app.getPath("userData"), "data")
    : path.join(ROOT, "data");
}

function sessionFilePath() {
  return path.join(dataDir(), "operator-session.json");
}

function normalizeSession(session) {
  if (!session || typeof session !== "object") return null;
  const accessToken =
    typeof session.accessToken === "string" ? session.accessToken : "";
  const refreshToken =
    typeof session.refreshToken === "string" ? session.refreshToken : "";
  if (!accessToken && !refreshToken) return null;
  return {
    accessToken,
    refreshToken,
    expiresAt:
      typeof session.expiresAt === "string" ? session.expiresAt : null,
  };
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}
