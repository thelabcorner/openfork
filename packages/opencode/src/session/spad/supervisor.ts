import { CrossTurnWatch, ToolResultProgressTracker, toolResultSignature } from "./thrash"
import { DEFAULT_SPAD_CONFIG } from "./config"
import { SpadDetector } from "./detector"
import { MotifWatchdog } from "./motif-watchdog"
import { addPersistedMotif, getPersistedMotifs } from "./pattern-store"
import { decideRecovery } from "./policy"
import { recoveryPrompt, thrashRecoveryPrompt, toolRecoveryPrompt } from "./recovery"
import { ToolLoopDetector } from "./tool-loop"
import { InformationRecurrenceWatch } from "./information-watch"
import { BoundedTextTail } from "./text-tail"
import { RecentThrashWatch } from "./thrash-v2"
import type {
  PeriodDetection,
  SpadAction,
  SpadAuditCase,
  SpadChannel,
  SpadConfig,
  SpadPolicyReason,
  TurnPolicy,
} from "./types"

const AUDIT_TAIL_CHARS = 8192
const MAX_PENDING_AUDITS = 4
const AUDITABLE_SOURCES = new Set([
  "canonical-period",
  "expansion-heuristic",
  "cross-turn-thrash",
  "generation-state-cycle",
  "information-recurrence",
  "tool-loop",
])
const HARD_PROGRESS_INVALIDATED_AUDITS = new Set([
  "cross-turn-thrash",
  "generation-state-cycle",
  "information-recurrence",
  "tool-loop",
])
const INFORMATION_PROGRESS_INVALIDATED_AUDITS = new Set(["cross-turn-thrash", "tool-loop"])

export class SpadSupervisor {
  readonly config: SpadConfig
  private policy: TurnPolicy = { repetitionExpected: false, observeOnly: false, mutationForbidden: false }
  private detector!: SpadDetector
  private textDetector: SpadDetector | undefined
  private reasoningDetector: SpadDetector | undefined
  private channel: SpadChannel = "text"
  private attempts = 0
  private watchdog: MotifWatchdog | undefined
  private watchdogChannel: SpadChannel | undefined
  private watchRemaining = 0
  private lastDetection: PeriodDetection | undefined
  private partObserveOnly = false
  private readonly toolLoop = new ToolLoopDetector()
  private readonly thrash: CrossTurnWatch
  private readonly stateCycle = new RecentThrashWatch()
  private readonly toolResults = new ToolResultProgressTracker()
  private readonly information = new InformationRecurrenceWatch({ minConsecutiveGenerations: 3 })
  private persistedWatchdogs: MotifWatchdog[] = []
  private persistedIds: string[] = []
  private readonly partTextTail = new BoundedTextTail(AUDIT_TAIL_CHARS)
  private partChars = 0
  private readonly pendingAudits: SpadAuditCase[] = []

  constructor(config: SpadConfig = DEFAULT_SPAD_CONFIG) { this.config = config; this.thrash = new CrossTurnWatch(config) }
  beginTurn(policy: TurnPolicy): void {
    this.policy = policy
    this.attempts = 0
    this.watchdog = undefined
    this.watchdogChannel = undefined
    this.watchRemaining = 0
    this.lastDetection = undefined
    this.pendingAudits.length = 0
    this.toolLoop.reset()
    this.thrash.reset()
    this.stateCycle.reset()
    this.toolResults.reset()
    this.information.reset()
    if (this.config.autoRecoverPersistedMotifs) this.refreshPersistedWatchdogs()
    else {
      this.persistedWatchdogs = []
      this.persistedIds = []
    }
    this.startPart("text", false)
  }

  /** Mark the boundary between provider generations (each recovery loop iteration). */
  markGeneration(): void {
    if (this.config.autoRecoverThrash) this.thrash.markGeneration()
    this.stateCycle.markGeneration()
    this.information.markGeneration()
  }

