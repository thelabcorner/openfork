import type { PeriodDetection, SpadChannel, SpadConfig } from "./types"

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function boundedContentSignature(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ")
  let h1 = 0x811c9dc5 >>> 0
  let h2 = 0x9e3779b9 >>> 0
  for (let i = 0; i < normalized.length; i++) {
    const code = normalized.charCodeAt(i)
    h1 ^= code
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0
    h2 ^= h2 >>> 13
  }
  const prefix = normalized.slice(0, 48).replace(/[^a-z0-9._:-]+/g, "_")
  return `${normalized.length}:${h1.toString(16)}:${h2.toString(16)}:${prefix}`
}

export function toolResultSignature(value: string): string {
  let h1 = 0x811c9dc5 >>> 0
  let h2 = 0x9e3779b9 >>> 0
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    h1 ^= code
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 ^= code + 0x9e37 + ((h2 << 6) >>> 0) + (h2 >>> 2)
    h2 >>>= 0
  }
  return `${value.length}:${h1.toString(16)}:${h2.toString(16)}`
}

/**
 * Bounded cache used to decide whether repeating the same exact operation
 * produced new information. Only signatures are retained, never tool output.
 */
export class ToolResultProgressTracker {
  private readonly signatures = new Map<string, string>()

  constructor(private readonly maxEntries = 256) {}

  reset(): void {
    this.signatures.clear()
  }

  observe(resource: string, output: string): boolean {
    return this.observeSignature(resource, toolResultSignature(output))
  }

  observeSignature(resource: string, signature: string): boolean {
    const previous = this.signatures.get(resource)
    const changed = previous !== undefined && previous !== signature
    if (!this.signatures.has(resource) && this.signatures.size >= this.maxEntries) {
      const oldest = this.signatures.keys().next().value as string | undefined
      if (oldest !== undefined) this.signatures.delete(oldest)
    }
    this.signatures.set(resource, signature)
    return changed
  }
}

function normalizedPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/").toLowerCase()
}

function stableInputProjection(value: unknown, depth = 0): string {
  if (value === null) return "null"
  if (typeof value === "string") return JSON.stringify(value.length > 512 ? `${value.slice(0, 512)}#${boundedContentSignature(value)}` : value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (depth >= 2) return typeof value
  if (Array.isArray(value)) return `[${value.slice(0, 16).map((item) => stableInputProjection(item, depth + 1)).join(",")}]`
  if (!isRecord(value)) return typeof value
  return `{${Object.keys(value)
    .sort()
    .slice(0, 32)
    .map((key) => `${JSON.stringify(key)}:${stableInputProjection(value[key], depth + 1)}`)
    .join(",")}}`
}

/**
 * Normalize a tool input into a precision-first operation/resource identity.
 * Only equivalences the host can actually prove are collapsed. In particular,
 * files keep their normalized full path and search/glob operations include
 * both query and scope. This deliberately prefers false negatives over
 * manufacturing recurrence from same-basename or same-action collisions.
 */
export function toolResourceKey(name: string, input: unknown, mutationResult?: string): string {
  const n = name.toLowerCase()
  const rec = isRecord(input) ? input : {}
  // Query-style tools often put a generic verb (`action: "query"`) before the
  // actual query text. Falling through to Object.values() would collapse every
  // distinct SQLite query into the same `sqlite:query` resource and manufacture
  // a tool loop during legitimate analytical work. Key SQL by bounded content
  // instead. The full SQL is never retained in detector state.
  if (typeof rec.sql === "string") {
    const db = typeof rec.db === "string" ? boundedContentSignature(normalizedPath(rec.db)) : "db"
    const mutationSig = mutationResult ? `:m${mutationResult.slice(0, 16).replace(/\s+/g, "_")}` : ""
    return `${n}:${db}:sql:${boundedContentSignature(rec.sql)}${mutationSig}`
  }
  const pat = rec.pattern ?? rec.glob ?? rec.query ?? rec.url ?? rec.src
  if (typeof pat === "string" && pat.trim().length > 0) {
    const scope = rec.path ?? rec.filePath ?? rec.file_path ?? rec.cwd ?? rec.directory
    const scopeSig = typeof scope === "string" ? `:scope:${boundedContentSignature(normalizedPath(scope))}` : ""
    const mutationSig = mutationResult ? `:m${mutationResult.slice(0, 16).replace(/\s+/g, "_")}` : ""
    return `${n}:query:${boundedContentSignature(pat)}${scopeSig}${mutationSig}`
  }
  const path = rec.filePath ?? rec.file_path ?? rec.path
  if (typeof path === "string") {
    const offset = typeof rec.offset === "number" ? `:o${rec.offset}` : ""
    const limit = typeof rec.limit === "number" ? `:l${rec.limit}` : ""
    const mutationSig = mutationResult ? `:m${mutationResult.slice(0, 16).replace(/\s+/g, "_")}` : ""
    return `file:${boundedContentSignature(normalizedPath(path))}${offset}${limit}${mutationSig}`
  }
  const projected = stableInputProjection(rec)
  const mutationSig = mutationResult ? `:m${mutationResult.slice(0, 16).replace(/\s+/g, "_")}` : ""
  return `${n}:input:${boundedContentSignature(projected)}${mutationSig}`
}

/**
 * Tool-name mutation classification is only an early hint. The authoritative
 * progress signal is `SpadSupervisor.markProgress()`, driven by the host
 * filesystem patch observed at step-finish.
 */
export function isSpadMutatingTool(name: string): boolean {
  switch (name.toLowerCase()) {
    case "write":
    case "edit":
    case "patch":
    case "apply_patch":
      return true
    default:
      return false
  }
}

function normalizeWords(delta: string): string[] {
  const lower = delta.toLowerCase()
  const out: string[] = []
  let word = ""
  for (let i = 0; i < lower.length; i++) {
    const c = lower.charCodeAt(i)
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) word += lower[i]!
    else {
      if (word.length > 0) out.push(word)
      word = ""
    }
  }
  if (word.length > 0) out.push(word)
  return out
}

