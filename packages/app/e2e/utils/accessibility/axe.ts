import { createRequire } from "node:module"
import type { Page } from "@playwright/test"

/**
 * Playwright loads specs as ESM, where a bare `require` identifier does not
 * exist. `createRequire(import.meta.url)` restores resolution relative to this
 * module, so `axe-core` resolves from this package's dependencies instead of
 * relying on a CommonJS global that is absent at runtime.
 */
const resolveFromHere = createRequire(import.meta.url)

const AXE_BUNDLE = "axe-core/axe.min.js"

/**
 * Deterministic axe-core injection and audit for the accessibility gate.
 *
 * Two failure modes make a naive axe gate silently useless, so both are hard
 * errors here rather than empty results:
 *
 * - axe never loaded (blocked inline script, wrong document, wrong build). A
 *   run that reports "no violations" because nothing executed is a false green.
 * - the scope selector matched nothing. Auditing an empty subtree proves
 *   nothing about the surface the gate claims to cover.
 *
 * Violations are normalized to a stable, sorted shape so assertion diffs stay
 * readable and do not churn on DOM ordering.
 */

/**
 * WCAG 2.0/2.1 A+AA. `best-practice` is intentionally excluded: those rules are
 * advisory rather than conformance criteria, and several are subjective enough
 * to make the gate flaky instead of stricter.
 */
export const ACCESSIBILITY_GATE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] as const

export type A11yViolation = {
  readonly rule: string
  readonly impact: string | null
  readonly help: string
  readonly helpUrl: string
  readonly targets: readonly string[]
  readonly nodes: number
}

export type A11yAudit = {
  readonly label: string
  readonly scope: string
  readonly scopeCount: number
  readonly violations: readonly A11yViolation[]
}

type RawViolation = {
  id?: unknown
  impact?: unknown
  help?: unknown
  helpUrl?: unknown
  nodes?: unknown
}

type RawResult = { missing: true } | { missing: false; violations: RawViolation[] }

function normalizeTarget(target: unknown): string {
  if (Array.isArray(target)) return target.map((entry) => String(entry)).join(" ")
  return String(target)
}

function normalize(violation: RawViolation): A11yViolation {
  const nodes = Array.isArray(violation.nodes) ? violation.nodes : []
  const targets = nodes
    .map((node) => (node && typeof node === "object" ? (node as { target?: unknown }).target : undefined))
    .filter((target): target is unknown => target !== undefined)
    .map(normalizeTarget)
    .sort()
  return {
    rule: String(violation.id ?? "unknown-rule"),
    impact: typeof violation.impact === "string" ? violation.impact : null,
    help: String(violation.help ?? ""),
    helpUrl: String(violation.helpUrl ?? ""),
    targets,
    nodes: nodes.length,
  }
}

export type AccessibilityAuditOptions = {
  /** Scenario name used in failure output. */
  label: string
  /** CSS selector for the subtree under audit. Must match at least one element. */
  scope: string
  /** Rule ids to switch off. Empty by default. */
  disabledRules?: readonly string[]
}

/**
 * Injects axe-core, audits `scope`, and returns normalized violations.
 * Throws rather than returning an empty list when axe failed to load or the
 * scope matched nothing.
 */
export async function auditAccessibility(page: Page, options: AccessibilityAuditOptions): Promise<A11yAudit> {
  const { label, scope, disabledRules = [] } = options

  const scopeCount = await page.locator(scope).count()
  if (scopeCount === 0) {
    throw new Error(
      `accessibility audit "${label}" scope matched no elements: ${JSON.stringify(scope)}. ` +
        `An empty scope would report zero violations and hide the surface it claims to cover.`,
    )
  }

  let axePath: string
  try {
    axePath = resolveFromHere.resolve(AXE_BUNDLE)
  } catch (cause) {
    throw new Error(
      `accessibility audit "${label}" cannot locate ${AXE_BUNDLE} from ${import.meta.url}: ${String(cause)}`,
    )
  }
  await page.addScriptTag({ path: axePath })

  const result = (await page.evaluate(
    async (input) => {
      const axe = (globalThis as { axe?: { run: (ctx: string, opts: unknown) => Promise<unknown> } }).axe
      if (!axe) return { missing: true as const }
      const rules: Record<string, { enabled: boolean }> = {}
      for (const id of input.disabledRules) rules[id] = { enabled: false }
      const report = (await axe.run(input.scope, {
        runOnly: { type: "tag", values: input.tags },
        rules,
        resultTypes: ["violations"],
      })) as { violations?: unknown[] }
      return { missing: false as const, violations: (report.violations ?? []) as RawViolation[] }
    },
    { scope, tags: [...ACCESSIBILITY_GATE_TAGS], disabledRules: [...disabledRules] },
  )) as RawResult

  if (result.missing) {
    throw new Error(
      `accessibility audit "${label}" could not run: axe-core is absent in the audited page. ` +
        `Injection must have been blocked; treat this as a broken gate, not a clean surface.`,
    )
  }

  const violations = result.violations
    .map(normalize)
    .sort((a, b) => {
      if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1
      const left = a.targets.join("|")
      const right = b.targets.join("|")
      if (left !== right) return left < right ? -1 : 1
      return 0
    })

  return { label, scope, scopeCount, violations }
}

/** Multi-line failure message; empty string when the surface is clean. */
export function formatViolations(audit: A11yAudit): string {
  if (audit.violations.length === 0) return ""
  const lines = [`${audit.violations.length} accessibility violation(s) in "${audit.label}" [${audit.scope}]`]
  for (const violation of audit.violations) {
    lines.push(`  - ${violation.rule} (impact: ${violation.impact ?? "unknown"}) — ${violation.help}`)
    lines.push(`    ${violation.helpUrl}`)
    for (const target of violation.targets) lines.push(`    target: ${target}`)
  }
  return lines.join("\n")
}