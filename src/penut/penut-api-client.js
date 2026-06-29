export function createPenutApiClient(settings) {
  const baseUrl = String(settings.penutApiBaseUrl || "").replace(/\/+$/, "");
  const token = String(settings.penutAccessToken || "").trim();

  return {
    isConfigured: Boolean(baseUrl && token),
    listTasks: () => request("/browser/tasks"),
    readTask: (taskId) => request(`/browser/tasks/${encodeURIComponent(taskId)}`),
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
    if (!baseUrl || !token) {
      throw new Error("Connect Operator to Penut before syncing tasks.");
    }

    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const text = await response.text();
    const payload = text ? safeJson(text) : null;
    if (!response.ok) {
      const message =
        payload?.message || payload?.error || `Penut request failed (${response.status}).`;
      throw new Error(message);
    }
    return payload || {};
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
