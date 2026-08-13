export type SearchDeadlineOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "user" }
  | { kind: "timeout" }

// Settle `request` within `deadlineMs` or abort `controller` with
// `timeoutReason`. One signal, one timer — no AbortSignal.any, so no browser
// support question. A no-arg `abort()` (user cancel, reason is an AbortError)
// and the deadline abort (marker reason) are distinguished by `signal.reason`
// identity; genuine failures are rethrown so the caller's error state fires.
export async function searchWithDeadline<T>(
  controller: AbortController,
  deadlineMs: number,
  timeoutReason: unknown,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<SearchDeadlineOutcome<T>> {
  const deadline = setTimeout(() => controller.abort(timeoutReason), deadlineMs)
  try {
    return { kind: "ok", value: await request(controller.signal) }
  } catch (cause) {
    if (controller.signal.reason === timeoutReason) return { kind: "timeout" }
    if (controller.signal.aborted) return { kind: "user" }
    throw cause
  } finally {
    clearTimeout(deadline)
  }
}
