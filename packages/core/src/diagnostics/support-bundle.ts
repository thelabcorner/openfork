/**
 * Privacy-safe diagnostics / support bundle core.
 *
 * A support bundle is a *shareable* artifact, so its security property is
 * structural rather than "we remembered not to include the bad field":
 *
 * 1. **Allowlisted projection.** Every section declares its own bounded field
 *    spec. Anything not declared is dropped, not filtered. Default sections are
 *    runtime/config/workspace/connectivity shape only; conversation and task
 *    content is a separately gated section that is OFF unless explicitly
 *    requested.
 * 2. **One secret owner.** Raw strings are scrubbed with `MemorySecrets`
 *    (`@opencode-ai/core/memory/secrets`), the canonical credential scanner.
 *    This module deliberately does not carry a second regex catalog: a second
 *    catalog is a second, permanently divergent answer to "what is a secret".
 * 3. **Report-local pseudonyms.** Private paths/names become stable
 *    `<kind>-<digest>` tokens *within one artifact*, salted per report so two
 *    reports of the same machine do not intentionally correlate. Structural
 *    relationships survive (same value → same token, same parent → same token),
 *    identities do not.
 * 4. **Scrub on the way out, not just on the way in.** `serialize` re-scrubs the
 *    finished structure and refuses to emit JSON that still scans dirty.
 *
 * The shape is intentionally transport- and owner-agnostic so the OXP/OFXP
 * connectivity projection, or any future subsystem, can contribute bounded
 * health facts without inheriting this module's assumptions about their content.
 *
 * Scope note on non-path private identity: bare IPv4 literals and bare internal
 * hostnames are pseudonymized by *field declaration*, not by auto-detection.
 * `1.18.34` (a version) and `10.0.0.1` (a private address) are lexically
 * identical, and diagnostics that mangled the product version would be worse
 * than useless. A section that owns host/endpoint/peer identity declares it
 * with `pseudonym`, and a host that knows its own home root, username, or
 * machine name passes those literals through `privateValues`.
 */
import { createHash, randomBytes } from "node:crypto"
import { MemorySecrets } from "../memory/secrets"

export * as SupportBundle from "./support-bundle"

// ---------------------------------------------------------------------------
// JSON shape
// ---------------------------------------------------------------------------

/** Browser-safe JSON value. The artifact never contains `undefined`, classes, or non-JSON leaves. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** The diagnostic surface of the host. A missing section is simply absent from `input`. */
export type SupportBundleSectionId =
  | "runtime"
  /** Host identity, toolchain, and storage roots. */
  | "config"
  /**
   * Which providers/agents/plugins/MCP servers exist — never their credentials.
   *
   * Not readable at Tier 0: `Config.Service` is instance-scoped, so a
   * bootstrap-free caller cannot resolve it. Excluded by default for that
   * reason, and because resolved config is the highest-risk section for
   * leaking names, paths, and credentials. An instance-bearing caller may pass
   * an already-redacted projection via `include`.
   */
  | "workspaces"
  /** Bounded workspace records: pseudonymized root, VCS, counts. */
  | "connectivity"
  /** OXP / OFXP peer, tunnel, and invocation health. No credentials, no endpoint secrets. */
  | "logs"
  /** Bounded scrubbed log text. */
  | "conversation"
  /** Conversation and task content. Never included by default. */

export interface SectionState {
  /** Whether a projection was emitted for this section. */
  readonly included: boolean
  /** Machine-readable reason when `included` is false, `null` when it is true. */
  readonly reason: ExclusionReason | null
  /** The bounded, scrubbed projection. `null` unless `included`. */
  readonly data: JsonValue | null
}

/** An explicitly absent section. Absence is data, never an omitted key. */
export interface ExcludedSection {
  readonly id: SupportBundleSectionId
  readonly reason: ExclusionReason
}

/**
 * Closed set of exclusion reasons, so a consumer can assert "conversation was
 * refused, not merely forgotten" without string-matching prose.
 */
export const EXCLUSION_REASONS = {
  /** The section was not in the requested set. */
  notRequested: "not-requested",
  /** The caller removed the section explicitly. */
  excludedByOption: "excluded-by-option",
  /** The section holds conversation/task content and consent was not given. */
  conversationNotConsent: "conversation-content-not-consent",
  /** The caller supplied no facts for the section. */
  absentInInput: "absent-in-input",
  /** Facts were supplied but none matched the declared field spec. */
  projectionEmpty: "projection-empty",
  /**
   * The section's owner is instance-scoped, so a bootstrap-free caller cannot
   * read it. Distinct from `not-requested` because this is an architectural
   * boundary, not an oversight.
   */
  instanceScoped: "instance-scoped-not-readable-without-workspace-bootstrap",
} as const

export type ExclusionReason = (typeof EXCLUSION_REASONS)[keyof typeof EXCLUSION_REASONS]