  private refreshPersistedWatchdogs(): void {
    const motifs = getPersistedMotifs().slice(0, 8)
    this.persistedWatchdogs = motifs.map((m) => new MotifWatchdog(m.motif, this.config.qgram))
    this.persistedIds = motifs.map((m) => String(m.hash))
  }
  startPart(
    channel: SpadChannel,
    recoveryMode = this.watchdog !== undefined,
    observeOnly = this.policy.observeOnly,
  ): void {
    this.channel = channel
    // Reasoning is a hard Stage-0 abstention boundary. Enforce it here rather
    // than relying on every processor/provider integration call site to pass
    // the right flag.
    this.partObserveOnly = observeOnly || channel === "reasoning"
    if (recoveryMode) {
      // Recovery-mode parts are rare and may carry different thresholds; keep
      // them isolated rather than retaining four heavyweight detector variants.
      this.detector = new SpadDetector({ channel, config: this.config, recoveryMode: true })
    } else if (channel === "text") {
      if (this.textDetector) this.textDetector.reset()
      else this.textDetector = new SpadDetector({ channel: "text", config: this.config })
      this.detector = this.textDetector
    } else {
      if (this.reasoningDetector) this.reasoningDetector.reset()
      else this.reasoningDetector = new SpadDetector({ channel: "reasoning", config: this.config })
      this.detector = this.reasoningDetector
    }
    this.partTextTail.reset()
    this.partChars = 0
    if (this.watchdog && this.watchdogChannel === channel) this.watchdog.resetStream()
    for (const w of this.persistedWatchdogs) w.resetStream()
  }

  private recoveryPolicy(detection: PeriodDetection): { allowed: boolean; reason: SpadPolicyReason } {
    return decideRecovery({ config: this.config, turn: this.policy, partObserveOnly: this.partObserveOnly, evidence: detection })
  }

  private rememberText(delta: string): void {
    this.partChars += delta.length
    this.partTextTail.push(delta)
  }

  private queueAudit(detection: PeriodDetection, policyReason: SpadPolicyReason): void {
    if (this.channel !== "text" || !AUDITABLE_SOURCES.has(detection.source)) return
    if (this.pendingAudits.length >= MAX_PENDING_AUDITS) return
    if (this.pendingAudits.some((candidate) => candidate.detection.source === detection.source)) return

    const tail = this.partTextTail.toString()
    const textPositioned = detection.source === "canonical-period" || detection.source === "expansion-heuristic"
    const tailStart = Math.max(0, this.partChars - tail.length)
    const start = textPositioned
      ? Math.max(0, Math.min(tail.length, detection.runStart - tailStart))
      : Math.max(0, tail.length - 2400)
    const end = textPositioned
      ? Math.max(start, Math.min(tail.length, detection.runEnd - tailStart))
      : tail.length
    const region = end > start ? tail.slice(start, end) : tail.slice(-2400)
    const contextBefore = tail.slice(Math.max(0, start - 800), start)
    const candidateHead = region.slice(0, 1200)
    const candidateTail = region.slice(Math.max(0, region.length - 1200))
    const features: Record<string, string | number | boolean | null> = {
      period: detection.period,
      runLength: detection.runLength,
      exponent: detection.exponent,
      agreement: detection.agreement,
      insideCodeFence: detection.insideCodeFence,
      canonicalDuplicate4GramRatio: detection.canonicalDuplicate4GramRatio ?? null,
      expansionDuplicateRatio: detection.expansionDuplicateRatio ?? null,
      exactVerifiedSpan: detection.exactVerifiedSpan ?? null,
      exactMinimalPeriod: detection.exactMinimalPeriod ?? null,
      informationRecurrences: detection.informationRecurrences ?? null,
      informationResource: detection.informationResource ?? null,
      stateCyclePeriod: detection.stateCyclePeriod ?? null,
      stateCycleComparisons: detection.stateCycleComparisons ?? null,
      stateCycleResourceJaccard: detection.stateCycleResourceJaccard ?? null,
      stateCycleNarrationDice: detection.stateCycleNarrationDice ?? null,
    }
    this.pendingAudits.push({
      detection,
      policyReason,
      intentIndependent: { contextBefore, candidateHead, candidateTail, contentKind: this.channel, features },
    })
  }

  private observe(detection: PeriodDetection, policyReason: SpadPolicyReason): SpadAction {
    this.queueAudit(detection, policyReason)
    return { type: "observe", detection, policyReason }
  }

  private invalidateAudits(sources: ReadonlySet<string>): void {
    for (let i = this.pendingAudits.length - 1; i >= 0; i--) {
      if (sources.has(this.pendingAudits[i]!.detection.source)) this.pendingAudits.splice(i, 1)
    }
  }

  private observeStateCycle(): SpadAction | undefined {
    if (this.channel !== "text") return undefined
    const stateHit = this.stateCycle.evaluate(this.channel)
    if (!stateHit) return undefined
    const metrics = this.stateCycle.metrics()
    const detection: PeriodDetection = {
      kind: "periodic-attractor",
      lane: "state",
      source: "generation-state-cycle",
      channel: this.channel,
      period: metrics.generationPeriod,
      runStart: 0,
      runEnd: 0,
      runLength: metrics.generations,
      exponent: metrics.periodComparisons,
      agreement: Math.min(metrics.meanResourceJaccard, metrics.meanNarrationDice),
      insideCodeFence: false,
      stateCyclePeriod: metrics.generationPeriod,
      stateCycleComparisons: metrics.periodComparisons,
      stateCycleResourceJaccard: metrics.meanResourceJaccard,
      stateCycleNarrationDice: metrics.meanNarrationDice,
    }
    return this.observe(detection, "state-cycle-observe-only")
  }

