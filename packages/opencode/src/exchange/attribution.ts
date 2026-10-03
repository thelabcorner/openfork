export * as ExchangeAttribution from "./attribution"

import { CodingActivity } from "@opencode-ai/core/coding-activity"

/** Source recorded by a producer that supplies no attribution of its own. */
export const DEFAULT_SOURCE: CodingActivity.Source = "core"

/**
 * Optional attribution for the ONE canonical CodingActivity record an Exchange
 * producer already publishes.
 *
 * A trusted boundary (OFXP today) can name who performed the file operation by
 * handing this context to the shared producer. Attribution is folded into the
 * record the producer already emits; it never adds a second record and never
 * causes the producer to skip one. That keeps every file operation attributed
 * exactly once no matter how many boundaries observe it.
 *
 * Deliberately absent: any line-change count. The producer computes the exact
 * before/after delta from committed bytes, so a count can only be exact or
 * absent — a boundary can never contribute an estimate.
 */
export interface Attribution {
  /** Boundary that actually performed the operation. */
  readonly source: CodingActivity.Source
  /**
   * Canonical project identity the boundary already proved from trusted state.
   * Required so a boundary that claims attribution also owns project identity
   * instead of silently inheriting the kernel's display-path heuristic.
   *
   * This is a display name, not a directory. It is kept strictly separate from
   * `projectFolder` and must never be turned into one.
   */
  readonly project: string
  /**
   * Canonical absolute filesystem root the boundary proved, or absent when it
   * proved none.
   *
   * This is the only field allowed to become a `projectFolder`, and it is
   * optional precisely because root authority is not universal: a boundary that
   * authorized a file inside some root has one, and a boundary that handed the
   * kernel nothing but an already-authorized target has not. It must be a real
   * directory the boundary already resolved and verified — never a display name,
   * a public alias, a `displayPath` spelling, or anything derived from one.
   */
  readonly projectFolder?: string
  /**
   * Stable identity of the acting principal. Must be a durable principal
   * identity, not a per-invocation token: this names who acted, and consumers
   * may legitimately use it to group activity from one actor.
   */
  readonly sourceRef?: string
  /**
   * Per-invocation identity proving that a CodingActivity observation is a
   * replay of the same logical operation. Unlike `sourceRef`, this identifies
   * one invocation/observation rather than the acting principal.
   */
  readonly replayToken?: string
}

export interface Identity {
  readonly source: CodingActivity.Source
  readonly project: string
  readonly projectFolder?: string
  readonly sourceRef?: string
  readonly replayToken?: string
}

/**
 * Folds optional attribution into the shared record fields of one producer.
 *
 * With no attribution the producer keeps its exact previous behavior, including
 * the display-path project heuristic, and — deliberately — supplies no project
 * folder. The kernel holds no root authority of its own, so an unattributed
 * producer has nothing truthful to report and must fail closed rather than
 * guess a directory from a path spelling.
 */
export function apply(
  attribution: Attribution | undefined,
  fallback: { readonly project: string },
): Identity {
  if (attribution === undefined) return { source: DEFAULT_SOURCE, project: fallback.project }
  return {
    source: attribution.source,
    project: attribution.project,
    ...(attribution.projectFolder === undefined ? {} : { projectFolder: attribution.projectFolder }),
    ...(attribution.sourceRef === undefined ? {} : { sourceRef: attribution.sourceRef }),
    ...(attribution.replayToken === undefined ? {} : { replayToken: attribution.replayToken }),
  }
}
