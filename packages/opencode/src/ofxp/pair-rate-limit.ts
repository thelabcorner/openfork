export const PAIR_WINDOW_MS = 60_000
export const PAIR_PER_SOURCE = 12
export const PAIR_GLOBAL = 96
export const MAX_RATE_SOURCES = 512

type RateRow = {
  start: number
  count: number
  used: number
}

function normalizeMappedIpv4(value: string) {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value)
  if (!mapped) return value
  const octets = mapped[1]!.split(".").map(Number)
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return value
  return octets.join(".")
}

/**
 * Normalize the transport-derived network source used for public pairing
 * admission. This value must never include an attacker-controlled peer ID.
 */
export function sourceKey(remoteAddress: string | undefined) {
  const value = remoteAddress?.trim().toLowerCase()
  if (!value) return "unknown"
  const zone = value.indexOf("%")
  return normalizeMappedIpv4(zone === -1 ? value : value.slice(0, zone))
}

/**
 * Process-local pairing bootstrap limiter.
 *
 * The source bucket is keyed only by the transport-derived network address.
 * A process-global window independently caps aggregate work. Source rows are
 * bounded and least-recently-used rows are evicted after stale rows are pruned.
 */
export class PairRateLimiter {
  private readonly sources = new Map<string, RateRow>()
  private global: RateRow = { start: 0, count: 0, used: 0 }
  private sequence = 0

  constructor(
    private readonly windowMs = PAIR_WINDOW_MS,
    private readonly perSource = PAIR_PER_SOURCE,
    private readonly globalLimit = PAIR_GLOBAL,
    private readonly maxSources = MAX_RATE_SOURCES,
  ) {}

  get sourceCount() {
    return this.sources.size
  }

  allow(remoteAddress: string | undefined, now = Date.now()) {
    const source = sourceKey(remoteAddress)
    if (now - this.global.start >= this.windowMs) this.global = { start: now, count: 0, used: ++this.sequence }
    if (this.global.count >= this.globalLimit) return false

    let row = this.sources.get(source)
    if (!row || now - row.start >= this.windowMs) {
      row = { start: now, count: 0, used: ++this.sequence }
      this.sources.set(source, row)
    } else {
      row.used = ++this.sequence
    }
    if (row.count >= this.perSource) return false

    row.count++
    this.global.count++
    this.trim(now)
    return true
  }

  private trim(now: number) {
    if (this.sources.size <= this.maxSources) return

    for (const [key, row] of this.sources) {
      if (now - row.start >= this.windowMs) this.sources.delete(key)
    }
    if (this.sources.size <= this.maxSources) return

    const remove = [...this.sources.entries()]
      .sort((a, b) => a[1].used - b[1].used || a[0].localeCompare(b[0]))
      .slice(0, this.sources.size - this.maxSources)
    for (const [key] of remove) this.sources.delete(key)
  }
}
