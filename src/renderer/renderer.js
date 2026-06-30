const taskPrompt = document.querySelector("#taskPrompt");
const statusBadge = document.querySelector("#statusBadge");
const eventList = document.querySelector("#eventList");
const listScreen = document.querySelector("#listScreen");
const detailScreen = document.querySelector("#detailScreen");
const settingsScreen = document.querySelector("#settingsScreen");
const taskDetails = document.querySelector("#taskDetails");
const emptyState = document.querySelector("#emptyState");
const emptyActionBtn = document.querySelector("#emptyActionBtn");
const listEmptyState = document.querySelector("#listEmptyState");
const listEmptyActionBtn = document.querySelector("#listEmptyActionBtn");
const emptyActivity = document.querySelector("#emptyActivity");
const taskList = document.querySelector("#taskList");
const refreshTasksBtn = document.querySelector("#refreshTasksBtn");
const newTaskBtn = document.querySelector("#newTaskBtn");
const backBtn = document.querySelector("#backBtn");
const approvalsNavBtn = document.querySelector("#approvalsNavBtn");
const settingsNavBtn = document.querySelector("#settingsNavBtn");
const chromeProfileSelect = document.querySelector("#chromeProfileSelect");
const profileHelp = document.querySelector("#profileHelp");
const saveSettingsBtn = document.querySelector("#saveSettingsBtn");
const readinessList = document.querySelector("#readinessList");
const authHelp = document.querySelector("#authHelp");
const authCard = document.querySelector(".auth-card");
const authCode = document.querySelector("#authCode");
const signInBtn = document.querySelector("#signInBtn");
const reopenAuthBtn = document.querySelector("#reopenAuthBtn");
const cancelAuthBtn = document.querySelector("#cancelAuthBtn");
const signOutBtn = document.querySelector("#signOutBtn");
const approveBtn = document.querySelector("#approveBtn");
const stopBtn = document.querySelector("#stopBtn");
let runInProgress = false;
let lastRenderedPrompt = "";
let promptDirty = false;
let currentState;
let selectedTaskId;
let currentScreen = "list";
let currentSettings;
let currentAuth;
let chromeProfileData = { userDataDir: "", profiles: [] };
let currentReadiness = { ready: false, checks: [] };
let currentPendingAuth;
let refreshInProgress = false;
let authPollTimer;

function humanStatus(status) {
  return String(status || "unknown").replaceAll("_", " ");
}

function readableStatus(status) {
  const normalized = String(status || "unknown");
  const map = {
    draft: "Draft",
    pending: "Waiting for approval",
    approved: "Approved",
    running: "Working",
    completed: "Completed",
    failed: "Needs attention",
    stopped: "Stopped",
    rejected: "Rejected",
    expired: "Expired",
  };
  return map[normalized] || humanStatus(status);
}

