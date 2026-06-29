import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { safeStorage } = require("electron");
const ROOT = path.resolve(__dirname, "../..");
const DATA_DIR = path.join(ROOT, "data");
const SESSION_FILE = path.join(DATA_DIR, "operator-session.json");

export function createOperatorAuthStore() {
  return {
    readSession,
    saveSession,
    clearSession,
  };
}

function readSession() {
  const payload = readJson(SESSION_FILE);
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
  if (payload.mode === "plain") return normalizeSession(payload.session);
  return null;
}

function saveSession(session) {
  mkdirSync(DATA_DIR, { recursive: true });
  const normalized = normalizeSession(session);
  if (!normalized) return;
  const payload = safeStorage.isEncryptionAvailable()
    ? {
        mode: "safeStorage",
        data: safeStorage
          .encryptString(JSON.stringify(normalized))
          .toString("base64"),
      }
    : {
        mode: "plain",
        session: normalized,
      };
  writeFileSync(SESSION_FILE, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600,
  });
}

function clearSession() {
  if (!existsSync(SESSION_FILE)) return;
  try {
    unlinkSync(SESSION_FILE);
  } catch {
    // A stale local auth file should not block sign-out UX.
  }
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
