/**
 * Structure of a failed tool call's message.
 *
 * Tool errors are not one blob. They are prose, sometimes interleaved with
 * verbatim source excerpts (the `patch`/`edit` tools quote the lines they could
 * not find, with a `NNNN |` gutter), sometimes followed by remediation aimed at
 * the model, and only occasionally by an actual stack trace.
 *
 * Getting the split wrong is worse than not splitting: the previous heuristic
 * treated *any* line indented four spaces as the start of a stack trace, so a
 * patch failure collapsed its entire body — the part that tells you which lines
 * did not match — behind "Show stack (21 lines)".
 */

/** `at fn (/path/file.ts:1:2)`, `at async Foo.bar`, `at <anonymous>`. */
const STACK_FRAME = /^\s*at\s+\S/
/** A bare location tail: `    /src/foo.ts:12:34`, `    file.ts:12`. */
const STACK_LOCATION = /^\s+\(?(?:[A-Za-z]:)?[^\s:()]+:\d+(?::\d+)?\)?$/
/** Node's `node:internal/...` and bundler frames without a leading `at`. */
const STACK_MODULE = /^\s+(?:node:|file:\/\/|webpack:|\.\/|\/)\S*:\d+/

const isStackLine = (line: string) =>
  STACK_FRAME.test(line) || STACK_LOCATION.test(line) || STACK_MODULE.test(line)

/** Lines tools append to tell the *model* what to do next. */
const REMEDIATION = /^(please |try |use |re-save |hint:|suggestion:|did you mean)/i

/** `SchemaError(...)`, `ENOENT:`, `TypeError:` — a leading machine-readable type. */
const ERROR_TYPE = /^([A-Z][A-Za-z0-9_]*(?:Error|Exception)|E[A-Z]{3,})\b[:(]?/

/** ` 1137 |   const x = 1` / `>1137 |   const x = 1` — a quoted source excerpt. */
const GUTTER = /^(\s*)(>?)\s*(\d+)\s*[|│]\s?(.*)$/

/** Verbatim code the tool quoted back, indented under a prose line. */
const INDENTED_CODE = /^ {4,}\S/

export type ErrorCodeLine = { marker: boolean; number?: string; text: string }

export type ErrorBlock = { kind: "text"; text: string } | { kind: "code"; lines: ErrorCodeLine[] }

export type ParsedToolError = {
  raw: string
  type?: string
  blocks: ErrorBlock[]
  hints: string[]
  stack: string[]
}

/**
 * Only treat a tail as a stack when it really is one: walk backwards while the
 * lines look like frames, and require enough of them that collapsing is a
 * favour rather than a hiding place. A single `at ...` line is cheaper to read
 * than a disclosure button.
 */
function splitStack(lines: string[]): { body: string[]; stack: string[] } {
  let index = lines.length
  let frames = 0
  while (index > 0) {
    const line = lines[index - 1]!
    if (line.trim() === "") {
      index--
      continue
    }
    if (!isStackLine(line)) break
    frames++
    index--
  }
  if (frames < 3) return { body: lines, stack: [] }
  // Drop the blank lines that trail the prose rather than lead the stack.
  while (index < lines.length && lines[index]!.trim() === "") index++
  return { body: lines.slice(0, index), stack: lines.slice(index) }
}

function toBlocks(lines: string[]): ErrorBlock[] {
  const blocks: ErrorBlock[] = []
  let text: string[] = []
  let code: ErrorCodeLine[] = []

  const flushText = () => {
    const joined = text.join("\n").replace(/^\n+|\n+$/g, "")
    if (joined.trim()) blocks.push({ kind: "text", text: joined })
    text = []
  }
  const flushCode = () => {
    while (code.length && !code[code.length - 1]!.text.trim() && !code[code.length - 1]!.number) code.pop()
    if (code.length) blocks.push({ kind: "code", lines: code })
    code = []
  }

  for (const line of lines) {
    const gutter = GUTTER.exec(line)
    if (gutter) {
      flushText()
      code.push({ marker: gutter[2] === ">", number: gutter[3], text: gutter[4] ?? "" })
      continue
    }
    if (INDENTED_CODE.test(line)) {
      flushText()
      code.push({ marker: false, text: line.replace(/^ {2}/, "") })
      continue
    }
    // A blank line inside a quoted excerpt belongs to the excerpt.
    if (code.length && line.trim() === "") {
      code.push({ marker: false, text: "" })
      continue
    }
    flushCode()
    text.push(line)
  }

  flushText()
  flushCode()
  return blocks
}

export function parseToolError(error: string): ParsedToolError {
  const raw = error.replace(/^Error:\s*/, "").trimEnd()
  const { body, stack } = splitStack(raw.split("\n"))

  const hints: string[] = []
  while (body.length > 1 && REMEDIATION.test(body[body.length - 1]!.trim())) {
    hints.unshift(body.pop()!.trim())
  }

  const blocks = toBlocks(body)
  const first = blocks.find((block) => block.kind === "text")
  const type = first?.kind === "text" ? ERROR_TYPE.exec(first.text)?.[1] : undefined

  return { raw, type, blocks, hints, stack }
}
