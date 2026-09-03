import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { ZEN_FREE_DAY_MS, zenUtcDayEnd } from "@/usage/zen-free"

export type ZenGovernorState = "READY" | "COOLING_DOWN" | "QUOTA_EXHAUSTED"

export type ZenHitKind = "rate-limit" | "quota" | "transient"

export type ZenHit = {
  model: string | null
  at: number
  resetAt: number | null
  kind: ZenHitKind
}

export type ZenObservation = {
  status?: number
  body?: string
  headers?: Record<string, string | undefined>
  model?: string
  at?: number
}

export type ZenGovernorOptions = {
  persistenceFile?: string
}

const FREE_LIMIT_BODY = /FreeUsageLimitError/
const GO_LIMIT_BODY = /GoUsageLimitError/
const RESET_FIELD_BODY = /"?(?:resetAt|reset_time|resetDate|reset_at)"?\s*:\s*("?[\d.:T\-+Z ]{8,}"?|\d+)/

const UNEXPLAINED_BASE_MS = 2_000
const UNEXPLAINED_RATE_CAP_MS = 15 * 60_000
const TRANSIENT_CAP_MS = 60_000
const MIN_COOLDOWN_MS = 1_000
const JITTER_MS = 1_000
const WINDOW_PRIOR_WEIGHT = 0.35
const WINDOW_HALF_LIFE_MS = 14 * ZEN_FREE_DAY_MS
const MAX_SAMPLES = 8
const MAX_HITS = 50

function headerValue(headers: Record<string, string | undefined> | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && value) return value
  }
  return undefined
}

function parseTimeValue(raw: string, now: number): number | undefined {
  const numeric = Number(raw)
  if (!Number.isNaN(numeric)) {
    // Epoch milliseconds and epoch seconds are absolute; small numbers are a
    // delta in seconds from now.
    if (numeric > 1e12) return numeric
    if (numeric > 1e9) return numeric * 1000
    if (numeric >= 0) return now + numeric * 1000
    return undefined
  }
  const date = Date.parse(raw)
  if (!Number.isNaN(date)) return date
  return undefined
}