  private triggerRecovery(
    detection: PeriodDetection,
    policyReason: SpadPolicyReason,
    prompt: string = recoveryPrompt(this.attempts),
  ): SpadAction {
    if (this.attempts >= this.config.maxRecoveryAttempts)
      return { type: "abort", detection, reason: "recovery-budget-exhausted", policyReason }
    this.attempts++
    this.lastDetection = detection
    const motif = this.detector.extractMotif(detection)
    if (motif) {
      this.watchdog = new MotifWatchdog(motif, this.config.qgram)
      this.watchdogChannel = detection.channel
      this.watchRemaining = this.config.recoveryWatchChars
      // Learn the bad motif persistently for cross-restart early detection. Only
      // persist raw lane motifs (exact) to keep precision; canonical remains
      // gated by duplicate ratio.
      if (detection.lane === "raw" && this.config.autoRecoverPersistedMotifs) addPersistedMotif(motif)
    }
    // Quarantine the sustained loop but keep a single occurrence of the motif so
    // the truncated part still reads as text rather than vanishing entirely.
    const quarantineFrom = detection.runStart + (detection.period > 0 ? detection.period : 0)
    // A thrash recovery resets cross-turn stagnation state so the post-recovery
    // generation is judged on fresh evidence instead of the accumulated
    // re-access stats that triggered the recovery.
    if (detection.lane === "thrash") this.thrash.reset()
    return { type: "recover", attempt: this.attempts, detection, quarantineFrom, recoveryPrompt: prompt, noTruncate: detection.lane === "thrash", policyReason }
  }

  private relapse(): SpadAction | undefined {
    const detection = this.lastDetection
    if (!detection) return undefined
    if (this.attempts >= this.config.maxRecoveryAttempts)
      return { type: "abort", detection, reason: "relapse", policyReason: "raw-exact-authorized" }
    this.attempts++; this.watchdog?.resetStream(); this.watchRemaining = this.config.recoveryWatchChars
    return { type: "recover", attempt: this.attempts, detection, quarantineFrom: 0, recoveryPrompt: recoveryPrompt(this.attempts), policyReason: "raw-exact-authorized" }
  }

  push(delta: string): SpadAction | undefined {
    // Auditor cases are text-only; reasoning can never consume this tail.
    // Avoid bounded-tail bookkeeping on the dominant reasoning character path.
    if (this.channel === "text") this.rememberText(delta)
    // Persistent learned motifs get an early, lower-threshold check (32 chars)
    // so a known bad pattern is interrupted even before the full period
    // detector would confirm it. This is the cross-restart learning path.
    // Respect the same policy as normal detection to avoid false positives
    // on intentional repetition or structured output.
    if (
      this.config.autoRecoverPersistedMotifs &&
      this.persistedWatchdogs.length > 0 &&
      !this.policy.repetitionExpected &&
      !this.policy.observeOnly &&
      !this.partObserveOnly
    ) {
      const earlyThreshold = Math.max(64, Math.floor(this.config.relapseMatchChars * 0.66))
      for (let i = 0; i < this.persistedWatchdogs.length; i++) {
        const w = this.persistedWatchdogs[i]!
        if (w.push(delta, earlyThreshold)) {
          const detection: PeriodDetection = {
            kind: "periodic-attractor",
            lane: "persisted",
            source: "persisted-motif",
            channel: this.channel,
            period: 0,
            runStart: 0,
            runEnd: delta.length,
            runLength: delta.length,
            exponent: 1,
            agreement: 1,
            insideCodeFence: false,
          }
          const policy = this.recoveryPolicy(detection)
           if (!policy.allowed) return this.observe(detection, policy.reason)
          w.resetStream()
          return this.triggerRecovery(detection, policy.reason)
        }
      }
    }
    if (this.watchdog && this.watchdogChannel === this.channel && this.watchRemaining > 0) {
      const inspected = Math.min(delta.length, this.watchRemaining)
      if (this.watchdog.push(delta, this.config.relapseMatchChars, inspected)) return this.relapse()
      this.watchRemaining -= inspected
      if (this.watchRemaining <= 0) { this.watchdog = undefined; this.watchdogChannel = undefined }
    }
    if (this.config.autoRecoverThrash) this.thrash.pushNarration(delta)
    this.stateCycle.pushNarration(delta)
    const stateAction = this.observeStateCycle()
    const detection = this.detector.push(delta)
    if (!detection) return stateAction
    const policy = this.recoveryPolicy(detection)
     if (!policy.allowed) return this.observe(detection, policy.reason)
    return this.triggerRecovery(detection, policy.reason)
  }

