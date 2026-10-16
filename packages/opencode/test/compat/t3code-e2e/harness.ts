// Durable regression harness for the audited legacy T3 Code / OpenCode 1.15.13
// compatibility profile.
//
// EVIDENCE CLASS: `openfork_process_integration` — SUPPLEMENTARY.
//
// This harness does NOT close the "real stock T3 E2E" gate. It proves OpenFork's
// side of the legacy wire against a REAL listener with REAL HTTP and REAL SSE,
// using a hand-written driver that reproduces the legacy SDK's transport rules.
// The stock-T3 gate is satisfied elsewhere by executing immutable T3 source from
// `git archive` snapshots. Keep this file as the in-repo regression canary: it
// runs in CI, it is cheap, and it fails loudly when the legacy contract drifts.
//
// THE FAITHFULNESS RULE
//
// The legacy SDK's location carrier is subtle enough to be a real defect source:
// the client sets `x-opencode-directory` to an ENCODED path, then a request
// interceptor rewrites GET/HEAD into a `?directory=` query parameter and deletes
// the header. `pick()` is what makes that round-trip correct — it un-does the
// double encoding so the server sees the raw path on BOTH carriers. If `pick()`
// is ever removed or simplified, every GET/HEAD instance route 400s while POST
// keeps working: exactly the asymmetric failure signature already observed on
// `session.abort` in `handlers/session-control.ts`.
//
// This harness therefore reproduces `packages/sdk/js/src/client.ts:9-31,46-51`
// literally rather than "reasonably", and the tests below pin BOTH carriers.
//
// Source of the reproduced rules:
//   packages/sdk/js/src/client.ts:9-15   pick()
//   packages/sdk/js/src/client.ts:17-31  rewrite() — GET/HEAD only
//   packages/sdk/js/src/client.ts:46-51  x-opencode-directory header injection
//   packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts:89-103
//   packages/opencode/src/server/auth.ts  default username "opencode"
//
// ISOLATION (copied from test/server/pairing-e2e.test.ts, this repo's existing
// real-listener E2E): explicit random non-zero port, `OPENCODE_DB` pointed at an
// in-tree gitignored `tmp/` path set BEFORE the first opencode module import
// (Flag snapshots process.env at module load), and port-free verification on
// teardown. No external temp dirs.

import { mkdir, mkdtemp, rm } from "node:fs/promises"
import net from "node:net"
import path from "node:path"

export const T3_COMPAT_SERVER_PASSWORD = "t3-e2e-password"
export const T3_COMPAT_SERVER_USERNAME = "opencode"

const SCRATCH_ROOT = path.resolve(import.meta.dir, "../../../tmp/t3code-e2e")

let scratchRoot: string | undefined

async function ensureScratch() {
  if (scratchRoot) return scratchRoot
  await mkdir(SCRATCH_ROOT, { recursive: true })
  scratchRoot = await mkdtemp(path.join(SCRATCH_ROOT, "run-"))
  return scratchRoot
}

export async function cleanupScratch() {
  if (!scratchRoot) return
  const root = scratchRoot
  scratchRoot = undefined
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
}

export function isPortFree(port: number) {
  return new Promise<boolean>((resolve) => {
    const probe = net.createServer()
    probe.once("error", () => resolve(false))
    probe.once("listening", () => probe.close(() => resolve(true)))
    probe.listen(port, "127.0.0.1")
  })
}

async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = 20_000 + Math.floor(Math.random() * 20_000)
    if (await isPortFree(port)) return port
  }
  throw new Error("no free port found for the T3 compatibility listener")
}

export type CompatServer = {
  readonly url: string
  readonly port: number
  /** Absolute workspace directory T3 would open a thread in. */
  readonly workspace: string
  stop: () => Promise<void>
}

/**
 * Start a REAL listener with the explicit T3 compatibility profile active and
 * server authentication enabled exactly as T3 configures it.
 *
 * `profile` selects which identity the process projects. `"t3code"` is the
 * audited exception; `"canonical"` is the negative control proving the profile
 * gate is what changes the observable contract.
 */
