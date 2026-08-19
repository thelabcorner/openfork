import { DEFAULT_SPAD_CONFIG } from "./config"
import { SpadDetector } from "./detector"
import { MotifWatchdog } from "./motif-watchdog"
import { recoveryPrompt } from "./recovery"
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

  constructor(config: SpadConfig = DEFAULT_SPAD_CONFIG) { this.config = config }
  beginTurn(policy: TurnPolicy): void { this.policy = policy; this.attempts = 0; this.watchdog = undefined; this.watchdogChannel = undefined; this.watchRemaining = 0; this.lastDetection = undefined; this.startPart("text", false) }
  startPart(
    channel: SpadChannel,
    recoveryMode = this.watchdog !== undefined,
    observeOnly = this.policy.observeOnly,
  ): void {
    this.channel = channel
    this.partObserveOnly = observeOnly
    this.detector = new SpadDetector({ channel, config: this.config, recoveryMode })
    if (this.watchdog && this.watchdogChannel === channel) this.watchdog.resetStream()
  }

  private interventionAllowed(detection: PeriodDetection): boolean {
    if (this.policy.repetitionExpected || this.policy.observeOnly || this.partObserveOnly) return false
    if (detection.lane === "canonical" && !this.config.autoRecoverCanonical) return false
    return true
  }

  private triggerRecovery(detection: PeriodDetection): SpadAction {
    if (this.attempts >= this.config.maxRecoveryAttempts) return { type: "abort", detection, reason: "recovery-budget-exhausted" }
    this.attempts++; this.lastDetection = detection
    const motif = this.detector.extractMotif(detection)
    if (motif) { this.watchdog = new MotifWatchdog(motif, this.config.qgram); this.watchdogChannel = detection.channel; this.watchRemaining = this.config.recoveryWatchChars }
    return { type: "recover", attempt: this.attempts, detection, quarantineFrom: detection.runStart, recoveryPrompt: recoveryPrompt(this.attempts) }
  }

  private relapse(): SpadAction | undefined {
    const detection = this.lastDetection
    if (!detection) return undefined
    if (this.attempts >= this.config.maxRecoveryAttempts) return { type: "abort", detection, reason: "relapse" }
    this.attempts++; this.watchdog?.resetStream(); this.watchRemaining = this.config.recoveryWatchChars
    return { type: "recover", attempt: this.attempts, detection, quarantineFrom: 0, recoveryPrompt: recoveryPrompt(this.attempts) }
  }

  push(delta: string): SpadAction | undefined {
    if (this.watchdog && this.watchdogChannel === this.channel && this.watchRemaining > 0) {
      const inspected = Math.min(delta.length, this.watchRemaining)
      if (this.watchdog.push(delta, this.config.relapseMatchChars, inspected)) return this.relapse()
      this.watchRemaining -= inspected
      if (this.watchRemaining <= 0) { this.watchdog = undefined; this.watchdogChannel = undefined }
    }
    const detection = this.detector.push(delta)
    if (!detection) return undefined
    if (!this.interventionAllowed(detection)) return { type: "observe", detection }
    return this.triggerRecovery(detection)
  }

  get recoveryAttempts(): number { return this.attempts }
}
