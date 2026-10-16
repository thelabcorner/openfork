/** Keep every streamed tool-output character in the timeline's canonical part. */
export function appendRunningToolOutput(current: unknown, delta: string) {
  return (typeof current === "string" ? current : "") + delta
}