function timeAgo(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const diff = Date.now() - date.getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

function friendlyEventMessage(event) {
  const map = {
    "Operator run started.": "Task started",
    "Observed browser page.": "Page opened",
    "Operator run stopped by user.": "Stopped by you",
  };
  return map[event?.message] || event?.message || "Update";
}

function friendlyEventDetail(event) {
  const detail = event?.detail;
  if (!detail || typeof detail !== "object") return "";
  if (detail.error) return String(detail.error);
  if (detail.reason) return String(detail.reason);
  if (typeof detail.ms === "number" && typeof detail.totalMs === "number") {
    return `Run time: ${Math.round(detail.ms / 1000 * 10) / 10}s, total: ${Math.round(detail.totalMs / 1000 * 10) / 10}s`;
  }
  if (typeof detail.ms === "number") return `Took ${Math.round(detail.ms / 1000 * 10) / 10}s`;
  if (detail.url) return `Page: ${detail.url}`;
  if (detail.action) return `Action: ${detail.action}`;
  if (detail.rejectedAction) return `Rejected: ${detail.rejectedAction}`;
  if (detail.rejectionCount) return `Rejected ${detail.rejectionCount} time(s)`;
  return "";
}

function selectedTask(state) {
  return state?.tasks?.find((task) => task.id === state.selectedTaskId) || state?.tasks?.[0];
}

function taskPreview(task) {
  const prompt = String(task?.prompt || "").trim();
  if (!prompt) return "Untitled task";
  return prompt.length > 72 ? `${prompt.slice(0, 69)}...` : prompt;
}

function setScreen(screen) {
  currentScreen = screen;
  approvalsNavBtn.classList.toggle("active", screen !== "settings");
  settingsNavBtn.classList.toggle("active", screen === "settings");
}

function render(state) {
  currentState = state;
  const task = selectedTask(state);
  const isSettings = currentScreen === "settings";
  const isDetail = currentScreen === "detail";
  settingsScreen.classList.toggle("hidden", !isSettings);
  listScreen.classList.toggle("hidden", isDetail || isSettings);
  detailScreen.classList.toggle("hidden", !isDetail || isSettings);

  if (!task) {
    taskDetails.classList.add("hidden");
    emptyState.classList.toggle("hidden", !isDetail);
    listEmptyState.classList.toggle("hidden", isDetail || isSettings);
    const syncState = describeSyncState(state);
    const emptyTitle = emptyState.querySelector("h2");
    const emptyMessage = emptyState.querySelector("p");
    const listEmptyTitle = listEmptyState.querySelector("h3");
    const listEmptyMessage = listEmptyState.querySelector("p");
    if (emptyTitle) emptyTitle.textContent = syncState.title;
    if (emptyMessage) {
      emptyMessage.textContent = syncState.message;
    }
    if (listEmptyTitle) listEmptyTitle.textContent = syncState.title;
    if (listEmptyMessage) listEmptyMessage.textContent = syncState.message;
    statusBadge.textContent = syncState.badge;
    statusBadge.className = syncState.badgeClass;
    emptyActionBtn.textContent = syncState.actionLabel || "";
    emptyActionBtn.classList.toggle("hidden", !syncState.action);
    emptyActionBtn.dataset.action = syncState.action || "";
    listEmptyActionBtn.textContent = syncState.actionLabel || "";
    listEmptyActionBtn.classList.toggle("hidden", !syncState.action);
    listEmptyActionBtn.dataset.action = syncState.action || "";
    taskList.replaceChildren();
    return;
  }
  selectedTaskId = task.id;
  const currentTaskRunning = task.status === "running";

  taskDetails.classList.toggle("hidden", !isDetail);
  emptyState.classList.add("hidden");
  listEmptyState.classList.add("hidden");

  if (!isDetail) {
    statusBadge.textContent = isSettings
      ? profileStatusText()
      : `${state.tasks?.length || 0} task${state.tasks?.length === 1 ? "" : "s"}`;
    statusBadge.className = "badge";
  } else {
    statusBadge.textContent = readableStatus(task.status);
    statusBadge.className = `badge ${task.status}`;
  }

  if (isDetail && !promptDirty && document.activeElement !== taskPrompt) {
    taskPrompt.value = task.prompt || "";
    lastRenderedPrompt = taskPrompt.value;
  }

  const canEdit = ["pending", "approved", "failed", "stopped"].includes(task.status);
  taskPrompt.disabled = !canEdit;
  approveBtn.disabled = runInProgress || !["pending", "approved", "failed", "stopped"].includes(task.status);
  stopBtn.disabled = !currentTaskRunning;
  newTaskBtn.disabled = runInProgress;
  refreshTasksBtn.disabled = runInProgress || refreshInProgress;

  taskList.replaceChildren(
    ...(state.tasks || []).map((item) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      const title = document.createElement("strong");
      const meta = document.createElement("span");

      button.type = "button";
      button.className = "task-card";
      title.textContent = taskPreview(item);
      meta.textContent = `${readableStatus(item.status)} · ${timeAgo(new Date(item.updatedAt || item.createdAt))}`;
      button.append(title, meta);
      button.addEventListener("click", async () => {
        setScreen("detail");
        promptDirty = false;
        render(await window.penutOperator.selectTask(item.id));
      });
      li.append(button);
      return li;
    }),
  );

  const events = task.events || [];
  emptyActivity.classList.toggle("hidden", events.length > 0);
  eventList.replaceChildren(
    ...events.map((event) => {
      const item = document.createElement("li");
      const row = document.createElement("div");
      const message = document.createElement("p");
      const time = document.createElement("time");
      const detail = document.createElement("small");

      message.textContent = friendlyEventMessage(event);
      time.textContent = timeAgo(new Date(event.at));
      detail.textContent = friendlyEventDetail(event);

      row.append(message, time);
      item.append(row);
      if (detail.textContent) item.append(detail);
      return item;
    }),
  );
}

