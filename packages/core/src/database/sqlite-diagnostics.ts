const SAFE_SQLITE_CODE = /^[A-Za-z0-9_]+$/

export function sqliteStatementClass(query: string) {
  let source = query.trimStart()
  for (;;) {
    if (source.startsWith("--")) {
      const newline = source.indexOf("\n")
      source = newline < 0 ? "" : source.slice(newline + 1).trimStart()
      continue
    }
    if (source.startsWith("/*")) {
      const end = source.indexOf("*/", 2)
      source = end < 0 ? "" : source.slice(end + 2).trimStart()
      continue
    }
    break
  }
  const keyword = /^[A-Za-z]+/.exec(source)?.[0]?.toUpperCase()
  switch (keyword) {
    case "SELECT":
    case "INSERT":
    case "UPDATE":
    case "DELETE":
    case "REPLACE":
    case "PRAGMA":
    case "EXPLAIN":
    case "ATTACH":
    case "DETACH":
      return keyword
    case "CREATE":
    case "ALTER":
    case "DROP":
    case "REINDEX":
    case "VACUUM":
      return "DDL"
    case "BEGIN":
    case "COMMIT":
    case "END":
    case "ROLLBACK":
    case "SAVEPOINT":
    case "RELEASE":
      return "TRANSACTION"
    case "WITH":
      return "WITH"
    default:
      return "OTHER"
  }
}

export function sqliteNativeCode(cause: unknown, depth = 0): string | undefined {
  if (typeof cause !== "object" || cause === null || depth > 2) return undefined
  const value = cause as { code?: unknown; errno?: unknown; cause?: unknown }
  if (typeof value.code === "string" && value.code.length <= 80 && SAFE_SQLITE_CODE.test(value.code)) return value.code
  if (typeof value.errno === "number" && Number.isFinite(value.errno)) return `ERRNO_${value.errno}`
  return sqliteNativeCode(value.cause, depth + 1)
}

/**
 * Includes only operation class and native error code. SQL text and bound
 * parameter values intentionally never enter logs/errors.
 */
export function sqliteExecutionFailureMessage(cause: unknown, query: string) {
  const code = sqliteNativeCode(cause)
  return `Failed to execute statement class=${sqliteStatementClass(query)}${code ? ` sqlite=${code}` : ""}`
}

function nativeRecord(cause: unknown, depth = 0): Record<string, unknown> | undefined {
  if (typeof cause !== "object" || cause === null) return undefined
  const direct: Record<string, unknown> = {}
  for (const key of ["name", "code", "errno", "message", "cause"] as const) {
    const value = Reflect.get(cause, key)
    if (value !== undefined) direct[key] = value
  }
  if (direct.code !== undefined || direct.errno !== undefined || depth >= 2 || direct.cause === undefined) return direct
  const nested = nativeRecord(direct.cause, depth + 1)
  return nested ? { ...direct, ...nested } : direct
}

function safeNativeMessage(cause: unknown) {
  const message = nativeRecord(cause)?.message
  if (typeof message !== "string") return undefined
  return message
    .replace(/'(?:''|[^'])*'/g, "'[redacted]'")
    .replace(/"(?:""|[^"])*"/g, '"[redacted]"')
    .slice(0, 512)
}

/** Structured, bounded diagnostic fields; never contains SQL or bind values. */
export function sqliteFailureLogFields(cause: unknown, query: string) {
  const native = nativeRecord(cause)
  const code = sqliteNativeCode(cause)
  const message = safeNativeMessage(cause)
  return {
    operation: "execute",
    statementClass: sqliteStatementClass(query),
    cause: {
      ...(typeof native?.name === "string" ? { name: native.name.slice(0, 80) } : {}),
      ...(code ? { code } : {}),
      ...(typeof native?.errno === "number" && Number.isFinite(native.errno) ? { errno: native.errno } : {}),
      ...(message ? { message } : {}),
    },
  }
}