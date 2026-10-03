import { contextBridge, ipcRenderer } from "electron"
import type { SidecarControlFetchInput } from "../../../app/src/utils/sidecar-control-request"

contextBridge.exposeInMainWorld("__fullAppGateControl", {
  dispatch: (requestID: string, input: SidecarControlFetchInput) =>
    ipcRenderer.invoke("full-app-gate-control-fetch", requestID, input),
  cancel: (requestID: string) => ipcRenderer.send("full-app-gate-control-cancel", requestID),
})
