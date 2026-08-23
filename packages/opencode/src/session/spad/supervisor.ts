import { CrossTurnWatch } from "./thrash"
import { DEFAULT_SPAD_CONFIG } from "./config"
import { SpadDetector } from "./detector"
import { MotifWatchdog } from "./motif-watchdog"
import { addPersistedMotif, getPersistedMotifs } from "./pattern-store"
import { recoveryPrompt, thrashRecoveryPrompt, toolRecoveryPrompt } from "./recovery"
import { ToolLoopDetector } from "./tool-loop"
import type { PeriodDetection, SpadAction, SpadChannel, SpadConfig, TurnPolicy } from "./types"

export class SpadSupervisor {
  readonly config: SpadConfig
  private policy: TurnPolicy = { repetitionExpected: false, observeOnly: false }
  private detector!: SpadDetector
  private channel: SpadChannel = "text"
  private attempts = 0
  private watchdog: MotifWatchdog | undefined
  private watchdogChannel: SpadChannel | undefined
  private watchRemaining = 0
  private lastDetection: PeriodDetection | undefined
  private partObserveOnly = false
  private readonly toolLoop = new ToolLoopDetector()
  private readonly thrash: CrossTurnWatch
  private lastToolDetection: PeriodDetection | undefined
  private persistedWatchdogs: MotifWatchdog[] = []
  private persistedIds: string[] = []

  constructor(config: SpadConfig = DEFAULT_SPAD_CONFIG) { this.config = config; this.thrash = new CrossTurnWatch(config) }
  beginTurn(policy: TurnPolicy): void {
    this.policy = policy
    this.attempts = 0
    this.watchdog = undefined
    this.watchdogChannel = undefined
    this.watchRemaining = 0
    this.lastDetection = undefined
    this.lastToolDetection = undefined
    this.toolLoop.reset()
    this.thrash.reset()
    this.refreshPersistedWatchdogs()
    this.startPart("text", false)
  }

  /** Mark the boundary between provider generations (each recovery loop iteration). */
  markGeneration(): void {
    this.thrash.markGeneration()
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
    this.partObserveOnly = observeOnly
    this.detector = new SpadDetector({ channel, config: this.config, recoveryMode })
    if (this.watchdog && this.watchdogChannel === channel) this.watchdog.resetStream()
    for (const w of this.persistedWatchdogs) w.resetStream()
  }

  private interventionAllowed(detection: PeriodDetection): boolean {
    if (this.policy.repetitionExpected || this.policy.observeOnly || this.partObserveOnly) return false
    if (detection.lane === "canonical") {
      if (!this.config.autoRecoverCanonical) return false
      if ((detection.canonicalDuplicate4GramRatio ?? 0) < this.config.canonicalMinDuplicate4GramRatio) return false
    }
    if (detection.lane === "expansion") {
      if (!this.config.autoRecoverExpansion) return false
    }
    if (detection.lane === "thrash" && !this.config.autoRecoverThrash) return false
    return true
  }