export function parseResetAt(
  headers: Record<string, string | undefined> | undefined,
  body: string | undefined,
  now: number,
): number | undefined {
  const retryAfterMs = headerValue(headers, "retry-after-ms")
  if (retryAfterMs) {
    const ms = Number(retryAfterMs)
    if (!Number.isNaN(ms)) return now + ms
  }
  const retryAfter = headerValue(headers, "retry-after")
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (!Number.isNaN(seconds)) return now + seconds * 1000
    const date = Date.parse(retryAfter)
    if (!Number.isNaN(date)) return date
  }
  const rateLimitReset = headerValue(headers, "x-ratelimit-reset")
  if (rateLimitReset) {
    const parsed = parseTimeValue(rateLimitReset, now)
    if (parsed !== undefined) return parsed
  }
  const match = (body ?? "").match(RESET_FIELD_BODY)
  if (match) {
    const parsed = parseTimeValue(match[1].replace(/^"|"$/g, "").trim(), now)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

type WeightedValue = { value: number; weight: number }

function weightedMedian(values: readonly WeightedValue[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a.value - b.value)
  const total = sorted.reduce((sum, item) => sum + item.weight, 0)
  if (!(total > 0)) return null
  let cursor = 0
  for (const item of sorted) {
    cursor += item.weight
    if (cursor >= total / 2) return item.value
  }
  return sorted.at(-1)?.value ?? null
}

function windowWeight(now: number, at: number) {
  return 2 ** (-Math.max(0, now - at) / WINDOW_HALF_LIFE_MS)
}

type Persisted = {
  schema: 1
  state: ZenGovernorState
  resetAt: number | null
  consecutive: number
  lastUnexplainedAt: number | null
  samples: Array<{ at: number; windowMs: number }>
  hits: ZenHit[]
}

function loadPersisted(file: string): Persisted | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Persisted
    if (parsed?.schema !== 1) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * Per-key quota state machine: READY -> COOLING_DOWN -> QUOTA_EXHAUSTED.
 * `resetAt` is the single notion of "when this key comes back" — both the
 * router's failover ordering key and the value surfaced for display.
 */
export class ZenGovernor {
  private readonly persistenceFile: string
  private state: ZenGovernorState = "READY"
  private resetAt: number | undefined
  private consecutive = 0
  private lastUnexplainedAt: number | undefined
  private samples: Array<{ at: number; windowMs: number }> = []
  private hits: ZenHit[] = []
  private failures = 0

  constructor(options: ZenGovernorOptions = {}) {
    this.persistenceFile = options.persistenceFile ?? join(tmpdir(), "opencode-zen", "governor.json")
    const persisted = loadPersisted(this.persistenceFile)
    if (!persisted) return
    if (persisted.state === "QUOTA_EXHAUSTED") {
      this.state = "QUOTA_EXHAUSTED"
    } else if (
      persisted.state === "COOLING_DOWN" &&
      typeof persisted.resetAt === "number" &&
      persisted.resetAt > Date.now()
    ) {
      this.state = "COOLING_DOWN"
      this.resetAt = persisted.resetAt
    }
    this.consecutive = Math.max(0, persisted.consecutive)
    this.lastUnexplainedAt = persisted.lastUnexplainedAt ?? undefined
    this.samples = [...(persisted.samples ?? [])].slice(-MAX_SAMPLES)
    this.hits = [...(persisted.hits ?? [])].slice(-MAX_HITS)
  }

  private persist() {
    try {
      mkdirSync(dirname(this.persistenceFile), { recursive: true })
      const temp = `${this.persistenceFile}.${process.pid}.tmp`
      const stored: Persisted = {
        schema: 1,
        state: this.state,
        resetAt: this.resetAt ?? null,
        consecutive: this.consecutive,
        lastUnexplainedAt: this.lastUnexplainedAt ?? null,
        samples: this.samples,
        hits: this.hits,
      }
      writeFileSync(temp, JSON.stringify(stored))
      renameSync(temp, this.persistenceFile)
    } catch {}
  }

  private pushHit(hit: ZenHit) {
    this.hits.push(hit)
    if (this.hits.length > MAX_HITS) this.hits.splice(0, this.hits.length - MAX_HITS)
  }

  private recordSample(at: number, windowMs: number) {
    this.samples.push({ at, windowMs: Math.max(MIN_COOLDOWN_MS, Math.round(windowMs)) })
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES)
  }

  /**
   * estimateZenFreeLimit's learner, adapted to cooldown windows: the prior
   * (exponential in consecutive unexplained failures) is combined with past
   * observed window lengths via a time-decayed weighted median.
   */
  private learnedWindow(now: number, prior: number, cap: number): number {
    const weighted: WeightedValue[] = [{ value: Math.min(cap, prior), weight: WINDOW_PRIOR_WEIGHT }]
    for (const sample of this.samples) {
      weighted.push({ value: Math.min(cap, sample.windowMs), weight: windowWeight(now, sample.at) })
    }
    const window = weightedMedian(weighted) ?? prior
    return Math.max(MIN_COOLDOWN_MS, Math.min(cap, Math.round(window)))
  }

  private refresh(now: number) {
    if (this.state !== "COOLING_DOWN") return
    if (this.resetAt === undefined || now < this.resetAt) return
    if (this.lastUnexplainedAt !== undefined && this.resetAt > this.lastUnexplainedAt) {
      this.recordSample(this.lastUnexplainedAt, this.resetAt - this.lastUnexplainedAt)
    }
    this.lastUnexplainedAt = undefined
    this.state = "READY"
    this.resetAt = undefined
    this.persist()
  }

  usable(now = Date.now()): boolean {
    this.refresh(now)
    return this.state === "READY"
  }

  currentResetAt(now = Date.now()): number | undefined {
    this.refresh(now)
    return this.resetAt
  }

  reset() {
    this.state = "READY"
    this.resetAt = undefined
    this.consecutive = 0
    this.lastUnexplainedAt = undefined
    this.persist()
  }

  observe(observation: ZenObservation) {
    const now = observation.at ?? Date.now()
    const status = observation.status
    const body = observation.body ?? ""
    if (status !== undefined && status >= 200 && status < 300) {
      if (this.lastUnexplainedAt !== undefined) {
        this.recordSample(this.lastUnexplainedAt, now - this.lastUnexplainedAt)
        this.lastUnexplainedAt = undefined
      }
      this.state = "READY"
      this.resetAt = undefined
      this.consecutive = 0
      this.persist()
      return
    }
    this.failures++
    if (status === 402) {
      this.state = "QUOTA_EXHAUSTED"
      this.resetAt = undefined
      this.lastUnexplainedAt = undefined
      this.pushHit({ model: observation.model ?? null, at: now, resetAt: null, kind: "quota" })
      this.persist()
      return
    }
    const isRateLimit = status === 429 || FREE_LIMIT_BODY.test(body) || GO_LIMIT_BODY.test(body)
    if (isRateLimit) {
      const parsed = parseResetAt(observation.headers, body, now)
      let resetAtNext: number
      if (parsed !== undefined && parsed > now) {
        if (this.lastUnexplainedAt !== undefined && parsed > this.lastUnexplainedAt) {
          this.recordSample(this.lastUnexplainedAt, parsed - this.lastUnexplainedAt)
        }
        this.lastUnexplainedAt = undefined
        resetAtNext = parsed
      } else if (FREE_LIMIT_BODY.test(body)) {
        // Free-tier windows reset at 00:00 UTC, not on a rolling clock.
        resetAtNext = zenUtcDayEnd(now)
      } else {
        this.consecutive++
        this.lastUnexplainedAt = now
        const window = this.learnedWindow(now, UNEXPLAINED_BASE_MS * 2 ** (this.consecutive - 1), UNEXPLAINED_RATE_CAP_MS)
        resetAtNext = now + window + Math.floor(Math.random() * JITTER_MS)
      }
      if (resetAtNext <= now) resetAtNext = now + MIN_COOLDOWN_MS
      this.state = "COOLING_DOWN"
      this.resetAt = resetAtNext
      this.pushHit({ model: observation.model ?? null, at: now, resetAt: resetAtNext, kind: "rate-limit" })
      this.persist()
      return
    }
    this.consecutive++
    this.lastUnexplainedAt = now
    const window = this.learnedWindow(now, UNEXPLAINED_BASE_MS * 2 ** (this.consecutive - 1), TRANSIENT_CAP_MS)
    const resetAtNext = now + window + Math.floor(Math.random() * JITTER_MS)
    this.state = "COOLING_DOWN"
    this.resetAt = resetAtNext
    this.pushHit({ model: observation.model ?? null, at: now, resetAt: resetAtNext, kind: "transient" })
    this.persist()
  }

  metrics(now = Date.now()) {
    this.refresh(now)
    return {
      state: this.state,
      resetAt: this.resetAt ?? null,
      usable: this.state === "READY",
      failures: this.failures,
      consecutive: this.consecutive,
      hits: [...this.hits],
    }
  }
}
