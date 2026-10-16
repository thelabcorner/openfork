import type { A11yViolation } from "./axe"

/**
 * Reviewed pre-existing accessibility debt.
 *
 * The gate was introduced against a UI that already carries WCAG A/AA findings.
 * Landing it as an all-or-nothing red gate would be useless: it would fail every
 * run for reasons nobody can act on in the same change, so people would delete
 * it. So this table records the known findings as an explicit, reviewable
 * ratchet instead:
 *
 * - Each entry is matched by exact `rule` + normalized target, so a violation
 *   anywhere else — or the same rule on a different element — still fails.
 * - Fixing a finding means deleting its entry, so the table can only shrink.
 * - Nothing here is a judgement that the finding is acceptable. Every entry is
 *   real debt that still needs product work; the table only records that this
 *   gate is not the place to pay it off.
 *
 * `:nth-child(N)` is normalized to `:nth-child(*)` so ordinary sibling
 * reordering in the composer toolbar does not turn into a false regression.
 */
export type AccessibilityDebt = {
  readonly rule: string
  readonly target: string
  /** Why the finding exists, and what fixing it requires. */
  readonly reason: string
  /** Scenarios in which this finding was observed. */
  readonly observedIn: readonly string[]
}

export const KNOWN_ACCESSIBILITY_DEBT: readonly AccessibilityDebt[] = [
  {
    rule: "button-name",
    target: 'div[data-component="tooltip-v2-trigger"][data-closed=""]:nth-child(*) > button[data-size="normal"][data-component="icon-button-v2"]',
    reason:
      "Composer toolbar icon buttons ship with no accessible name. Needs an i18n label per toolbar action; not a fixture or harness concern.",
    observedIn: ["active", "read-only"],
  },
  {
    rule: "aria-hidden-focus",
    target: 'div[data-slot="session-turn-assistant-content"]',
    reason:
      "The assistant turn wrapper is aria-hidden while still containing focusable content. Needs a product fix so hiding and focusability agree.",
    observedIn: ["active"],
  },
  {
    rule: "aria-prohibited-attr",
    target: 'span[aria-label="Thinking"]',
    reason:
      "The thinking-phase shimmer span carries aria-label on a role that forbids naming. Needs the label moved to a permitted host.",
    observedIn: ["active"],
  },
  {
    rule: "color-contrast",
    target:
      'span[aria-label="Thinking"] > span[data-slot="text-shimmer-char"] > span[data-slot="text-shimmer-char-shimmer"][data-run="true"]',
    reason:
      "Animated shimmer glyphs fall below AA contrast in the oc-2 palette. Needs a theme token change, so it is theme-dependent.",
    observedIn: ["active"],
  },
  {
    rule: "color-contrast",
    target: '.font-\\[440\\].text-v2-text-text-faint.truncate',
    reason: "Question card header uses the faint text token; below AA in the oc-2 palette.",
    observedIn: ["selected-disabled"],
  },
  {
    rule: "color-contrast",
    target: '.h-\\[18px\\].font-\\[500\\].hover\\:text-v2-text-text-base:nth-child(*)',
    reason: "Question card option/footer row sits below AA in the oc-2 palette.",
    observedIn: ["selected-disabled"],
  },
  {
    rule: "color-contrast",
    target: ".text-\\[9px\\]",
    reason: "Question step counter uses the faint text token; below AA in the oc-2 palette.",
    observedIn: ["selected-disabled"],
  },
  {
    rule: "color-contrast",
    target: 'button[title="Clear selection — ⌫"]',
    reason: "Clear-selection affordance is below AA in the oc-2 palette.",
    observedIn: ["selected-disabled"],
  },
]

/**
 * Strips volatile selector fragments so a baseline entry survives harmless DOM
 * churn without becoming so loose that it masks a real regression elsewhere.
 */
export function normalizeBaselineTarget(target: string): string {
  return target
    .replace(/:nth-child\(\d+\)/g, ":nth-child(*)")
    // Solid serializes a component prop into the attribute selector axe echoes
    // back, which is an implementation artifact rather than a stable contract.
    .replace(/\[icon="\[object [^\]]*\]"\]/g, "")
}

function matches(entry: AccessibilityDebt, violation: A11yViolation): boolean {
  if (entry.rule !== violation.rule) return false
  return violation.targets.some((target) => normalizeBaselineTarget(target) === normalizeBaselineTarget(entry.target))
}

export type PartitionedViolations = {
  /** Not covered by the reviewed baseline: these fail the gate. */
  regressed: readonly A11yViolation[]
  /** Matched a baseline entry. Still real debt, never silently dropped. */
  acknowledged: readonly A11yViolation[]
}

export function partitionViolations(violations: readonly A11yViolation[]): PartitionedViolations {
  const regressed: A11yViolation[] = []
  const acknowledged: A11yViolation[] = []
  for (const violation of violations) {
    if (KNOWN_ACCESSIBILITY_DEBT.some((entry) => matches(entry, violation))) acknowledged.push(violation)
    else regressed.push(violation)
  }
  return { regressed, acknowledged }
}

/** Human summary of what the gate tolerated, for CI annotations. */
export function describeAcknowledged(violations: readonly A11yViolation[]): string {
  if (violations.length === 0) return "no acknowledged debt"
  return violations.map((violation) => `${violation.rule} (${violation.impact ?? "unknown"})`).join(", ")
}