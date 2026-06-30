const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("penutOperator", {
  getTask: () => ipcRenderer.invoke("tasks:get"),
  selectTask: (taskId) => ipcRenderer.invoke("tasks:select", taskId),
  createTask: (prompt) => ipcRenderer.invoke("tasks:create", prompt),
  updateTask: (patch) => ipcRenderer.invoke("tasks:update", patch),
  approveTask: () => ipcRenderer.invoke("tasks:approve"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (patch) => ipcRenderer.invoke("settings:update", patch),
  startAuth: () => ipcRenderer.invoke("auth:start"),
  getPendingAuth: () => ipcRenderer.invoke("auth:pending"),
  openPendingAuth: () => ipcRenderer.invoke("auth:open-pending"),
  cancelAuth: () => ipcRenderer.invoke("auth:cancel"),
  pollAuth: () => ipcRenderer.invoke("auth:poll"),
  logoutAuth: () => ipcRenderer.invoke("auth:logout"),
  runAgent: (prompt) => ipcRenderer.invoke("agent:run", prompt),
  runTasks: (taskIds, promptByTaskId) => ipcRenderer.invoke("agent:run-tasks", taskIds, promptByTaskId),
  stopAgent: () => ipcRenderer.invoke("agent:stop"),
  onTaskChanged: (handler) => {
    const listener = (_event, task) => handler(task);
    ipcRenderer.on("tasks:changed", listener);
    return () => ipcRenderer.removeListener("tasks:changed", listener);
  },
});
