import { dialog, ipcMain } from "electron"
import type { IpcMainInvokeEvent } from "electron"
import type { RendererTrust } from "../browser/renderer-trust"
import { nativeT } from "../native-translations"
import type { SidecarOxpGrant, SidecarOxpModelSelection } from "../sidecar-protocol"
import type { OxpLifecycle } from "./config"
import type { OxpController } from "./controller"
import { projectOxpIpcError } from "./ipc-error"

const grantKeys = new Set<keyof SidecarOxpGrant>([
  "read",
  "write",
  "process",
  "git",
  "integrations",
  "browser",
  "filesReceive",
  "filesSend",
  "automation",
  "sessionSupervision",
  "requestSupervision",
  "delegation",
  "nestedDelegation",
])
const lifecycleKeys = new Set<keyof OxpLifecycle>(["autoConnect", "launchAtLogin", "startHidden", "closeToTray"])

function requireTrusted(trust: RendererTrust, event: IpcMainInvokeEvent) {
  if (!trust.isTrusted(event)) throw new Error("Untrusted OXP sender")
}

function boundedString(value: unknown, field: string, max: number) {
  if (typeof value !== "string" || value.length > max) throw new Error(`Invalid ${field}`)
  return value
}

function grantPatch(value: unknown): Partial<SidecarOxpGrant> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid OXP grant patch")
  const result: Partial<SidecarOxpGrant> = {}
  for (const [rawKey, item] of Object.entries(value)) {
    const key = rawKey as keyof SidecarOxpGrant
    if (!grantKeys.has(key)) throw new Error(`Unknown OXP grant field: ${rawKey}`)
    if (key === "sessionSupervision") {
      if (item !== "none" && item !== "approved-roots") throw new Error("Invalid session supervision policy")
      result.sessionSupervision = item
      continue
    }
    if (key === "delegation") {
      if (item !== "disabled" && item !== "spawn") throw new Error("Invalid delegation policy")
      result.delegation = item
      continue
    }
    if (typeof item !== "boolean") throw new Error(`Invalid OXP grant field: ${rawKey}`)
    Object.assign(result, { [key]: item })
  }
  return result
}

function lifecyclePatch(value: unknown): Partial<OxpLifecycle> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid OXP lifecycle patch")
  const result: Partial<OxpLifecycle> = {}
  for (const [rawKey, item] of Object.entries(value)) {
    const key = rawKey as keyof OxpLifecycle
    if (!lifecycleKeys.has(key) || typeof item !== "boolean") throw new Error(`Invalid OXP lifecycle field: ${rawKey}`)
    Object.assign(result, { [key]: item })
  }
  return result
}

function modelSelection(value: unknown): SidecarOxpModelSelection | undefined {
  if (value === undefined) return
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid OXP model selection")
  }
  const source = value as Record<string, unknown>
  const allowed = new Set(["providerID", "modelID", "accountID", "variant"])
  if (Object.keys(source).some((key) => !allowed.has(key))) {
    throw new Error("Invalid OXP model selection")
  }
  const providerID = boundedString(source.providerID, "provider ID", 256).trim()
  const modelID = boundedString(source.modelID, "model ID", 256).trim()
  if (!providerID || !modelID || /[\x00-\x1f\x7f]/.test(providerID + modelID)) {
    throw new Error("Invalid OXP model selection")
  }
  const accountID =
    source.accountID === undefined
      ? undefined
      : boundedString(source.accountID, "account ID", 256).trim()
  const variant =
    source.variant === undefined
      ? undefined
      : boundedString(source.variant, "variant", 256).trim()
  if (
    (accountID !== undefined &&
      (!accountID || /[\x00-\x1f\x7f]/.test(accountID))) ||
    (variant !== undefined &&
      (!variant || /[\x00-\x1f\x7f]/.test(variant)))
  ) {
    throw new Error("Invalid OXP model selection")
  }
  return {
    providerID,
    modelID,
    ...(accountID ? { accountID } : {}),
    ...(variant ? { variant } : {}),
  }
}

