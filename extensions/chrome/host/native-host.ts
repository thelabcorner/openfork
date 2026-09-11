// Node/Bun native host — stdio bridge for com.opencode.desktop.
// Chrome launches this process per extension connectNative; it speaks native messaging
// framing (32-bit LE length + UTF-8 JSON) on stdin/stdout and bridges to the desktop
// app over the BrowserHost loopback HTTP (callbackUrl + Bearer token).
//
// Topology is duplex:
//   extension -> native stdio -> BrowserHost /v1/browser/request (extension-initiated diagnostics)
//   BrowserHost -> authenticated long-poll -> native stdio -> extension (normal browser_* control)
//   extension response -> native stdio -> BrowserHost /v1/browser/extension/response
//
// Limits: host->ext 1 MiB, ext->host 64 MiB. Browser requests are small in the
// 1 MiB direction; screenshot payloads travel in the larger extension->host direction.
// Mirror Codex (com.openai.codexextension at ~/.codex/plugins/cache...) and
// Claude (com.anthropic.claude_code_browser_extension) patterns.

import { existsSync, readFileSync } from "node:fs"

const NATIVE_HOST_NAME = "com.opencode.desktop"
const MAX_HOST_TO_EXT = 1 * 1024 * 1024
const MAX_EXT_TO_HOST = 64 * 1024 * 1024
const HEADER_BYTES = 4
const RELAY_POLL_MS = 20_000
const RELAY_RETRY_MS = 500

class FramingError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message)
    this.name = "FramingError"
  }
}

function encodeNativeMessage(value: unknown): Buffer {
  const json = JSON.stringify(value)
  const payload = Buffer.from(json, "utf8")
  if (payload.byteLength > MAX_HOST_TO_EXT) {
    throw new FramingError(`Native message ${payload.byteLength} exceeds host->ext limit ${MAX_HOST_TO_EXT}`, "too_large")
  }
  const out = Buffer.allocUnsafe(HEADER_BYTES + payload.byteLength)
  out.writeUInt32LE(payload.byteLength, 0)
  payload.copy(out, HEADER_BYTES)
  return out
}

// Incremental stdin reader — yields complete JSON messages.
class NativeMessageReader {
  private buf = Buffer.alloc(0)
  push(chunk: Buffer): unknown[] {
    this.buf = Buffer.concat([this.buf, chunk])
    const msgs: unknown[] = []
    while (this.buf.byteLength >= HEADER_BYTES) {
      const len = this.buf.readUInt32LE(0)
      if (len > MAX_EXT_TO_HOST) throw new FramingError(`Frame ${len} exceeds ext->host limit`, "too_large")
      const needed = HEADER_BYTES + len
      if (this.buf.byteLength < needed) break
      const json = this.buf.subarray(HEADER_BYTES, needed).toString("utf8")
      msgs.push(JSON.parse(json) as unknown)
      this.buf = this.buf.subarray(needed)
    }
    return msgs
  }
}

function log(msg: string, meta?: Record<string, unknown>) {
  // Native host must NOT write to stdout (that's the message channel); use stderr
  console.error(`[native-host] ${msg}`, meta ? JSON.stringify(meta) : "")
}

// ---- desktop bridge HTTP config ----
// The desktop app writes its BrowserHost callbackUrl + token to a well-known file
// that this host reads. Alternative is argv via manifest path wrapper — we support both.
//
// Env/file discovery order:
// 1. OPENCODE_BROWSER_CALLBACK_URL + OPENCODE_BROWSER_CALLBACK_TOKEN env
// 2. File at platform-specific state dir: {userDataPath}/opencode-browser.json  (desktop writes on BrowserHost.start())
// 3. Fallback WS port discovery via storage — not needed for native primary.

interface HostConfig {
  callbackUrl: string
  callbackToken: string
}

