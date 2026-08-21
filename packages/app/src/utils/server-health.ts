import { usePlatform } from "@/context/platform"
import { ServerConnection } from "@/context/server"
import { authTokenFromCredentials, createSdkForServer } from "./server"
import { forgetServerStreamLiveness, isServerStreamLive } from "./server-liveness"
import { ClientError, OpenCode } from "@opencode-ai/client"
import { Accessor, createEffect, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"

export type ServerHealth = { healthy: boolean; version?: string }

interface CheckServerHealthOptions {
  timeoutMs?: number
  signal?: AbortSignal
  retryCount?: number
  retryDelayMs?: number
}

const defaultTimeoutMs = 30_000
const defaultRetryCount = 2
const defaultRetryDelayMs = 100
const cacheMs = 750
const healthCache = new Map<
  string,
  { at: number; done: boolean; fetch: typeof globalThis.fetch; promise: Promise<ServerHealth> }
>()

function cacheKey(server: ServerConnection.HttpBase) {
  return `${server.url}\n${server.username ?? ""}\n${server.password ?? ""}`
}

function timeoutSignal(timeoutMs: number) {
  const timeout = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout
  if (timeout) {
    try {
      return {
        signal: timeout.call(AbortSignal, timeoutMs),
        clear: undefined as (() => void) | undefined,
      }
    } catch {}
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException("Aborted", "AbortError"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function retryable(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return false
  if (error instanceof ClientError) return error.reason === "Transport"
  if (!(error instanceof Error)) return false
  if (error.name === "AbortError" || error.name === "TimeoutError") return false
  if (error instanceof TypeError) return true
  return /network|fetch|econnreset|econnrefused|enotfound|timedout/i.test(error.message)
}

export async function checkServerHealth(
  server: ServerConnection.HttpBase,
  fetch: typeof globalThis.fetch,
  opts?: CheckServerHealthOptions,
): Promise<ServerHealth> {
  const timeout = opts?.signal ? undefined : timeoutSignal(opts?.timeoutMs ?? defaultTimeoutMs)
  const signal = opts?.signal ?? timeout?.signal
  const retryCount = opts?.retryCount ?? defaultRetryCount
  const retryDelayMs = opts?.retryDelayMs ?? defaultRetryDelayMs
  const next = (count: number, error: unknown) => {
    if (count >= retryCount || !retryable(error, signal)) return Promise.resolve({ healthy: false } as const)
    return wait(retryDelayMs * (count + 1), signal)
      .then(() => attempt(count + 1))
      .catch(() => ({ healthy: false }))
  }
  const attempt = async (count: number): Promise<ServerHealth> => {
    const current = await OpenCode.make({
      baseUrl: server.url,
      fetch,
      headers: server.password
        ? {
            Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
          }
        : undefined,
    })
      .health.get({ signal })
      .then((x) =>
        typeof x.healthy === "boolean"
          ? { data: { healthy: x.healthy, version: x.version } }
          : { error: new Error("Invalid health response") },
      )
      .catch((error) => ({ error }))
    if ("data" in current && current.data) return current.data
    if (signal?.aborted) return { healthy: false }

    return createSdkForServer({ server, fetch, signal })
      .global.health()
      .then((x) => (x.error ? next(count, x.error) : { healthy: x.data?.healthy === true, version: x.data?.version }))
      .catch((error) => next(count, error))
  }
  return attempt(0).finally(() => timeout?.clear?.())
}

const pollMs = 10_000
// While a server's SSE stream is live, the health check only re-runs this often
// (to keep the version badge fresh); the stream's own heartbeat is the liveness
// signal in between. Version only changes on a server restart, so this staleness
// is invisible in practice -- but it also bounds how long a wrong/stale liveness
// signal (e.g. a desynced stream) can hold the status dot stuck without a real
// re-check. Kept short specifically for that self-healing property.
const VERSION_REFRESH_MS = 20_000
const lastVersionAt = new Map<string, number>()
// The live polling loop fails fast and relies on the next 10s tick to retry,
// rather than the exported default (used by one-off manual checks, e.g. "test
// connection", where waiting longer for a slow network is worth it). Without
// this, a single slow/wedged attempt could hold the status dot on its last
// (possibly false) value for up to ~30s+retries before trying again.
const POLL_CHECK_OPTS = { timeoutMs: 8_000, retryCount: 1, retryDelayMs: 150 }
// Safety net: if a refresh cycle is somehow still "in flight" long after it
// should have settled (checkServerHealth always resolves within its own
// timeout), stop trusting the in-flight flag and let a new cycle start. This
// guards against the status dot being stuck on a stale value forever if some
// future change to the check chain ever introduces a promise that doesn't
// settle on its own.
const REFRESH_WATCHDOG_MS = pollMs * 4

export function useCheckServerHealth() {
  const platform = usePlatform()
  const fetcher = platform.fetch ?? globalThis.fetch

  return (http: ServerConnection.HttpBase, opts?: CheckServerHealthOptions) => {
    const key = cacheKey(http)
    const hit = healthCache.get(key)
    const now = Date.now()
    if (!opts && hit && hit.fetch === fetcher && (!hit.done || now - hit.at < cacheMs)) return hit.promise
    const promise = checkServerHealth(http, fetcher, opts).finally(() => {
      const next = healthCache.get(key)
      if (!next || next.promise !== promise) return
      next.done = true
      next.at = Date.now()
    })
    if (!opts) healthCache.set(key, { at: now, done: false, fetch: fetcher, promise })
    return promise
  }
}

export const useServerHealth = (servers: Accessor<ServerConnection.Any[]>, enabled: Accessor<boolean>) => {
  const checkServerHealth = useCheckServerHealth()
  const [status, setStatus] = createStore({} as Record<ServerConnection.Key, ServerHealth | undefined>)

  createEffect(() => {
    if (!enabled()) {
      setStatus(reconcile({}))
      return
    }
    const list = servers()
    let dead = false
    let refreshing = false
    let pending = false
    const failures = new Map<ServerConnection.Key, number>()

    for (const key of [...lastVersionAt.keys()]) {
      if (!list.some((conn) => ServerConnection.key(conn) === key)) lastVersionAt.delete(key)
    }

    const refresh = async () => {
      if (refreshing) {
        pending = true
        return
      }
      refreshing = true
      const results: Record<string, ServerHealth> = {}
      try {
        await Promise.all(
          list.map(async (conn) => {
            const key = ServerConnection.key(conn)
            // A live SSE stream (server.connected on connect + heartbeat every 10s)
            // proves the server is reachable; skip the HTTP check entirely and only
            // re-run it occasionally to keep the version badge fresh. Failure
            // semantics are unchanged: the stream loop marks the server dead on a
            // genuine stream error, which resumes the full check with the same 10s
            // poll + two-failure grace period as before.
            if (isServerStreamLive(key)) {
              if ((lastVersionAt.get(key) ?? 0) > Date.now() - VERSION_REFRESH_MS) {
                failures.delete(key)
                results[key] = status[key]?.healthy === true ? status[key] : { healthy: true }
                return
              }
            }
            const result = await checkServerHealth(conn.http)
            if (result.healthy) lastVersionAt.set(key, Date.now())
            const failed = result.healthy === false
            const failureCount = failed ? (failures.get(key) ?? 0) + 1 : 0
            if (failed) failures.set(key, failureCount)
            else failures.delete(key)
            const visible = failed && status[key]?.healthy === true && failureCount < 2 ? status[key]! : result
            results[key] = visible
            if (!dead) setStatus(key, visible)
          }),
        )
        if (!dead) setStatus(reconcile(results))
      } finally {
        refreshing = false
        if (pending && !dead) {
          pending = false
          void refresh()
        }
      }
    }

    void refresh()
    const id = setInterval(() => void refresh(), pollMs)
    onCleanup(() => {
      dead = true
      clearInterval(id)
      for (const conn of list) forgetServerStreamLiveness(ServerConnection.key(conn))
    })
  })

  return status
}
