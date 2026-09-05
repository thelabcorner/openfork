/**
 * PowerShell has no Bash heredoc operator. This module rewrites the common
 * Bash form before the command reaches PowerShell:
 *
 *   python - <<'PY'
 *   ...script...
 *   PY
 *
 * into a here-string pipeline:
 *
 *   @'
 *   ...script...
 *   '@ | python -
 *
 * The command is tokenized first, so heredoc operators that appear inside
 * single-quoted, double-quoted, or backtick-escaped text are never mistaken
 * for real shell syntax. A rewrite only happens when the operator is a real
 * redirection whose whole pipeline segment is safely representable; anything
 * else is left untouched so PowerShell reports the original error.
 *
 * Verified PowerShell behavior that shapes the output:
 * - `@'...'@` here-strings are literal, work on both Windows PowerShell 5.1
 *   and PowerShell 7+, and pass the body through a pipeline byte-exactly.
 * - A body line consisting of exactly `'@` would terminate the here-string
 *   early, so such bodies are sent as base64 instead.
 * - Native commands receive the body through `$OutputEncoding`, which
 *   defaults to ASCII on Windows PowerShell, so commands with non-ASCII
 *   bodies get a UTF-8 preamble; `PYTHONIOENCODING` keeps Python's own
 *   stdin decoder from reading the bytes as cp1252.
 * - Windows PowerShell 5.1 does not support `&&`, so the preamble is always
 *   emitted as the first statement of the whole command, never inline.
 * - An explicit `&` call operator in the input is preserved; quoted
 *   interpreter paths always get one, because PowerShell only treats a
 *   quoted string as a command when `&` precedes it.
 */

/** Programs we translate. Kept small so unknown targets stay untouched. */
const TARGETS = new Set([
  // Interpreters that read a script from stdin when passed "-".
  "python",
  "python2",
  "python3",
  "py",
  "node",
  "nodejs",
  "deno",
  "bun",
  "ruby",
  "perl",
  "php",
  "lua",
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  // Common stdin-consuming CLIs that are not PowerShell aliases. PowerShell
  // aliases resolve ahead of PATH executables, so alias names (cat, sort,
  // tee, curl, ...) must never be piped into.
  "git",
  "gh",
  "jq",
  "yq",
  "xxd",
  "base64",
  "openssl",
  "gpg",
  "sqlite3",
  "psql",
  "mysql",
  "redis-cli",
  "mongosh",
  "docker",
  "kubectl",
  "ssh",
  "tar",
])

/**
 * Emitted as the first statements of the command when a rewritten body
 * contains non-ASCII text. The `;`-joined form is valid at the start of any
 * command, including one that later uses `&&` (which only PowerShell 7
 * supports, and where an inline assignment after `&&` is a parse error).
 */
const UTF8_PREAMBLE = "$OutputEncoding=[System.Text.UTF8Encoding]::new($false); $env:PYTHONIOENCODING='utf-8'; "

type Word =
  | { kind: "bare"; text: string }
  | { kind: "single"; text: string }
  | { kind: "double"; text: string }

type Heredoc = {
  /** Index where the rewrite replaces the original text. */
  spliceFrom: number
  /** Index where the body starts (just past the opening line's newline). */
  bodyStart: number
  /** Index just past the terminator word (and its `\r`), before its newline. */
  bodyEnd: number
  delimiter: string
  stripTabs: boolean
  /** Body after tab-stripping, verbatim otherwise. */
  body: string
  /** Words of the pipeline segment before the operator, in order. */
  words: Word[]
  /** Whether the segment began with an explicit `&` call operator. */
  callOperator: boolean
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function unquoteToken(token: string) {
  let out = ""
  let i = 0
  while (i < token.length) {
    const char = token[i]
    if (char === "'" || char === '"') {
      const quote = char
      i++
      while (i < token.length && token[i] !== quote) {
        out += token[i]
        i++
      }
      i++
      continue
    }
    if (char === "`") {
      const next = token[i + 1]
      if (next !== undefined) {
        out += next === "`" ? "`" : next
        i += 2
        continue
      }
      i++
      continue
    }
    out += char
    i++
  }
  return out
}

function matchSeparator(text: string, index: number) {
  const two = text.slice(index, index + 2)
  if (two === "&&" || two === "||" || two === "|&") return two
  const one = text[index]
  if (one === ";" || one === "|" || one === "&") return one
  return
}

function skipQuoted(text: string, index: number) {
  const quote = text[index]
  let i = index + 1
  while (i < text.length) {
    if (text[i] === quote) return i + 1
    i++
  }
  return text.length
}

function skipWord(text: string, index: number) {
  let i = index
  while (i < text.length) {
    const char = text[i]
    if (char === " " || char === "\t" || char === "\r" || char === "\n") break
    if (char === "'" || char === '"') {
      i = skipQuoted(text, i)
      continue
    }
    if (char === "`") {
      i += 2
      continue
    }
    if (matchSeparator(text, i)) break
    i++
  }
  return i
}

/** Index just past the newline that closes the opening line, if there is one. */
function endOfLine(text: string, index: number) {
  let i = index
  while (i < text.length && text[i] !== "\n") {
    if (text[i] === "'" || text[i] === '"') {
      i = skipQuoted(text, i)
      continue
    }
    if (text[i] === "`") {
      i += 2
      continue
    }
    i++
  }
  if (i >= text.length) return
  return i + 1
}

function hasNonAscii(text: string) {
  return /[\u0080-\u{10FFFF}]/u.test(text)
}

function hasControlChars(text: string) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true
  }
  return false
}

