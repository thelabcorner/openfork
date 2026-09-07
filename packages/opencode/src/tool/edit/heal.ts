import { normalizeNewlines } from "./text"

export type Healed<T> = { value: T; warnings: string[] }

const READ_PREFIX = /^\s*\d+[:|]\s?/

/**
 * D48 — strip the `N: ` prefix that read() renders. Nothing detected it, even
 * though edit.txt already warned about it — which makes it the
 * highest-frequency known failure mode. Only fires when EVERY non-empty line
 * carries a prefix, so genuine code containing "42: " is untouched.
 */
export function stripReadPrefix(text: string): Healed<string> {
  const lines = text.split("\n")
  const meaningful = lines.filter((l) => l.trim().length > 0)
  if (meaningful.length === 0) return { value: text, warnings: [] }
  if (!meaningful.every((l) => READ_PREFIX.test(l))) return { value: text, warnings: [] }
  return {
    value: lines.map((l) => (l.trim().length === 0 ? l : l.replace(READ_PREFIX, ""))).join("\n"),
    warnings: [
      "Stripped read() line-number prefixes (\"N: \") from the supplied text. Send the content that appears " +
        "AFTER the prefix — the prefix is display-only and is not part of the file.",
    ],
  }
}

const FENCE = /^```([a-zA-Z0-9+#._-]*)\s*\n([\s\S]*?)\n```\s*$/

/**
 * D48 — strip a markdown code fence wrapping replacement text. Writing a fence
 * into a source file is unambiguously wrong, so this is safe to apply
 * unconditionally when the whole payload is one fenced block.
 */
export function stripCodeFence(text: string): Healed<string> {
  const m = text.match(FENCE)
  if (!m) return { value: text, warnings: [] }
  return {
    value: m[2]!,
    warnings: [
      `Stripped a markdown code fence (\`\`\`${m[1] || ""}) from the replacement text. Send raw file content, ` +
        `not a fenced block.`,
    ],
  }
}

/**
 * D29 — deletion newline absorption: when replacing a block with nothing and
 * oldString has no trailing newline, extend the span over the following
 * terminator so the deletion doesn't leave a blank line behind. Without it,
 * every block deletion needs a second edit call to tidy up — directly against
 * the tool's own cost model.
 */
export function absorbDeletionNewline(
  content: string,
  span: { start: number; end: number; replacement: string },
): Healed<{ start: number; end: number; replacement: string }> {
  if (span.replacement !== "") return { value: span, warnings: [] }
  if (content.slice(span.start, span.end).endsWith("\n")) return { value: span, warnings: [] }
  if (content.startsWith("\r\n", span.end)) {
    return { value: { ...span, end: span.end + 2 }, warnings: [] }
  }
  if (content[span.end] === "\n" || content[span.end] === "\r") {
    return { value: { ...span, end: span.end + 1 }, warnings: [] }
  }
  return { value: span, warnings: [] }
}

/** Apply the input-side rails in order. Call once per model-supplied string. */
export function healInput(text: string, kind: "oldString" | "newString" | "newText" | "oldText" | "nearText"): Healed<string> {
  const warnings: string[] = []
  let value = normalizeNewlines(text)
  const fence = stripCodeFence(value)
  value = fence.value
  warnings.push(...fence.warnings.map((w) => `${kind}: ${w}`))
  const prefix = stripReadPrefix(value)
  value = prefix.value
  warnings.push(...prefix.warnings.map((w) => `${kind}: ${w}`))
  return { value, warnings }
}

export * as EditHeal from "./heal"
