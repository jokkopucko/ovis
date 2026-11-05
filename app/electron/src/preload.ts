import { contextBridge, ipcRenderer } from "electron";

// only the app's own connection screen gets the bridge, never a page the server serves
if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("ovisDesktop", {
    status: () => ipcRenderer.invoke("ovis:status"),
    onStatus: (listener: (status: unknown) => void) => {
      ipcRenderer.on("ovis:status", (_event, status: unknown) => listener(status));
    },
    retry: () => ipcRenderer.send("ovis:retry"),
    showLogs: () => ipcRenderer.send("ovis:logs"),
  });
}