/** A line of the body consisting of exactly `'@` would close the here-string. */
function hereStringUnsafe(body: string) {
  return /^'@[ \t]*(\r\n|\n|\r|$)/m.test(body)
}

function base64(body: string) {
  const bytes = new TextEncoder().encode(body)
  let out = ""
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(out)
}

/**
 * Find every real heredoc operator. Walks the command as a stream of
 * separators and ordinary words, so `<<` inside quoted text or inside a word
 * (for example `echo 'a <<PY'`) is never treated as a redirection.
 */
function collectHeredocs(command: string) {
  const found: Heredoc[] = []
  let i = 0

  while (i < command.length) {
    const char = command[i]

    if (char === "\n" || char === " " || char === "\t" || char === "\r") {
      i++
      continue
    }
    if (char === "'" || char === '"') {
      i = skipQuoted(command, i)
      continue
    }
    if (char === "`") {
      i += 2
      continue
    }
    if (char === "#") {
      i = skipLine(command, i)
      continue
    }

    const separator = matchSeparator(command, i)
    if (separator) {
      i += separator.length
      continue
    }

    const wordStart = i
    i = skipWord(command, i)
    const word = command.slice(wordStart, i)

    const redirect = redirectIndex(word)
    if (redirect === undefined) continue

    // Only `<<` and `<<-` at word start are heredocs. A digit-prefixed fd
    // (`2<<`) or an append/duplicate form is left alone: PowerShell cannot
    // express it, and rewriting it would silently change the meaning.
    if (redirect !== 0) continue
    if (!word.startsWith("<<")) continue

    const spec = parseOperator(word)
    if (!spec) continue

    const operatorIndex = wordStart
    const opEnd = operatorIndex + spec.matchLength
    const rawLineEnd = rawEndOfLine(command, opEnd)
    if (rawLineEnd === undefined) continue

    // Bash requires nothing but whitespace between the delimiter and the end
    // of the opening line. Anything there (another redirect, `2>&1`, ...) is
    // syntax PowerShell cannot merge into the pipeline form.
    if (command.slice(opEnd, rawLineEnd).trim() !== "") continue

    const lineEnd = endOfLine(command, opEnd)
    if (lineEnd === undefined) continue

    const found0 = findTerminator(command, lineEnd, spec.delimiter, spec.stripTabs)
    if (!found0) continue

    const segment = segmentStart(command, operatorIndex)
    const raw = command.slice(lineEnd, found0.start)
    const body = spec.stripTabs ? stripLeadingTabs(raw) : raw

    found.push({
      spliceFrom: segment.spliceFrom,
      bodyStart: lineEnd,
      bodyEnd: found0.end,
      delimiter: spec.delimiter,
      stripTabs: spec.stripTabs,
      body,
      words: segmentWords(command, segment.start, operatorIndex),
      callOperator: segment.callOperator,
    })
    i = found0.end
  }

  return found
}

