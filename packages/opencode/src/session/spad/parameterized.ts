/**
 * Lightweight parameterized-code matching prototype.
 *
 * This is deliberately evidence-only. It asks whether two JavaScript/
 * TypeScript-ish token streams are identical up to a consistent bijective
 * renaming of identifiers while constants (keywords, operators, punctuation,
 * string literals, and numeric literals) remain exact.
 *
 * The matcher is linear in token count and reports the evidence-strength
 * guards called out by the SPAD v2 audit. In particular, all-fresh identifiers
 * are weak evidence: callers should inspect repeatedParameterDensity rather
 * than treating `matched=true` as loop authority.
 */

export type ParameterizedTokenRole = "identifier" | "callee" | "declaration"

export type ParameterizedToken =
  | { readonly kind: "constant"; readonly value: string }
  | { readonly kind: "parameter"; readonly value: string; readonly role: ParameterizedTokenRole }

export interface ParameterizedMatchEvidence {
  readonly matched: boolean
  readonly tokenCount: number
  readonly constantTokens: number
  readonly constantCoverage: number
  readonly parameterTokens: number
  readonly parameterClasses: number
  readonly repeatedParameterClasses: number
  readonly repeatedParameterTokens: number
  readonly repeatedParameterDensity: number
  readonly renamedParameterClasses: number
  readonly renamedCalleeClasses: number
  readonly firstMismatchToken?: number
}

const KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "declare",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "get",
  "if",
  "implements",
  "import",
  "in",
  "infer",
  "instanceof",
  "interface",
  "keyof",
  "let",
  "namespace",
  "new",
  "null",
  "of",
  "private",
  "protected",
  "public",
  "readonly",
  "return",
  "satisfies",
  "set",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "unique",
  "unknown",
  "var",
  "void",
  "while",
  "with",
  "yield",
])

const MULTI_OPERATORS = [
  ">>>=",
  "===",
  "!==",
  ">>>",
  "**=",
  "&&=",
  "||=",
  "??=",
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "++",
  "--",
  "&&",
  "||",
  "??",
  "?.",
  "**",
  "<<",
  ">>",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
] as const

function identifierStart(code: number) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36
}

function identifierPart(code: number) {
  return identifierStart(code) || (code >= 48 && code <= 57)
}

function digit(code: number) {
  return code >= 48 && code <= 57
}

function skipQuoted(source: string, start: number, quote: number) {
  let i = start + 1
  while (i < source.length) {
    const code = source.charCodeAt(i)
    if (code === 92) {
      i += 2
      continue
    }
    i++
    if (code === quote) break
  }
  return i
}

function nextNonWhitespace(source: string, start: number) {
  let i = start
  while (i < source.length) {
    const c = source.charCodeAt(i)
    if (c !== 9 && c !== 10 && c !== 13 && c !== 32) return source[i]!
    i++
  }
  return ""
}

/**
 * Tokenize a conservative JS/TS lexical subset. Comments and whitespace are
 * ignored. Quoted/template literals and numeric literals are exact constants.
 * Template interpolation is intentionally not parsed yet; the whole template
 * literal remains a constant so this prototype fails closed on that syntax.
 */
export function tokenizeParameterizedCode(source: string): ParameterizedToken[] {
  const out: ParameterizedToken[] = []
  let i = 0
  let previousConstant = ""
  while (i < source.length) {
    const code = source.charCodeAt(i)
    if (code === 9 || code === 10 || code === 13 || code === 32) {
      i++
      continue
    }

    // comments
    if (code === 47 && source.charCodeAt(i + 1) === 47) {
      i += 2
      while (i < source.length && source.charCodeAt(i) !== 10) i++
      continue
    }
    if (code === 47 && source.charCodeAt(i + 1) === 42) {
      i += 2
      while (i + 1 < source.length && !(source.charCodeAt(i) === 42 && source.charCodeAt(i + 1) === 47)) i++
      i = Math.min(source.length, i + 2)
      continue
    }

    // quoted strings and template strings are exact constants.
    if (code === 34 || code === 39 || code === 96) {
      const end = skipQuoted(source, i, code)
      const value = `lit:${source.slice(i, end)}`
      out.push({ kind: "constant", value })
      previousConstant = value
      i = end
      continue
    }

    // Numeric literal: preserve spelling/value as a constant. This is
    // intentionally conservative; numeric normalization is a future lane.
    if (digit(code) || (code === 46 && digit(source.charCodeAt(i + 1)))) {
      const start = i
      i++
      while (i < source.length) {
        const c = source.charCodeAt(i)
        if (
          digit(c) ||
          (c >= 65 && c <= 90) ||
          (c >= 97 && c <= 122) ||
          c === 46 ||
          c === 95
        ) {
          i++
          continue
        }
        break
      }
      const value = `num:${source.slice(start, i)}`
      out.push({ kind: "constant", value })
      previousConstant = value
      continue
    }

    if (identifierStart(code)) {
      const start = i++
      while (i < source.length && identifierPart(source.charCodeAt(i))) i++
      const value = source.slice(start, i)
      if (KEYWORDS.has(value)) {
        out.push({ kind: "constant", value: `kw:${value}` })
        previousConstant = `kw:${value}`
        continue
      }
      const next = nextNonWhitespace(source, i)
      const role: ParameterizedTokenRole =
        previousConstant === "kw:function" || previousConstant === "kw:class" || previousConstant === "kw:interface"
          ? "declaration"
          : next === "("
            ? "callee"
            : "identifier"
      out.push({ kind: "parameter", value, role })
      // A parameter occurrence is not a lexical keyword anchor for the next
      // identifier, so clear the declaration keyword state.
      previousConstant = ""
      continue
    }

    let op = ""
    for (const candidate of MULTI_OPERATORS) {
      if (source.startsWith(candidate, i)) {
        op = candidate
        break
      }
    }
    if (!op) op = source[i]!
    const value = `op:${op}`
    out.push({ kind: "constant", value })
    previousConstant = value
    i += op.length
  }
  return out
}

