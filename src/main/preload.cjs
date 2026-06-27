const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("penutOperator", {
  getTask: () => ipcRenderer.invoke("tasks:get"),
  selectTask: (taskId) => ipcRenderer.invoke("tasks:select", taskId),
  createTask: (prompt) => ipcRenderer.invoke("tasks:create", prompt),
  updateTask: (patch) => ipcRenderer.invoke("tasks:update", patch),
  approveTask: () => ipcRenderer.invoke("tasks:approve"),
  resetTask: () => ipcRenderer.invoke("tasks:reset"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (patch) => ipcRenderer.invoke("settings:update", patch),
  runAgent: (prompt) => ipcRenderer.invoke("agent:run", prompt),
  stopAgent: () => ipcRenderer.invoke("agent:stop"),
  onTaskChanged: (handler) => {
    const listener = (_event, task) => handler(task);
    ipcRenderer.on("tasks:changed", listener);
    return () => ipcRenderer.removeListener("tasks:changed", listener);
  },
});
