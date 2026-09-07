import type { Span } from "./span"
import { assertSpansExplain } from "./invariant"
import { applySpans } from "./span"

export type EditPlan = {
  filePath: string
  /** Original file text, original line endings, BOM stripped. */
  contentOld: string
  contentNew: string
  bom: boolean
  /** In contentOld coordinates. Carries replacement text (see span.ts). */
  spans: Span[]
  strategy: string
  /** TRUE count. Previously hardcoded to 1 in finishEdit (D25). */
  applied: number
  warnings: string[]
  oldPreview?: string
  isNew: boolean
}

export function buildPlan(input: Omit<EditPlan, "contentNew"> & { contentNew?: string }): EditPlan {
  const contentNew = input.contentNew ?? applySpans(input.contentOld, input.spans)
  // Invariant is checked at plan construction, so a bad matcher or strategy
  // fails before a permission prompt is ever shown to a human.
  assertSpansExplain(input.contentOld, contentNew, input.spans)
  return { ...input, contentNew }
}

export * as EditPlanMod from "./plan"