function parseOperator(word: string) {
  const match = /^<<(?<stripTabs>-?)(?<quote>['"`]?)(?<delimiter>[^\s'"`;|&<>]+)/.exec(word)
  if (!match || !match.groups) return
  const quote = match.groups.quote
  // Bash allows any character to quote the delimiter; backtick-quoting has no
  // PowerShell equivalent we can guarantee, so only the two quote kinds pass.
  if (quote === "`") return
  if (match.groups.delimiter === "") return
  let matchLength = match[0].length
  if (quote && word[matchLength] === quote) matchLength++
  return {
    stripTabs: match.groups.stripTabs === "-",
    delimiter: match.groups.delimiter,
    quote,
    matchLength,
  }
}

/** Index of the next `\n` at or after `index` (end of input if none). */
function rawEndOfLine(text: string, index: number) {
  let i = index
  while (i < text.length && text[i] !== "\n") i++
  return i
}

function skipLine(text: string, index: number) {
  let i = index
  while (i < text.length && text[i] !== "\n") i++
  return i
}

function redirectIndex(word: string) {
  let i = 0
  while (i < word.length) {
    const char = word[i]
    if (char === "'" || char === '"') {
      i = skipQuoted(word, i)
      continue
    }
    if (char === "`") {
      i += 2
      continue
    }
    if (char === "<") return i
    i++
  }
  return
}

function stripLeadingTabs(text: string) {
  return text.replace(/^\t+/gm, "")
}

/** Locate the first line that is exactly the delimiter, and its end. */
function findTerminator(text: string, from: number, delimiter: string, stripTabs: boolean) {
  const pattern = new RegExp(`^${stripTabs ? "\\t*" : ""}${escapeRegExp(delimiter)}\\r?$`, "m")
  const match = pattern.exec(text.slice(from))
  if (!match) return
  const start = from + match.index
  return { start, end: start + match[0].length }
}

/**
 * Start of the pipeline segment that ends at `operatorIndex` (whitespace
 * before the first word included), and whether the segment began with an
 * explicit `&` call operator (which the rewrite must consume, since
 * `@'...'@ | & python -` carries its own `&`).
 */
function segmentStart(command: string, operatorIndex: number) {
  let i = 0
  let start = 0
  while (i < operatorIndex) {
    const char = command[i]
    if (char === "'" || char === '"') {
      i = skipQuoted(command, i)
      continue
    }
    if (char === "`") {
      i += 2
      continue
    }
    if (char === "\n") {
      start = i + 1
      i++
      continue
    }
    const separator = matchSeparator(command, i)
    if (separator) {
      start = i + separator.length
      i += separator.length
      continue
    }
    i++
  }
  while (start < operatorIndex && (command[start] === " " || command[start] === "\t" || command[start] === "\r")) start++

  // Scan back over horizontal whitespace for a lone `&`. A `&&` chain does
  // not count; a `&` background operator would, which is acceptable since it
  // has no PowerShell equivalent either.
  let back = start
  while (back > 0 && (command[back - 1] === " " || command[back - 1] === "\t")) back--
  const callOperator = command[back - 1] === "&" && command[back - 2] !== "&"
  return { start, callOperator, spliceFrom: callOperator ? back - 1 : start }
}

/** Words of the pipeline segment spanning [start, end). */
function segmentWords(command: string, start: number, end: number) {
  const words: Word[] = []
  let i = start

  while (i < end) {
    const char = command[i]
    if (char === " " || char === "\t" || char === "\r" || char === "\n") {
      i++
      continue
    }
    if (char === "`") {
      i += 2
      continue
    }
    const wordStart = i
    i = skipWord(command, i)
    const text = command.slice(wordStart, i).trim()
    if (!text) continue
    const first = text[0]
    if (first === "'") words.push({ kind: "single", text })
    else if (first === '"') words.push({ kind: "double", text })
    else words.push({ kind: "bare", text })
  }

  return words
}

/**
 * Decide whether this heredoc can be translated. Returns the invocation text
 * to place after the pipeline, or undefined when the construct must be left
 * alone (unknown target, unsafe argument, or no stdin consumer).
 */
function invocation(command: string, heredoc: Heredoc) {
  const program = heredoc.words[0]
  if (!program) return

  const name = unquoteToken(program.text).replace(/\.exe$/i, "")
  const base = name.split(/[\\/]/).pop() ?? name
  if (!TARGETS.has(base.toLowerCase())) return

  const args = heredoc.words.slice(1)
  // The last argument must consume stdin, and no argument may carry Bash
  // redirection or backtick substitution, whose PowerShell meaning differs.
  const last = args.at(-1)
  if (!last || unquoteToken(last.text) !== "-") return
  for (const arg of args) {
    if (/^\d*[<>]/.test(arg.text) || arg.text.includes("<")) return
    if (arg.kind !== "single" && arg.text.includes("`")) return
  }

  let text = heredoc.words.map((word) => word.text).join(" ")
  if (heredoc.callOperator) text = `& ${text}`
  else if (program.text[0] === "'" || program.text[0] === '"' || /\s/.test(unquoteToken(program.text))) text = `& ${text}`
  return text
}

function render(body: string, invocation: string) {
  const pipe = ` | ${invocation}`
  if (hasControlChars(body) || hereStringUnsafe(body)) {
    return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64(body)}'))${pipe}`
  }
  return `@'\n${body}'@${pipe}`
}

/**
 * Rewrite Bash heredocs into PowerShell here-string pipelines. Returns the
 * input unchanged when nothing can be translated safely.
 */
export function rewriteBashHeredocsForPowerShell(command: string) {
  const heredocs = collectHeredocs(command)
  if (heredocs.length === 0) return command

  const pieces: string[] = []
  let cursor = 0
  let rewritten = 0
  let preamble = ""

  for (const heredoc of heredocs) {
    const target = invocation(command, heredoc)
    if (!target) continue

    pieces.push(command.slice(cursor, heredoc.spliceFrom))
    pieces.push(render(heredoc.body, target))
    cursor = heredoc.bodyEnd
    rewritten++
    if (hasNonAscii(heredoc.body)) preamble = UTF8_PREAMBLE
  }

  if (rewritten === 0) return command
  pieces.push(command.slice(cursor))
  return preamble + pieces.join("")
}

export * as PowerShellHeredoc from "./powershell-heredoc"
