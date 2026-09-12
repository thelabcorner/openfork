import {
  ParameterizedFingerprintBuilder,
  hashParameterizedFingerprint,
} from "./parameterized-fast"
import { parameterizedMatchCode, type ParameterizedMatchEvidence } from "./parameterized"

export interface ParameterizedBlockWatchOptions {
  readonly windowLines?: number
  readonly phaseStrideLines?: number
  readonly maxDistanceLines?: number
  readonly minTokens?: number
  readonly minConstantCoverage?: number
  readonly minRepeatedParameterDensity?: number
  readonly minRepeatedParameterClasses?: number
  readonly minRenamedParameterClasses?: number
  readonly minStrongRecurrences?: number
  readonly maxBlockChars?: number
}

export interface ParameterizedBlockDetection {
  readonly startLine: number
  readonly previousStartLine: number
  readonly recurrence: number
  readonly evidence: ParameterizedMatchEvidence
}

type Previous = {
  readonly startLine: number
  readonly text: string
  readonly strongStreak: number
}

type PhaseState = {
  readonly seen: Map<string, Previous>
  readonly order: string[]
}

/**
 * Evidence-only watch for sustained local code-structure recurrence.
 *
 * Windows are emitted in staggered non-overlapping phases. A 32-bit structural
 * fingerprint pair is only a proposal key; every recurrence is rechecked by
 * the collision-free parameterized matcher. Detection requires a sustained
 * series of strong, consistently-renamed matches. This class has no recovery
 * authority and is not wired into the production detector yet.
 */
export class ParameterizedBlockWatch {
  private readonly windowLines: number
  private readonly phaseStrideLines: number
  private readonly maxDistanceLines: number
  private readonly minTokens: number
  private readonly minConstantCoverage: number
  private readonly minRepeatedParameterDensity: number
  private readonly minRepeatedParameterClasses: number
  private readonly minRenamedParameterClasses: number
  private readonly minStrongRecurrences: number
  private readonly maxBlockChars: number
  private readonly builder: ParameterizedFingerprintBuilder
  private readonly lines: string[] = []
  private readonly phases: PhaseState[]
  private lineCount = 0

  constructor(options: ParameterizedBlockWatchOptions = {}) {
    this.windowLines = options.windowLines ?? 8
    this.phaseStrideLines = options.phaseStrideLines ?? 4
    this.maxDistanceLines = options.maxDistanceLines ?? 96
    this.minTokens = options.minTokens ?? 24
    this.minConstantCoverage = options.minConstantCoverage ?? 0.35
    this.minRepeatedParameterDensity = options.minRepeatedParameterDensity ?? 0.5
    this.minRepeatedParameterClasses = options.minRepeatedParameterClasses ?? 2
    this.minRenamedParameterClasses = options.minRenamedParameterClasses ?? 2
    this.minStrongRecurrences = options.minStrongRecurrences ?? 3
    this.maxBlockChars = options.maxBlockChars ?? 8192
    if (this.windowLines <= 0 || this.phaseStrideLines <= 0 || this.windowLines % this.phaseStrideLines !== 0)
      throw new Error("parameterized watch requires windowLines to be a positive multiple of phaseStrideLines")
    this.builder = new ParameterizedFingerprintBuilder(this.maxBlockChars)
    const phaseCount = this.windowLines / this.phaseStrideLines
    this.phases = Array.from({ length: phaseCount }, () => ({ seen: new Map(), order: [] }))
  }

  reset(): void {
    this.lines.length = 0
    this.lineCount = 0
    for (const phase of this.phases) {
      phase.seen.clear()
      phase.order.length = 0
    }
  }

  private strong(evidence: ParameterizedMatchEvidence) {
    return (
      evidence.matched &&
      evidence.constantCoverage >= this.minConstantCoverage &&
      evidence.repeatedParameterDensity >= this.minRepeatedParameterDensity &&
      evidence.repeatedParameterClasses >= this.minRepeatedParameterClasses &&
      evidence.renamedParameterClasses >= this.minRenamedParameterClasses
    )
  }

  private remember(phase: PhaseState, key: string, value: Previous) {
    if (!phase.seen.has(key)) phase.order.push(key)
    phase.seen.set(key, value)
    // A phase can only contain roughly maxDistance/windowLines useful windows.
    // Keep a little slack but never allow arbitrary per-generation growth.
    const cap = Math.max(16, Math.ceil(this.maxDistanceLines / this.windowLines) * 4)
    while (phase.order.length > cap) {
      const oldest = phase.order.shift()!
      phase.seen.delete(oldest)
    }
  }

  pushLine(line: string): ParameterizedBlockDetection | undefined {
    this.lines.push(line)
    this.lineCount++
    if (this.lines.length > this.windowLines) this.lines.shift()
    if (this.lines.length < this.windowLines) return undefined

    const startLine = this.lineCount - this.windowLines + 1
    const zeroStart = startLine - 1
    if (zeroStart % this.phaseStrideLines !== 0) return undefined
    const phaseIndex = Math.floor((zeroStart % this.windowLines) / this.phaseStrideLines)
    const phase = this.phases[phaseIndex]!
    const block = this.lines.join("\n")
    if (block.length > this.maxBlockChars) return undefined
    const fingerprint = this.builder.build(block)
    if (fingerprint.length < this.minTokens) return undefined
    const { h1, h2 } = hashParameterizedFingerprint(fingerprint)
    const key = `${fingerprint.length}:${h1}:${h2}`
    const previous = phase.seen.get(key)
    let strongStreak = 0
    if (previous) {
      const distance = startLine - previous.startLine
      if (distance <= this.maxDistanceLines) {
        const evidence = parameterizedMatchCode(previous.text, block)
        const strong = this.strong(evidence)
        strongStreak = strong ? previous.strongStreak + 1 : 0
        this.remember(phase, key, { startLine, text: block, strongStreak })
        if (strong && strongStreak >= this.minStrongRecurrences) {
          return { startLine, previousStartLine: previous.startLine, recurrence: strongStreak, evidence }
        }
        return undefined
      }
    }
    this.remember(phase, key, { startLine, text: block, strongStreak })
    return undefined
  }
}
