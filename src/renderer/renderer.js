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
const signInBtn = document.querySelector("#signInBtn");
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

function renderAuthState(message) {
  const penut = currentReadiness.checks.find((check) => check.id === "penutConnection");
  const signedIn = Boolean(penut?.ready);
  authHelp.textContent =
    message ||
    currentAuth?.label ||
    penut?.message ||
    "Sign in to load and run your assigned browser tasks.";
  signInBtn.classList.toggle("hidden", signedIn);
  signOutBtn.classList.toggle("hidden", !signedIn);
  signInBtn.disabled = false;
  signOutBtn.disabled = false;
}

function profileStatusText() {
  if (!currentSettings?.chromeProfileDirectory) return "Setup needed";
  return currentSettings.chromeProfileName || currentSettings.chromeProfileDirectory;
}

async function refresh() {
  if (!window.penutOperator) {
    throw new Error("Operator preload did not initialize.");
  }
  renderSettings(await window.penutOperator.getSettings());
  render(await window.penutOperator.getTask());
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
  try {
    const auth = await window.penutOperator.startAuth();
    const codeText = auth.userCode ? ` Code: ${auth.userCode}` : "";
    renderAuthState(`Finish signing in from the browser window.${codeText}`);
    startAuthPolling();
  } catch (error) {
    renderAuthState(error.message || "Could not start sign-in. Try again.");
    signInBtn.disabled = false;
    emptyActionBtn.disabled = false;
    listEmptyActionBtn.disabled = false;
  }
}

signInBtn.addEventListener("click", startSignIn);

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
  renderSettings(await window.penutOperator.logoutAuth());
  render(await window.penutOperator.getTask());
});

function startAuthPolling() {
  stopAuthPolling();
  authPollTimer = setInterval(async () => {
    try {
      const result = await window.penutOperator.pollAuth();
      if (result.pending) return;
      stopAuthPolling();
      if (result.authenticated && result.settings) {
        renderSettings(result.settings);
        render(await window.penutOperator.getTask());
        statusBadge.textContent = "Signed in";
        statusBadge.className = "badge completed";
        return;
      }
      renderAuthState(result.error || "Sign-in was not completed. Try again.");
    } catch (error) {
      stopAuthPolling();
      renderAuthState(error.message || "Could not finish sign-in. Try again.");
    }
  }, 2500);
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
      statusBadge.textContent = result.error;
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
window.addEventListener("focus", refreshTasks);
setInterval(() => {
  if (document.visibilityState === "visible" && currentScreen === "list") {
    void refreshTasks();
  }
}, 15000);
refresh().catch((error) => {
  statusBadge.textContent = error.message;
  statusBadge.className = "badge failed";
});