function hashTrigram(a: string, b: string, c: string): number {
  let h = 0x811c9dc5 >>> 0
  for (const s of [a, b, c]) {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
  }
  return h >>> 0
}

function intersectionCount(a: Set<number>, b: Set<number>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let count = 0
  for (const v of small) if (large.has(v)) count++
  return count
}

/**
 * Cross-turn progress-loop ("thrash") detector.
 *
 * Unlike the exact periodic-attractor lane (which only sees one generation's
 * byte stream), this watches the *whole user turn* — spanning every provider
 * request the supervisor lives across — for the signature of a stuck agent:
 *
 *   1. repeated tool activity that keeps re-touching the same small set of
 *      resources (re-access) instead of making forward progress, AND
 *   2. a sustained stretch with no mutating tool call (no edits/writes), AND
 *   3. a high resource re-access ratio — whose bar is widened when narration
 *      self-similarity (fuzzy re-use of the same phrases across generations)
 *      also holds, so a model that both re-touches files and reuses phrasing
 *      is caught earlier without penalizing legitimate boilerplate.
 *
 * State is bounded: resource identity uses a capped set, narration similarity
 * uses capped word-trigram sets and compares each generation only against the
 * immediately preceding one. No regex, no per-turn growth beyond the caps.
 */
export class CrossTurnWatch {
  private readonly cfg: SpadConfig
  private gen = 0
  private readonly globalResources = new Set<string>()
  private toolCalls = 0
  private reaccess = 0
  private lastMutationGen = -1
  private narrationRecurrenceStreak = 0
  private readonly genWords: string[] = []
  private readonly genNarration = new Set<number>()
  private prevGenNarration: Set<number> | undefined
  private static readonly MAX_GLOBAL = 2048
  private static readonly MAX_NARRATION = 2000

  constructor(cfg: SpadConfig) {
    this.cfg = cfg
  }

  reset(): void {
    this.gen = 0
    this.globalResources.clear()
    this.toolCalls = 0
    this.reaccess = 0
    this.lastMutationGen = -1
    this.narrationRecurrenceStreak = 0
    this.genWords.length = 0
    this.genNarration.clear()
    this.prevGenNarration = undefined
  }

  /** Host-attested state progress invalidates all pre-progress stagnation evidence. */
  markProgress(): void {
    this.globalResources.clear()
    this.toolCalls = 0
    this.reaccess = 0
    this.lastMutationGen = this.gen
    this.narrationRecurrenceStreak = 0
    this.genWords.length = 0
    this.genNarration.clear()
    this.prevGenNarration = undefined
  }

  /** Call once at the start of every generation (every provider request). */
  markGeneration(): void {
    if (this.gen > 0) {
      if (this.prevGenNarration && this.genNarration.size > 0) {
        const overlap = intersectionCount(this.genNarration, this.prevGenNarration) / this.genNarration.size
        this.narrationRecurrenceStreak =
          overlap >= this.cfg.thrashNarrationOverlap ? this.narrationRecurrenceStreak + 1 : 0
      } else {
        this.narrationRecurrenceStreak = 0
      }
      this.prevGenNarration = new Set(this.genNarration)
    }
    this.gen++
    this.genWords.length = 0
    this.genNarration.clear()
  }

  pushTool(_family: string, isMutating: boolean, resource?: string): void {
    if (isMutating) {
      this.markProgress()
      return
    }
    this.toolCalls++
    if (resource) {
      if (this.globalResources.has(resource)) this.reaccess++
      else if (this.globalResources.size < CrossTurnWatch.MAX_GLOBAL) this.globalResources.add(resource)
    }
  }

  pushNarration(delta: string): void {
    const words = normalizeWords(delta)
    for (const w of words) {
      this.genWords.push(w)
      if (this.genWords.length >= 3 && this.genNarration.size < CrossTurnWatch.MAX_NARRATION) {
        const len = this.genWords.length
        this.genNarration.add(
          hashTrigram(this.genWords[len - 3]!, this.genWords[len - 2]!, this.genWords[len - 1]!),
        )
      }
    }
  }

  evaluate(channel: SpadChannel): PeriodDetection | undefined {
    if (this.gen < this.cfg.thrashMinGenerations) return undefined
    const gensSinceMut = this.gen - this.lastMutationGen
    if (gensSinceMut < this.cfg.thrashNoMutationGens) return undefined

    const reaccessRatio = this.toolCalls > 0 ? this.reaccess / this.toolCalls : 0
    // Narration self-similarity is a *reinforcer*, not a standalone trigger: it
    // widens the resource-reaccess bar (so a model that both re-touches the
    // same files AND reuses the same phrasing is caught earlier) but never
    // fires on boilerplate narration during legitimate, forward-progressing
    // exploration. This is the precision safeguard against false positives.
    const narrationOk = this.narrationRecurrenceStreak >= this.cfg.thrashNarrationStreak
    const requiredRatio = narrationOk ? this.cfg.thrashReaccessRatio * 0.6 : this.cfg.thrashReaccessRatio
    if (reaccessRatio >= requiredRatio && this.toolCalls >= this.cfg.thrashMinToolCalls) {
      return {
        kind: "periodic-attractor",
        lane: "thrash",
        source: "cross-turn-thrash",
        channel,
        period: 0,
        runStart: 0,
        runEnd: 0,
        runLength: 0,
        exponent: 1,
        agreement: 1,
        insideCodeFence: false,
      }
    }
    return undefined
  }
}
