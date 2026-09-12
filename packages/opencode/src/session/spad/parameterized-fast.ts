/**
 * Allocation-light proposal fingerprint for parameterized code matching.
 *
 * This is NOT proof. Identifiers and constants are represented by 32-bit
 * hashes, so collisions are possible. A fingerprint equality may only propose
 * a candidate; callers MUST confirm it with `parameterizedMatchCode` before
 * emitting structural evidence.
 */

const FNV_OFFSET = 0x811c9dc5 >>> 0
const FNV_PRIME = 0x01000193
const PARAM_TAG = 0x80000000 >>> 0
const ROLE_SHIFT = 27
const ROLE_IDENTIFIER = 0
const ROLE_CALLEE = 1
const ROLE_DECLARATION = 2
const CLASS_MASK = 0x07ffffff

const KEYWORDS = [
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "declare",
  "default", "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for", "from", "function",
  "get", "if", "implements", "import", "in", "infer", "instanceof", "interface", "keyof", "let", "namespace", "new",
  "null", "of", "private", "protected", "public", "readonly", "return", "satisfies", "set", "static", "super",
  "switch", "this", "throw", "true", "try", "type", "typeof", "undefined", "unique", "unknown", "var", "void",
  "while", "with", "yield",
] as const

function hashString(value: string) {
  let hash = FNV_OFFSET
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), FNV_PRIME) >>> 0
  return hash >>> 0
}

const KEYWORD_HASHES = new Set(KEYWORDS.map(hashString))
const DECLARATION_HASHES = new Set([hashString("function"), hashString("class"), hashString("interface")])

function identifierStart(code: number) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36
}

function identifierPart(code: number) {
  return identifierStart(code) || (code >= 48 && code <= 57)
}

function digit(code: number) {
  return code >= 48 && code <= 57
}

function nextNonWhitespaceCode(source: string, start: number) {
  for (let i = start; i < source.length; i++) {
    const code = source.charCodeAt(i)
    if (code !== 9 && code !== 10 && code !== 13 && code !== 32) return code
  }
  return 0
}

function hashRange(source: string, start: number, end: number, seed = FNV_OFFSET) {
  let hash = seed >>> 0
  for (let i = start; i < end; i++) hash = Math.imul(hash ^ source.charCodeAt(i), FNV_PRIME) >>> 0
  return hash >>> 0
}

function nextPowerOfTwo(value: number) {
  let n = 1
  while (n < value) n <<= 1
  return n
}

export interface ParameterizedFingerprintView {
  readonly tokens: Uint32Array
  readonly length: number
  readonly constantTokens: number
  readonly parameterTokens: number
  readonly parameterClasses: number
  readonly repeatedParameterClasses: number
  readonly repeatedParameterTokens: number
  readonly repeatedParameterDensity: number
}

/** Reusable bounded scratch builder intended for rare structural checkpoints. */
export class ParameterizedFingerprintBuilder {
  private readonly tokens: Uint32Array
  private readonly hashes: Uint32Array
  private readonly classes: Uint32Array
  private readonly epochs: Uint32Array
  private readonly classCounts: Uint16Array
  private readonly tableMask: number
  private epoch = 1
  private lastClassCount = 0

  constructor(maxSourceChars = 8192, maxParameterClasses = 2048) {
    this.tokens = new Uint32Array(Math.max(1, maxSourceChars))
    const tableSize = nextPowerOfTwo(Math.max(64, maxParameterClasses * 2))
    this.hashes = new Uint32Array(tableSize)
    this.classes = new Uint32Array(tableSize)
    this.epochs = new Uint32Array(tableSize)
    this.classCounts = new Uint16Array(Math.max(2, maxParameterClasses + 1))
    this.tableMask = tableSize - 1
  }

  private begin() {
    this.epoch = (this.epoch + 1) >>> 0
    if (this.epoch === 0) {
      this.epochs.fill(0)
      this.epoch = 1
    }
    // Clear only classes touched by the previous build. A full 2K-entry fill
    // dominated small structural blocks in benchmarks.
    if (this.lastClassCount > 0) this.classCounts.fill(0, 1, this.lastClassCount + 1)
    this.lastClassCount = 0
  }

  private parameterClass(hash: number, nextClass: number) {
    let slot = (hash ^ (hash >>> 16)) & this.tableMask
    for (let probe = 0; probe <= this.tableMask; probe++) {
      if (this.epochs[slot] !== this.epoch) {
        this.epochs[slot] = this.epoch
        this.hashes[slot] = hash
        this.classes[slot] = nextClass
        return nextClass
      }
      if (this.hashes[slot] === hash) return this.classes[slot]!
      slot = (slot + 1) & this.tableMask
    }
    // Table saturation is a proposal-only failure mode. Fold to a stable class;
    // the collision-free terminal verifier remains authoritative.
    return (hash & CLASS_MASK) || 1
  }

