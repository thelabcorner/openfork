import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { app, utilityProcess } from "electron"
import type { Details } from "electron"
import { getLogger } from "./logging"
import { getUserShell, loadShellEnv } from "./shell-env"
import { getStore } from "./store"
import { DEFAULT_SERVER_URL_KEY } from "./store-keys"
import { waitForServerHealth } from "./server-health"
export type HealthCheck = { wait: Promise<void> }
type SidecarMessage =
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }
export type SidecarListener = { stop: () => Promise<void> }
const SIDECAR_SERVICE_NAME = "opencode server"
const SIDECAR_START_STALL_TIMEOUT = 60_000
const SIDECAR_STOP_TIMEOUT = 6_000
type SpawnLocalServerOptions = {
  userDataPath: string
  /**
   * Extra environment for the sidecar only. Kept off `process.env` on purpose:
   * per-instance values (OPENCODE_INSTANCE_ID) must not leak into WSL sidecars
   * or any other child, or two servers would claim one identity.
   */
  env?: Record<string, string>
  onStdout?: (message: string) => void
  onStderr?: (message: string) => void
  onExit?: (code: number) => void
}
export function getDefaultServerUrl(): string | null {
  const value = getStore().get(DEFAULT_SERVER_URL_KEY)
  return typeof value === "string" ? value : null
}
export function setDefaultServerUrl(url: string | null) {
  if (url) {
    getStore().set(DEFAULT_SERVER_URL_KEY, url)
    return
  }
  getStore().delete(DEFAULT_SERVER_URL_KEY)
}
export function preferAppEnv(userDataPath: string) {
  const shell = process.platform === "win32" ? null : getUserShell()
  const shellEnv = shell ? loadShellEnv(shell, getLogger()) : null
  Object.assign(process.env, {
    ...shellEnv,
    OPENCODE_EXPERIMENTAL_ICON_DISCOVERY: "true",
    OPENCODE_EXPERIMENTAL_FILEWATCHER: "true",
    OPENCODE_CLIENT: "desktop",
    XDG_STATE_HOME: userDataPath,
  })
  return shellEnv
}
export async function spawnLocalServer(
  hostname: string,
  port: number,
  password: string,
  options: SpawnLocalServerOptions,
) {
  const sidecar = join(dirname(fileURLToPath(import.meta.url)), "sidecar.js")
  const child = utilityProcess.fork(sidecar, [], {
    cwd: process.cwd(),
    env: createSidecarEnv(options.env),
    serviceName: SIDECAR_SERVICE_NAME,
    stdio: "pipe",
  })
  let exited = false
  const exit = defer<number>()
  const onProcessGone = (_event: unknown, details: Details) => {
    if (details.type !== "Utility" || details.name !== SIDECAR_SERVICE_NAME) return
    options.onStderr?.(`utility process gone reason=${details.reason} exitCode=${details.exitCode}`)
  }
  app.on("child-process-gone", onProcessGone)
  child.once("exit", (code) => {
    exited = true
    app.off("child-process-gone", onProcessGone)
    options.onExit?.(code)
    exit.resolve(code)
  })
  child.on("error", (error) => options.onStderr?.(`utility process error: ${serializeError(error).message}`))
  child.stdout?.on("data", (chunk: Buffer) => options.onStdout?.(chunk.toString("utf8").trimEnd()))
  child.stderr?.on("data", (chunk: Buffer) => options.onStderr?.(chunk.toString("utf8").trimEnd()))
  await new Promise<void>((resolve, reject) => {
    let done = false
    let timeout: NodeJS.Timeout
    const fail = (error: Error) => {
      if (done) return
      done = true
      cleanup()
      reject(error)
    }
    const refreshTimeout = () => {
      clearTimeout(timeout)
      timeout = setTimeout(() => {
        fail(new Error(`Sidecar did not become ready within ${SIDECAR_START_STALL_TIMEOUT}ms: ${sidecar}`))
      }, SIDECAR_START_STALL_TIMEOUT)
    }
    const onMessage = (message: SidecarMessage) => {
      if (message.type === "ready") {
        if (done) return
        done = true
        cleanup()
        resolve()
        return
      }
      if (message.type === "error") {
        const detail = message.error.stack ?? message.error.message
        options.onStderr?.(`sidecar startup error: ${detail} (port ${port})`)
        const err = Object.assign(
          new Error(message.error.message || `Sidecar failed to start on ${hostname}:${port}`),
          {
            stack: message.error.stack,
          },
        )
        // Preserve EADDRINUSE code for callers that want to retry
        const code = /EADDRINUSE/.test(detail) ? "EADDRINUSE" : undefined
        if (code) (err as NodeJS.ErrnoException).code = code
        fail(err)
      }
    }
    const onExit = (code: number) => {
      fail(new Error(`Sidecar exited before ready with code ${code}`))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      child.off("message", onMessage)
      child.off("exit", onExit)
    }
    child.on("message", onMessage)
    child.on("exit", onExit)
    refreshTimeout()
    child.postMessage({
      type: "start",
      hostname,
      port,
      password,
      userDataPath: options.userDataPath,
    })
  }).catch((error) => {
    if (!exited) child.kill()
    throw error
  })
  const wait = waitForServerHealth(
    (signal) => checkHealth(`http://${hostname}:${port}`, password, signal),
    exit.promise,
  )
  let stopping: Promise<void> | undefined
  return {
    listener: {
      stop: () => {
        if (stopping) return stopping
        if (exited) return Promise.resolve()
        child.postMessage({ type: "stop" })
        stopping = Promise.race([
          exit.promise.then(() => undefined),
          delay(SIDECAR_STOP_TIMEOUT).then(() => {
            if (!exited) child.kill()
          }),
        ])
        return stopping
      },
    },
    health: { wait },
  }
}
export async function checkHealth(url: string, password?: string | null, signal?: AbortSignal): Promise<boolean> {
  let healthUrls: URL[]
  try {
    healthUrls = [new URL("/api/health", url), new URL("/global/health", url)]
  } catch {
    return false
  }
  const headers = new Headers()
  if (password) {
    const auth = Buffer.from(`opencode:${password}`).toString("base64")
    headers.set("authorization", `Basic ${auth}`)
  }
  for (const healthUrl of healthUrls) {
    if (signal?.aborted) return false
    try {
      const res = await fetch(healthUrl, {
        method: "GET",
        headers,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000),
      })
      await res.body?.cancel()
      if (res.ok) return true
    } catch {}
  }
  return false
}
function createSidecarEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])),
    ),
    ...extra,
  }
  delete env.DEBUG
  if (process.platform === "linux") delete env.LD_PRELOAD
  // Don't propagate OPENCODE_PORT to the sidecar — the desktop picks its own
  // ephemeral port to avoid colliding with `opencode serve` / JetBrains ACP.
  delete env.OPENCODE_PORT
  // Server Effect logs go to a file unless OPENCODE_PRINT_LOGS=1 (see
  // packages/core/src/observability/logging.ts). In dev (`bun run dev`) the
  // sidecar's stderr is piped back to the main process and mirrored to the
  // terminal (see index.ts onStdout/onStderr), so opt into stderr logs here.
  // Without this, `bun run dev` shows [desktop]/[pwa] but never any server
  // output. Explicit env wins; packaged builds keep file-only logging.
  if (!app.isPackaged && env.OPENCODE_PRINT_LOGS === undefined) {
    env.OPENCODE_PRINT_LOGS = "1"
  }
  return env
}
function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}
function serializeError(error: unknown) {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause
    const causeMessage = cause instanceof Error ? cause.message : cause ? String(cause) : ""
    const message = error.message || causeMessage || String(error)
    return { message, stack: error.stack ?? (cause instanceof Error ? cause.stack : undefined) }
  }
  return { message: String(error) }
}
function defer<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