function loadHostConfig(): HostConfig | null {
  const envUrl = process.env.OPENCODE_BROWSER_CALLBACK_URL
  const envToken = process.env.OPENCODE_BROWSER_CALLBACK_TOKEN
  if (envUrl && envToken) return { callbackUrl: envUrl, callbackToken: envToken }

  // Try reading from well-known file locations (desktop writes this)
  // On macOS/Linux: $XDG_STATE_HOME or ~/.local/state/opencode / ~/Library/Application Support/opencode
  // We probe a few candidates; the desktop installer ensures one exists.
  const candidates: string[] = []
  const xdgState = process.env.XDG_STATE_HOME
  if (xdgState) candidates.push(`${xdgState}/opencode/browser-host.json`)
  const home = process.env.HOME ?? process.env.USERPROFILE
  if (home) {
    candidates.push(`${home}/.local/state/opencode/browser-host.json`)
    candidates.push(`${home}/Library/Application Support/opencode/browser-host.json`)
    candidates.push(`${home}/AppData/Roaming/opencode/browser-host.json`)
  }
  // Also try relative to executable
  candidates.push("./browser-host.json")

  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue
      const data = JSON.parse(readFileSync(p, "utf8")) as HostConfig
      if (data.callbackUrl && data.callbackToken) return data
    } catch {}
  }
  return null
}

async function forwardToDesktop(request: unknown): Promise<unknown> {
  const cfg = loadHostConfig()
  if (!cfg) {
    return { ok: false, requestId: (request as Record<string, unknown>)?.requestId ?? "", elapsedMs: 0, error: { tag: "BrowserHostUnavailable", message: "Desktop BrowserHost not reachable — is the desktop app running?", retryable: true } }
  }
  const url = `${cfg.callbackUrl}/v1/browser/request`
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.callbackToken}`,
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`desktop responded ${res.status}: ${text.slice(0, 500)}`)
  }
  return (await res.json()) as unknown
}

async function postRelay(path: string, body: unknown, cfg = loadHostConfig()): Promise<Response | null> {
  if (!cfg) return null
  return fetch(`${cfg.callbackUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.callbackToken}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  })
}