export interface ScrubReport {
  /** Always true; recorded so a reader can assert the artifact was never emitted raw. */
  readonly applied: boolean
  /** The owner of the secret semantics. There is intentionally exactly one. */
  readonly secretRedactionOwner: string
  /** Values that contained a credential and were rewritten. */
  readonly redactedValues: number
  /** Distinct `MemorySecrets` rule names that fired. Rule names only — never the matched text. */
  readonly redactedRules: string[]
  /** Values whose private path/name identity was replaced by a pseudonym. */
  readonly pseudonymizedValues: number
  /** Values shortened to the string-length bound. */
  readonly truncatedValues: number
  /** Values dropped because they exceeded a structural bound. */
  readonly droppedValues: number
}

export interface PseudonymSummary {
  /**
   * Per-kind pseudonymous token counts.
   *
   * Deliberately counts only. A caller-supplied "human label" channel would let
   * raw private identity re-enter a privacy artifact through the side door, so
   * no such map exists: a reader identifies a pseudonym by its token alone.
   */
  readonly counts: Readonly<Record<PseudonymKind, number>>
}

export interface SupportBundleArtifact {
  readonly schemaVersion: 1
  readonly product: "openfork"
  readonly generatedAt: string
  readonly policy: BundlePolicy
  readonly sections: Readonly<Record<SupportBundleSectionId, SectionState>>
  readonly included: readonly SupportBundleSectionId[]
  readonly excluded: readonly ExcludedSection[]
  readonly scrub: ScrubReport
  readonly pseudonyms: PseudonymSummary
}

export interface BundlePolicy {
  readonly conversationContent: boolean
  readonly maxStringLength: number
  readonly maxArrayItems: number
  readonly maxObjectKeys: number
  readonly maxDepth: number
  readonly maxNodes: number
}

// ---------------------------------------------------------------------------
// Pseudonymizer — report-local, salted
// ---------------------------------------------------------------------------

export type PseudonymKind = "path" | "name" | "email"

export interface PseudonymizerOptions {
  /**
   * Test-only salt. Production callers must omit this: an unsalted or shared salt
   * would make private paths correlatable across reports, which is exactly the
   * property the artifact exists to destroy.
   */
  readonly seed?: string
  /** Private literals (home root, username, machine name, project roots) to pseudonymize as substrings. */
  readonly values?: readonly string[]
}

export interface Pseudonymizer {
  /** Pseudonymize a filesystem path, preserving root and per-segment structure. */
  readonly path: (value: string) => string
  /** Pseudonymize an arbitrary private name (username, project name, peer label). */
  readonly name: (value: string) => string
  /** Pseudonymize using embedded span detection only; returns `value` unchanged when nothing is private. */
  readonly scrub: (value: string) => string
  /** Register an additional private literal after construction. */
  readonly register: (value: string) => void
  /** Pseudonym accounting for this report. Never contains a raw private value. */
  readonly summary: () => PseudonymSummary
}

