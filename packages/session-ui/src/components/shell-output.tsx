import { For, type Accessor } from "solid-js"

const ESC = "\u001b"
const BEL = "\u0007"
const CSI = "\u009b"
const OSC = "\u009d"

const ANSI_COLOR_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "bright-black",
  "bright-red",
  "bright-green",
  "bright-yellow",
  "bright-blue",
  "bright-magenta",
  "bright-cyan",
  "bright-white",
] as const

export type ShellOutputStyle = {
  foreground?: string
  background?: string
  decoration?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  blink?: boolean
  inverse?: boolean
  hidden?: boolean
}

export type ShellOutputSegment = {
  text: string
  style: ShellOutputStyle
}

export type ParsedShellOutput = {
  text: string
  segments: ShellOutputSegment[]
}

type MutableShellOutputStyle = {
  foreground?: string
  background?: string
  underline: boolean
  overline: boolean
  strikethrough: boolean
  bold: boolean
  dim: boolean
  italic: boolean
  blink: boolean
  inverse: boolean
  hidden: boolean
}

type SgrParameter = number[]

type AnsiSequence = {
  length: number
  sgr?: string
}

const ANSI_COLOR_CODES: Record<number, number> = {
  30: 0,
  31: 1,
  32: 2,
  33: 3,
  34: 4,
  35: 5,
  36: 6,
  37: 7,
  90: 8,
  91: 9,
  92: 10,
  93: 11,
  94: 12,
  95: 13,
  96: 14,
  97: 15,
}

const ANSI_BACKGROUND_CODES: Record<number, number> = {
  40: 0,
  41: 1,
  42: 2,
  43: 3,
  44: 4,
  45: 5,
  46: 6,
  47: 7,
  100: 8,
  101: 9,
  102: 10,
  103: 11,
  104: 12,
  105: 13,
  106: 14,
  107: 15,
}

const EMPTY_STYLE = (): MutableShellOutputStyle => ({
  underline: false,
  overline: false,
  strikethrough: false,
  bold: false,
  dim: false,
  italic: false,
  blink: false,
  inverse: false,
  hidden: false,
})

function ansiPaletteColor(index: number) {
  const name = ANSI_COLOR_NAMES[index]
  return name ? `var(--shell-ansi-${name})` : undefined
}

