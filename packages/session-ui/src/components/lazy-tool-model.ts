/**
 * Presentation-only projection of the stable lazy-tool broker.
 *
 * Runtime authority remains with tool/access.ts; never infer a dispatch or
 * synthesize a contract from a transcript. The broker envelope is not user UI.
 */
type ObjectRecord = Record<string, unknown>

function record(value: unknown): ObjectRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ObjectRecord : {}
}
function str(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export type LazyToolAction = "list" | "describe" | "call"

export function readableToolName(value: unknown) {
  const name = str(value)
  if (!name) return undefined
  if (name === "ofxp") return "OFXP"
  if (name === "oxp") return "OXP"
  if (name === "lsp") return "LSP"
  if (name === "mcp") return "MCP"
  if (name === "sqlite") return "SQLite"
  return name
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .slice(0, 80)
}

export function lazyToolIdentity(input: unknown, metadata?: unknown) {
  const call = record(input)
  const meta = record(metadata)
  const requestedAction = str(call.action) ?? str(meta.brokerAction)
  const action: LazyToolAction = requestedAction === "list" || requestedAction === "describe" ? requestedAction : "call"
  const target = str(meta.delegatedTool) ?? str(meta.tool) ?? str(call.tool)
  const args = record(call.args)
  const operation = str(args.action) ?? str(args.operation) ?? str(args.mode)
  const subject =
    str(args.description) ?? str(args.title) ?? str(args.name) ?? str(args.query) ??
    str(args.path) ?? str(args.sessionID) ?? str(args.taskID)
  return {
    action, target, name: readableToolName(target),
    operation: readableToolName(operation),
    subject: subject?.slice(0, 160),
    args,
  }
}

export type LazyCatalogEntry = { id: string; description: string }
export function lazyToolCatalog(output: unknown): LazyCatalogEntry[] {
  if (typeof output !== "string") return []
  // The backend list result is a simple bullet catalog. Bound the scan for
  // pathological/streamed outputs without creating a transcript-side cache.
  const entries: LazyCatalogEntry[] = []
  for (const line of output.slice(0, 262_144).split("\n")) {
    if (entries.length >= 256) break
    const found = /^\s*-\s+([\w.-]{1,80}):\s*(.{1,1024})$/.exec(line)
    if (found) entries.push({ id: found[1]!, description: found[2]!.trim() })
  }
  return entries
}

export type LazyParameter = { name: string; type: string; required: boolean; description?: string }
export function lazyToolDescriptor(output: unknown): { description?: string; parameters: LazyParameter[] } | undefined {
  if (typeof output !== "string" || output.length > 524_288) return
  let parsed: ObjectRecord
  try {
    parsed = record(JSON.parse(output))
  } catch {
    return
  }
  const schema = record(parsed.parameters ?? parsed.inputSchema ?? parsed.schema)
  const properties = record(schema.properties)
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [])
  const parameters = Object.entries(properties).slice(0, 128).map(([name, raw]) => {
    const value = record(raw)
    const kind = str(value.type) ?? (Array.isArray(value.type) ? value.type.filter((v) => typeof v === "string").join(" | ") : undefined)
    return { name, type: kind ?? (value.anyOf ? "union" : "value"), required: required.has(name), description: str(value.description)?.slice(0, 220) }
  })
  // Long tool instructions belong in opt-in raw output, not the compact card.
  return { description: str(parsed.description)?.slice(0, 320), parameters }
}

/** Never place broker verification material or secrets in the public param strip. */
export function lazyVisibleArgs(input: unknown): Record<string, unknown> {
  const value = record(input)
  const result: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (Object.keys(result).length >= 12) break
    if (/contract|secret|token|passw|credential|api.?key|authorization|cookie|private.?key/i.test(key)) continue
    if (typeof raw === "string" && raw.length <= 160) result[key] = raw
    else if (typeof raw === "number" || typeof raw === "boolean") result[key] = raw
  }
  return result
}