const EMAIL_TOKEN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}/g
// The drive letter needs a non-alphanumeric boundary, or `s://` in `https://`
// reads as drive `s:` and the whole URL origin gets pseudonymized.
const WINDOWS_PATH_TOKEN = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|*?]*|\\\\[^\s"'<>|*?]+\\[^\s"'<>|*?]*/g
// A bare `~` is only a home reference at end-of-token; `~30s` is a duration.
const HOME_PATH_TOKEN = /(?<![A-Za-z0-9_\\/~])~(?:[\\/][^\s"'<>|*?]*)?(?=$|\s)/g

const WINDOWS_PATH_SHAPE = /^(?:[A-Za-z]:[\\/]|\\\\)/
const POSIX_PATH_SHAPE = /^\/[^\s"'<>|*?]/
const HOME_PATH_SHAPE = /^~[\\/]/
const EMAIL_SHAPE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/

/** Length of the digest suffix in a pseudonym token. Short enough to stay readable, long enough to avoid birthday collisions in one report. */
const DIGEST_CHARS = 8

/**
 * Collapse JSON string escaping so an already-serialized value classifies the
 * same as its raw form.
 *
 * This is the Windows path-escaping regression guard. `C:\Users\me` serializes to
 * `"C:\\Users\\me"`; a path matcher written against the raw form does not match
 * the escaped form, so a pre-serialized value would sail through as a raw
 * private path. Classification therefore always normalizes first.
 */
function normalizeEscaped(value: string): string {
  if (!value.includes("\\")) return value
  const simple: Record<string, string> = {
    '"': '"',
    "\\": "\\",
    "/": "/",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
  }
  let out = ""
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (char !== "\\") {
      out += char
      continue
    }
    const next = value[i + 1]
    if (next === undefined) {
      out += char
      continue
    }
    const mapped = simple[next]
    if (mapped !== undefined) {
      out += mapped
      i++
      continue
    }
    if (next === "u" && value[i + 2] === "{") {
      const close = value.indexOf("}", i + 3)
      const body = close === -1 ? "" : value.slice(i + 3, close)
      const code = body && /^[0-9a-fA-F]{1,6}$/.test(body) ? Number.parseInt(body, 16) : Number.NaN
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
        out += String.fromCodePoint(code)
        i = close
        continue
      }
    }
    if (next === "u") {
      const body = value.slice(i + 2, i + 6)
      if (/^[0-9a-fA-F]{4}$/.test(body)) {
        out += String.fromCharCode(Number.parseInt(body, 16))
        i += 5
        continue
      }
    }
    out += char
    out += next
    i++
  }
  return out
}

const stripControl = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, "")

/**
 * Whether a value carries JSON string escaping at all.
 *
 * This gate exists because `\t`, `\n`, `\r`, `\b`, and `\f` are ordinary Windows
 * path segments: `C:\notes`, `C:\temp`, `C:\build`, `C:\reports`. Decoding those
 * as JSON escapes turns real paths into control characters and silently
 * destroys the exact input this module exists to handle. Only a value that
 * actually shows JSON escaping is decoded.
 */
function isEscapedForm(value: string): boolean {
  return value.includes("\\\\") || /\\u[0-9a-fA-F]{4}/.test(value)
}

/**
 * Classify a whole value. Returns `undefined` when the value carries no private
 * identity of its own.
 */
function classifyShape(normalized: string): PseudonymKind | undefined {
  if (EMAIL_SHAPE.test(normalized)) return "email"
  if (WINDOWS_PATH_SHAPE.test(normalized) || POSIX_PATH_SHAPE.test(normalized) || HOME_PATH_SHAPE.test(normalized))
    return "path"
  return undefined
}

/**
 * Classify a path root so shape and separators survive pseudonymization.
 *
 * A drive letter (`C:`) and the absolute/UNC marker are structural. A UNC
 * *server* and *share* are private host identity, so they are pseudonymized
 * along with every other segment rather than preserved verbatim.
 */
function pathRoot(value: string): string {
  const windows = /^([A-Za-z]:)(?=[\\/])/.exec(value)
  if (windows) return windows[1]
  if (value.startsWith("\\\\")) return "\\\\"
  return ""
}

/** Pseudonymize each path segment, preserving the root so drive/UNC structure stays legible. */
function pseudonymPath(normalized: string, token: (kind: PseudonymKind, value: string) => string): string {
  const root = pathRoot(normalized)
  const remainder = normalized.slice(root.length)
  if (!remainder) return token("path", normalized)
  const separator = remainder.includes("\\") && !remainder.includes("/") ? "\\" : "/"
  const segments = remainder.split(/[\\/]+/).filter((segment) => segment.length > 0)
  if (segments.length === 0) return token("path", normalized)
  // A UNC root is already a separator prefix; appending another would emit a
  // malformed leading `\\\`.
  const head = root ? (root.endsWith(separator) ? root : `${root}${separator}`) : separator
  return head + segments.map((segment) => token("path", segment)).join(separator)
}

/**
 * Create a report-local pseudonymizer.
 *
 * The salt is random per call unless a test seed is supplied, so two artifacts
 * built from the same machine produce unrelated token sets. Within one
 * pseudonymizer, equal inputs always map to equal tokens — that is the
 * relationship-preserving property callers depend on.
 */
export function createPseudonymizer(options: PseudonymizerOptions = {}): Pseudonymizer {
  const salt = options.seed ?? randomBytes(16).toString("hex")
  const tokens = new Map<string, string>()
  const counts: Record<PseudonymKind, number> = { path: 0, name: 0, email: 0 }
  const literals: string[] = []

  const digest = (kind: PseudonymKind, value: string) =>
    createHash("sha256").update(salt).update("\u0000").update(kind).update("\u0000").update(value).digest("hex")

  const token = (kind: PseudonymKind, value: string): string => {
    const key = `${kind}\u0000${value}`
    const existing = tokens.get(key)
    if (existing) return existing
    const minted = `${kind}-${digest(kind, value).slice(0, DIGEST_CHARS)}`
    tokens.set(key, minted)
    counts[kind]++
    return minted
  }

  const pseudonymPathValue = (raw: string): string => {
    // Classify the raw value first. Decoding first would collapse a genuine UNC
    // `\\server\share` into a single-backslash form that no longer looks like
    // any known path shape, and the private host would sail through raw.
    const direct = stripControl(raw).trim()
    if (classifyShape(direct) === "path") return pseudonymPath(direct, token)
    if (classifyShape(direct) === "email") return token("email", direct)
    if (!isEscapedForm(direct)) return pseudonymSpans(direct, raw)
    const decoded = stripControl(normalizeEscaped(direct)).trim()
    if (!decoded) return raw
    if (classifyShape(decoded) === "path") return pseudonymPath(decoded, token)
    return pseudonymSpans(decoded, raw)
  }

  const pseudonymNameValue = (raw: string): string => {
    const direct = stripControl(raw).trim()
    const directShape = classifyShape(direct)
    if (directShape === "email") return token("email", direct)
    if (directShape === "path") return pseudonymPath(direct, token)
    const normalized = isEscapedForm(direct) ? stripControl(normalizeEscaped(direct)).trim() : direct
    const shape = classifyShape(normalized)
    if (shape === "email") return token("email", normalized)
    if (shape === "path") return pseudonymPath(normalized, token)
    return token("name", normalized || direct)
  }

  /** Replace private identities that appear as spans inside a longer string. */
  const pseudonymSpans = (scan: string, original: string): string => {
    let out = ""
    let cursor = 0
    const spans: Array<{ start: number; end: number; replacement: string }> = []
    const collect = (pattern: RegExp, replace: (match: string) => string) => {
      for (const match of scan.matchAll(pattern)) {
        if (match.index === undefined || match[0].length === 0) continue
        spans.push({ start: match.index, end: match.index + match[0].length, replacement: replace(match[0]) })
      }
    }
    collect(EMAIL_TOKEN, (match) => token("email", match))
    collect(WINDOWS_PATH_TOKEN, (match) => pseudonymPath(match, token))
    collect(
      HOME_PATH_TOKEN,
      (match) => (match === "~" ? token("name", "~") : pseudonymPath(match, token)),
    )
    for (const literal of literals) {
      if (!literal || literal.length < 2) continue
      let from = 0
      for (;;) {
        const at = scan.indexOf(literal, from)
        if (at === -1) break
        spans.push({ start: at, end: at + literal.length, replacement: token("name", literal) })
        from = at + literal.length
      }
    }
    if (spans.length === 0) return original
    spans.sort((a, b) => a.start - b.start || b.end - a.end)
    for (const span of spans) {
      if (span.start < cursor) continue
      out += scan.slice(cursor, span.start) + span.replacement
      cursor = span.end
    }
    return out + scan.slice(cursor)
  }

  const register = (value: string) => {
    const normalized = isEscapedForm(value) ? stripControl(normalizeEscaped(value)).trim() : stripControl(value).trim()
    if (normalized.length >= 2 && !literals.includes(normalized)) literals.push(normalized)
  }

  for (const value of options.values ?? []) register(value)

  return {
    path: pseudonymPathValue,
    name: pseudonymNameValue,
    scrub: (value: string) => {
      // Raw scan first; the decoded scan is only a fallback for text that is
      // already serialized. Reversing this order is the Windows escaping
      // regression: a pre-serialized `C:\\Users\\me` no longer matches a
      // raw-form matcher, so the raw private path would pass through
      // un-pseudonymized.
      const fromRaw = pseudonymSpans(value, value)
      if (fromRaw !== value) return fromRaw
      if (!isEscapedForm(value)) return value
      return pseudonymSpans(normalizeEscaped(value), value)
    },
    register,
    summary: () => ({ counts: { ...counts } }),
  }
}

// ---------------------------------------------------------------------------
// Bounded, allowlisted projection
// ---------------------------------------------------------------------------

type FieldKind = "scalar" | "enum" | "strings" | "counters"

interface FieldSpec {
  readonly key: string
  readonly kind: FieldKind
  /** Whole-value identity handling. `auto` detects path/email shapes. */
  readonly pseudonym?: PseudonymKind | "auto"
}

interface RecordSpec {
  readonly key: string
  readonly max: number
  readonly fields: readonly FieldSpec[]
}

interface SectionSpec {
  readonly id: SupportBundleSectionId
  /** Requires explicit consent because the projection is conversation/task content. */
  readonly gated: boolean
  /** Not readable without workspace bootstrap; denied with its own reason so the omission is legible. */
  readonly instanceScoped: boolean
  readonly fields: readonly FieldSpec[]
  readonly records: readonly RecordSpec[]
}

const SECTION_SPECS: readonly SectionSpec[] = [
  {
    id: "runtime",
    gated: false,
    instanceScoped: false,
    fields: [
      { key: "version", kind: "scalar" },
      { key: "channel", kind: "scalar" },
      { key: "platform", kind: "scalar" },
      { key: "arch", kind: "scalar" },
      { key: "nodeVersion", kind: "scalar" },
      { key: "executable", kind: "scalar", pseudonym: "path" },
      { key: "configRoot", kind: "scalar", pseudonym: "path" },
      { key: "dataRoot", kind: "scalar", pseudonym: "path" },
      { key: "uptimeSeconds", kind: "scalar" },
    ],
    records: [],
  },
  {
    id: "config",
    gated: false,
    instanceScoped: true,
    fields: [
      { key: "providerIds", kind: "strings" },
      { key: "modelIds", kind: "strings" },
      { key: "agentNames", kind: "strings" },
      { key: "mcpServerNames", kind: "strings" },
      { key: "pluginIds", kind: "strings" },
      { key: "permissionModes", kind: "strings" },
      { key: "configSchemaVersion", kind: "scalar" },
      { key: "pluginCount", kind: "scalar" },
    ],
    records: [],
  },
  {
    id: "workspaces",
    gated: false,
    instanceScoped: false,
    fields: [],
    records: [
      {
        key: "workspaces",
        max: 64,
        fields: [
          { key: "id", kind: "scalar", pseudonym: "name" },
          { key: "path", kind: "scalar", pseudonym: "path" },
          { key: "vcs", kind: "enum" },
          { key: "branch", kind: "scalar", pseudonym: "name" },
          { key: "sessionCount", kind: "scalar" },
          { key: "lastActivity", kind: "scalar" },
        ],
      },
    ],
  },
  {
    id: "connectivity",
    gated: false,
    instanceScoped: false,
    fields: [
      { key: "oxpEnabled", kind: "scalar" },
      { key: "oxpPeerCount", kind: "scalar" },
      { key: "oxpConnectedPeerIds", kind: "strings", pseudonym: "name" },
      { key: "ofxpEnabled", kind: "scalar" },
      { key: "ofxpTrustedPeerCount", kind: "scalar" },
      { key: "ofxpInvocationTotals", kind: "counters" },
      { key: "ofxpDeniedTotals", kind: "counters" },
      { key: "oxpTunnelState", kind: "enum" },
      { key: "oxpTunnelTotals", kind: "counters" },
      { key: "controlPlaneTotals", kind: "counters" },
    ],
    records: [
      {
        key: "oxpPeers",
        max: 64,
        fields: [
          { key: "id", kind: "scalar", pseudonym: "name" },
          { key: "state", kind: "enum" },
          { key: "lastError", kind: "scalar" },
        ],
      },
      {
        key: "ofxpPeers",
        max: 64,
        fields: [
          { key: "id", kind: "scalar", pseudonym: "name" },
          { key: "trusted", kind: "scalar" },
          { key: "grantedRootCount", kind: "scalar" },
          { key: "revoked", kind: "scalar" },
        ],
      },
    ],
  },
  {
    id: "logs",
    gated: false,
    instanceScoped: false,
    fields: [
      { key: "level", kind: "enum" },
      { key: "lines", kind: "strings" },
    ],
    records: [],
  },
  {
    id: "conversation",
    gated: true,
    instanceScoped: false,
    fields: [
      { key: "sessionCount", kind: "scalar" },
      { key: "turnCount", kind: "scalar" },
      { key: "toolCallCount", kind: "scalar" },
      { key: "texts", kind: "strings" },
    ],
    records: [],
  },
]

const SECTION_IDS: readonly SupportBundleSectionId[] = SECTION_SPECS.map((spec) => spec.id)

/** Default surface: bounded health/shape facts only. `conversation` is never in it. */
export const DEFAULT_SECTION_IDS: readonly SupportBundleSectionId[] = SECTION_IDS.filter(
  (id) => !SECTION_SPECS.some((spec) => spec.id === id && (spec.gated || spec.instanceScoped)),
)

/** The single canonical secret owner this module delegates to. */
export const SECRET_REDACTION_OWNER = "@opencode-ai/core/memory/secrets"

export const DEFAULT_MAX_STRING_LENGTH = 512
export const DEFAULT_MAX_ARRAY_ITEMS = 64
export const DEFAULT_MAX_OBJECT_KEYS = 128
export const DEFAULT_MAX_DEPTH = 8
export const DEFAULT_MAX_NODES = 4096

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface BuildOptions {
  /**
   * Replaces the default section set when provided. Unknown ids are ignored.
   * Including `"conversation"` here still does not include it unless
   * `includeConversationContent` is also true.
   */
  readonly include?: readonly SupportBundleSectionId[]
  /** Removed from the effective section set. */
  readonly exclude?: readonly SupportBundleSectionId[]
  /** Must be explicitly true to project conversation/task content. Defaults false. */
  readonly includeConversationContent?: boolean
  /** Private literals (home root, username, machine name, project roots) registered for substring scrubbing. */
  readonly privateValues?: readonly string[]
  /** Test-only pseudonym salt. Omit in production; see `PseudonymizerOptions.seed`. */
  readonly pseudonymSeed?: string
  /** Supply a pre-built pseudonymizer to share one report salt across several artifacts. */
  readonly pseudonymizer?: Pseudonymizer
  /** Overrides `new Date().toISOString()`. Pass a fixed value for deterministic output. */
  readonly now?: string
  readonly maxStringLength?: number
  readonly maxArrayItems?: number
  readonly maxObjectKeys?: number
  readonly maxDepth?: number
  readonly maxNodes?: number
}

export interface SupportBundleInput {
  readonly runtime?: unknown
  /** An already-redacted config projection from an instance-bearing caller. */
  readonly config?: unknown
  readonly workspaces?: unknown
  readonly connectivity?: unknown
  readonly logs?: unknown
  readonly conversation?: unknown
}

// ---------------------------------------------------------------------------
// Scrubbing
// ---------------------------------------------------------------------------

export interface ScrubOutcome {
  readonly value: JsonValue
  readonly report: ScrubReport
}

interface MutableReport {
  redactedValues: number
  redactedRules: Set<string>
  pseudonymizedValues: number
  truncatedValues: number
  droppedValues: number
  nodes: number
}

/**
 * Recursively scrub a value: credentials removed by the canonical owner, private
 * identities replaced by report-local pseudonyms, length/width bounded.
 *
 * Numbers and booleans pass through. Objects are rebuilt with a bounded key
 * count; cycles and over-deep values are dropped rather than thrown, because a
 * diagnostics artifact must never be the thing that breaks diagnostics.
 */
export function scrub(
  value: unknown,
  pseudonymizer: Pseudonymizer,
  limits: BundlePolicy,
  existing?: MutableReport,
): ScrubOutcome {
  const report: MutableReport = existing ?? {
    redactedValues: 0,
    redactedRules: new Set<string>(),
    pseudonymizedValues: 0,
    truncatedValues: 0,
    droppedValues: 0,
    nodes: 0,
  }
  const seen = new WeakSet<object>()

  const walk = (input: unknown, depth: number): JsonValue => {
    if (report.nodes >= limits.maxNodes) {
      report.droppedValues++
      return null
    }
    report.nodes++
    if (input === null || input === undefined) return null
    if (typeof input === "boolean") return input
    if (typeof input === "number") return Number.isFinite(input) ? input : null
    if (typeof input === "bigint") return input.toString()
    if (typeof input === "string") return scrubString(input, pseudonymizer, limits, report)
    // Symbols and functions carry no diagnostic value, and stringifying them
    // would emit `[object Object]`-shaped noise into a shareable artifact.
    if (typeof input !== "object") return null
    if (depth >= limits.maxDepth) {
      report.droppedValues++
      return null
    }
    if (seen.has(input)) {
      report.droppedValues++
      return null
    }
    seen.add(input)
    if (Array.isArray(input)) {
      const out: JsonValue[] = []
      for (const item of input.slice(0, limits.maxArrayItems)) {
        if (out.length >= limits.maxArrayItems) {
          report.droppedValues++
          break
        }
        out.push(walk(item, depth + 1))
      }
      if (input.length > limits.maxArrayItems) report.droppedValues++
      return out
    }
    if (input instanceof Date) return input.toISOString()
    if (input instanceof Error) return scrubString(input.message, pseudonymizer, limits, report)
    const out: { [key: string]: JsonValue } = {}
    const entries = Object.entries(input)
    for (const [key, child] of entries) {
      if (Object.keys(out).length >= limits.maxObjectKeys) {
        report.droppedValues++
        break
      }
      // Keys are raw strings too. A credential or private path smuggled into a
      // key would otherwise bypass every value scrubber in this module.
      out[scrubString(key, pseudonymizer, limits, report)] = walk(child, depth + 1)
    }
    if (entries.length > limits.maxObjectKeys) report.droppedValues++
    return out
  }

  return { value: walk(value, 0), report: toReport(report) }
}

function scrubString(input: string, pseudonymizer: Pseudonymizer, limits: BundlePolicy, report: MutableReport) {
  // 1. One owner for credential semantics.
  const scan = MemorySecrets.scan(input)
  let out = input
  if (!scan.clean) {
    report.redactedValues++
    for (const rule of scan.findings) report.redactedRules.add(rule)
    out = MemorySecrets.redact(out)
  }
  // Defense in depth: if the owner's own redaction did not reach a clean state,
  // do not try to salvage the value — drop it.
  if (!MemorySecrets.scan(out).clean) {
    report.droppedValues++
    return "[redacted]"
  }

  // 2. Private identity becomes a report-local pseudonym.
  const pseudonymized = pseudonymizer.scrub(out)
  if (pseudonymized !== out) {
    report.pseudonymizedValues++
    out = pseudonymized
  }

  // 3. Bound length.
  if (out.length > limits.maxStringLength) {
    report.truncatedValues++
    out = `${out.slice(0, limits.maxStringLength)}\u2026[truncated ${out.length - limits.maxStringLength}]`
  }
  return out
}

function toReport(report: MutableReport): ScrubReport {
  return {
    applied: true,
    secretRedactionOwner: SECRET_REDACTION_OWNER,
    redactedValues: report.redactedValues,
    redactedRules: [...report.redactedRules].toSorted(),
    pseudonymizedValues: report.pseudonymizedValues,
    truncatedValues: report.truncatedValues,
    droppedValues: report.droppedValues,
  }
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Enum fields accept only short, punctuation-free tokens; anything else is dropped as unsafe to publish. */
function isEnumSafe(value: string) {
  return value.length <= 64 && /^[A-Za-z0-9._:/+-]+$/.test(value)
}

function projectField(
  spec: FieldSpec,
  raw: unknown,
  pseudonymizer: Pseudonymizer,
  limits: BundlePolicy,
  report: MutableReport,
): JsonValue | undefined {
  switch (spec.kind) {
    case "scalar": {
      if (typeof raw === "string") return applyPseudonym(spec, raw, pseudonymizer)
      if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined
      if (typeof raw === "boolean") return raw
      return undefined
    }
    case "enum": {
      if (typeof raw !== "string" || !isEnumSafe(raw)) return undefined
      return raw
    }
    case "strings": {
      if (!Array.isArray(raw)) return undefined
      const out: string[] = []
      const kept = Math.min(raw.length, limits.maxArrayItems)
      for (const item of raw.slice(0, kept)) {
        if (out.length >= limits.maxArrayItems) break
        if (typeof item !== "string") continue
        // Honor the field's identity classification per element. A future
        // string-array field marked private must not leak raw identity merely
        // because it is an array.
        out.push(spec.pseudonym ? applyPseudonym(spec, item, pseudonymizer) : item)
      }
      // Bounded-away data is still accounted for: an artifact that silently
      // truncates reports the same scrub counters as one that kept everything.
      report.droppedValues += Math.max(0, raw.length - kept)
      return out
    }
    case "counters": {
      if (!isPlainObject(raw)) return undefined
      const out: { [key: string]: number } = {}
      const entries = Object.entries(raw)
      for (const [key, item] of entries.slice(0, limits.maxObjectKeys)) {
        if (Object.keys(out).length >= limits.maxObjectKeys) break
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(key)) continue
        if (typeof item !== "number" || !Number.isFinite(item)) continue
        out[key] = item
      }
      report.droppedValues += Math.max(0, entries.length - limits.maxObjectKeys)
      return out
    }
    default:
      return undefined
  }
}

function applyPseudonym(spec: FieldSpec, raw: string, pseudonymizer: Pseudonymizer): string {
  if (spec.pseudonym === "path") return pseudonymizer.path(raw)
  if (spec.pseudonym === "name") return pseudonymizer.name(raw)
  if (spec.pseudonym === "auto") {
    const shape = classifyShape(stripControl(raw).trim()) ?? classifyShape(stripControl(normalizeEscaped(raw)).trim())
    if (shape === "path") return pseudonymizer.path(raw)
    if (shape === "email") return pseudonymizer.name(raw)
  }
  return raw
}

/** Keep only declared fields, coercing to the declared kind. Undeclared keys never survive. */
function projectSection(
  spec: SectionSpec,
  raw: unknown,
  pseudonymizer: Pseudonymizer,
  limits: BundlePolicy,
  report: MutableReport,
): { data: JsonValue; empty: boolean } {
  if (!isPlainObject(raw)) return { data: {}, empty: true }
  const out: { [key: string]: JsonValue } = {}
  for (const field of spec.fields) {
    if (!(field.key in raw)) continue
    const projected = projectField(field, raw[field.key], pseudonymizer, limits, report)
    if (projected === undefined) continue
    out[field.key] = projected
  }
  for (const record of spec.records) {
    const list = raw[record.key]
    if (!Array.isArray(list)) continue
    const rows: JsonValue[] = []
    const kept = Math.min(list.length, record.max)
    for (const item of list.slice(0, kept)) {
      if (!isPlainObject(item)) continue
      const row: { [key: string]: JsonValue } = {}
      for (const field of record.fields) {
        if (!(field.key in item)) continue
        const projected = projectField(field, item[field.key], pseudonymizer, limits, report)
        if (projected === undefined) continue
        row[field.key] = projected
      }
      if (Object.keys(row).length > 0) rows.push(row)
    }
    report.droppedValues += Math.max(0, list.length - kept)
    out[record.key] = rows
  }
  return { data: out, empty: Object.keys(out).length === 0 }
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

function positiveOr(value: number | undefined, fallback: number) {
  if (value === undefined) return fallback
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/**
 * Build a privacy-safe support bundle artifact.
 *
 * The returned object is already scrubbed; `serialize` re-scrubs it once more so
 * the invariant also holds at the JSON boundary.
 */
export function build(input: SupportBundleInput, options: BuildOptions = {}): SupportBundleArtifact {
  const limits: BundlePolicy = {
    conversationContent: options.includeConversationContent === true,
    maxStringLength: positiveOr(options.maxStringLength, DEFAULT_MAX_STRING_LENGTH),
    maxArrayItems: positiveOr(options.maxArrayItems, DEFAULT_MAX_ARRAY_ITEMS),
    maxObjectKeys: positiveOr(options.maxObjectKeys, DEFAULT_MAX_OBJECT_KEYS),
    maxDepth: positiveOr(options.maxDepth, DEFAULT_MAX_DEPTH),
    maxNodes: positiveOr(options.maxNodes, DEFAULT_MAX_NODES),
  }

  const pseudonymizer =
    options.pseudonymizer ??
    createPseudonymizer({ seed: options.pseudonymSeed, values: options.privateValues })
  if (options.privateValues) for (const value of options.privateValues) pseudonymizer.register(value)

  const requested = options.include ? SECTION_IDS.filter((id) => options.include!.includes(id)) : DEFAULT_SECTION_IDS
  const excludedByOption = new Set(options.exclude ?? [])
  const effective = new Set(requested.filter((id) => !excludedByOption.has(id)))

  const sections = {} as Record<SupportBundleSectionId, SectionState>
  const included: SupportBundleSectionId[] = []
  const excluded: ExcludedSection[] = []
  const shared: MutableReport = {
    redactedValues: 0,
    redactedRules: new Set<string>(),
    pseudonymizedValues: 0,
    truncatedValues: 0,
    droppedValues: 0,
    nodes: 0,
  }

  const deny = (id: SupportBundleSectionId, reason: ExclusionReason) => {
    sections[id] = { included: false, reason, data: null }
    excluded.push({ id, reason })
  }

  for (const spec of SECTION_SPECS) {
    const id = spec.id
    // Consent is checked before request so a refused gated section reports the
    // refusal. "not-requested" would read as "nobody cared", which is the wrong
    // signal for the one section whose absence is a privacy decision.
    if (spec.gated && !limits.conversationContent) {
      deny(id, EXCLUSION_REASONS.conversationNotConsent)
      continue
    }
    if (excludedByOption.has(id)) {
      deny(id, EXCLUSION_REASONS.excludedByOption)
      continue
    }
    if (spec.instanceScoped && !effective.has(id)) {
      deny(id, EXCLUSION_REASONS.instanceScoped)
      continue
    }
    if (!effective.has(id)) {
      deny(id, EXCLUSION_REASONS.notRequested)
      continue
    }
    if (!(id in input) || input[id] === undefined) {
      deny(id, EXCLUSION_REASONS.absentInInput)
      continue
    }
    const projected = projectSection(spec, input[id], pseudonymizer, limits, shared)
    if (projected.empty) {
      deny(id, EXCLUSION_REASONS.projectionEmpty)
      continue
    }
    const outcome = scrub(projected.data, pseudonymizer, limits, shared)
    sections[id] = { included: true, reason: null, data: outcome.value }
    included.push(id)
  }

  return {
    schemaVersion: 1,
    product: "openfork",
    generatedAt: options.now ?? new Date().toISOString(),
    policy: limits,
    sections,
    included,
    excluded,
    scrub: toReport(shared),
    pseudonyms: pseudonymizer.summary(),
  }
}

/** Recursively re-apply the canonical secret owner to a finished artifact. */
function rescrubStructure(value: unknown, limits: BundlePolicy, report: MutableReport, depth = 0): JsonValue {
  if (report.nodes >= limits.maxNodes) {
    report.droppedValues++
    return null
  }
  report.nodes++
  if (value === null || value === undefined) return null
  if (typeof value === "string") {
    const scan = MemorySecrets.scan(value)
    let out = value
    if (!scan.clean) {
      report.redactedValues++
      for (const rule of scan.findings) report.redactedRules.add(rule)
      out = MemorySecrets.redact(out)
      if (!MemorySecrets.scan(out).clean) {
        report.droppedValues++
        return "[redacted]"
      }
    }
    if (out.length > limits.maxStringLength) {
      report.truncatedValues++
      out = `${out.slice(0, limits.maxStringLength)}\u2026[truncated]`
    }
    return out
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "boolean") return value
  if (depth >= limits.maxDepth) {
    report.droppedValues++
    return null
  }
  if (Array.isArray(value)) {
    const out: JsonValue[] = []
    for (const item of value.slice(0, limits.maxArrayItems)) {
      if (out.length >= limits.maxArrayItems) {
        report.droppedValues++
        break
      }
      out.push(rescrubStructure(item, limits, report, depth + 1))
    }
    return out
  }
  if (typeof value === "object") {
    const out: { [key: string]: JsonValue } = {}
    for (const [key, item] of Object.entries(value)) {
      if (Object.keys(out).length >= limits.maxObjectKeys) {
        report.droppedValues++
        break
      }
      out[key] = rescrubStructure(item, limits, report, depth + 1)
    }
    return out
  }
  return null
}

/**
 * Serialize an artifact to JSON.
 *
 * This is the enforcing boundary: the structure is re-scrubbed, then the emitted
 * JSON string is scanned. If anything still matches a credential rule the bundle
 * is refused wholesale rather than shipped with a plausible-looking redaction
 * bug. A refused bundle is a valid, tiny, diagnosable document.
 */
export function serialize(bundle: SupportBundleArtifact, options: { readonly pretty?: boolean } = {}): string {
  const limits = bundle.policy ?? DEFAULT_POLICY
  const report: MutableReport = {
    redactedValues: 0,
    redactedRules: new Set<string>(),
    pseudonymizedValues: 0,
    truncatedValues: 0,
    droppedValues: 0,
    nodes: 0,
  }
  const clean = rescrubStructure(bundle, limits, report)
  const json = options.pretty ? JSON.stringify(clean, null, 2) : JSON.stringify(clean)
  if (!MemorySecrets.scan(json).clean) {
    return JSON.stringify({
      schemaVersion: 1,
      product: "openfork",
      generatedAt: bundle.generatedAt,
      error: "refused-unredacted-output",
      secretRedactionOwner: SECRET_REDACTION_OWNER,
      rules: MemorySecrets.scan(json).findings,
    })
  }
  return json
}

const DEFAULT_POLICY: BundlePolicy = {
  conversationContent: false,
  maxStringLength: DEFAULT_MAX_STRING_LENGTH,
  maxArrayItems: DEFAULT_MAX_ARRAY_ITEMS,
  maxObjectKeys: DEFAULT_MAX_OBJECT_KEYS,
  maxDepth: DEFAULT_MAX_DEPTH,
  maxNodes: DEFAULT_MAX_NODES,
}