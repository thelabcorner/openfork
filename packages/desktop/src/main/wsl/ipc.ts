import { app, ipcMain } from "electron"
import type { IpcMainInvokeEvent } from "electron"
import type { WslServersController } from "./servers"
import { requireWslIpcString, requireWslIpcStrings } from "./policy"
import type { WslServersState } from "../../preload/types"
import { nativeT } from "../native-translations"
export function registerWslIpcHandlers(controller: WslServersController) {
  if (process.platform !== "win32") {
    registerUnavailableWslIpcHandlers()
    return
  }
  const subscriptions = new Map<number, () => void>()
  const unsubscribe = (id: number) => subscriptions.get(id)?.()
  app.once("will-quit", () => {
    for (const id of subscriptions.keys()) unsubscribe(id)
  })
  ipcMain.handle("wsl-servers-subscribe", (event) => {
    const id = event.sender.id
    if (subscriptions.has(id)) return
    const sender = event.sender
    let dead = false
    let stop = () => {}
    const remove = () => {
      if (dead) return
      dead = true
      stop()
      sender.removeListener("destroyed", remove)
      if (subscriptions.get(id) === remove) subscriptions.delete(id)
    }
    subscriptions.set(id, remove)
    stop = controller.subscribe((payload) => {
      if (dead) return
      if (sender.isDestroyed()) {
        remove()
        return
      }
      try {
        sender.send("wsl-servers-event", payload)
      } catch {
        remove()
      }
    })
    if (dead) {
      stop()
      if (subscriptions.get(id) === remove) subscriptions.delete(id)
      return
    }
    if (sender.isDestroyed()) {
      remove()
      return
    }
    sender.once("destroyed", remove)
  })
  ipcMain.handle("wsl-servers-unsubscribe", (event) => unsubscribe(event.sender.id))
  ipcMain.handle("wsl-servers-get-state", () => controller.getState())
  ipcMain.handle("wsl-servers-probe-runtime", () => controller.probeRuntime())
  ipcMain.handle("wsl-servers-refresh-distros", () => controller.refreshDistros())
  ipcMain.handle("wsl-servers-install-wsl", () => controller.installWsl())
  ipcMain.handle("wsl-servers-install-distro", (_event: IpcMainInvokeEvent, name: string) =>
    controller.installDistro(requireWslIpcString("distro", name)),
  )
  ipcMain.handle("wsl-servers-probe-addable", (_event: IpcMainInvokeEvent, distros: string[]) =>
    controller.probeAddable(requireWslIpcStrings("distro", distros)),
  )
  ipcMain.handle("wsl-servers-install-opencode", (_event: IpcMainInvokeEvent, name: string) =>
    controller.installOpencode(requireWslIpcString("distro", name)),
  )
  ipcMain.handle("wsl-servers-open-terminal", (_event: IpcMainInvokeEvent, name: string) =>
    controller.openTerminal(requireWslIpcString("distro", name)),
  )
  ipcMain.handle("wsl-servers-add", (_event: IpcMainInvokeEvent, distro: string) =>
    controller.addServer(requireWslIpcString("distro", distro)),
  )
  ipcMain.handle("wsl-servers-remove", (_event: IpcMainInvokeEvent, id: string) =>
    controller.removeServer(requireWslIpcString("server id", id)),
  )
  ipcMain.handle("wsl-servers-start", (_event: IpcMainInvokeEvent, id: string) =>
    controller.startServer(requireWslIpcString("server id", id)),
  )
}
function registerUnavailableWslIpcHandlers() {
  const unavailable = () => {
    throw new Error(nativeT("desktop.wsl.error.windowsOnly"))
  }
  const state = (): WslServersState => ({
    runtime: {
      available: false,
      version: null,
      error: nativeT("desktop.wsl.error.windowsOnly"),
    },
    installed: [],
    online: [],
    distroProbes: {},
    opencodeChecks: {},
    pendingRestart: false,
    servers: [],
    job: null,
  })
  ipcMain.handle("wsl-servers-subscribe", (event) => {
    event.sender.send("wsl-servers-event", { type: "state", state: state() })
  })
  ipcMain.handle("wsl-servers-unsubscribe", () => undefined)
  ipcMain.handle("wsl-servers-get-state", () => state())
  ipcMain.handle("wsl-servers-probe-runtime", unavailable)
  ipcMain.handle("wsl-servers-refresh-distros", unavailable)
  ipcMain.handle("wsl-servers-install-wsl", unavailable)
  ipcMain.handle("wsl-servers-install-distro", unavailable)
  ipcMain.handle("wsl-servers-probe-addable", unavailable)
  ipcMain.handle("wsl-servers-install-opencode", unavailable)
  ipcMain.handle("wsl-servers-open-terminal", unavailable)
  ipcMain.handle("wsl-servers-add", unavailable)
  ipcMain.handle("wsl-servers-remove", unavailable)
  ipcMain.handle("wsl-servers-start", unavailable)
}
