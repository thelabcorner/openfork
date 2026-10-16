import * as LSPClient from "./client"

const MAX_PER_FILE = 20
const MAX_METADATA_PER_FILE = 20
const MAX_METADATA_DIAGNOSTICS = 100
const MAX_METADATA_BYTES = 64 * 1024
const MAX_METADATA_MESSAGE = 2_000

/**
 * Project the live workspace diagnostic map onto the files changed by a tool
 * and cap the persisted representation. LSP servers may report diagnostics
 * for every file in a workspace, and tool metadata becomes durable session
 * history; keeping the live map here would multiply that payload on every edit.
 */
export function metadataForFiles(
  files: readonly string[],
  diagnostics: Record<string, LSPClient.Diagnostic[]>,
): Record<string, LSPClient.Diagnostic[]> {
  const result: Record<string, LSPClient.Diagnostic[]> = {}
  const encoder = new TextEncoder()
  let count = 0
  let bytes = 2 // JSON object braces

  for (const file of new Set(files)) {
    const items = diagnostics[file]
    if (!items?.length) continue
    const kept: LSPClient.Diagnostic[] = []
    const fileBytes = encoder.encode(JSON.stringify(file)).byteLength + 1 // key quotes and colon
    for (const item of items.slice(0, MAX_METADATA_PER_FILE)) {
      if (count >= MAX_METADATA_DIAGNOSTICS) break
      const projected: LSPClient.Diagnostic = {
        range: item.range,
        message: item.message.slice(0, MAX_METADATA_MESSAGE),
        ...(item.severity !== undefined ? { severity: item.severity } : {}),
        ...(item.code !== undefined ? { code: item.code } : {}),
        ...(item.source !== undefined ? { source: item.source.slice(0, 128) } : {}),
      }
      const size = encoder.encode(JSON.stringify(projected)).byteLength
      const separatorBytes = kept.length > 0 || Object.keys(result).length > 0 ? 1 : 0
      const entryBytes = kept.length === 0 ? fileBytes + 2 : 0 // include the diagnostics array brackets
      if (bytes + entryBytes + separatorBytes + size > MAX_METADATA_BYTES) break
      kept.push(projected)
      count++
      bytes += size + entryBytes + separatorBytes
    }
    if (kept.length) result[file] = kept
    if (count >= MAX_METADATA_DIAGNOSTICS || bytes >= MAX_METADATA_BYTES) break
  }

  return result
}

export function pretty(diagnostic: LSPClient.Diagnostic) {
  const severityMap = {
    1: "ERROR",
    2: "WARN",
    3: "INFO",
    4: "HINT",
  }

  const severity = severityMap[diagnostic.severity || 1]
  const line = diagnostic.range.start.line + 1
  const col = diagnostic.range.start.character + 1

  return `${severity} [${line}:${col}] ${diagnostic.message}`
}

export function report(file: string, issues: LSPClient.Diagnostic[]) {
  const errors = issues.filter((item) => item.severity === 1)
  if (errors.length === 0) return ""
  const limited = errors.slice(0, MAX_PER_FILE)
  const more = errors.length - MAX_PER_FILE
  const suffix = more > 0 ? `\n... and ${more} more` : ""
  return `<diagnostics file="${file}">\n${limited.map(pretty).join("\n")}${suffix}\n</diagnostics>`
}

export * as Diagnostic from "./diagnostic"
