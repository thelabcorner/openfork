import { contextBridge, ipcRenderer } from "electron"
import type { SidecarControlFetchInput } from "../../../app/src/utils/sidecar-control-request"

contextBridge.exposeInMainWorld("__nativeGateControl", {
  dispatch: (requestID: string, input: SidecarControlFetchInput) =>
    ipcRenderer.invoke("native-gate-control-fetch", requestID, input),
  cancel: (requestID: string) => ipcRenderer.send("native-gate-control-cancel", requestID),
})