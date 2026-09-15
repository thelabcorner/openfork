export function mentionSearchEndpointUnavailable(error: unknown) {
  if (!error || typeof error !== "object") return false
  const direct = "status" in error ? Number((error as { status?: unknown }).status) : undefined
  const cause = error instanceof Error && error.cause && typeof error.cause === "object" ? error.cause : undefined
  const caused = cause && "status" in cause ? Number((cause as { status?: unknown }).status) : undefined
  const response = "response" in error && (error as { response?: unknown }).response
  const responded =
    response && typeof response === "object" && "status" in response
      ? Number((response as { status?: unknown }).status)
      : undefined
  const status = direct ?? caused ?? responded
  return status === 404 || status === 405
}
