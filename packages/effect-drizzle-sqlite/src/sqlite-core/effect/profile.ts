import { createHmac, randomBytes } from "node:crypto"

type QueryMetadata = {
  readonly type: "select" | "update" | "delete" | "insert"
  readonly tables: string[]
}

type Site = {
  readonly key: string
  readonly fingerprint: string
  readonly operation: string
  readonly queryType?: QueryMetadata["type"]
  readonly tables: readonly string[]
  readonly caller: string
}

/** Opt-in diagnostic; emits bounded query aggregates, never SQL or bind values. */
const enabled = process.env.EFFECT_DRIZZLE_SQLITE_PROFILE === "1"
const WINDOW_MS = 5_000
const GROUP_LIMIT = 128
const originLimit = 256
const key = enabled ? randomBytes(32) : undefined
const origins = new Map<string, string>()
const groups = new Map<string, { count: number; totalMs: number; maxMs: number; rows: number; maxRows: number; site: Site }>()
let timer: ReturnType<typeof setTimeout> | undefined

function repositoryCaller() {
  for (const frame of new Error().stack?.split("\n").slice(1) ?? []) {
    const normalized = frame.replaceAll("\\", "/")
    const index = normalized.lastIndexOf("/packages/")
    if (index < 0 || normalized.includes("/packages/effect-drizzle-sqlite/")) continue
    return normalized.slice(index + 1).trim().slice(0, 240)
  }
  return "unknown"
}

export function captureSqliteQuerySite(
  query: string,
  operation: string,
  metadata: QueryMetadata | undefined,
): Site | undefined {
  if (!enabled || !key) return undefined
  const fingerprint = createHmac("sha256", key).update(query).digest("hex").slice(0, 16)
  let caller = origins.get(fingerprint)
  if (!caller) {
    caller = repositoryCaller()
    origins.set(fingerprint, caller)
    if (origins.size > originLimit) origins.delete(origins.keys().next().value!)
  }
  const tables = [...(metadata?.tables ?? [])].sort()
  return {
    key: `${fingerprint}:${operation}:${caller}`,
    fingerprint,
    operation,
    ...(metadata ? { queryType: metadata.type } : {}),
    tables,
    caller,
  }
}

export function recordSqliteQuerySuccess(site: Site | undefined, durationMs: number, rows: number) {
  if (!site) return
  const current = groups.get(site.key)
  if (current) {
    current.count++
    current.totalMs += durationMs
    current.maxMs = Math.max(current.maxMs, durationMs)
    current.rows += rows
    current.maxRows = Math.max(current.maxRows, rows)
  } else if (groups.size < GROUP_LIMIT - 1) {
    groups.set(site.key, { count: 1, totalMs: durationMs, maxMs: durationMs, rows, maxRows: rows, site })
  } else {
    const overflowKey = "<overflow>"
    const overflow = groups.get(overflowKey)
    if (overflow) {
      overflow.count++
      overflow.totalMs += durationMs
      overflow.maxMs = Math.max(overflow.maxMs, durationMs)
      overflow.rows += rows
      overflow.maxRows = Math.max(overflow.maxRows, rows)
    } else {
      groups.set(overflowKey, {
        count: 1,
        totalMs: durationMs,
        maxMs: durationMs,
        rows,
        maxRows: rows,
        site: {
          key: overflowKey,
          fingerprint: "<overflow>",
          operation: "mixed",
          tables: [],
          caller: "mixed",
        },
      })
    }
  }
  if (timer) return
  timer = setTimeout(() => {
    timer = undefined
    if (groups.size === 0) return
    const summary = [...groups.values()]
      .sort((left, right) => right.totalMs - left.totalMs)
      .slice(0, 20)
      .map(({ site: { fingerprint, operation, queryType, tables, caller }, count, totalMs, maxMs, rows, maxRows }) => ({
        fingerprint,
        operation,
        queryType,
        tables,
        caller,
        count,
        totalMs: Math.round(totalMs * 10) / 10,
        maxMs: Math.round(maxMs * 10) / 10,
        rows,
        maxRows,
      }))
    groups.clear()
    console.info("[sqlite-profile] successful query summary", summary)
  }, WINDOW_MS)
  timer.unref?.()
}