  pushTool(tool: string, isMutating: boolean, resource?: string): SpadAction | undefined {
    if (this.config.autoRecoverThrash) this.thrash.pushTool(tool, isMutating, resource)
    this.stateCycle.pushTool(tool, isMutating, resource)
    const hit = this.toolLoop.push(tool, isMutating, resource)
    if (!hit) return undefined
    const detection: PeriodDetection = {
      kind: "periodic-attractor",
      lane: "tool",
      source: "tool-loop",
      channel: this.channel,
      period: hit.period,
      runStart: 0,
      runEnd: hit.runLength,
      runLength: hit.runLength,
      exponent: hit.exponent,
      agreement: 1,
      insideCodeFence: false,
    }
    const policy = this.recoveryPolicy(detection)
     if (!policy.allowed) return this.observe(detection, policy.reason)
    // Reset lane so post-recovery generation needs a fresh sustained period to re-trigger,
    // instead of firing on the very next tool call and burning the budget in 2 calls.
    this.toolLoop.reset()
    return this.triggerRecovery(detection, policy.reason, toolRecoveryPrompt(this.attempts))
  }

  /**
   * Observe a completed tool result after the host has the actual output.
   * Changed output for the same exact operation is information progress and
   * clears stagnation state before any thrash decision is made.
   */
  pushToolResult(resource: string, output: string, isMutating = false): SpadAction | undefined {
    const signature = toolResultSignature(output)
    const informationChanged = !isMutating && this.toolResults.observeSignature(resource, signature)
    if (!isMutating) this.stateCycle.pushResult(resource, signature)
    if (informationChanged) this.markInformationProgress()
    let informationAction: SpadAction | undefined
    if (!isMutating) {
      const informationHit = this.information.pushSignature(resource, signature)
      if (informationHit) {
        const detection: PeriodDetection = {
          kind: "periodic-attractor",
          lane: "information",
          source: "information-recurrence",
          channel: this.channel,
          period: 0,
          runStart: 0,
          runEnd: 0,
          runLength: 0,
          exponent: informationHit.recurrences,
          agreement: 1,
          insideCodeFence: false,
          informationResource: informationHit.resource,
          informationRecurrences: informationHit.recurrences,
          informationResultSignature: informationHit.resultSignature,
        }
        // Information recurrence is evidence-only. Queue it now, but do not
        // let an observation preempt a stronger action from another lane.
        informationAction = this.observe(detection, "information-observe-only")
      }
    }
    const stateAction = this.observeStateCycle()
    if (this.policy.mutationForbidden || !this.config.autoRecoverThrash) return stateAction ?? informationAction
    const thrashHit = this.thrash.evaluate(this.channel)
    if (!thrashHit) return stateAction ?? informationAction
    const policy = this.recoveryPolicy(thrashHit)
    if (policy.allowed) return this.triggerRecovery(thrashHit, policy.reason, thrashRecoveryPrompt(this.attempts))
    return this.observe(thrashHit, policy.reason)
  }

  /** Reset progress-sensitive evidence after a host-observed filesystem delta. */
  markProgress(resetToolResults = true): void {
    if (this.config.autoRecoverThrash) this.thrash.markProgress()
    this.stateCycle.markProgress()
    this.toolLoop.markProgress()
    this.information.markProgress()
    this.invalidateAudits(HARD_PROGRESS_INVALIDATED_AUDITS)
    if (resetToolResults) this.toolResults.reset()
  }

  /**
   * A changed passive result is evidence of information novelty, but it is not
   * equivalent to host-attested state mutation. Reset recovery-capable legacy
   * heuristics conservatively while preserving per-resource information and
   * bounded state-cycle evidence; changed result signatures make that state
   * different naturally.
   */
  private markInformationProgress(): void {
    if (this.config.autoRecoverThrash) this.thrash.markProgress()
    this.toolLoop.markProgress()
    this.invalidateAudits(INFORMATION_PROGRESS_INVALIDATED_AUDITS)
  }

  get recoveryAttempts(): number { return this.attempts }

  /** Drain bounded gray-zone evidence for asynchronous LLM calibration. */
  takeAuditCases(): SpadAuditCase[] {
    if (this.pendingAudits.length === 0) return []
    return this.pendingAudits.splice(0, this.pendingAudits.length)
  }
}