function rgbToHex(red: number, green: number, blue: number) {
  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, "0")).join("")}`
}

function color256(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 255) return
  if (value < 16) return ansiPaletteColor(value)

  if (value >= 232) {
    const gray = 8 + (value - 232) * 10
    return rgbToHex(gray, gray, gray)
  }

  const cube = value - 16
  const red = Math.floor(cube / 36)
  const green = Math.floor((cube % 36) / 6)
  const blue = cube % 6
  const level = (channel: number) => (channel === 0 ? 0 : 55 + channel * 40)
  return rgbToHex(level(red), level(green), level(blue))
}

function colorRgb(red: number, green: number, blue: number) {
  if (![red, green, blue].every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) return
  return rgbToHex(red, green, blue)
}

function parseSgrParameters(value: string): SgrParameter[] | undefined {
  if (!/^[0-9;:]*$/.test(value)) return
  if (value.length === 0) return [[0]]

  return value.split(";").map((parameter) => {
    const values = parameter
      .split(":")
      .filter((part) => part.length > 0)
      .map(Number)
    return values.length > 0 ? values : [0]
  })
}

function readExtendedColor(parameters: SgrParameter[], index: number) {
  const current = parameters[index] ?? []
  const mode = current[1]

  if (mode === 5 && current.length >= 3) {
    return { color: color256(current[2]), nextIndex: index + 1 }
  }

  if (mode === 2 && current.length >= 5) {
    return { color: colorRgb(current[2], current[3], current[4]), nextIndex: index + 1 }
  }

  const next = parameters[index + 1]?.[0]
  if (next === 5) {
    return { color: color256(parameters[index + 2]?.[0] ?? -1), nextIndex: index + 3 }
  }

  if (next === 2) {
    return {
      color: colorRgb(
        parameters[index + 2]?.[0] ?? -1,
        parameters[index + 3]?.[0] ?? -1,
        parameters[index + 4]?.[0] ?? -1,
      ),
      nextIndex: index + 5,
    }
  }

  return
}

function reset(style: MutableShellOutputStyle) {
  style.foreground = undefined
  style.background = undefined
  Object.assign(style, EMPTY_STYLE())
}

function applySgr(value: string, style: MutableShellOutputStyle) {
  const parameters = parseSgrParameters(value)
  if (!parameters) return

  for (let index = 0; index < parameters.length; index++) {
    const code = parameters[index]?.[0] ?? 0

    if (code === 0) {
      reset(style)
      continue
    }

    const foreground = ANSI_COLOR_CODES[code]
    if (foreground !== undefined) {
      style.foreground = ansiPaletteColor(foreground)
      continue
    }

    const background = ANSI_BACKGROUND_CODES[code]
    if (background !== undefined) {
      style.background = ansiPaletteColor(background)
      continue
    }

    if (code === 38 || code === 48) {
      const extended = readExtendedColor(parameters, index)
      if (extended?.color) {
        if (code === 38) style.foreground = extended.color
        else style.background = extended.color
        index = extended.nextIndex - 1
      }
      continue
    }

    switch (code) {
      case 1:
        style.bold = true
        break
      case 2:
        style.dim = true
        break
      case 3:
        style.italic = true
        break
      case 4:
        style.underline = parameters[index]?.[1] === 0 ? false : true
        break
      case 5:
      case 6:
        style.blink = true
        break
      case 7:
        style.inverse = true
        break
      case 8:
        style.hidden = true
        break
      case 9:
        style.strikethrough = true
        break
      case 21:
        style.underline = true
        break
      case 22:
        style.bold = false
        style.dim = false
        break
      case 23:
        style.italic = false
        break
      case 24:
        style.underline = false
        break
      case 25:
        style.blink = false
        break
      case 27:
        style.inverse = false
        break
      case 28:
        style.hidden = false
        break
      case 29:
        style.strikethrough = false
        break
      case 39:
        style.foreground = undefined
        break
      case 49:
        style.background = undefined
        break
      case 53:
        style.overline = true
        break
      case 55:
        style.overline = false
        break
    }
  }
}

function snapshotStyle(style: MutableShellOutputStyle): ShellOutputStyle {
  const decoration = [
    style.underline ? "underline" : "",
    style.overline ? "overline" : "",
    style.strikethrough ? "line-through" : "",
  ]
    .filter(Boolean)
    .join(" ")

  const snapshot: ShellOutputStyle = {}
  if (style.foreground) snapshot.foreground = style.foreground
  if (style.background) snapshot.background = style.background
  if (decoration) snapshot.decoration = decoration
  if (style.bold) snapshot.bold = true
  if (style.dim) snapshot.dim = true
  if (style.italic) snapshot.italic = true
  if (style.blink) snapshot.blink = true
  if (style.inverse) snapshot.inverse = true
  if (style.hidden) snapshot.hidden = true
  return snapshot
}

function styleKey(style: ShellOutputStyle) {
  return [
    style.foreground ?? "",
    style.background ?? "",
    style.decoration ?? "",
    style.bold ? "bold" : "",
    style.dim ? "dim" : "",
    style.italic ? "italic" : "",
    style.blink ? "blink" : "",
    style.inverse ? "inverse" : "",
    style.hidden ? "hidden" : "",
  ].join("|")
}

function appendSegment(segments: ShellOutputSegment[], text: string, style: ShellOutputStyle) {
  if (text.length === 0) return

  const previous = segments[segments.length - 1]
  if (previous && styleKey(previous.style) === styleKey(style)) {
    previous.text += text
    return
  }

  segments.push({ text, style })
}

function consumeStringControl(input: string, start: number, prefixLength: number) {
  for (let index = start + prefixLength; index < input.length; index++) {
    if (input[index] !== ESC) continue
    if (input[index + 1] === "\\") return index + 2 - start
  }
  return input.length - start
}

function consumeOsc(input: string, start: number, prefixLength: number): AnsiSequence {
  for (let index = start + prefixLength; index < input.length; index++) {
    if (input[index] === BEL) return { length: index + 1 - start }
    if (input[index] === ESC && input[index + 1] === "\\") return { length: index + 2 - start }
  }
  return { length: input.length - start }
}

function consumeCsi(input: string, start: number, prefixLength: number): AnsiSequence {
  const parametersStart = start + prefixLength

  for (let index = parametersStart; index < input.length; index++) {
    const code = input.charCodeAt(index)
    if (code < 0x40 || code > 0x7e) continue

    const parameters = input.slice(parametersStart, index)
    return {
      length: index + 1 - start,
      sgr: input[index] === "m" ? parameters : undefined,
    }
  }

  return { length: input.length - start }
}

function consumeAnsi(input: string, start: number): AnsiSequence {
  const next = input[start + 1]

  if (next === "[") return consumeCsi(input, start, 2)
  if (next === "]") return consumeOsc(input, start, 2)
  if (next === "P" || next === "X" || next === "^" || next === "_") {
    return { length: consumeStringControl(input, start, 2) }
  }

  // Charset selection and the remaining two-byte ESC sequences are control
  // instructions, not printable shell output.
  return { length: Math.min(2, input.length - start) }
}

function consumeControl(input: string, start: number): AnsiSequence | undefined {
  const code = input.charCodeAt(start)

  if (input[start] === ESC) return consumeAnsi(input, start)
  if (input[start] === CSI) return consumeCsi(input, start, 1)
  if (input[start] === OSC) return consumeOsc(input, start, 1)
  if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
    return { length: consumeStringControl(input, start, 1) }
  }
  if (code >= 0x80 && code <= 0x9f) return { length: 1 }
  return
}

/** A carriage return, `ESC[2K` (erase line), or `ESC[G`/`ESC[1G` (go to col 1). */
const LINE_RESET = /\r|\u001b\[2K|\u001b\[1?G/

/**
 * Drops the printable characters from a chunk but keeps its control sequences,
 * so colours set before an overwritten write still apply to what replaced it.
 */
function controlsOnly(chunk: string) {
  let out = ""
  for (let index = 0; index < chunk.length; ) {
    const control = consumeControl(chunk, index)
    if (!control) {
      index++
      continue
    }
    out += chunk.slice(index, index + control.length)
    index += control.length
  }
  return out
}

/**
 * Resolves in-place line rewrites.
 *
 * Progress output (`npm`, `vitest`, spinners) redraws one line by returning the
 * cursor to column zero and writing over it. Treating those carriage returns as
 * newlines — which is what happened before — turns a single progress line into
 * hundreds of near-identical rows and buries the output that follows.
 *
 * The model here is "last write wins" for the line, which is what a terminal
 * shows for full-width redraws. Partial overwrites (`abcdef\rXY`) are not
 * composited; tools that do that in practice also clear to end-of-line.
 */
function resolveLineRewrites(value: string) {
  if (!LINE_RESET.test(value)) return value
  return value
    .split("\n")
    .map((line) => {
      if (!LINE_RESET.test(line)) return line
      const chunks = line.split(LINE_RESET)
      const last = chunks.pop() ?? ""
      return chunks.map(controlsOnly).join("") + last
    })
    .join("\n")
}

export function parseShellOutput(input: string): ParsedShellOutput {
  const value = resolveLineRewrites(input.replace(/\r\n/g, "\n"))
  const segments: ShellOutputSegment[] = []
  const style = EMPTY_STYLE()
  let textStart = 0

  for (let index = 0; index < value.length; ) {
    const control = consumeControl(value, index)
    if (!control) {
      index++
      continue
    }

    appendSegment(segments, value.slice(textStart, index), snapshotStyle(style))
    if (control.sgr !== undefined) applySgr(control.sgr, style)
    index += control.length
    textStart = index
  }

  appendSegment(segments, value.slice(textStart), snapshotStyle(style))

  return {
    text: segments.map((segment) => segment.text).join(""),
    segments,
  }
}

type ShellOutputCssVariables = {
  "--shell-output-fg"?: string
  "--shell-output-bg"?: string
  "--shell-output-decoration"?: string
}

function segmentStyle(style: ShellOutputStyle): ShellOutputCssVariables | undefined {
  if (!style.foreground && !style.background && !style.decoration) return undefined

  const properties: ShellOutputCssVariables = {}
  if (style.foreground) properties["--shell-output-fg"] = style.foreground
  if (style.background) properties["--shell-output-bg"] = style.background
  if (style.decoration) properties["--shell-output-decoration"] = style.decoration
  return properties
}

export function ShellOutput(props: { parsed: Accessor<ParsedShellOutput> }) {
  return (
    <For each={props.parsed().segments}>
      {(segment) => {
        const style = segment.style
        return (
          <span
            data-slot="shell-output-segment"
            data-shell-bold={style.bold ? "true" : undefined}
            data-shell-dim={style.dim ? "true" : undefined}
            data-shell-italic={style.italic ? "true" : undefined}
            data-shell-blink={style.blink ? "true" : undefined}
            data-shell-inverse={style.inverse ? "true" : undefined}
            data-shell-hidden={style.hidden ? "true" : undefined}
            style={segmentStyle(style)}
          >
            {segment.text}
          </span>
        )
      }}
    </For>
  )
}