function describeSyncState(state) {
  if (!state?.syncError) {
    return {
      title: "No approvals",
      message: "No approved browser tasks are assigned to you yet.",
      badge: "No tasks",
      badgeClass: "badge",
      action: null,
      actionLabel: "",
    };
  }

  if (state.syncErrorReason === "auth_required") {
    return {
      title: "Sign in to Penut",
      message: state.syncError,
      badge: "Sign in needed",
      badgeClass: "badge approved",
      action: "sign_in",
      actionLabel: "Sign in to Penut",
    };
  }

  return {
    title: "Cannot load approvals",
    message: state.syncError,
    badge: "Connection issue",
    badgeClass: "badge failed",
    action: "refresh",
    actionLabel: "Try again",
  };
}

function renderSettings(settingsPayload) {
  currentSettings = settingsPayload.settings;
  currentAuth = settingsPayload.auth || null;
  chromeProfileData = settingsPayload.chromeProfiles;
  currentReadiness = settingsPayload.readiness || { ready: false, checks: [] };
  const profiles = chromeProfileData.profiles || [];

  chromeProfileSelect.replaceChildren(
    ...profiles.map((profile) => {
      const option = document.createElement("option");
      option.value = profile.directory;
      option.textContent = profile.email ? `${profile.name} (${profile.email})` : profile.name;
      return option;
    }),
  );

  if (currentSettings.chromeProfileDirectory) {
    chromeProfileSelect.value = currentSettings.chromeProfileDirectory;
  }

  chromeProfileSelect.disabled = profiles.length === 0;
  saveSettingsBtn.disabled = profiles.length === 0;
  profileHelp.textContent = profiles.length
    ? `Operator will use Chrome profile data from ${chromeProfileData.userDataDir}.`
    : "No Chrome profiles were found on this computer.";

  renderAuthState();

  readinessList.replaceChildren(
    ...currentReadiness.checks.map((check) => {
      const item = document.createElement("li");
      const state = document.createElement("span");
      const body = document.createElement("div");
      const label = document.createElement("strong");
      const message = document.createElement("small");

      item.className = check.ready ? "ready" : "needs-setup";
      state.textContent = check.ready ? "Ready" : "Needs setup";
      label.textContent = check.label;
      message.textContent = check.message;
      body.append(label, message);
      item.append(body, state);
      return item;
    }),
  );
}

function renderAuthState(input = {}) {
  const options = typeof input === "string" ? { message: input, state: "error" } : input;
  const penut = currentReadiness.checks.find((check) => check.id === "penutConnection");
  const signedIn = Boolean(penut?.ready);
  const state = options.state || (signedIn ? "connected" : "idle");
  const waiting = state === "waiting";
  const error = state === "error";
  const expiresAt = options.expiresAt ? new Date(options.expiresAt) : null;
  const expiresText =
    expiresAt instanceof Date && !Number.isNaN(expiresAt.getTime())
      ? ` ${formatExpiry(expiresAt)}`
      : "";

  authCard.classList.toggle("waiting", waiting);
  authCard.classList.toggle("connected", state === "connected");
  authCard.classList.toggle("error", error);
  authHelp.textContent =
    options.message ||
    currentAuth?.label ||
    penut?.message ||
    "Sign in to load and run your assigned browser tasks.";
  if (waiting) {
    authHelp.textContent =
      `${options.message || "Waiting for browser approval. Return here after you click Connect Operator."}${expiresText}`;
  }

  authCode.textContent = options.userCode ? `Code: ${options.userCode}` : "";
  authCode.classList.toggle("hidden", !options.userCode || !waiting);

  signInBtn.classList.toggle("hidden", signedIn);
  signOutBtn.classList.toggle("hidden", !signedIn);
  reopenAuthBtn.classList.toggle("hidden", !waiting || !options.verificationUrl);
  cancelAuthBtn.classList.toggle("hidden", !waiting);
  signInBtn.disabled = waiting;
  signOutBtn.disabled = false;
}

