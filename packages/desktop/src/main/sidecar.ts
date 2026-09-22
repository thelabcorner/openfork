import { createRequire, enableCompileCache, registerHooks } from "node:module"
import * as http from "node:http"
import path from "node:path"
import * as tls from "node:tls"
import { pathToFileURL } from "node:url"
import { autopsyMark } from "./autopsy-timing" // STARTUP-AUTOPSY: temporary probe, see 02-main-process.md
import { childRuntimeEnvPatch } from "./child-runtime-env"
import {
  parseSidecarCommand,
  type OxpSidecarRequest,
  type SidecarMessage,
} from "./sidecar-protocol"
import {
  RuntimeRefreshCoordinator,
  type RuntimeBackendModule,
} from "./oxp/runtime-refresh"
import { recoverAcceptedRuntime } from "./oxp/runtime-artifacts"

enableCompileCache()

const nodePtyUrl = pathToFileURL(
  createRequire(import.meta.url).resolve(`@lydell/node-pty-${process.platform}-${process.arch}`),
).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@lydell/node-pty") return { url: nodePtyUrl, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

type NodeHttpWithEnvProxy = typeof http & {
  setGlobalProxyFromEnv: () => void
}

type NodeTlsWithSystemCertificates = typeof tls & {
  getCACertificates: (type: "default" | "system") => string[]
  setDefaultCACertificates: (certificates: string[]) => void
}

type StartCommand = Extract<ReturnType<typeof parseSidecarCommand>, { type: "start" }>
type OxpHostModule = RuntimeBackendModule["OxpHost"]
type OxpHostState = Awaited<ReturnType<OxpHostModule["restore"]>>

type ParentPort = {
  postMessage(message: SidecarMessage): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
}

type Listener = {
  stop(close?: boolean): void | Promise<void>
}

const parentPort = getParentPort()
let listener: Listener | undefined
let oxpHost: OxpHostModule | undefined
let runtimeRefresh: RuntimeRefreshCoordinator | undefined

autopsyMark("sidecar-module-eval") // STARTUP-AUTOPSY (utility process module graph loaded)

parentPort.on("message", (event) => {
  const command = parseCommand(event.data)
  if (!command) return
  if (command.type === "stop") {
    void stop()
    return
  }
  if (command.type === "oxp-request") {
    void handleOxp(command.id, command.request)
    return
  }
  void start(command)
})

async function start(command: StartCommand) {
  try {
    autopsyMark("sidecar-start-cmd") // STARTUP-AUTOPSY
    prepareSidecarEnv(command.password, command.userDataPath)
    ensureLoopbackNoProxy()
    useSystemCertificates()
    useEnvProxy()
    const runtimeArtifactUrl = import.meta.env.OPENCODE_RUNTIME_MODULE_URL
    const runtimeCheckpointRoot = path.join(
      command.userDataPath,
      "oxp-runtime-refresh",
    )
    if (runtimeArtifactUrl) {
      await recoverAcceptedRuntime(
        runtimeArtifactUrl,
        runtimeCheckpointRoot,
      )
    }
    const backend = (await import("virtual:opencode-server")) as typeof import("virtual:opencode-server") &
      RuntimeBackendModule
    const { Server, OxpHost } = backend
    oxpHost = OxpHost
    autopsyMark("sidecar-server-imported") // STARTUP-AUTOPSY (33 MB server bundle parsed+evaluated)

    runtimeRefresh = await RuntimeRefreshCoordinator.create(backend, {
      publish: (state) => parentPort.postMessage({ type: "oxp-state", state }),
      probe: probeOxpRuntime,
      artifactUrl: runtimeArtifactUrl || undefined,
      checkpointRoot: runtimeArtifactUrl
        ? runtimeCheckpointRoot
        : undefined,
      log: (level, message, metadata) => {
        if (level === "error") console.error(message, metadata ?? {})
        else if (level === "warn") console.warn(message, metadata ?? {})
        else console.log(message, metadata ?? {})
      },
    })

    listener = await Server.listen({
      port: command.port,
      hostname: command.hostname,
      username: "opencode",
      password: command.password,
      cors: ["oc://renderer"],
    })
    autopsyMark("sidecar-listening") // STARTUP-AUTOPSY
    parentPort.postMessage({ type: "ready" })
    // OXP is an independent listener owned by the same sidecar process. Restore
    // it after ordinary OpenFork readiness so a malformed/failed optional OXP
    // runtime can never make the primary HTTP server unavailable. If OXP was
    // disabled, restore returns without opening a listener; if enabled it
    // recreates a fresh secret path/generation for this sidecar lifetime.
    const host = currentOxpHost()
    if (!host) throw new Error("OXP host unavailable after backend import")
    void host
      .restore()
      .then((state: OxpHostState) => parentPort.postMessage({ type: "oxp-state", state }))
      .catch((_error: unknown) => {
        // Host errors can originate after a secret loopback URL has been
        // allocated. Keep this optional-startup diagnostic generic rather than
        // reflecting privileged exception text into process logs.
        console.warn("failed to restore optional OXP endpoint")
        void publishOxpState()
      })
  } catch (error) {
    parentPort.postMessage({ type: "error", error: serializeError(error) })
    setImmediate(() => process.exit(1))
  }
}

