/**
 * JSON-RPC transport incidents shared by the legacy full server and the
 * lightweight host listener. Never invent a success response for malformed
 * notifications; an incident ID is a bounded diagnostic, not a commit proof.
 */
export function projectInternalErrorBody(request: unknown, incidentID: string): unknown | undefined {
  const project = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const row = value as Record<string, unknown>
    if (row.jsonrpc !== "2.0" || typeof row.method !== "string") return undefined
    if (!Object.prototype.hasOwnProperty.call(row, "id")) return undefined
    const id = row.id
    if (id !== null && typeof id !== "string" && typeof id !== "number") return undefined
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: `Unexpected OXP transport failure recorded as ${incidentID}; query openfork_diagnostics with incidentID=${incidentID}.`,
      },
    }
  }
  if (Array.isArray(request)) {
    const replies = request.flatMap((item) => {
      const answer = project(item)
      return answer === undefined ? [] : [answer]
    })
    return replies.length > 0 ? replies : undefined
  }
  return project(request)
}
