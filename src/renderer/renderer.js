const taskPrompt = document.querySelector("#taskPrompt");
const statusBadge = document.querySelector("#statusBadge");
const eventList = document.querySelector("#eventList");
const saveBtn = document.querySelector("#saveBtn");
const resetBtn = document.querySelector("#resetBtn");
const approveBtn = document.querySelector("#approveBtn");
const stopBtn = document.querySelector("#stopBtn");
let runInProgress = false;

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
    "Loaded sample browser task seed.": "Loaded sample task",
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

function render(task) {
  taskPrompt.value = task.prompt || "";
  statusBadge.textContent = readableStatus(task.status);
  statusBadge.className = `badge ${task.status}`;

  const canEdit = ["pending", "approved", "failed", "stopped"].includes(task.status);
  taskPrompt.disabled = !canEdit;
  saveBtn.disabled = !canEdit;
  approveBtn.disabled = !["pending", "failed", "stopped"].includes(task.status);
  stopBtn.disabled = task.status !== "running";

  eventList.replaceChildren(
    ...(task.events || []).map((event) => {
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

async function refresh() {
  if (!window.penutOperator) {
    throw new Error("Operator preload did not initialize.");
  }
  render(await window.penutOperator.getTask());
}

saveBtn.addEventListener("click", async () => {
  render(
    await window.penutOperator.updateTask({
      prompt: taskPrompt.value,
    }),
  );
});

resetBtn.addEventListener("click", async () => {
  render(await window.penutOperator.resetTask());
});

approveBtn.addEventListener("click", async () => {
  if (runInProgress) return;
  runInProgress = true;
  approveBtn.disabled = true;
  try {
    const result = await window.penutOperator.runAgent();
    if (result.task) render(result.task);
    if (!result.ok && result.error) {
      statusBadge.textContent = result.error;
      statusBadge.className = "badge failed";
    }
  } finally {
    runInProgress = false;
    render(await window.penutOperator.getTask());
  }
});

stopBtn.addEventListener("click", async () => {
  const result = await window.penutOperator.stopAgent();
  if (result.task) render(result.task);
});

if (window.penutOperator) window.penutOperator.onTaskChanged(render);
refresh().catch((error) => {
  statusBadge.textContent = error.message;
  statusBadge.className = "badge failed";
});
