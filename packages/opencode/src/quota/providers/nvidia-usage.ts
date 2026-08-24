export const NVIDIA_LIMIT_PER_MINUTE = 40
export const NVIDIA_WINDOW_MS = 60_000

let windowStart = Date.now()
let requestCount = 0

export function trackNvidiaRequest(now = Date.now()) {
  resetExpiredWindow(now)
  requestCount++
}

export function resetNvidiaUsage(now = Date.now()) {
  windowStart = now
  requestCount = 0
}

export function nvidiaUsage(now = Date.now()) {
  resetExpiredWindow(now)
  return {
    requestCount,
    windowStart,
    resetAt: windowStart + NVIDIA_WINDOW_MS,
  }
}

function resetExpiredWindow(now: number) {
  if (now - windowStart < NVIDIA_WINDOW_MS) return
  windowStart = now
  requestCount = 0
}
