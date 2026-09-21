export const POLL_FRESH_MS = 95_000
const MAX_METRICS_BYTES = 256 * 1024
const MAX_STATUS_BYTES = 64 * 1024
const MAX_READY_BYTES = 4 * 1024

export type TunnelHealth = {
  pollErrors: number | null
  uptimeSeconds: number | null
  route: string | null
  probe: string | null
  clientVersion: string | null
}

type PollHealth = { lastSuccessMs: number | null; polls: number | null; errors: number | null }

export function readMetric(text: string, name: string): number | null {
  let total: number | null = null
  for (const line of text.split("\n")) {
    if (line.startsWith("#")) continue
    const trimmed = line.trim()
    if (!trimmed.startsWith(name)) continue
    const rest = trimmed.slice(name.length)
    if (rest !== "" && rest[0] !== " " && rest[0] !== "{") continue
    const sample = rest.replace(/^\{[^}]*\}/, "").trim().split(/\s+/)[0]
    if (!sample) continue
    const value = Number(sample)
    if (!Number.isFinite(value)) continue
    total = (total ?? 0) + value
  }
  return total
}

function parsePollHealth(metrics: string): PollHealth {
  const seconds = readMetric(metrics, "commands_poll_last_successful_timestamp_seconds")
  return {
    lastSuccessMs: seconds !== null && seconds > 0 ? Math.round(seconds * 1000) : null,
    polls: readMetric(metrics, "commands_poll_cycles_total"),
    errors: readMetric(metrics, "commands_poll_errors_total"),
  }
}

export async function boundedResponseText(response: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    return null
  }
  if (!response.body) return ""
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let output = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      output += decoder.decode(value, { stream: true })
    }
    return output + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

async function fetchText(url: string, maxBytes: number, timeoutMs = 3000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "*/*" } })
    if (!response.ok) return null
    return await boundedResponseText(response, maxBytes)
  } catch {
    return null
  }
}

export async function readPollHealth(base: string): Promise<PollHealth | null> {
  const text = await fetchText(`${base}/metrics`, MAX_METRICS_BYTES)
  if (text === null || readMetric(text, "commands_poll_last_successful_timestamp_seconds") === null) return null
  return parsePollHealth(text)
}

export async function readClientStatus(base: string) {
  const text = await fetchText(`${base}/api/status`, MAX_STATUS_BYTES)
  if (text === null) return null
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    const channels = Array.isArray(raw.channels) ? raw.channels : []
    const main = channels.find(
      (item) => item && typeof item === "object" && (item as Record<string, unknown>).name === "main",
    ) as Record<string, unknown> | undefined
    const string = (value: unknown) => (typeof value === "string" && value ? value : null)
    const route = raw.control_plane_route && typeof raw.control_plane_route === "object"
      ? (raw.control_plane_route as Record<string, unknown>)
      : {}
    const target = string(route.target)
    const mode = string(route.route_mode)
    const proxy = string(route.proxy_source)
    return {
      version: string(raw.version),
      probe: string(main?.probe_status),
      uptimeSeconds: typeof raw.uptime_seconds === "number" ? raw.uptime_seconds : null,
      route: target ? `${target} · ${proxy && proxy !== "none" ? `via ${proxy}` : (mode ?? "direct")}` : null,
    }
  } catch {
    return null
  }
}

export async function probeReady(base: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(3000) })
    const body = await boundedResponseText(response, MAX_READY_BYTES)
    const detail = body === null ? "Tunnel health response exceeded the allowed size." : body.trim().slice(0, 400)
    return { ok: response.ok, detail }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

export function ago(at: number | null, now = Date.now()) {
  if (at === null) return "never"
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 3) return "just now"
  if (seconds < 90) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}
