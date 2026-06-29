const DEFAULT_API_URL = "https://api.penut.ai/";

export function createPenutApiClient(settings = {}, options = {}) {
  const authStore = options.authStore || null;
  let auth = authStore?.readSession() || {};
  const baseUrl = normalizeApiBaseUrl(process.env.PENUT_API_BASE_URL || DEFAULT_API_URL);

  return {
    isConfigured: Boolean(baseUrl && auth.accessToken),
    authSource: auth.accessToken ? "operator" : "missing",
    hasBaseUrl: Boolean(baseUrl),
    hasAccessToken: Boolean(auth.accessToken),
    hasRefreshToken: Boolean(auth.refreshToken),
    initDeviceLogin: () =>
      publicRequest("/identity/device/init", {
        method: "POST",
        body: {
          clientName: "Penut Operator",
          requestedScopes: ["read", "write", "offline_access"],
        },
      }),
    pollDeviceLogin: (deviceCode) =>
      publicRequest("/identity/device/poll", {
        method: "POST",
        body: {
          deviceCode,
          clientName: "Penut Operator",
        },
      }).then((payload) => {
        saveAuth({
          accessToken: payload.accessToken || payload.access_token,
          refreshToken: payload.refreshToken || payload.refresh_token,
          expiresAt: payload.expiresAt || null,
        });
        return payload;
      }),
    logout: async () => {
      if (auth.accessToken) {
        await request("/identity/session/logout", { method: "POST" }).catch(() => {});
      }
      authStore?.clearSession();
    },
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
    if (!baseUrl || !auth.accessToken) {
      throw new Error("Connect Operator to Penut before syncing tasks.");
    }

    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const text = await response.text();
    const payload = text ? safeJson(text) : null;
    if (response.status === 401 && auth.refreshToken && !options.skipRefresh) {
      auth = await refreshAuth(baseUrl, auth, authStore);
      return request(path, { ...options, skipRefresh: true });
    }
    if (!response.ok) {
      const message =
        payload?.message || payload?.error || `Penut request failed (${response.status}).`;
      throw new Error(message);
    }
    return payload || {};
  }

  async function publicRequest(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method || "GET",
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await response.text();
    const payload = text ? safeJson(text) : null;
    if (!response.ok) {
      const message =
        payload?.message ||
        payload?.error_description ||
        payload?.error ||
        `Penut request failed (${response.status}).`;
      const error = new Error(message);
      error.status = response.status;
      error.body = payload;
      throw error;
    }
    return payload || {};
  }

  function saveAuth(nextAuth) {
    auth = { ...auth, ...nextAuth };
    authStore?.saveSession(auth);
  }
}

async function refreshAuth(baseUrl, currentAuth, authStore) {
  const response = await fetch(`${baseUrl}/identity/oauth/refresh`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ refreshToken: currentAuth.refreshToken }),
  });
  const text = await response.text();
  const payload = text ? safeJson(text) : null;
  if (!response.ok || !payload?.accessToken) {
    throw new Error("Your Penut session expired. Sign in again to continue.");
  }
  const nextAuth = {
    ...currentAuth,
    accessToken: payload.accessToken,
    expiresAt: payload.expiresAt,
  };
  authStore?.saveSession(nextAuth);
  return nextAuth;
}

function normalizeApiBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  if (raw.endsWith("/api")) return raw;
  if (raw.endsWith("/api/platform")) return raw.replace(/\/platform$/, "");
  return `${raw}/api`;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
