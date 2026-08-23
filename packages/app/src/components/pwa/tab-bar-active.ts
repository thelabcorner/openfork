export type PwaTabKey = "sessions" | "search" | "settings"

export function resolveActiveTab(pathname: string): PwaTabKey | undefined {
  if (pathname === "/") return "sessions"
  if (pathname.startsWith("/server/") || pathname === "/new-session") return "sessions"
  if (pathname.includes("/session/")) return "sessions"
  return undefined
}
