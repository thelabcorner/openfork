import type { PeriodDetection, SpadChannel } from "./types"

type GenerationState = {
  toolCalls: number
  toolResults: number
  mutations: number
  resources: Set<string>
  resultStates: Set<string>
  narration: Set<number>
}

export interface RecentThrashOptions {
  readonly windowGenerations?: number
  readonly maxGenerationPeriod?: number
  readonly minToolCalls?: number
  readonly minResourceObservations?: number
  readonly minReaccessRatio?: number
  readonly minPairResourceJaccard?: number
  readonly minRecurringResourcePairs?: number
  readonly minNarrationDice?: number
  readonly minRecurringNarrationPairs?: number
  readonly maxResourcesPerGeneration?: number
  readonly maxNarrationTrigrams?: number
}

export interface RecentThrashMetrics {
  readonly generations: number
  /** Best jointly recurring generation-state period (1 = same state each generation). */
  readonly generationPeriod: number
  readonly periodComparisons: number
  readonly toolCalls: number
  readonly toolResults: number
  readonly mutations: number
  readonly resourceObservations: number
  readonly reaccessRatio: number
  readonly novelResources: number
  readonly recurringResourcePairs: number
  readonly meanResourceJaccard: number
  readonly recurringNarrationPairs: number
  readonly meanNarrationDice: number
}

const DEFAULTS: Required<RecentThrashOptions> = {
  windowGenerations: 4,
  maxGenerationPeriod: 2,
  minToolCalls: 4,
  minResourceObservations: 4,
  minReaccessRatio: 0.5,
  minPairResourceJaccard: 0.75,
  minRecurringResourcePairs: 2,
  minNarrationDice: 0.2,
  minRecurringNarrationPairs: 2,
  maxResourcesPerGeneration: 64,
  maxNarrationTrigrams: 2000,
}

function generation(): GenerationState {
  return { toolCalls: 0, toolResults: 0, mutations: 0, resources: new Set(), resultStates: new Set(), narration: new Set() }
}

const FNV_OFFSET = 0x811c9dc5 >>> 0
const FNV_PRIME = 0x01000193

function hashWordTrigram(a: number, b: number, c: number): number {
  let h = FNV_OFFSET
  h = Math.imul(h ^ a, FNV_PRIME) >>> 0
  h = Math.imul(h ^ b, FNV_PRIME) >>> 0
  h = Math.imul(h ^ c, FNV_PRIME) >>> 0
  return h
}

function intersectionSize<T>(a: Set<T>, b: Set<T>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let n = 0
  for (const value of small) if (large.has(value)) n++
  return n
}

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 || b.size === 0) return 0
  const common = intersectionSize(a, b)
  return common / (a.size + b.size - common)
}

function dice<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 || b.size === 0) return 0
  return (2 * intersectionSize(a, b)) / (a.size + b.size)
}

/**
 * Precision-first cross-generation stagnation watch.
 *
 * Unlike the legacy cumulative watcher, evidence is computed only from a
 * bounded recent generation window. A resource seen hundreds of actions ago
 * cannot make the current action look like re-access. Any mutation inside the
 * evidence window blocks a hit. Unlike the first prototype, recurrence is
 * checked at generation periods 1..P rather than only between adjacent
 * generations. This catches A/B/A/B state cycles without turning unrelated
 * adjacent states into false negatives. Resource recurrence and narration
 * recurrence must agree on the same generation period; exact/silent tool
 * cycles belong to ToolLoopDetector / InformationRecurrenceWatch.
 *
 * This class is evidence-only while it is calibrated against real traces.
 */
export class RecentThrashWatch {
  private readonly opt: Required<RecentThrashOptions>
  private readonly history: GenerationState[] = []
  private current = generation()
  private started = false
  private activeDetection = false
  private wordHash = FNV_OFFSET
  private wordLength = 0
  private previousWordA = 0
  private previousWordB = 0
  private completedWords = 0

  constructor(options: RecentThrashOptions = {}) {
    this.opt = { ...DEFAULTS, ...options }
    if (this.opt.windowGenerations < 3) throw new Error("recent thrash window must contain at least 3 generations")
  }

  reset(): void {
    this.history.length = 0
    this.current = generation()
    this.started = false
    this.activeDetection = false
    this.resetNarrationScanner()
  }

  markProgress(): void {
    this.reset()
  }

  markGeneration(): void {
    this.finishWord()
    if (this.started) {
      this.history.push(this.current)
      while (this.history.length >= this.opt.windowGenerations) this.history.shift()
    } else {
      this.started = true
    }
    this.current = generation()
    this.resetNarrationScanner()
  }

  pushTool(_family: string, isMutating: boolean, resource?: string): void {
    this.current.toolCalls++
    if (isMutating) this.current.mutations++
    if (resource && this.current.resources.size < this.opt.maxResourcesPerGeneration) this.current.resources.add(resource)
  }

  /**
   * Attach the completed result state to the current generation. State-cycle
   * similarity is result-sensitive: revisiting the same operation with a
   * changed result is a different observed state, not a stagnation match.
   */
  pushResult(resource: string, signature: string): void {
    this.current.toolResults++
    if (this.current.resultStates.size < this.opt.maxResourcesPerGeneration)
      this.current.resultStates.add(`${resource}@${signature}`)
  }

  private resetNarrationScanner(): void {
    this.wordHash = FNV_OFFSET
    this.wordLength = 0
    this.previousWordA = 0
    this.previousWordB = 0
    this.completedWords = 0
  }

