/**
 * Strict, fail-closed admission control for accessibility fixture payloads.
 *
 * The accessibility gate renders fixture strings into the very document it
 * injects `axe` into. Two properties therefore have to hold at once:
 *
 * 1. Safety. Executable markup inside a fixture would run inside the audited
 *    page, so "test" data could drive the harness that is supposed to be
 *    testing it.
 * 2. Gate integrity. Removing the offending markup and auditing the remainder
 *    would measure a document no user input could ever produce. A sanitized
 *    fixture turns a real finding green, which is worse than a red gate
 *    because it looks like coverage.
 *
 * So this module REJECTS. It never rewrites, escapes, truncates, or strips a
 * payload. A caller either gets the original string back untouched, or a typed
 * error naming the exact rule that refused it, and the fixture author fixes the
 * fixture. There is deliberately no "sanitize and continue" escape hatch and no
 * opt-out flag.
 */

export type UnsafeFixtureRuleId =
  | "markup-delimiter"
  | "html-comment"
  | "event-handler-attribute"
  | "script-url-scheme"
  | "entity-encoded-markup"
  | "template-interpolation"
  | "control-character"

type Hazard = { rule: UnsafeFixtureRuleId; index: number; match: string; reason: string }

export class UnsafeFixturePayloadError extends Error {
  readonly field: string
  readonly rule: UnsafeFixtureRuleId
  /** JSON-encoded window around the rejected bytes, so markup stays visibly inert. */
  readonly excerpt: string

  constructor(input: { field: string; rule: UnsafeFixtureRuleId; reason: string; excerpt: string }) {
    super(
      `refusing unsafe accessibility fixture at ${input.field}: ${input.reason} (rule ${input.rule}, at ${input.excerpt}). ` +
        `Fix the fixture text instead of stripping it — a sanitized payload audits a document the product can never render.`,
    )
    this.name = "UnsafeFixturePayloadError"
    this.field = input.field
    this.rule = input.rule
    this.excerpt = input.excerpt
  }
}

/**
 * Named references that decode to a markup-significant character. Deliberately
 * a short explicit table rather than the full HTML entity list: every other
 * named reference is inert for injection purposes, and an unknown name is left
 * alone instead of being rejected.
 */
const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  amp: "&",
  sol: "/",
  bsol: "\\",
  colon: ":",
  num: "#",
  dollar: "$",
  NewLine: "\n",
  Tab: "\t",
}

const MARKUP_SIGNIFICANT = new Set(["<", ">", '"', "'", "&", "/", "\\", "=", ":", "#", "$"])

