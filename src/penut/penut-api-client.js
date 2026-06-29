import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PENUT_HOME = path.join(os.homedir(), ".penut");
const CLI_CONFIG_FILE = path.join(PENUT_HOME, "config.json");
const CLI_SESSION_FILE = path.join(PENUT_HOME, "session.json");

export function createPenutApiClient(settings) {
  let cliAuth = readCliAuth();
  const baseUrl = normalizeApiBaseUrl(process.env.PENUT_API_BASE_URL || cliAuth.apiUrl);

  return {
    isConfigured: Boolean(baseUrl && cliAuth.accessToken),
    authSource: cliAuth.accessToken ? "cli" : "missing",
    hasBaseUrl: Boolean(baseUrl),
    hasAccessToken: Boolean(cliAuth.accessToken),
    hasRefreshToken: Boolean(cliAuth.refreshToken),
    readSession: () => request("/identity/session"),
    listTasks: () => request("/browser/tasks"),
    readTask: (taskId) => request(`/browser/tasks/${encodeURIComponent(taskId)}`),
    createTask: (input) =>
      request("/browser/tasks", {
        method: "POST",
        body: input,
      }),
    approveTask: (taskId, input = {}) =>
      request(`/browser/tasks/${encodeURIComponent(taskId)}/approve`, {
        method: "POST",
        body: input,
      }),
    rejectTask: (taskId, input = {}) =>
      request(`/browser/tasks/${encodeURIComponent(taskId)}/reject`, {
        method: "POST",
        body: input,
      }),
    claimTask: (taskId, input = {}) =>
      request(`/browser/tasks/${encodeURIComponent(taskId)}/claim`, {
        method: "POST",
        body: input,
      }),
    updateStatus: (taskId, input) =>
      request(`/browser/tasks/${encodeURIComponent(taskId)}/status`, {
        method: "PATCH",
        body: input,
      }),
    addEvent: (taskId, input) =>
      request(`/browser/tasks/${encodeURIComponent(taskId)}/events`, {
        method: "POST",
        body: input,
      }),
  };

  async function request(path, options = {}) {
    if (!baseUrl || !cliAuth.accessToken) {
      throw new Error("Connect Operator to Penut before syncing tasks.");
    }

    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${cliAuth.accessToken}`,
        Accept: "application/json",
        ...(cliAuth.projectId ? { "x-penut-project-id": cliAuth.projectId } : {}),
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const text = await response.text();
    const payload = text ? safeJson(text) : null;
    if (response.status === 401 && cliAuth.refreshToken && !options.skipRefresh) {
      cliAuth = await refreshCliAuth(baseUrl, cliAuth);
      return request(path, { ...options, skipRefresh: true });
    }
    if (!response.ok) {
      const message =
        payload?.message || payload?.error || `Penut request failed (${response.status}).`;
      throw new Error(message);
    }
    return payload || {};
  }
}

function readCliAuth() {
  const config = readJson(CLI_CONFIG_FILE) || {};
  const session = readJson(CLI_SESSION_FILE) || {};
  return {
    apiUrl: typeof config.apiUrl === "string" ? config.apiUrl : "",
    projectId:
      typeof config.currentProjectId === "string" ? config.currentProjectId : "",
    accessToken:
      typeof session.accessToken === "string" ? session.accessToken : "",
    refreshToken:
      typeof session.refreshToken === "string" ? session.refreshToken : "",
    expiresAt: session.expiresAt,
  };
}

async function refreshCliAuth(baseUrl, cliAuth) {
  const response = await fetch(`${baseUrl}/identity/oauth/refresh`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ refreshToken: cliAuth.refreshToken }),
  });
  const text = await response.text();
  const payload = text ? safeJson(text) : null;
  if (!response.ok || !payload?.accessToken) {
    throw new Error("Penut CLI session expired. Run penut auth login --device from your agent.");
  }
  const nextAuth = {
    ...cliAuth,
    accessToken: payload.accessToken,
    expiresAt: payload.expiresAt,
  };
  writeCliSession(nextAuth);
  return nextAuth;
}

function writeCliSession(auth) {
  writeFileSync(
    CLI_SESSION_FILE,
    `${JSON.stringify(
      {
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
        expiresAt: auth.expiresAt,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

function normalizeApiBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  if (raw.endsWith("/api")) return raw;
  if (raw.endsWith("/api/platform")) return raw.replace(/\/platform$/, "");
  return `${raw}/api`;
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
