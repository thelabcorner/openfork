/**
 * Mints the persistent dev tooling token, reusing the existing one whenever it
 * still works.
 *
 * Split out from the Electron main process so it can be tested against a real
 * HTTP server without booting Electron — the whole reason this token exists is
 * that untested plumbing here is invisible until something is badly broken.
 */
import { deviceAuthorization, readAgentToken, writeAgentToken, type DevAgentToken } from "./agent-token"
import { AGENT_DEVICE_NAME, AGENT_TOKEN_VERSION } from "./constants"

/** Cheap, authenticated, and side-effect free: a 401 here means the token is dead. */
const PROBE_PATH = "/config"

export type ProvisionOutcome =
  | { ok: true; reused: boolean; token: DevAgentToken }
  | { ok: false; reason: "begin-failed" | "claim-failed" | "write-failed"; detail: string }

export type ProvisionOptions = {
  file: string
  url: string
  username: string
  password: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  onLog?: (message: string, meta?: Record<string, unknown>) => void
}

function basic(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

export async function tokenStillWorks(input: {
  url: string
  token: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}) {
  const fetchImpl = input.fetchImpl ?? fetch
  try {
    const response = await fetchImpl(new URL(PROBE_PATH, `${input.url.replace(/\/$/, "")}/`), {
      headers: { authorization: deviceAuthorization(input.token), accept: "application/json" },
      signal: AbortSignal.timeout(input.timeoutMs ?? 4000),
    })
    // 401/403 mean the device was forgotten or the database was reset. Anything
    // else — including a 500 — says the credential itself was accepted.
    return response.status !== 401 && response.status !== 403
  } catch {
    // Unreachable is not the same as rejected: keep the token rather than
    // burning a new pairing on a server that is merely still starting.
    return true
  }
}

export async function provisionAgentToken(options: ProvisionOptions): Promise<ProvisionOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 4000
  const base = options.url.replace(/\/$/, "")
  const log = options.onLog ?? (() => {})

  const existing = readAgentToken(options.file)
  if (existing && (await tokenStillWorks({ url: base, token: existing.token, fetchImpl, timeoutMs }))) {
    return { ok: true, reused: true, token: existing }
  }

  let code: string
  try {
    const response = await fetchImpl(new URL("/pair/begin", `${base}/`), {
      method: "POST",
      headers: { authorization: basic(options.username, options.password), "content-type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return { ok: false, reason: "begin-failed", detail: `HTTP ${response.status}` }
    const body = (await response.json()) as { code?: unknown }
    if (typeof body?.code !== "string" || !body.code) {
      return { ok: false, reason: "begin-failed", detail: "no code in response" }
    }
    code = body.code
  } catch (error) {
    return { ok: false, reason: "begin-failed", detail: String(error) }
  }

  let claimed: { token: string; device: { id: string; name: string } }
  try {
    const response = await fetchImpl(new URL("/pair/claim", `${base}/`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, name: AGENT_DEVICE_NAME }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return { ok: false, reason: "claim-failed", detail: `HTTP ${response.status}` }
    const body = (await response.json()) as { token?: unknown; device?: { id?: unknown; name?: unknown } }
    if (typeof body?.token !== "string" || !body.token) {
      return { ok: false, reason: "claim-failed", detail: "no token in response" }
    }
    claimed = {
      token: body.token,
      device: {
        id: typeof body.device?.id === "string" ? body.device.id : "",
        name: typeof body.device?.name === "string" ? body.device.name : AGENT_DEVICE_NAME,
      },
    }
  } catch (error) {
    return { ok: false, reason: "claim-failed", detail: String(error) }
  }

  const token: DevAgentToken = {
    version: AGENT_TOKEN_VERSION,
    token: claimed.token,
    deviceID: claimed.device.id,
    deviceName: claimed.device.name,
    createdAt: new Date().toISOString(),
  }
  try {
    writeAgentToken(options.file, token)
  } catch (error) {
    return { ok: false, reason: "write-failed", detail: String(error) }
  }
  log("minted dev tooling device token", { deviceID: token.deviceID, file: options.file })
  return { ok: true, reused: false, token }
}
