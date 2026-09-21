/**
 * Detect Bash stdin-redirection syntax before a V1 command reaches PowerShell.
 *
 * OpenFork used to translate quoted Bash heredocs into PowerShell here-string
 * pipelines. Byte-level integration tests disproved the required invariant:
 * PowerShell's native pipeline normalized a valid heredoc's trailing LF to
 * CRLF on Windows. Unquoted heredocs are even less portable because Bash also
 * performs parameter, command, and arithmetic expansion in their bodies.
 *
 * This module therefore has one narrow job: identify real Bash heredoc / here-
 * string syntax outside quoted text and comments so the launcher can reject it
 * with an actionable diagnostic. It never rewrites model-authored shell code.
 */

export type Analysis = {
  unquotedHeredoc: boolean
  quotedHeredoc: boolean
  hereString: boolean
}

type Heredoc = {
  quote: "'" | '"' | ""
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
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
    if (quote === '"' && text[i] === "`" && i + 1 < text.length) {
      i += 2
      continue
    }
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
      i += Math.min(2, text.length - i)
      continue
    }
    if (matchSeparator(text, i)) break
    i++
  }
  return i
}

function skipLine(text: string, index: number) {
  let i = index
  while (i < text.length && text[i] !== "\n") i++
  return i
}

function rawEndOfLine(text: string, index: number) {
  let i = index
  while (i < text.length && text[i] !== "\n") i++
  return i
}

function endOfLine(text: string, index: number) {
  const end = rawEndOfLine(text, index)
  return end < text.length ? end + 1 : undefined
}

function redirectIndex(word: string) {
  let i = 0
  while (i < word.length - 1) {
    const char = word[i]
    if (char === "'" || char === '"') {
      i = skipQuoted(word, i)
      continue
    }
    if (char === "`" && i + 1 < word.length) {
      i += 2
      continue
    }
    if (char === "<" && word[i + 1] === "<") return i
    i++
  }
  return
}

function parseHeredocOperator(word: string) {
  const match = /^<<(?<stripTabs>-?)(?<quote>['"]?)(?<delimiter>[^\s'"`;|&<>]+)/.exec(word)
  if (!match?.groups) return
  const quote = match.groups.quote as "'" | '"' | ""
  let matchLength = match[0].length
  if (quote) {
    if (word[matchLength] !== quote) return
    matchLength++
  }
  return {
    stripTabs: match.groups.stripTabs === "-",
    delimiter: match.groups.delimiter,
    quote,
    matchLength,
  }
}

function findTerminator(text: string, from: number, delimiter: string, stripTabs: boolean) {
  const pattern = new RegExp(`^${stripTabs ? "\\t*" : ""}${escapeRegExp(delimiter)}\\r?$`, "m")
  return pattern.test(text.slice(from))
}

function analyze(command: string) {
  const heredocs: Heredoc[] = []
  let hereString = false
  let i = 0

  while (i < command.length) {
    const char = command[i]
    if (char === "\n" || char === "\r" || char === " " || char === "\t") {
      i++
      continue
    }
    if (char === "'" || char === '"') {
      i = skipQuoted(command, i)
      continue
    }
    if (char === "`") {
      i += Math.min(2, command.length - i)
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

    const operator = word.slice(redirect)
    if (operator.startsWith("<<<")) {
      hereString = true
      continue
    }

    const spec = parseHeredocOperator(operator)
    if (!spec) continue
    const opEnd = wordStart + redirect + spec.matchLength
    const lineEndRaw = rawEndOfLine(command, opEnd)
    if (command.slice(opEnd, lineEndRaw).trim() !== "") continue
    const bodyStart = endOfLine(command, opEnd)
    if (bodyStart === undefined) continue
    if (!findTerminator(command, bodyStart, spec.delimiter, spec.stripTabs)) continue
    heredocs.push({ quote: spec.quote })
  }

  return { heredocs, hereString }
}

export function analyzeBashStdinSyntaxForPowerShell(command: string): Analysis {
  const result = analyze(command)
  return {
    unquotedHeredoc: result.heredocs.some((item) => !item.quote),
    quotedHeredoc: result.heredocs.some((item) => Boolean(item.quote)),
    hereString: result.hereString,
  }
}

export * as PowerShellHeredoc from "./powershell-heredoc"