export function registerOxpIpc(controller: OxpController, trust: RendererTrust) {
  const subscriptions = new Map<number, () => void>()
  const handler = <Args extends unknown[], Result>(
    channel: string,
    fn: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>,
  ) => {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        requireTrusted(trust, event)
        return await fn(event, ...(args as Args))
      } catch (error) {
        throw projectOxpIpcError(error)
      }
    })
  }

  handler("oxp-get-state", () => controller.getState())
  handler("oxp-set-enabled", (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new Error("Invalid OXP enabled state")
    return controller.setEnabled(enabled)
  })
  handler("oxp-set-grant", (_event, patch: unknown) => controller.setGrant(grantPatch(patch)))
  handler("oxp-set-worker-default-model", (_event, value: unknown) =>
    controller.setWorkerDefaultModel(modelSelection(value)),
  )
  handler("oxp-list-worker-agents", (_event, rootID: unknown) =>
    controller.listWorkerAgents(boundedString(rootID, "root ID", 128)),
  )
  handler(
    "oxp-set-worker-default-agent",
    (_event, rootID: unknown, agent: unknown) => {
      const normalizedRootID = boundedString(rootID, "root ID", 128)
      if (agent === undefined) {
        return controller.setWorkerDefaultAgent(normalizedRootID)
      }
      const normalizedAgent = boundedString(
        agent,
        "worker agent",
        256,
      ).trim()
      if (
        !normalizedAgent ||
        /[\x00-\x1f\x7f]/.test(normalizedAgent)
      ) {
        throw new Error("Invalid OXP worker agent")
      }
      return controller.setWorkerDefaultAgent(
        normalizedRootID,
        normalizedAgent,
      )
    },
  )
  handler("oxp-add-root", async (event) => {
    const result = await dialog.showOpenDialog({
      title: nativeT("desktop.oxp.dialog.chooseFolder"),
      properties: ["openDirectory"],
    })
    if (result.canceled || !result.filePaths[0]) return controller.getState()
    // The renderer never supplies this native path. The sidecar independently
    // canonicalizes it and enforces overlap/link/device-root constraints.
    return controller.addRoot(result.filePaths[0])
  })
  handler("oxp-sync-project-roots", (_event, value: unknown) => {
    if (!Array.isArray(value) || value.length > 256) throw new Error("Invalid OXP project roots")
    const paths = value.map((item) => boundedString(item, "project root", 4096))
    return controller.syncProjectRoots(paths)
  })
  handler("oxp-rename-root", (_event, rootID: unknown, alias: unknown) =>
    controller.renameRoot(boundedString(rootID, "root ID", 64), boundedString(alias, "root alias", 64)),
  )
  handler("oxp-remove-root", (_event, rootID: unknown) => controller.removeRoot(boundedString(rootID, "root ID", 64)))
  handler("oxp-reveal-root", (_event, rootID: unknown) => controller.revealRoot(boundedString(rootID, "root ID", 64)))
  handler("oxp-set-tunnel-id", (_event, value: unknown) => controller.setTunnelID(boundedString(value, "tunnel ID", 128)))
  handler("oxp-set-openai-api-key", (_event, value: unknown) =>
    controller.setOpenAiApiKey(boundedString(value, "OXP OpenAI API key", 16 * 1024)),
  )
  handler("oxp-clear-openai-api-key", () => controller.clearOpenAiApiKey())
  handler("oxp-reset-unreadable-credential-store", () => controller.resetUnreadableCredentialStore())
  handler("oxp-set-lifecycle", (_event, patch: unknown) => controller.setLifecycle(lifecyclePatch(patch)))
  handler("oxp-import-localmcp", async () => {
    const result = await dialog.showOpenDialog({
      title: nativeT("desktop.dialog.chooseFile"),
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }],
    })
    if (result.canceled || !result.filePaths[0]) return controller.getState()
    return controller.importLocalMcpConfig(result.filePaths[0])
  })
  handler("oxp-auto-import-localmcp", () => controller.autoImportLocalMcpConfig())
  handler("oxp-retire-localmcp", () => controller.retireLocalMcpConnector())
  handler("oxp-connect", () => controller.connect())
  handler("oxp-disconnect", () => controller.disconnect())
  handler("oxp-export-diagnostics", () => controller.exportDiagnostics())
  handler("oxp-subscribe", (event) => {
    const id = event.sender.id
    subscriptions.get(id)?.()
    const unsubscribe = controller.subscribe((state) => {
      if (event.sender.isDestroyed()) return
      event.sender.send("oxp-state", state)
    })
    subscriptions.set(id, unsubscribe)
    event.sender.once("destroyed", () => {
      subscriptions.get(id)?.()
      subscriptions.delete(id)
    })
    return true
  })
  handler("oxp-unsubscribe", (event) => {
    subscriptions.get(event.sender.id)?.()
    subscriptions.delete(event.sender.id)
  })

  return () => {
    for (const unsubscribe of subscriptions.values()) unsubscribe()
    subscriptions.clear()
  }
}