async function stop() {
  try {
    if (runtimeRefresh) await runtimeRefresh.dispose().catch(() => undefined)
    else await oxpHost?.dispose().catch(() => undefined)
    await listener?.stop()
  } finally {
    listener = undefined
    runtimeRefresh = undefined
    oxpHost = undefined
    parentPort.postMessage({ type: "stopped" })
    setImmediate(() => process.exit(0))
  }
}

async function publishOxpState() {
  const host = currentOxpHost()
  if (!host) return
  try {
    parentPort.postMessage({ type: "oxp-state", state: await host.getState() })
  } catch {
    // OXP is optional. Ordinary sidecar readiness remains independent.
  }
}

async function handleOxp(id: number, request: OxpSidecarRequest) {
  const host = currentOxpHost()
  if (!host) {
    parentPort.postMessage({ type: "oxp-response", id, ok: false, error: { message: "OXP host is not ready" } })
    return
  }
  try {
    const state = await (() => {
      switch (request.action) {
        case "get-state": return host.getState()
        case "start": return host.start()
        case "stop": return host.stop()
        case "revoke": return host.revoke()
        case "set-enabled": return host.setEnabled(request.enabled)
        case "set-grant": return host.setGrant(request.patch)
        case "approve-root": return host.approveRoot(request.path, request.alias)
        case "sync-project-roots": return host.syncProjectRoots(request.paths)
        case "rename-root": return host.renameRoot(request.rootID, request.alias)
        case "remove-root": return host.removeRoot(request.rootID)
        case "set-openai-api-key":
          return host.setOpenAiApiKey(request.value).then(() => host.getState())
        case "import-legacy-config":
          return host.importLegacyConfig(request.plan)
      }
    })()
    parentPort.postMessage({ type: "oxp-response", id, ok: true, state })
    parentPort.postMessage({ type: "oxp-state", state })
  } catch (error) {
    const serialized = serializeError(error)
    const message = redactOxpControlError(serialized.message)
    parentPort.postMessage({
      type: "oxp-response",
      id,
      ok: false,
      error: { message, ...((error as { _tag?: unknown })?._tag ? { code: String((error as { _tag?: unknown })._tag) } : {}) },
    })
  }
}

function currentOxpHost() {
  return runtimeRefresh?.host ?? oxpHost
}

async function probeOxpRuntime(state: OxpHostState) {
  const endpoint = state.endpoint
  if (
    !state.enabled ||
    endpoint.state !== "ready" ||
    !endpoint.url ||
    !endpoint.metadataUrl ||
    !endpoint.schemaFingerprint
  ) {
    throw new Error("OXP runtime probe requires a ready endpoint")
  }
  const response = await fetch(endpoint.metadataUrl, {
    method: "GET",
    signal: AbortSignal.timeout(3_000),
  })
  if (!response.ok) {
    throw new Error("OXP runtime metadata probe failed")
  }
  const metadata = (await response.json()) as { resource?: unknown }
  if (metadata.resource !== endpoint.url) {
    throw new Error("OXP runtime metadata probe returned a mismatched resource")
  }
}

function redactOxpControlError(message: string) {
  // The sidecar is the only process that ever sees the secret MCP route.
  // Defense in depth: never allow a thrown listener/server error containing a
  // loopback URL to cross the privileged utility-process boundary.
  return message
    .replace(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/[^\s"']*/gi, "[redacted local endpoint]")
    .slice(0, 2048)
}

function prepareSidecarEnv(password: string, userDataPath: string) {
  Object.assign(process.env, {
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_SERVER_PASSWORD: password,
    XDG_STATE_HOME: userDataPath,
    ...childRuntimeEnvPatch(),
  })
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

function useSystemCertificates() {
  try {
    const nodeTls = tls as NodeTlsWithSystemCertificates
    nodeTls.setDefaultCACertificates([
      ...new Set([...nodeTls.getCACertificates("default"), ...nodeTls.getCACertificates("system")]),
    ])
  } catch (error) {
    console.warn("failed to load system certificates", error)
  }
}

function useEnvProxy() {
  try {
    ;(http as NodeHttpWithEnvProxy).setGlobalProxyFromEnv()
  } catch (error) {
    console.warn("failed to load proxy environment", error)
  }
}

const parseCommand = parseSidecarCommand

function serializeError(error: unknown) {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause
    const causeMessage = cause instanceof Error ? cause.message : cause ? String(cause) : ""
    const message = error.message || causeMessage || String(error)
    const stack = error.stack ?? (cause instanceof Error ? cause.stack : undefined)
    return { message, stack }
  }
  return { message: String(error) }
}

function getParentPort() {
  const port = process.parentPort as ParentPort | undefined
  if (!port) throw new Error("Sidecar parent port unavailable")
  return port
}
