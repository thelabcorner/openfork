import type { PeriodDetection, SpadChannel, SpadConfig } from "./types"

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/**
 * Normalize a tool input into a coarse, comparable resource key so that the
 * same file reached through different tools/paths collapses to one identity.
 *
 * File tools (read, write, edit, glob, grep, ...) are keyed by the lower-cased
 * basename of the path or glob, so a read of "a/b.ts" and a glob that also
 * resolves to "b.ts" collapse to the same resource. Non-file tools fall back
 * to the tool name plus a short signature of their primary string argument, so
 * genuinely different commands stay distinct resources (avoiding false
 * re-access on e.g. `bash`).
 */
export function toolResourceKey(name: string, input: unknown): string {
  const n = name.toLowerCase()
  const rec = isRecord(input) ? input : {}
  const path = rec.filePath ?? rec.path ?? rec.file_path
  if (typeof path === "string") {
    return path.toLowerCase().split(/[\\/]/).pop()!
  }
  const pat = rec.pattern ?? rec.glob ?? rec.query ?? rec.url ?? rec.src
  if (typeof pat === "string") {
    const base = pat.toLowerCase().split(/[\\/]/).pop()!.split(/[?*{}]/)[0]!
    return base
  }
  let sig = ""
  for (const value of Object.values(rec)) {
    if (typeof value === "string" && value.length > 1) {
      sig = value.slice(0, 24).toLowerCase().replace(/\s+/g, " ")
      break
    }
  }
  return sig ? `${n}:${sig}` : n
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
    this.toolCalls++
    if (isMutating) {
      this.lastMutationGen = this.gen
      this.narrationRecurrenceStreak = 0
      return
    }
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