function formatExpiry(date) {
  const ms = date.getTime() - Date.now();
  if (ms <= 0) return "This sign-in has expired.";
  const mins = Math.max(1, Math.ceil(ms / 60000));
  return `Expires in ${mins} minute${mins === 1 ? "" : "s"}.`;
}

function profileStatusText() {
  if (!currentSettings?.chromeProfileDirectory) return "Setup needed";
  return currentSettings.chromeProfileName || currentSettings.chromeProfileDirectory;
}

function userFacingError(error, fallback = "Something went wrong. Try again.") {
  const message = String(error?.message || error || "");
  if (/Error invoking remote method/i.test(message)) return fallback;
  if (/Penut request failed \(404\)|not found/i.test(message)) {
    return "This Penut server does not support that Operator action yet. Update the server, then try again.";
  }
  if (/Penut request failed \(\d+\)/i.test(message)) {
    return "Penut could not complete that request. Try again in a moment.";
  }
  if (/fetch failed|network|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(message)) {
    return "Cannot reach Penut right now. Check your connection and try again.";
  }
  return message || fallback;
}

async function refresh() {
  if (!window.penutOperator) {
    throw new Error("Operator preload did not initialize.");
  }
  renderSettings(await window.penutOperator.getSettings());
  render(await window.penutOperator.getTask());
  await resumePendingSignIn();
}

async function refreshTasks() {
  if (!window.penutOperator || refreshInProgress) return;
  refreshInProgress = true;
  refreshTasksBtn.disabled = true;
  try {
    render(await window.penutOperator.getTask());
  } finally {
    refreshInProgress = false;
    refreshTasksBtn.disabled = false;
  }
}

taskPrompt.addEventListener("input", () => {
  promptDirty = true;
});

newTaskBtn.addEventListener("click", async () => {
  setScreen("detail");
  promptDirty = false;
  render(await window.penutOperator.createTask(""));
  taskPrompt.focus();
});

backBtn.addEventListener("click", () => {
  setScreen("list");
  promptDirty = false;
  render(currentState);
});

refreshTasksBtn.addEventListener("click", refreshTasks);

approvalsNavBtn.addEventListener("click", () => {
  setScreen("list");
  promptDirty = false;
  render(currentState);
});

settingsNavBtn.addEventListener("click", async () => {
  setScreen("settings");
  renderSettings(await window.penutOperator.getSettings());
  render(currentState);
});

saveSettingsBtn.addEventListener("click", async () => {
  const directory = chromeProfileSelect.value;
  const profile = (chromeProfileData.profiles || []).find((item) => item.directory === directory);
  renderSettings(await window.penutOperator.updateSettings({
    chromeUserDataDir: chromeProfileData.userDataDir,
    chromeProfileDirectory: directory,
    chromeProfileName: profile?.name || directory,
  }));
  render(await window.penutOperator.getTask());
  statusBadge.textContent = "Profile saved";
  statusBadge.className = "badge completed";
});

async function startSignIn() {
  signInBtn.disabled = true;
  emptyActionBtn.disabled = true;
  listEmptyActionBtn.disabled = true;
  renderAuthState({ state: "waiting", message: "Opening the browser approval page..." });
  try {
    const auth = await window.penutOperator.startAuth();
    if (!auth.ok) {
      currentPendingAuth = null;
      renderAuthState({ state: "error", message: auth.error || "Could not start sign-in. Try again." });
      signInBtn.disabled = false;
      emptyActionBtn.disabled = false;
      listEmptyActionBtn.disabled = false;
      return;
    }
    currentPendingAuth = auth;
    renderAuthState({
      state: "waiting",
      message: "Waiting for browser approval. Click Connect Operator in the browser, then return here.",
      userCode: auth.userCode,
      verificationUrl: auth.verificationUrl,
      expiresAt: auth.expiresAt,
    });
    startAuthPolling(auth);
  } catch (error) {
    currentPendingAuth = null;
    renderAuthState({ state: "error", message: userFacingError(error, "Could not start sign-in. Try again.") });
    signInBtn.disabled = false;
    emptyActionBtn.disabled = false;
    listEmptyActionBtn.disabled = false;
  }
}