  private finishWord(): void {
    if (this.wordLength === 0) return
    // Fold length into the token so short FNV collisions cannot make words of
    // different lengths trivially identical in this heuristic-only surface.
    const token = Math.imul(this.wordHash ^ this.wordLength, FNV_PRIME) >>> 0
    if (this.completedWords >= 2 && this.current.narration.size < this.opt.maxNarrationTrigrams)
      this.current.narration.add(hashWordTrigram(this.previousWordA, this.previousWordB, token))
    this.previousWordA = this.previousWordB
    this.previousWordB = token
    this.completedWords++
    this.wordHash = FNV_OFFSET
    this.wordLength = 0
  }

  pushNarration(text: string): void {
    // Once the bounded evidence set is full, additional narration in this
    // generation cannot affect any metric. Avoid scanning unrepresented text.
    if (this.current.narration.size >= this.opt.maxNarrationTrigrams) return
    for (let i = 0; i < text.length; i++) {
      let code = text.charCodeAt(i)
      if (code >= 65 && code <= 90) code += 32
      if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) {
        this.wordHash = Math.imul(this.wordHash ^ code, FNV_PRIME) >>> 0
        this.wordLength++
      } else {
        this.finishWord()
        if (this.current.narration.size >= this.opt.maxNarrationTrigrams) return
      }
    }
  }

  metrics(): RecentThrashMetrics {
    const states = [...this.history, this.current].slice(-this.opt.windowGenerations)
    let toolCalls = 0
    let toolResults = 0
    let mutations = 0
    let resourceObservations = 0
    let reaccess = 0
    let novelResources = 0
    const seen = new Set<string>()

    for (let i = 0; i < states.length; i++) {
      const state = states[i]!
      toolCalls += state.toolCalls
      toolResults += state.toolResults
      mutations += state.mutations
      if (i > 0) {
        for (const resource of state.resources) {
          resourceObservations++
          if (seen.has(resource)) reaccess++
          else novelResources++
        }
      }
      for (const resource of state.resources) seen.add(resource)
    }

    let generationPeriod = 0
    let recurringResourcePairs = 0
    let resourceSimilarity = 0
    let recurringNarrationPairs = 0
    let narrationSimilarity = 0
    let comparedPairs = 0
    let bestScore = -1
    const maxPeriod = Math.min(this.opt.maxGenerationPeriod, Math.max(0, states.length - 1))
    for (let period = 1; period <= maxPeriod; period++) {
      let rp = 0
      let np = 0
      let rs = 0
      let ns = 0
      let pairs = 0
      for (let i = period; i < states.length; i++) {
        const previous = states[i - period]!
        const current = states[i]!
        const previousSurface = previous.resultStates.size ? previous.resultStates : previous.resources
        const currentSurface = current.resultStates.size ? current.resultStates : current.resources
        const r = jaccard(previousSurface, currentSurface)
        const n = dice(previous.narration, current.narration)
        rs += r
        ns += n
        pairs++
        if (r >= this.opt.minPairResourceJaccard) rp++
        if (n >= this.opt.minNarrationDice) np++
      }
      if (pairs === 0) continue
      // Prefer periods where both state surfaces recur, then break ties by
      // total recurrence count and similarity. This prevents a strong resource
      // cycle at p=2 from being paired with unrelated narration at p=1.
      const joint = Math.min(rp, np)
      const score = joint * 100 + (rp + np) * 10 + rs / pairs + ns / pairs
      if (score <= bestScore) continue
      bestScore = score
      generationPeriod = period
      recurringResourcePairs = rp
      recurringNarrationPairs = np
      resourceSimilarity = rs
      narrationSimilarity = ns
      comparedPairs = pairs
    }

    return {
      generations: states.length,
      generationPeriod,
      periodComparisons: comparedPairs,
      toolCalls,
      toolResults,
      mutations,
      resourceObservations,
      reaccessRatio: resourceObservations ? reaccess / resourceObservations : 0,
      novelResources,
      recurringResourcePairs,
      meanResourceJaccard: comparedPairs ? resourceSimilarity / comparedPairs : 0,
      recurringNarrationPairs,
      meanNarrationDice: comparedPairs ? narrationSimilarity / comparedPairs : 0,
    }
  }

  evaluate(channel: SpadChannel): PeriodDetection | undefined {
    // Fast hot-path rejection. A state cycle cannot exist until the full
    // bounded generation window is present and the current generation has at
    // least one completed tool observation. Avoid rebuilding metrics on every
    // streamed narration delta before that point.
    if (this.history.length + 1 < this.opt.windowGenerations) return undefined
    if (this.current.toolCalls === 0 || this.current.toolResults !== this.current.toolCalls) return undefined
    const m = this.metrics()
    const qualifies =
      m.generations >= this.opt.windowGenerations &&
      m.mutations === 0 &&
      m.toolCalls >= this.opt.minToolCalls &&
      m.toolResults === m.toolCalls &&
      m.resourceObservations >= this.opt.minResourceObservations &&
      m.reaccessRatio >= this.opt.minReaccessRatio &&
      m.generationPeriod > 0 &&
      m.recurringResourcePairs === m.periodComparisons &&
      m.recurringNarrationPairs === m.periodComparisons &&
      m.recurringResourcePairs >= this.opt.minRecurringResourcePairs &&
      m.recurringNarrationPairs >= this.opt.minRecurringNarrationPairs
    if (!qualifies) {
      this.activeDetection = false
      return undefined
    }
    // Require complete bounded-window support for the selected period. One
    // unrelated state must not be outvoted by two later matches. For a four
    // generation window this means p=1 needs 3/3 pairs and p=2 needs 2/2.
    if (this.activeDetection) return undefined
    this.activeDetection = true
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
}
