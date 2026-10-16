export const POLL_FRESH_MS = 95_000
const MAX_METRICS_BYTES = 256 * 1024
const MAX_READY_BYTES = 4 * 1024

export type TunnelHealth = {
  pollErrors: number | null
  uptimeSeconds: number | null
  route: string | null
  probe: string | null
  clientVersion: string | null
}

type PollHealth = {
  lastSuccessMs: number | null
  polls: number | null
  errors: number | null
  uptimeSeconds: number | null
}

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

export function parsePollHealth(metrics: string, now = Date.now()): PollHealth | null {
  const values = new Map<string, number>()
  const names = new Set([
    "commands_poll_last_successful_timestamp_seconds",
    "commands_poll_cycles_total",
    "commands_poll_errors_total",
    "process_start_time_seconds",
  ])
  for (const line of metrics.split("\n")) {
    if (!line || line.startsWith("#")) continue
    const separator = line.search(/[ {]/)
    if (separator < 1) continue
    const name = line.slice(0, separator)
    if (!names.has(name)) continue
    const rest = line.slice(separator)
    const sample = rest.replace(/^\{[^}]*\}/, "").trim().split(/\s+/)[0]
    if (!sample) continue
    const value = Number(sample)
    if (!Number.isFinite(value)) continue
    values.set(name, (values.get(name) ?? 0) + value)
  }
  const seconds = values.get("commands_poll_last_successful_timestamp_seconds")
  if (seconds === undefined) return null
  const processStarted = values.get("process_start_time_seconds")
  return {
    lastSuccessMs: seconds > 0 ? Math.round(seconds * 1000) : null,
    polls: values.get("commands_poll_cycles_total") ?? null,
    errors: values.get("commands_poll_errors_total") ?? null,
    uptimeSeconds: processStarted === undefined ? null : Math.max(0, Math.floor(now / 1000 - processStarted)),
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
  return text === null ? null : parsePollHealth(text)
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
