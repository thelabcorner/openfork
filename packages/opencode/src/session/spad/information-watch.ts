import { toolResultSignature } from "./thrash"

export interface InformationRecurrenceOptions {
  /** Distinct consecutive provider generations required, including the first. */
  readonly minConsecutiveGenerations?: number
  readonly maxResources?: number
}

export interface InformationRecurrenceDetection {
  readonly resource: string
  readonly recurrences: number
  readonly startGeneration: number
  readonly endGeneration: number
  readonly resultSignature: string
}

type ResourceState = {
  signature: string
  lastGeneration: number
  startGeneration: number
  streak: number
}

/**
 * Evidence-only detector for a particularly strong form of agent stagnation:
 * the same exact operation returns the same exact bounded result signature in
 * consecutive provider generations. Same-generation repetition belongs to the
 * existing doom-loop/tool-loop mechanisms and does not advance this streak.
 *
 * No tool output is retained. Host-attested progress clears all streaks.
 */
export class InformationRecurrenceWatch {
  private readonly minConsecutiveGenerations: number
  private readonly maxResources: number
  private readonly states = new Map<string, ResourceState>()
  private generation = -1

  constructor(options: InformationRecurrenceOptions = {}) {
    this.minConsecutiveGenerations = options.minConsecutiveGenerations ?? 4
    this.maxResources = options.maxResources ?? 256
    if (this.minConsecutiveGenerations < 2) throw new Error("information recurrence requires at least 2 generations")
  }

  reset(): void {
    this.states.clear()
    this.generation = -1
  }

  markGeneration(): void {
    this.generation++
  }

  markProgress(): void {
    this.states.clear()
  }

  pushResult(resource: string, output: string): InformationRecurrenceDetection | undefined {
    return this.pushSignature(resource, toolResultSignature(output))
  }

  pushSignature(resource: string, signature: string): InformationRecurrenceDetection | undefined {
    const previous = this.states.get(resource)
    let next: ResourceState
    if (previous?.lastGeneration === this.generation) {
      // Multiple identical operations inside one generation do not create
      // cross-generation evidence. Doom-loop owns that surface.
      if (previous.signature !== signature)
        next = { signature, lastGeneration: this.generation, startGeneration: this.generation, streak: 1 }
      else next = previous
    } else if (
      previous &&
      previous.signature === signature &&
      previous.lastGeneration === this.generation - 1
    ) {
      next = { ...previous, lastGeneration: this.generation, streak: previous.streak + 1 }
    } else {
      next = { signature, lastGeneration: this.generation, startGeneration: this.generation, streak: 1 }
    }

    if (!this.states.has(resource) && this.states.size >= this.maxResources) {
      const oldest = this.states.keys().next().value as string | undefined
      if (oldest !== undefined) this.states.delete(oldest)
    }
    this.states.set(resource, next)

    // Edge-trigger the episode. Once a recurrence has crossed the evidence
    // threshold, later identical generations are the same episode rather than
    // new evidence events. A changed result, generation gap, or host progress
    // restarts the streak and may produce a future detection.
    if (next.streak !== this.minConsecutiveGenerations) return undefined
    return {
      resource,
      recurrences: next.streak,
      startGeneration: next.startGeneration,
      endGeneration: next.lastGeneration,
      resultSignature: next.signature,
    }
  }
}
