export * as SpadAuditor from "./spad-auditor"

import { Effect, Schema } from "effect"

export const VERDICT_TOOL = "spad_verdict"
export const MAX_INPUT_CHARS = 4_096
export const MAX_EXCERPT_CHARS = 1_200
export const VETO_CONFIDENCE = 0.8

export const DECISIONS = ["degenerate", "legitimate", "uncertain"] as const
export const REASONS = [
  "exact_loop",
  "approximate_loop",
  "structural_loop",
  "semantic_stagnation",
  "intentional_repetition",
  "structured_content",
  "code_structure",
  "genuine_progress",
  "insufficient_evidence",
] as const

export const Decision = Schema.Literals(DECISIONS)
export type Decision = typeof Decision.Type

export const Reason = Schema.Literals(REASONS)
export type Reason = typeof Reason.Type

export const Verdict = Schema.Struct({
  decision: Decision,
  confidence: Schema.Number,
  reason: Reason,
})
export type Verdict = typeof Verdict.Type

export type FeatureValue = string | number | boolean | null

export interface AuditCase {
  /** User intent only. Never include an upstream detector label or proposed verdict. */
  readonly intentExcerpt: string
  /** Small amount of text immediately before the candidate region. */
  readonly contextBefore: string
  /** Representative beginning of the candidate region. */
  readonly candidateHead: string
  /** Representative end of the candidate region. */
  readonly candidateTail: string
  /** Coarse surface type such as prose, code, JSONL, tool-activity, or unknown. */
  readonly contentKind: string
  /** Objective detector measurements only; no aggregate "loop score" or proposed label. */
  readonly features: Readonly<Record<string, FeatureValue>>
}

export type Disposition = "veto" | "retain-observation"

/**
 * The auditor is an observation-quality guard, not a recovery authority, so it
 * is safe to run by default. Only an explicit false disables it.
 */
export function enabled(flag: boolean | undefined): boolean {
  return flag !== false
}

export const DEFAULT_PROMPT = `You are a narrow repetition-quality auditor. Decide whether the supplied candidate region is genuinely degenerate repetition or legitimate repeated/structured content.

Judge only the supplied evidence. Repetition by itself is not a failure. Tables, generated code, logs, JSON/JSONL, repeated headings, quotations, requested repetition, iterative work with changing values, and other structured content can legitimately repeat. Genuine degeneration means the output is trapped in materially redundant continuation without useful new information or progress.

Prefer "uncertain" whenever the evidence is insufficient. Do not infer hidden repository state, tool results, or user intent beyond the supplied excerpts.`

export const PROTOCOL_PROMPT = `You have exactly one host tool: ${VERDICT_TOOL}. Finish only by calling it exactly once with decision, confidence, and reason. Do not emit prose or Markdown. Do not call any other tool. IMMEDIATELY END GENERATION after the tool call.`

function clip(value: string, max: number) {
  if (value.length <= max) return value
  const head = Math.ceil(max * 0.55)
  const tail = Math.floor(max * 0.35)
  return `${value.slice(0, head)}\n[...clipped...]\n${value.slice(-tail)}`
}

function stableFeatures(features: Readonly<Record<string, FeatureValue>>) {
  return Object.fromEntries(Object.entries(features).toSorted(([a], [b]) => a.localeCompare(b)))
}

/**
 * Render neutral evidence for the auditor. The wire shape deliberately has no
 * SPAD lane/source, detector verdict, proposed action, confidence score, model
 * identity, or wording such as "detected loop" that could anchor the judge.
 */
export function renderCase(input: AuditCase): string {
  const payload = {
    intentExcerpt: clip(input.intentExcerpt, 800),
    contextBefore: clip(input.contextBefore, MAX_EXCERPT_CHARS),
    candidateHead: clip(input.candidateHead, MAX_EXCERPT_CHARS),
    candidateTail: clip(input.candidateTail, MAX_EXCERPT_CHARS),
    contentKind: clip(input.contentKind, 80),
    features: stableFeatures(input.features),
  }
  const body = JSON.stringify(payload)
  if (body.length <= MAX_INPUT_CHARS) return `<repetition-audit-case>${body}</repetition-audit-case>`
  // The candidate excerpts carry more judgment value than ambient context. If
  // the first bounded render is still too large, retain both candidate edges
  // and collapse intent/context deterministically.
  const compact = JSON.stringify({
    ...payload,
    intentExcerpt: clip(payload.intentExcerpt, 320),
    contextBefore: clip(payload.contextBefore, 320),
    candidateHead: clip(payload.candidateHead, 900),
    candidateTail: clip(payload.candidateTail, 900),
  })
  return `<repetition-audit-case>${compact.slice(0, MAX_INPUT_CHARS)}</repetition-audit-case>`
}

export function validateVerdict(input: unknown): Effect.Effect<Verdict, string> {
  return Schema.decodeUnknownEffect(Verdict)(input).pipe(
    Effect.mapError((error) => `Invalid ${VERDICT_TOOL} payload: ${String(error)}`),
    Effect.flatMap((verdict) => {
      if (!Number.isFinite(verdict.confidence) || verdict.confidence < 0 || verdict.confidence > 1)
        return Effect.fail(`Invalid ${VERDICT_TOOL} payload: confidence must be between 0 and 1`)
      return Effect.succeed(verdict)
    }),
  )
}

/**
 * Phase-1 authority rule. The auditor may suppress an ambiguous observation
 * when it is confidently legitimate, but it can never create or authorize a
 * destructive intervention. A "degenerate" verdict only retains the existing
 * deterministic observation for telemetry/calibration.
 */
export function disposition(verdict: Verdict, vetoConfidence = VETO_CONFIDENCE): Disposition {
  if (verdict.decision === "legitimate" && verdict.confidence >= vetoConfidence) return "veto"
  return "retain-observation"
}
