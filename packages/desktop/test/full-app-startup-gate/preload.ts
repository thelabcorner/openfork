import { contextBridge, ipcRenderer } from "electron"
import type { SidecarControlFetchInput } from "../../../app/src/utils/sidecar-control-request"

contextBridge.exposeInMainWorld("__fullAppGateControl", {
  dispatch: (requestID: string, input: SidecarControlFetchInput) =>
    ipcRenderer.invoke("full-app-gate-control-fetch", requestID, input),
  cancel: (requestID: string) => ipcRenderer.send("full-app-gate-control-cancel", requestID),
  traceStart: (scenario: string) => ipcRenderer.invoke("full-app-gate-trace-start", scenario),
  traceStop: (scenario: string) => ipcRenderer.invoke("full-app-gate-trace-stop", scenario),
  restartSidecar: () => ipcRenderer.invoke("full-app-gate-restart-sidecar"),
  profileStopStartup: () => ipcRenderer.invoke("full-app-gate-profile-stop-startup"),
  clickStop: (input: { x: number; y: number }) => ipcRenderer.invoke("full-app-gate-click-stop", input),
  seedLargeHistory: (input: { sessionID: string; messageID: string; count: number }) =>
    ipcRenderer.invoke("full-app-gate-seed-large-history", input),
})
