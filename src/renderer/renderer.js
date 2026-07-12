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
const runSelectedBtn = document.querySelector("#runSelectedBtn");
const selectionHelp = document.querySelector("#selectionHelp");
const backBtn = document.querySelector("#backBtn");
const tasksNavBtn = document.querySelector("#tasksNavBtn");
const settingsNavBtn = document.querySelector("#settingsNavBtn");
const chromeProfileSelect = document.querySelector("#chromeProfileSelect");
const profileHelp = document.querySelector("#profileHelp");
const saveSettingsBtn = document.querySelector("#saveSettingsBtn");
const readinessList = document.querySelector("#readinessList");
const runtimeRepairActions = document.querySelector("#runtimeRepairActions");
const repairRuntimeBtn = document.querySelector("#repairRuntimeBtn");
const saveTaskBtn = document.querySelector("#saveTaskBtn");
const approveBtn = document.querySelector("#approveBtn");
const stopBtn = document.querySelector("#stopBtn");
let runInProgress = false;
let lastRenderedPrompt = "";
let promptDirty = false;
let currentState;
let selectedTaskId;
let currentScreen = "list";
let currentSettings;
let chromeProfileData = { userDataDir: "", profiles: [] };
let currentReadiness = { ready: false, checks: [] };
let refreshInProgress = false;
let selectedRunTaskIds = new Set();

function humanStatus(status) {
  return String(status || "unknown").replaceAll("_", " ");
}

function readableStatus(status) {
  const normalized = String(status || "unknown");
  const map = {
    draft: "Draft",
    pending: "Draft",
    approved: "Ready",
    running: "Working",
    completed: "Done",
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
    "Browser-use worker failed.": "Task could not finish",
    "Browser worker ready.": "Browser is ready",
    "Opening Chrome.": "Opening Chrome",
    "Starting task.": "Starting task",
  };
  return map[event?.message] || event?.message || "Update";
}

function friendlyEventDetail(event) {
  const detail = event?.detail;
  if (!detail || typeof detail !== "object") return "";
  if (detail.error) return friendlyActivityDetail(detail.error);
  if (detail.reason) return friendlyActivityDetail(detail.reason);
  return "";
}

