const statusBadge = document.querySelector("#statusBadge");
const taskTitle = document.querySelector("#taskTitle");
const taskContext = document.querySelector("#taskContext");
const requestedBy = document.querySelector("#requestedBy");
const accountOwner = document.querySelector("#accountOwner");
const targetLink = document.querySelector("#targetLink");
const riskLevel = document.querySelector("#riskLevel");
const messageDraft = document.querySelector("#messageDraft");
const eventList = document.querySelector("#eventList");
const saveBtn = document.querySelector("#saveBtn");
const resetBtn = document.querySelector("#resetBtn");
const approveBtn = document.querySelector("#approveBtn");
const rejectBtn = document.querySelector("#rejectBtn");
const runBtn = document.querySelector("#runBtn");

let currentTask = null;

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}

function humanStatus(status) {
  return String(status || "unknown").replaceAll("_", " ");
}

function eventDetailText(item) {
  const detail = item.detail;
  if (!detail || typeof detail !== "object") return "";

  if (detail.error) return detail.error;
  if (detail.debug?.url) {
    return [
      `Page: ${detail.debug.url}`,
      `Visible candidates: ${detail.debug.visibleCandidateCount ?? 0}`,
    ].join(" | ");
  }
  if (detail.prepared) return "Draft was inserted; final send was not clicked.";
  return "";
}

function render(task) {
  currentTask = task;
  statusBadge.textContent = humanStatus(task.status);
  statusBadge.className = `badge ${task.status}`;
  taskTitle.textContent = `${task.action.replaceAll("_", " ")} on ${task.platform}`;
  taskContext.textContent = task.context || "";
  requestedBy.textContent = task.requestedBy || "-";
  accountOwner.textContent = task.accountOwner || "-";
  targetLink.textContent = task.target?.name || task.target?.profileUrl || "-";
  targetLink.href = task.target?.profileUrl || "#";
  riskLevel.textContent = task.riskLevel || "-";
  messageDraft.value = task.messageDraft || "";

  const canEdit = task.status === "pending" || task.status === "approved_waiting_for_run";
  saveBtn.disabled = !canEdit;
  approveBtn.disabled = task.status !== "pending";
  rejectBtn.disabled = !["pending", "approved_waiting_for_run"].includes(task.status);
  runBtn.disabled = !["approved_waiting_for_run", "failed", "needs_manual_paste"].includes(
    task.status,
  );

  eventList.replaceChildren(
    ...(task.events || []).map((item) => {
      const li = document.createElement("li");
      const p = document.createElement("p");
      const time = document.createElement("time");
      const detail = document.createElement("small");
      p.textContent = item.message;
      time.textContent = new Date(item.at).toLocaleString();
      detail.textContent = eventDetailText(item);
      li.append(p, time);
      if (detail.textContent) li.append(detail);
      return li;
    }),
  );
}

async function refresh() {
  const { task } = await api("/api/task");
  render(task);
}

saveBtn.addEventListener("click", async () => {
  const { task } = await api("/api/task/update", {
    method: "POST",
    body: JSON.stringify({ messageDraft: messageDraft.value }),
  });
  render(task);
});

resetBtn.addEventListener("click", async () => {
  const { task } = await api("/api/task/reset", { method: "POST" });
  render(task);
});

approveBtn.addEventListener("click", async () => {
  const { task } = await api("/api/task/approve", { method: "POST" });
  render(task);
});

rejectBtn.addEventListener("click", async () => {
  const { task } = await api("/api/task/reject", { method: "POST" });
  render(task);
});

runBtn.addEventListener("click", async () => {
  const { task } = await api("/api/task/run", { method: "POST" });
  render(task);
});

setInterval(refresh, 2500);
refresh().catch((error) => {
  statusBadge.textContent = error.message;
  statusBadge.className = "badge failed";
});