export function parameterizedMatchTokens(
  left: readonly ParameterizedToken[],
  right: readonly ParameterizedToken[],
): ParameterizedMatchEvidence {
  const tokenCount = Math.max(left.length, right.length)
  let constantTokens = 0
  let parameterTokens = 0
  const leftCounts = new Map<string, number>()
  const leftToRight = new Map<string, string>()
  const rightToLeft = new Map<string, string>()
  const calleeClasses = new Set<string>()
  let firstMismatchToken: number | undefined

  if (left.length !== right.length) firstMismatchToken = Math.min(left.length, right.length)
  const n = Math.min(left.length, right.length)
  for (let i = 0; i < n; i++) {
    const a = left[i]!
    const b = right[i]!
    if (a.kind === "constant") constantTokens++
    else {
      parameterTokens++
      leftCounts.set(a.value, (leftCounts.get(a.value) ?? 0) + 1)
      if (a.role === "callee") calleeClasses.add(a.value)
    }
    if (firstMismatchToken !== undefined) continue
    if (a.kind !== b.kind) {
      firstMismatchToken = i
      continue
    }
    if (a.kind === "constant") {
      if (a.value !== b.value) firstMismatchToken = i
      continue
    }
    const mapped = leftToRight.get(a.value)
    const reverse = rightToLeft.get(b.value)
    if ((mapped !== undefined && mapped !== b.value) || (reverse !== undefined && reverse !== a.value)) {
      firstMismatchToken = i
      continue
    }
    if (mapped === undefined) leftToRight.set(a.value, b.value)
    if (reverse === undefined) rightToLeft.set(b.value, a.value)
  }

  // Count the remainder for evidence-strength metrics even on unequal streams.
  for (let i = n; i < left.length; i++) {
    const token = left[i]!
    if (token.kind === "constant") constantTokens++
    else {
      parameterTokens++
      leftCounts.set(token.value, (leftCounts.get(token.value) ?? 0) + 1)
      if (token.role === "callee") calleeClasses.add(token.value)
    }
  }

  let repeatedParameterClasses = 0
  let repeatedParameterTokens = 0
  for (const count of leftCounts.values()) {
    if (count < 2) continue
    repeatedParameterClasses++
    repeatedParameterTokens += count
  }
  let renamedParameterClasses = 0
  let renamedCalleeClasses = 0
  for (const [leftName, rightName] of leftToRight) {
    if (leftName === rightName) continue
    renamedParameterClasses++
    if (calleeClasses.has(leftName)) renamedCalleeClasses++
  }

  return {
    matched: firstMismatchToken === undefined && left.length === right.length,
    tokenCount,
    constantTokens,
    constantCoverage: tokenCount === 0 ? 0 : constantTokens / tokenCount,
    parameterTokens,
    parameterClasses: leftCounts.size,
    repeatedParameterClasses,
    repeatedParameterTokens,
    repeatedParameterDensity: parameterTokens === 0 ? 0 : repeatedParameterTokens / parameterTokens,
    renamedParameterClasses,
    renamedCalleeClasses,
    firstMismatchToken,
  }
}

export function parameterizedMatchCode(left: string, right: string): ParameterizedMatchEvidence {
  return parameterizedMatchTokens(tokenizeParameterizedCode(left), tokenizeParameterizedCode(right))
}