function friendlyActivityDetail(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (/one or more files are locked|close any chrome windows|chrome profile/i.test(text)) {
    return "Chrome is already using this profile. Close Chrome completely, then try again.";
  }
  if (/payload too large|request entity too large/i.test(text)) {
    return "The task was too large to process. Try making the request shorter.";
  }
  if (/browser-use|worker|traceback|runtimeerror|file \"|python/i.test(text)) {
    return "Operator could not complete the browser task. Try again, or restart Operator if it keeps happening.";
  }
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function selectedTask(state) {
  return state?.tasks?.find((task) => task.id === state.selectedTaskId) || state?.tasks?.[0];
}

function taskCanRun(task) {
  return ["approved", "failed", "stopped", "expired", "pending"].includes(task?.status);
}

function taskPreview(task) {
  const prompt = String(task?.prompt || "").trim();
  if (!prompt) return "Untitled task";
  return prompt.length > 72 ? `${prompt.slice(0, 69)}...` : prompt;
}

function setScreen(screen) {
  currentScreen = screen;
  tasksNavBtn.classList.toggle("active", screen !== "settings");
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
    const emptyTitle = emptyState.querySelector("h2");
    const emptyMessage = emptyState.querySelector("p");
    const listEmptyTitle = listEmptyState.querySelector("h3");
    const listEmptyMessage = listEmptyState.querySelector("p");
    if (emptyTitle) emptyTitle.textContent = "No tasks yet";
    if (emptyMessage) {
      emptyMessage.textContent = "Create a task, describe what should happen in the browser, then run it.";
    }
    if (listEmptyTitle) listEmptyTitle.textContent = "No tasks yet";
    if (listEmptyMessage) {
      listEmptyMessage.textContent = "Create a task, describe what should happen in the browser, then run it.";
    }
    statusBadge.textContent = isSettings ? profileStatusText() : "No tasks";
    statusBadge.className = "badge";
    emptyActionBtn.textContent = "New task";
    emptyActionBtn.classList.remove("hidden");
    emptyActionBtn.disabled = false;
    listEmptyActionBtn.textContent = "New task";
    listEmptyActionBtn.classList.remove("hidden");
    listEmptyActionBtn.disabled = false;
    taskList.replaceChildren();
    selectedRunTaskIds.clear();
    runSelectedBtn.disabled = true;
    newTaskBtn.disabled = runInProgress;
    refreshTasksBtn.disabled = refreshInProgress;
    selectionHelp.textContent = "Create a task to get started.";
    return;
  }

  selectedTaskId = task.id;
  const currentTaskRunning = task.status === "running";
  const runnableTasks = (state.tasks || []).filter(taskCanRun);
  selectedRunTaskIds = new Set(
    [...selectedRunTaskIds].filter((taskId) => runnableTasks.some((item) => item.id === taskId)),
  );
  const selectedRunCount = selectedRunTaskIds.size;

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
  saveTaskBtn.disabled = runInProgress || !canEdit || !promptDirty;
  approveBtn.disabled = runInProgress || !["pending", "approved", "failed", "stopped"].includes(task.status);
  stopBtn.disabled = !currentTaskRunning;
  newTaskBtn.disabled = runInProgress;
  runSelectedBtn.disabled = runInProgress || selectedRunCount === 0;
  runSelectedBtn.textContent =
    selectedRunCount > 1 ? `Run ${selectedRunCount} selected` : "Run selected";
  selectionHelp.textContent = selectedRunCount
    ? `${selectedRunCount} task${selectedRunCount === 1 ? "" : "s"} selected. Operator will run them one after another.`
    : runnableTasks.length
      ? "Select ready tasks to run them one after another."
      : "No ready tasks are available to run.";
  refreshTasksBtn.disabled = runInProgress || refreshInProgress;

  taskList.replaceChildren(
    ...(state.tasks || []).map((item) => {
      const li = document.createElement("li");
      const card = document.createElement("article");
      const row = document.createElement("div");
      const checkbox = document.createElement("input");
      const title = document.createElement("strong");
      const openButton = document.createElement("button");
      const meta = document.createElement("span");
      const canRun = taskCanRun(item);

      card.className = "task-card";
      card.tabIndex = canRun && !runInProgress ? 0 : -1;
      card.role = canRun ? "checkbox" : "group";
      card.ariaChecked = canRun ? String(selectedRunTaskIds.has(item.id)) : undefined;
      card.classList.toggle("selected-for-run", selectedRunTaskIds.has(item.id));
      checkbox.type = "checkbox";
      checkbox.checked = selectedRunTaskIds.has(item.id);
      checkbox.disabled = runInProgress || !canRun;
      checkbox.ariaLabel = `Select ${taskPreview(item)} to run`;
      title.className = "task-card-title";
      title.textContent = taskPreview(item);
      openButton.type = "button";
      openButton.className = "task-open-button";
      openButton.textContent = "Open";
      meta.textContent = `${readableStatus(item.status)} · ${timeAgo(new Date(item.updatedAt || item.createdAt))}`;
      row.className = "task-card-row";
      row.append(checkbox, title, openButton);
      card.append(row, meta);
      checkbox.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!canRun) return;
        if (checkbox.checked) selectedRunTaskIds.add(item.id);
        else selectedRunTaskIds.delete(item.id);
        render(currentState);
      });
      openButton.addEventListener("click", async (event) => {
        event.stopPropagation();
        setScreen("detail");
        promptDirty = false;
        render(await window.browserOperator.selectTask(item.id));
      });
      card.addEventListener("click", () => {
        if (runInProgress || !canRun) return;
        if (selectedRunTaskIds.has(item.id)) selectedRunTaskIds.delete(item.id);
        else selectedRunTaskIds.add(item.id);
        render(currentState);
      });
      card.addEventListener("keydown", (event) => {
        if (!["Enter", " "].includes(event.key) || runInProgress || !canRun) return;
        event.preventDefault();
        if (selectedRunTaskIds.has(item.id)) selectedRunTaskIds.delete(item.id);
        else selectedRunTaskIds.add(item.id);
        render(currentState);
      });
      li.append(card);
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

function renderSettings(settingsPayload) {
  currentSettings = settingsPayload.settings;
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

  const runtimeNeedsRepair = currentReadiness.checks.some((check) =>
    ["pythonWorker", "workerScript", "automationEngine"].includes(check.id) &&
    !check.ready
  );
  runtimeRepairActions.classList.toggle("hidden", !runtimeNeedsRepair);
  repairRuntimeBtn.disabled = !runtimeNeedsRepair;

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

function profileStatusText() {
  if (!currentSettings?.chromeProfileDirectory) return "Setup needed";
  return currentSettings.chromeProfileName || currentSettings.chromeProfileDirectory;
}

function userFacingError(error, fallback = "Something went wrong. Try again.") {
  const message = String(error?.message || error || "");
  if (/Error invoking remote method/i.test(message)) return fallback;
  if (/OPENAI_API_KEY|model access/i.test(message)) {
    return "Add OPENAI_API_KEY to your .env file, then restart Operator.";
  }
  return message || fallback;
}

async function refresh() {
  if (!window.browserOperator) {
    throw new Error("Operator preload did not initialize.");
  }
  renderSettings(await window.browserOperator.getSettings());
  render(await window.browserOperator.getTask());
}

async function refreshTasks() {
  if (!window.browserOperator || refreshInProgress) return;
  refreshInProgress = true;
  refreshTasksBtn.disabled = true;
  try {
    render(await window.browserOperator.getTask());
  } finally {
    refreshInProgress = false;
    refreshTasksBtn.disabled = false;
  }
}

async function createNewTask() {
  setScreen("detail");
  promptDirty = false;
  render(await window.browserOperator.createTask(""));
  taskPrompt.focus();
}

taskPrompt.addEventListener("input", () => {
  promptDirty = true;
});

newTaskBtn.addEventListener("click", createNewTask);
listEmptyActionBtn.addEventListener("click", createNewTask);
emptyActionBtn.addEventListener("click", createNewTask);

backBtn.addEventListener("click", () => {
  setScreen("list");
  promptDirty = false;
  render(currentState);
});

refreshTasksBtn.addEventListener("click", refreshTasks);

runSelectedBtn.addEventListener("click", async () => {
  if (runInProgress || selectedRunTaskIds.size === 0) return;
  runInProgress = true;
  runSelectedBtn.disabled = true;
  try {
    const orderedTaskIds = (currentState?.tasks || [])
      .filter((task) => selectedRunTaskIds.has(task.id) && taskCanRun(task))
      .map((task) => task.id);
    const result = await window.browserOperator.runTasks(orderedTaskIds, {});
    selectedRunTaskIds.clear();
    if (result.state) render(result.state);
    if (!result.ok && result.error) {
      statusBadge.textContent = userFacingError(result.error, "Operator could not run the selected tasks.");
      statusBadge.className = "badge failed";
      if (/before running tasks|setup|install|model access|OPENAI_API_KEY|Chrome profile/i.test(result.error)) {
        setScreen("settings");
        renderSettings(await window.browserOperator.getSettings());
        render(currentState);
      }
    }
  } finally {
    runInProgress = false;
    render(await window.browserOperator.getTask());
  }
});

tasksNavBtn.addEventListener("click", () => {
  setScreen("list");
  promptDirty = false;
  render(currentState);
});

settingsNavBtn.addEventListener("click", async () => {
  setScreen("settings");
  renderSettings(await window.browserOperator.getSettings());
  render(currentState);
});

saveSettingsBtn.addEventListener("click", async () => {
  const directory = chromeProfileSelect.value;
  const profile = (chromeProfileData.profiles || []).find((item) => item.directory === directory);
  renderSettings(await window.browserOperator.updateSettings({
    chromeUserDataDir: chromeProfileData.userDataDir,
    chromeProfileDirectory: directory,
    chromeProfileName: profile?.name || directory,
  }));
  render(await window.browserOperator.getTask());
  statusBadge.textContent = "Profile saved";
  statusBadge.className = "badge completed";
});

repairRuntimeBtn.addEventListener("click", async () => {
  repairRuntimeBtn.disabled = true;
  repairRuntimeBtn.textContent = "Repairing...";
  statusBadge.textContent = "Repairing runtime";
  statusBadge.className = "badge approved";
  try {
    const result = await window.browserOperator.repairRuntime();
    if (result.settings) renderSettings(result.settings);
    if (!result.ok) {
      statusBadge.textContent = userFacingError(result.error, "Operator could not repair the runtime.");
      statusBadge.className = "badge failed";
      return;
    }
    statusBadge.textContent = "Runtime repaired";
    statusBadge.className = "badge completed";
  } catch (error) {
    statusBadge.textContent = userFacingError(error, "Operator could not repair the runtime.");
    statusBadge.className = "badge failed";
  } finally {
    repairRuntimeBtn.textContent = "Repair runtime";
    renderSettings(await window.browserOperator.getSettings());
  }
});

saveTaskBtn.addEventListener("click", async () => {
  if (runInProgress) return;
  const prompt = taskPrompt.value.trim();
  if (!prompt) return;
  taskPrompt.value = prompt;
  lastRenderedPrompt = prompt;
  promptDirty = false;
  saveTaskBtn.disabled = true;
  render(await window.browserOperator.updateTask({ prompt }));
  statusBadge.textContent = "Changes saved";
  statusBadge.className = "badge completed";
});

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
    const result = await window.browserOperator.runAgent(prompt);
    if (result.state) render(result.state);
    if (!result.ok && result.error) {
      statusBadge.textContent = userFacingError(result.error, "Operator could not run this task.");
      statusBadge.className = "badge failed";
      if (/before running tasks|setup|install|model access|OPENAI_API_KEY|Chrome profile/i.test(result.error)) {
        setScreen("settings");
        renderSettings(await window.browserOperator.getSettings());
        render(currentState);
      }
    }
  } finally {
    runInProgress = false;
    render(await window.browserOperator.getTask());
  }
});

stopBtn.addEventListener("click", async () => {
  const result = await window.browserOperator.stopAgent();
  if (result.state) render(result.state);
});

if (window.browserOperator) window.browserOperator.onTaskChanged(render);
refresh().catch((error) => {
  statusBadge.textContent = userFacingError(error, "Operator could not load.");
  statusBadge.className = "badge failed";
});
