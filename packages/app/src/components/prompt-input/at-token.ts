import { splitExternalToken } from "./external-path-search"

export function resolveAtToken(beforeCursor: string): { token: string; start: number } | undefined {
  const simple = beforeCursor.match(/@(\S*)$/)
  if (simple) return { token: simple[1], start: simple.index ?? beforeCursor.length - simple[0].length }
  // External paths may contain spaces ("@C:\Program Files\..."): keep the token
  // alive when the run before the first space is already external-path shaped.
  const loose = beforeCursor.match(/@([^\n]*)$/)
  if (!loose) return undefined
  const token = loose[1]
  const head = token.split(/\s/, 1)[0] ?? ""
  if (!head || !splitExternalToken(head)) return undefined
  return { token, start: loose.index ?? 0 }
}
