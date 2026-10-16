export type BackgroundServiceFetch = (
  input: URL,
  init: RequestInit,
) => Promise<Pick<Response, "ok" | "status">>

export async function waitForBackgroundService(
  input: { url: string; username: string; password: string },
  options: {
    fetcher?: BackgroundServiceFetch
    timeoutMs?: number
    intervalMs?: number
    now?: () => number
    sleep?: (ms: number) => Promise<void>
  } = {},
) {
  const timeoutMs = options.timeoutMs ?? 5_000
  const intervalMs = options.intervalMs ?? 250
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const fetcher = options.fetcher ?? fetch
  const deadline = now() + timeoutMs
  const authorization = `Basic ${Buffer.from(`${input.username}:${input.password}`).toString("base64")}`
  let lastStatus: number | undefined
  let lastError: unknown

  while (now() < deadline) {
    const remaining = deadline - now()
    try {
      const response = await fetcher(new URL("/global/health", `${input.url.replace(/\/$/, "")}/`), {
        headers: { accept: "application/json", authorization },
        signal: AbortSignal.timeout(Math.max(1, Math.min(1_000, remaining))),
      })
      if (response.ok) return
      lastStatus = response.status
      lastError = undefined
    } catch (error) {
      lastError = error
    }

    const delay = Math.min(intervalMs, deadline - now())
    if (delay > 0) await sleep(delay)
  }

  const detail = lastStatus === undefined ? (lastError instanceof Error ? lastError.message : String(lastError ?? "no response")) : `HTTP ${lastStatus}`
  throw new Error(`Background service at ${new URL(input.url).origin} did not pass /global/health within ${timeoutMs} ms (${detail})`)
}