signInBtn.addEventListener("click", startSignIn);

reopenAuthBtn.addEventListener("click", async () => {
  const result = await window.penutOperator.openPendingAuth();
  if (!result.ok) {
    renderAuthState({ state: "error", message: result.error || "Could not open the approval page. Start sign-in again." });
  }
});

cancelAuthBtn.addEventListener("click", async () => {
  stopAuthPolling();
  currentPendingAuth = null;
  renderSettings(await window.penutOperator.cancelAuth());
});

emptyActionBtn.addEventListener("click", async () => {
  await handleEmptyAction(emptyActionBtn.dataset.action);
});

listEmptyActionBtn.addEventListener("click", async () => {
  await handleEmptyAction(listEmptyActionBtn.dataset.action);
});

async function handleEmptyAction(action) {
  if (action === "sign_in") {
    setScreen("settings");
    renderSettings(await window.penutOperator.getSettings());
    render(currentState);
    await startSignIn();
    return;
  }
  if (action === "refresh") {
    await refreshTasks();
  }
}

signOutBtn.addEventListener("click", async () => {
  signOutBtn.disabled = true;
  stopAuthPolling();
  currentPendingAuth = null;
  renderSettings(await window.penutOperator.logoutAuth());
  render(await window.penutOperator.getTask());
});

async function resumePendingSignIn() {
  const pending = await window.penutOperator.getPendingAuth();
  if (!pending.pending || authPollTimer) return;
  currentPendingAuth = pending;
  renderAuthState({
    state: "waiting",
    message: "Still waiting for browser approval. If the browser tab closed, open it again.",
    userCode: pending.userCode,
    verificationUrl: pending.verificationUrl,
    expiresAt: pending.expiresAt,
  });
  startAuthPolling(pending);
}

function startAuthPolling(pending = {}) {
  stopAuthPolling();
  const poll = async () => {
    try {
      const result = await window.penutOperator.pollAuth();
      if (result.pending) return;
      stopAuthPolling();
      if (result.authenticated && result.settings) {
        currentPendingAuth = null;
        renderSettings(result.settings);
        render(await window.penutOperator.getTask());
        statusBadge.textContent = "Signed in";
        statusBadge.className = "badge completed";
        return;
      }
      currentPendingAuth = null;
      renderAuthState({ state: "error", message: result.error || "Sign-in was not completed. Try again." });
    } catch (error) {
      stopAuthPolling();
      renderAuthState({ state: "error", message: userFacingError(error, "Could not finish sign-in. Try again.") });
    }
  };
  authPollTimer = setInterval(poll, 2500);
  void poll();
}

function stopAuthPolling() {
  if (!authPollTimer) return;
  clearInterval(authPollTimer);
  authPollTimer = null;
}

approveBtn.addEventListener("click", async () => {
  if (runInProgress) return;
  runInProgress = true;
  approveBtn.disabled = true;
  try {
    const prompt = taskPrompt.value.trim();
    if (!prompt) return;
    taskPrompt.value = prompt;
    lastRenderedPrompt = prompt;
    promptDirty = false;
    const result = await window.penutOperator.runAgent(prompt);
    if (result.state) render(result.state);
    if (!result.ok && result.error) {
      statusBadge.textContent = userFacingError(result.error, "Operator could not run this task.");
      statusBadge.className = "badge failed";
      if (/before running tasks|setup|install|model access/i.test(result.error)) {
        setScreen("settings");
        renderSettings(await window.penutOperator.getSettings());
        render(currentState);
      }
    }
  } finally {
    runInProgress = false;
    render(await window.penutOperator.getTask());
  }
});

stopBtn.addEventListener("click", async () => {
  const result = await window.penutOperator.stopAgent();
  if (result.state) render(result.state);
});

if (window.penutOperator) window.penutOperator.onTaskChanged(render);
window.addEventListener("focus", () => {
  void resumePendingSignIn();
  void refreshTasks();
});
setInterval(() => {
  if (document.visibilityState === "visible" && currentScreen === "list") {
    void resumePendingSignIn();
    void refreshTasks();
  }
}, 15000);
refresh().catch((error) => {
  statusBadge.textContent = userFacingError(error, "Operator could not load.");
  statusBadge.className = "badge failed";
});