const EVENT_HANDLER = /(?:^|[^a-z0-9-])on[a-z]+\s*=/i
const SCRIPT_URL_SCHEME = /(?:javascript|vbscript|livescript|mocha|data)\s*:/i
const INLINE_STYLE_EXPRESSION = /\b(?:expression|url)\s*\(/i
const TEMPLATE_INTERPOLATION = /\$\{|\{\{/
const HTML_COMMENT = /<!--|-->|<!\[CDATA\[|<!DOCTYPE/i
const MARKUP_DELIMITER = /[<>]/
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const ENTITY_REFERENCE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g

function safeFromCodePoint(code: number): string | undefined {
  // Lone surrogates and out-of-range values become U+FFFD in a real decoder;
  // mirroring that keeps admission aligned with rendering.
  if (code < 0 || code > 0x10ffff) return "\uFFFD"
  try {
    return String.fromCodePoint(code)
  } catch {
    return "\uFFFD"
  }
}

function decodeNumericReference(decimal: string | undefined, hex: string | undefined): string | undefined {
  if (decimal !== undefined) {
    const code = Number.parseInt(decimal, 10)
    return Number.isNaN(code) ? undefined : safeFromCodePoint(code)
  }
  if (hex !== undefined) {
    const code = Number.parseInt(hex, 16)
    return Number.isNaN(code) ? undefined : safeFromCodePoint(code)
  }
  return undefined
}

function findEntityHazard(value: string): Hazard | undefined {
  for (const match of value.matchAll(ENTITY_REFERENCE)) {
    const [reference, decimal, hex, named] = match
    const decoded =
      decimal !== undefined || hex !== undefined
        ? decodeNumericReference(decimal, hex)
        : NAMED_ENTITIES[named as string]
    // An unrecognized named reference renders literally, so it cannot smuggle
    // a delimiter past this check.
    if (decoded === undefined) continue
    if ([...decoded].some((character) => MARKUP_SIGNIFICANT.has(character))) {
      return {
        rule: "entity-encoded-markup",
        index: match.index ?? 0,
        match: reference,
        reason: `entity reference ${reference} decodes to a markup-significant character`,
      }
    }
  }
  return undefined
}

/**
 * Rules are ordered by *provenance*: the most specific cause of the hazard is
 * reported, because that is the one a fixture author has to fix.
 *
 * The ordering matters more than it looks. A payload like
 * `&#x3C;svg onload=alert(1)&#x3E;` contains the literal text `onload=`, but that
 * text is inert on its own — it only becomes an event handler after the entity
 * references decode. Reporting `event-handler-attribute` there would point the
 * author at the wrong token and hide the real provenance, so entity provenance
 * is resolved before any raw-text rule. Likewise raw `<`/`>` outranks a raw
 * `on*=`, because without a raw delimiter the handler attribute is just text.
 */
function findUnsafeConstruct(value: string): Hazard | undefined {
  const comment = HTML_COMMENT.exec(value)
  if (comment) {
    return {
      rule: "html-comment",
      index: comment.index,
      match: comment[0],
      reason: "comment, CDATA, or doctype delimiter",
    }
  }

  const entity = findEntityHazard(value)
  if (entity) return entity

  const delimiter = MARKUP_DELIMITER.exec(value)
  if (delimiter) {
    return {
      rule: "markup-delimiter",
      index: delimiter.index,
      match: delimiter[0],
      reason: "raw markup delimiter",
    }
  }

  const handler = EVENT_HANDLER.exec(value)
  if (handler) {
    return {
      rule: "event-handler-attribute",
      index: handler.index,
      match: handler[0].trim(),
      reason: "inline event handler attribute",
    }
  }

  for (const { pattern, reason } of [
    { pattern: SCRIPT_URL_SCHEME, reason: "script-bearing URL scheme" },
    { pattern: INLINE_STYLE_EXPRESSION, reason: "inline style expression or url() reference" },
  ] as const) {
    const match = pattern.exec(value)
    if (match) return { rule: "script-url-scheme", index: match.index, match: match[0], reason }
  }

  const interpolation = TEMPLATE_INTERPOLATION.exec(value)
  if (interpolation) {
    return {
      rule: "template-interpolation",
      index: interpolation.index,
      match: interpolation[0],
      reason: "template or mustache interpolation sequence",
    }
  }

  return undefined
}

function excerptAround(value: string, index: number): string {
  const start = Math.max(0, index - 16)
  const end = Math.min(value.length, index + 24)
  return JSON.stringify(value.slice(start, end))
}

/** True when `value` is a string that cannot introduce markup or script. */
export function isInertFixtureText(value: unknown): value is string {
  if (typeof value !== "string") return false
  if (CONTROL_CHARACTER.test(value)) return false
  return findUnsafeConstruct(value) === undefined
}

/**
 * Returns `value` unchanged when it is inert, otherwise throws.
 *
 * This is the admission boundary for every string the accessibility gate puts
 * on screen. It never returns a modified string.
 */
export function assertInertFixtureText(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new UnsafeFixturePayloadError({
      field,
      rule: "markup-delimiter",
      reason: `expected inert text but received ${value === null ? "null" : typeof value}`,
      excerpt: JSON.stringify(value) ?? "undefined",
    })
  }
  if (CONTROL_CHARACTER.test(value)) {
    const index = value.search(CONTROL_CHARACTER)
    throw new UnsafeFixturePayloadError({
      field,
      rule: "control-character",
      reason: "disallowed control character",
      excerpt: excerptAround(value, index),
    })
  }
  const hazard = findUnsafeConstruct(value)
  if (hazard) {
    throw new UnsafeFixturePayloadError({
      field,
      rule: hazard.rule,
      reason: hazard.reason,
      excerpt: excerptAround(value, hazard.index),
    })
  }
  return value
}

const MAX_DEPTH = 12

/**
 * Recursively admits a fixture tree (plain objects and arrays), reporting the
 * failing path. Non-string leaves and non-plain objects (Date, Map, class
 * instances) are left to the fixture's own schema validation; this only guards
 * strings that would reach the audited document.
 */
export function assertInertFixtureTree<T>(value: T, field = "fixture"): T {
  const seen = new WeakSet<object>()
  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > MAX_DEPTH) {
      throw new UnsafeFixturePayloadError({
        field: path,
        rule: "markup-delimiter",
        reason: `fixture nesting deeper than ${MAX_DEPTH} levels`,
        excerpt: JSON.stringify(path),
      })
    }
    if (typeof node === "string") {
      assertInertFixtureText(node, path)
      return
    }
    if (typeof node !== "object" || node === null) return
    const prototype = Object.getPrototypeOf(node)
    if (prototype !== Object.prototype && prototype !== Array.prototype) return
    if (seen.has(node)) {
      throw new UnsafeFixturePayloadError({
        field: path,
        rule: "markup-delimiter",
        reason: "cyclic fixture payload",
        excerpt: JSON.stringify(path),
      })
    }
    seen.add(node)
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1))
      return
    }
    for (const [key, child] of Object.entries(node)) walk(child, `${path}.${key}`, depth + 1)
  }
  walk(value, field, 0)
  return value
}