  private triggerRecovery(detection: PeriodDetection, prompt: string = recoveryPrompt(this.attempts)): SpadAction {
    if (this.attempts >= this.config.maxRecoveryAttempts) return { type: "abort", detection, reason: "recovery-budget-exhausted" }
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
      if (detection.lane === "raw") addPersistedMotif(motif)
    }
    // Quarantine the sustained loop but keep a single occurrence of the motif so
    // the truncated part still reads as text rather than vanishing entirely.
    const quarantineFrom = detection.runStart + (detection.period > 0 ? detection.period : 0)
    // A thrash recovery resets cross-turn stagnation state so the post-recovery
    // generation is judged on fresh evidence instead of the accumulated
    // re-access stats that triggered the recovery.
    if (detection.lane === "thrash") this.thrash.reset()
    return { type: "recover", attempt: this.attempts, detection, quarantineFrom, recoveryPrompt: prompt, noTruncate: detection.lane === "thrash" }
  }

  private relapse(): SpadAction | undefined {
    const detection = this.lastDetection
    if (!detection) return undefined
    if (this.attempts >= this.config.maxRecoveryAttempts) return { type: "abort", detection, reason: "relapse" }
    this.attempts++; this.watchdog?.resetStream(); this.watchRemaining = this.config.recoveryWatchChars
    return { type: "recover", attempt: this.attempts, detection, quarantineFrom: 0, recoveryPrompt: recoveryPrompt(this.attempts) }
  }

  push(delta: string): SpadAction | undefined {
    // Persistent learned motifs get an early, lower-threshold check (32 chars)
    // so a known bad pattern is interrupted even before the full period
    // detector would confirm it. This is the cross-restart learning path.
    // Respect the same policy as normal detection to avoid false positives
    // on intentional repetition or structured output.
    if (this.persistedWatchdogs.length > 0 && !this.policy.repetitionExpected && !this.policy.observeOnly && !this.partObserveOnly) {
      const earlyThreshold = Math.max(64, Math.floor(this.config.relapseMatchChars * 0.66))
      for (let i = 0; i < this.persistedWatchdogs.length; i++) {
        const w = this.persistedWatchdogs[i]!
        if (w.push(delta, earlyThreshold)) {
          const detection: PeriodDetection = {
            kind: "periodic-attractor",
            lane: "raw",
            channel: this.channel,
            period: 0,
            runStart: 0,
            runEnd: delta.length,
            runLength: delta.length,
            exponent: 1,
            agreement: 1,
            insideCodeFence: false,
          }
          if (this.attempts >= this.config.maxRecoveryAttempts) return { type: "abort", detection, reason: "relapse" }
          this.attempts++
          w.resetStream()
          return { type: "recover", attempt: this.attempts, detection, quarantineFrom: 0, recoveryPrompt: recoveryPrompt(this.attempts) }
        }
      }
    }
    if (this.watchdog && this.watchdogChannel === this.channel && this.watchRemaining > 0) {
      const inspected = Math.min(delta.length, this.watchRemaining)
      if (this.watchdog.push(delta, this.config.relapseMatchChars, inspected)) return this.relapse()
      this.watchRemaining -= inspected
      if (this.watchRemaining <= 0) { this.watchdog = undefined; this.watchdogChannel = undefined }
    }
    this.thrash.pushNarration(delta)
    const thrashHit = this.thrash.evaluate(this.channel)
    if (thrashHit && this.interventionAllowed(thrashHit)) return this.triggerRecovery(thrashHit, thrashRecoveryPrompt(this.attempts))
    const detection = this.detector.push(delta)
    if (!detection) return undefined
    if (!this.interventionAllowed(detection)) return { type: "observe", detection }
    return this.triggerRecovery(detection)
  }

  pushTool(tool: string, isMutating: boolean, resource?: string): SpadAction | undefined {
    if (this.policy.repetitionExpected || this.policy.observeOnly) return undefined
    this.thrash.pushTool(tool, isMutating, resource)
    const thrashHit = this.thrash.evaluate(this.channel)
    if (thrashHit && this.interventionAllowed(thrashHit)) return this.triggerRecovery(thrashHit, thrashRecoveryPrompt(this.attempts))
    const hit = this.toolLoop.push(tool, isMutating)
    if (!hit) return undefined
    const detection: PeriodDetection = {
      kind: "periodic-attractor",
      lane: "raw",
      channel: this.channel,
      period: hit.period,
      runStart: 0,
      runEnd: hit.runLength,
      runLength: hit.runLength,
      exponent: hit.exponent,
      agreement: 1,
      insideCodeFence: false,
    }
    if (this.attempts >= this.config.maxRecoveryAttempts) return { type: "abort", detection, reason: "recovery-budget-exhausted" }
    this.attempts++
    this.lastToolDetection = detection
    return { type: "recover", attempt: this.attempts, detection, quarantineFrom: 0, recoveryPrompt: toolRecoveryPrompt(this.attempts) }
  }

  get recoveryAttempts(): number { return this.attempts }
}