  build(source: string): ParameterizedFingerprintView {
    if (source.length > this.tokens.length) throw new Error(`parameterized fingerprint source exceeds ${this.tokens.length} chars`)
    this.begin()
    let i = 0
    let length = 0
    let constants = 0
    let parameters = 0
    let nextClass = 1
    let previousDeclarationKeyword = false

    const pushConstant = (hash: number) => {
      this.tokens[length++] = hash & 0x7fffffff
      constants++
    }
    const pushParameter = (hash: number, role: number) => {
      const cls = this.parameterClass(hash, nextClass)
      if (cls === nextClass && nextClass < this.classCounts.length - 1) nextClass++
      this.tokens[length++] = (PARAM_TAG | ((role & 3) << ROLE_SHIFT) | (cls & CLASS_MASK)) >>> 0
      parameters++
      if (cls < this.classCounts.length && this.classCounts[cls]! < 0xffff) this.classCounts[cls]++
    }

    while (i < source.length) {
      const code = source.charCodeAt(i)
      if (code === 9 || code === 10 || code === 13 || code === 32) {
        i++
        continue
      }
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
      if (code === 34 || code === 39 || code === 96) {
        const start = i++
        while (i < source.length) {
          const c = source.charCodeAt(i++)
          if (c === 92) i++
          else if (c === code) break
        }
        pushConstant(hashRange(source, start, Math.min(i, source.length), FNV_OFFSET ^ 0x13579bdf))
        previousDeclarationKeyword = false
        continue
      }
      if (digit(code) || (code === 46 && digit(source.charCodeAt(i + 1)))) {
        const start = i++
        while (i < source.length) {
          const c = source.charCodeAt(i)
          if (digit(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95) i++
          else break
        }
        pushConstant(hashRange(source, start, i, FNV_OFFSET ^ 0x2468ace0))
        previousDeclarationKeyword = false
        continue
      }
      if (identifierStart(code)) {
        const start = i++
        let hash = Math.imul(FNV_OFFSET ^ code, FNV_PRIME) >>> 0
        while (i < source.length && identifierPart(source.charCodeAt(i))) {
          hash = Math.imul(hash ^ source.charCodeAt(i), FNV_PRIME) >>> 0
          i++
        }
        if (KEYWORD_HASHES.has(hash)) {
          pushConstant(hash ^ 0x31415926)
          previousDeclarationKeyword = DECLARATION_HASHES.has(hash)
          continue
        }
        const role = previousDeclarationKeyword ? ROLE_DECLARATION : nextNonWhitespaceCode(source, i) === 40 ? ROLE_CALLEE : ROLE_IDENTIFIER
        pushParameter(hash, role)
        previousDeclarationKeyword = false
        continue
      }

      // Punctuation/operators are exact proposal constants. Combining only the
      // current character keeps the scanner branch-light; the terminal verifier
      // still distinguishes multi-character operators exactly.
      pushConstant(Math.imul((FNV_OFFSET ^ code) >>> 0, FNV_PRIME) >>> 0)
      previousDeclarationKeyword = false
      i++
    }

    let repeatedParameterClasses = 0
    let repeatedParameterTokens = 0
    const classes = Math.min(nextClass - 1, this.classCounts.length - 1)
    this.lastClassCount = classes
    for (let cls = 1; cls <= classes; cls++) {
      const count = this.classCounts[cls]!
      if (count < 2) continue
      repeatedParameterClasses++
      repeatedParameterTokens += count
    }
    return {
      tokens: this.tokens,
      length,
      constantTokens: constants,
      parameterTokens: parameters,
      parameterClasses: classes,
      repeatedParameterClasses,
      repeatedParameterTokens,
      repeatedParameterDensity: parameters === 0 ? 0 : repeatedParameterTokens / parameters,
    }
  }
}

export function equalParameterizedFingerprint(a: ParameterizedFingerprintView, b: ParameterizedFingerprintView) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a.tokens[i] !== b.tokens[i]) return false
  return true
}

export function hashParameterizedFingerprint(view: ParameterizedFingerprintView): { readonly h1: number; readonly h2: number } {
  let h1 = 0x811c9dc5 >>> 0
  let h2 = 0x9e3779b9 >>> 0
  for (let i = 0; i < view.length; i++) {
    const token = view.tokens[i]!
    h1 = Math.imul(h1 ^ token, 0x01000193) >>> 0
    h2 = (Math.imul(h2 ^ (token >>> 16), 0x85ebca6b) + token) >>> 0
  }
  return { h1, h2 }
}
