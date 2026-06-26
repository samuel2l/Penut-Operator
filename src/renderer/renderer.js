const taskPrompt = document.querySelector("#taskPrompt");
const statusBadge = document.querySelector("#statusBadge");
const eventList = document.querySelector("#eventList");
const saveBtn = document.querySelector("#saveBtn");
const resetBtn = document.querySelector("#resetBtn");
const approveBtn = document.querySelector("#approveBtn");
const runBtn = document.querySelector("#runBtn");
const stopBtn = document.querySelector("#stopBtn");

function humanStatus(status) {
  return String(status || "unknown").replaceAll("_", " ");
}

function render(task) {
  taskPrompt.value = task.prompt || "";
  statusBadge.textContent = humanStatus(task.status);
  statusBadge.className = `badge ${task.status}`;

  const canEdit = ["pending", "approved", "failed", "stopped"].includes(task.status);
  taskPrompt.disabled = !canEdit;
  saveBtn.disabled = !canEdit;
  approveBtn.disabled = task.status !== "pending";
  runBtn.disabled = !["approved", "failed"].includes(task.status);
  stopBtn.disabled = task.status !== "running";

  eventList.replaceChildren(
    ...(task.events || []).map((event) => {
      const item = document.createElement("li");
      const message = document.createElement("p");
      const time = document.createElement("time");
      const detail = document.createElement("small");

      message.textContent = event.message;
      time.textContent = new Date(event.at).toLocaleString();
      detail.textContent = event.detail ? JSON.stringify(event.detail) : "";

      item.append(message, time);
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
  render(await window.penutOperator.approveTask());
});

runBtn.addEventListener("click", async () => {
  const result = await window.penutOperator.runAgent();
  if (result.task) render(result.task);
  if (!result.ok && result.error) {
    statusBadge.textContent = result.error;
    statusBadge.className = "badge failed";
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
