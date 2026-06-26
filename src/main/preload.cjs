const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("penutOperator", {
  getTask: () => ipcRenderer.invoke("tasks:get"),
  updateTask: (patch) => ipcRenderer.invoke("tasks:update", patch),
  approveTask: () => ipcRenderer.invoke("tasks:approve"),
  resetTask: () => ipcRenderer.invoke("tasks:reset"),
  runAgent: () => ipcRenderer.invoke("agent:run"),
  stopAgent: () => ipcRenderer.invoke("agent:stop"),
  onTaskChanged: (handler) => {
    const listener = (_event, task) => handler(task);
    ipcRenderer.on("tasks:changed", listener);
    return () => ipcRenderer.removeListener("tasks:changed", listener);
  },
});