async function forwardResponseToDesktop(response: unknown): Promise<void> {
  const res = await postRelay("/v1/browser/extension/response", { response })
  if (!res?.ok) throw new Error(`extension response relay failed: ${res?.status ?? "no desktop"}`)
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function runDesktopRelay(origin: string, signal: AbortSignal): Promise<void> {
  let registeredConfig = ""
  while (!signal.aborted) {
    const cfg = loadHostConfig()
    if (!cfg) {
      registeredConfig = ""
      await sleep(RELAY_RETRY_MS)
      continue
    }
    const configKey = `${cfg.callbackUrl}\n${cfg.callbackToken}`
    try {
      if (registeredConfig !== configKey) {
        const hello = await postRelay("/v1/browser/extension/hello", {
          hostName: NATIVE_HOST_NAME,
          origin,
          pid: process.pid,
          transport: "nativeMessaging+http-long-poll",
        }, cfg)
        if (!hello?.ok) throw new Error(`desktop relay hello failed: ${hello?.status ?? "unreachable"}`)
        registeredConfig = configKey
        log("desktop relay connected", { callbackUrl: cfg.callbackUrl })
      }

      const poll = await fetch(`${cfg.callbackUrl}/v1/browser/extension/poll?waitMs=${RELAY_POLL_MS}`, {
        headers: { authorization: `Bearer ${cfg.callbackToken}` },
        signal: AbortSignal.timeout(RELAY_POLL_MS + 5_000),
      })
      if (!poll.ok) throw new Error(`desktop relay poll failed: ${poll.status}`)
      const payload = await poll.json() as { message?: unknown }
      if (payload.message) process.stdout.write(encodeNativeMessage(payload.message))
    } catch (error) {
      registeredConfig = ""
      if (!signal.aborted) {
        log("desktop relay retry", { error: String(error) })
        await sleep(RELAY_RETRY_MS)
      }
    }
  }
}

// ---- main loop ----

async function main() {
  const reader = new NativeMessageReader()
  // Handle argv[2] being the chrome-extension origin (Chrome passes origin as first arg)
  const origin = process.argv[2] ?? ""
  if (origin) log("started", { origin, hostName: NATIVE_HOST_NAME })

  const relayController = new AbortController()
  void runDesktopRelay(origin, relayController.signal)

  // Send hello_ack immediately so extension knows we're alive
  process.stdout.write(encodeNativeMessage({ type: "hello_ack", accepted: true, hostId: "native-host" }))

  process.stdin.on("data", (chunk: Buffer) => {
    let messages: unknown[]
    try {
      messages = reader.push(chunk)
    } catch (e) {
      log("framing error", { error: String(e) })
      try {
        process.stdout.write(encodeNativeMessage({ type: "error", code: "BrowserOperationFailed", message: String(e) }))
      } catch {}
      return
    }
    for (const raw of messages) {
      void handleMessage(raw)
    }
  })

  process.stdin.on("end", () => {
    relayController.abort()
    log("stdin ended — exiting")
    void Promise.race([
      postRelay("/v1/browser/extension/disconnect", { reason: "native messaging stdin ended", pid: process.pid }).catch(() => null),
      sleep(100).then(() => null),
    ]).finally(() => process.exit(0))
  })
  process.stdin.on("error", (e) => {
    relayController.abort()
    log("stdin error", { error: String(e) })
    void Promise.race([
      postRelay("/v1/browser/extension/disconnect", { reason: `native messaging stdin error: ${String(e)}`, pid: process.pid }).catch(() => null),
      sleep(100).then(() => null),
    ]).finally(() => process.exit(1))
  })
  // Keep process alive — stdin is the lifeline; Chrome kills us when Port disconnects
  process.stdin.resume()
}

async function handleMessage(raw: unknown) {
  const msg = raw as Record<string, unknown>
  if (!msg || typeof msg !== "object") return
  switch (msg.type) {
    case "hello": {
      log("hello from extension", { extensionId: msg.extensionId, version: msg.version })
      try {
        process.stdout.write(encodeNativeMessage({ type: "hello_ack", accepted: true, hostId: "native-host" }))
      } catch {}
      break
    }
    case "ping": {
      try {
        process.stdout.write(encodeNativeMessage({ type: "pong", nonce: msg.nonce }))
      } catch {}
      break
    }
    case "request": {
      const request = msg.request as Record<string, unknown>
      const requestId = (request?.requestId as string) ?? ""
      try {
        const response = await forwardToDesktop(request)
        process.stdout.write(encodeNativeMessage({ type: "response", response }))
      } catch (e) {
        const errResp = { ok: false, requestId, elapsedMs: 0, error: { tag: "BrowserHostUnavailable", message: String(e), retryable: true } }
        try {
          process.stdout.write(encodeNativeMessage({ type: "response", response: errResp }))
        } catch {}
        log("forward failed", { requestId, error: String(e) })
      }
      break
    }
    case "response": {
      try {
        await forwardResponseToDesktop(msg.response)
      } catch (e) {
        log("response relay failed", { error: String(e) })
      }
      break
    }
    case "abort": {
      // Best-effort — desktop host handles abort via its own abort endpoint
      const cfg = loadHostConfig()
      if (cfg && msg.requestId) {
        const abortUrl = `${cfg.callbackUrl}/v1/browser/request/${msg.requestId}/abort`
        void fetch(abortUrl, { method: "POST", headers: { authorization: `Bearer ${cfg.callbackToken}` } }).catch(() => {})
      }
      break
    }
    case "event": {
      // Forward host events to desktop if needed — for now ack
      try {
        process.stdout.write(encodeNativeMessage({ type: "event_ack", ok: true }))
      } catch {}
      break
    }
    default:
      log("unknown message type", { type: msg.type })
  }
}

// Only run when executed directly (not imported for tests)
if (import.meta.main) {
  void main()
}

export { encodeNativeMessage, NativeMessageReader, FramingError, loadHostConfig, NATIVE_HOST_NAME, MAX_HOST_TO_EXT, MAX_EXT_TO_HOST }
