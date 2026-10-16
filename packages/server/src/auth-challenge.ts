const BASIC_CHALLENGE = 'Basic realm="Secure Area"'
const BEARER_CHALLENGE = 'Bearer realm="OpenFork"'

// Keep in step with the API prefixes served by the mobile dev proxy. This is
// used only by the unauthenticated catch-all router; typed API middleware marks
// its routes as API directly and does not infer their class from request headers.
const API_PATH_PREFIXES = new Set([
  "agent",
  "api",
  "auth",
  "command",
  "config",
  "devices",
  "event",
  "experimental",
  "file",
  "find",
  "fork",
  "formatter",
  "fs",
  "global",
  "goal",
  "instance",
  "log",
  "lsp",
  "mcp",
  "pair",
  "path",
  "permission",
  "project",
  "provider",
  "pty",
  "question",
  "quota",
  "session",
  "session-group",
  "skill",
  "sync",
  "tool",
  "tui",
  "usage",
  "vcs",
])

export function isApiRequestPath(pathname: string) {
  return API_PATH_PREFIXES.has(pathname.split("/")[1] ?? "")
}

export function isDocumentNavigation(input: {
  method: string
  destination?: string
  mode?: string
  accept?: string
}) {
  return (
    input.method.toUpperCase() === "GET" &&
    input.destination?.toLowerCase() === "document" &&
    input.mode?.toLowerCase() === "navigate" &&
    (input.accept ?? "").toLowerCase().includes("text/html")
  )
}

export function authChallenge(input: { apiRequest: boolean; documentNavigation?: boolean }) {
  // API failures always advertise the supported device-token scheme. Origin
  // can be absent, same-origin (notably the mobile dev proxy), malformed, or
  // rewritten by a proxy, so it is not a safe discriminator for browser fetches.
  if (input.apiRequest || !input.documentNavigation) return BEARER_CHALLENGE
  return BASIC_CHALLENGE
}