export async function startCompatServer(profile: "t3code" | "canonical" = "t3code"): Promise<CompatServer> {
  const root = await ensureScratch()
  const workspace = path.join(root, "workspace")
  await mkdir(workspace, { recursive: true })

  // Must happen before ANY opencode module import in this process.
  process.env.OPENCODE_DB = path.join(root, "compat.db")
  process.env.OPENCODE_SERVER_PASSWORD = T3_COMPAT_SERVER_PASSWORD
  process.env.OPENCODE_SERVER_USERNAME = T3_COMPAT_SERVER_USERNAME
  if (profile === "t3code") process.env.OPENFORK_COMPAT_PROFILE = "t3code-opencode-v1"
  else delete process.env.OPENFORK_COMPAT_PROFILE

  const [{ Server }, { withTimeout }] = await Promise.all([
    import("../../../src/server/server"),
    import("../../../src/util/timeout"),
  ])
  const port = await freePort()
  const listener = await withTimeout(Server.listen({ hostname: "127.0.0.1", port }), 60_000, "compat listener start")
  return {
    url: `http://127.0.0.1:${listener.port}`,
    port: listener.port,
    workspace,
    async stop() {
      await listener.stop(true)
      if (!(await isPortFree(listener.port))) throw new Error(`port ${listener.port} was not released`)
    },
  }
}

/** Drop instance/DB state so one server does not leak into the next test. */
export async function resetCompatState() {
  const [{ disposeAllInstances }, { resetDatabase }] = await Promise.all([
    import("../../fixture/fixture"),
    import("../../fixture/db"),
  ])
  await disposeAllInstances().catch(() => undefined)
  await resetDatabase().catch(() => undefined)
}

// ---------------------------------------------------------------------------
// Faithful legacy SDK transport reproduction
// ---------------------------------------------------------------------------

/**
 * Verbatim reproduction of `pick()` in packages/sdk/js/src/client.ts:9-15.
 *
 * The `value === encodeURIComponent(fallback)` branch is load-bearing: it is the
 * only reason a GET/HEAD query survives the encode/decode round trip.
 */
export function sdkPick(value: string | null | undefined, fallback?: string) {
  if (!value) return undefined
  if (!fallback) return value
  if (value === fallback) return fallback
  if (value === encodeURIComponent(fallback)) return fallback
  return value
}

export type LegacyRequestInit = {
  readonly url: string
  readonly headers: Record<string, string>
}

/**
 * Reproduce the legacy SDK request interceptor for one call.
 *
 * GET/HEAD: `?directory=<raw path>` (URLSearchParams encodes it once on the
 * wire) and NO `x-opencode-directory` header.
 * Anything else: `x-opencode-directory: encodeURIComponent(<raw path>)` and no
 * query parameter.
 */
