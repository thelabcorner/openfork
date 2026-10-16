/** Only surface server-authored, redacted title errors, not raw provider errors. */
export function sessionTitleErrorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const data = "data" in error ? error.data : undefined
  if (!data || typeof data !== "object") return undefined
  if (!("service" in data) || data.service !== "session-title") return undefined
  const message = "message" in data ? data.message : undefined
  return typeof message === "string" && message.trim().length > 0 && message.length <= 300
    ? message
    : undefined
}