export function legacyRequestInit(input: {
  readonly baseUrl: string
  readonly path: string
  readonly method: string
  readonly directory?: string
  readonly extraHeaders?: Record<string, string>
  readonly query?: Record<string, string | undefined>
}): LegacyRequestInit {
  const method = input.method.toUpperCase()
  const url = new URL(input.path, input.baseUrl)
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(
      `${T3_COMPAT_SERVER_USERNAME}:${T3_COMPAT_SERVER_PASSWORD}`,
      "utf8",
    ).toString("base64")}`,
    ...(input.extraHeaders ?? {}),
  }
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value)
  }
  if (input.directory) {
    if (method === "GET" || method === "HEAD") {
      const picked = sdkPick(encodeURIComponent(input.directory), input.directory)
      if (picked) url.searchParams.set("directory", picked)
    } else {
      headers["x-opencode-directory"] = encodeURIComponent(input.directory)
    }
  }
  return { url: url.toString(), headers }
}

export type LegacyResponse = {
  readonly status: number
  readonly headers: Headers
  readonly text: string
  readonly json: unknown
}

export async function legacyFetch(input: {
  readonly baseUrl: string
  readonly path: string
  readonly method?: string
  readonly directory?: string
  readonly body?: unknown
  readonly extraHeaders?: Record<string, string>
  readonly query?: Record<string, string | undefined>
  /** Send the legacy location carrier exactly as given, bypassing the interceptor. */
  readonly rawDirectory?: { readonly carrier: "header" | "query"; readonly value: string }
}): Promise<LegacyResponse> {
  const method = (input.method ?? "GET").toUpperCase()
  const init = legacyRequestInit({
    baseUrl: input.baseUrl,
    path: input.path,
    method,
    directory: input.directory,
    extraHeaders: input.extraHeaders,
    query: input.query,
  })
  const url = new URL(init.url)
  const headers = { ...init.headers }
  if (input.rawDirectory) {
    if (input.rawDirectory.carrier === "header") {
      url.searchParams.delete("directory")
      headers["x-opencode-directory"] = input.rawDirectory.value
    } else {
      url.searchParams.set("directory", input.rawDirectory.value)
      delete headers["x-opencode-directory"]
    }
  }
  let body: string | undefined
  if (input.body !== undefined) {
    body = JSON.stringify(input.body)
    headers["content-type"] = "application/json"
  }
  const response = await fetch(url, { method, headers, body })
  const text = await response.text()
  let json: unknown
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined
  } catch {
    json = undefined
  }
  return { status: response.status, headers: response.headers, text, json }
}

// ---------------------------------------------------------------------------
// Real SSE consumer
// ---------------------------------------------------------------------------

export type LegacyFrame = {
  readonly event: string | undefined
  readonly id: string | undefined
  readonly data: string | undefined
}

export type LegacyEventStream = {
  readonly frames: LegacyFrame[]
  readonly response: Response
  close: () => void
}

function parseFrameBlock(block: string): LegacyFrame {
  let event: string | undefined
  let id: string | undefined
  const data: string[] = []
  for (const line of block.split("\n")) {
    if (line.length === 0) continue
    const separator = line.indexOf(":")
    const field = separator === -1 ? line : line.slice(0, separator)
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "")
    if (field === "event") event = value
    else if (field === "id") id = value
    else if (field === "data") data.push(value)
  }
  return { event, id, data: data.length > 0 ? data.join("\n") : undefined }
}

/**
 * Open the legacy `GET /event` stream through the same carrier rules as every
 * other operation, then read frames off the real socket.
 */
export async function openLegacyEventStream(input: {
  readonly baseUrl: string
  readonly directory: string
  readonly onFrame?: (frame: LegacyFrame) => void
}): Promise<LegacyEventStream> {
  const init = legacyRequestInit({
    baseUrl: input.baseUrl,
    path: "/event",
    method: "GET",
    directory: input.directory,
    extraHeaders: { accept: "text/event-stream" },
  })
  const response = await fetch(init.url, { headers: init.headers })
  if (!response.ok) throw new Error(`GET /event failed: ${response.status} ${await response.text()}`)
  if (!response.body) throw new Error("GET /event returned no body stream")

  const frames: LegacyFrame[] = []
  const decoder = new TextDecoder()
  const reader = response.body.getReader()
  let buffer = ""
  let closed = false

  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf("\n\n")
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          if (block.trim().length > 0 && !block.startsWith(":")) {
            const frame = parseFrameBlock(block)
            frames.push(frame)
            input.onFrame?.(frame)
          }
          boundary = buffer.indexOf("\n\n")
        }
      }
    } catch {
      // A closed stream is the normal teardown path.
    } finally {
      closed = true
    }
  })()

  return {
    frames,
    response,
    close() {
      void reader.cancel().catch(() => undefined)
      void pump.catch(() => undefined)
      if (closed) return
    },
  }
}

/** Poll a published readiness signal; never sleep-and-hope. */
export async function waitFor(predicate: () => boolean, message: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${message}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}