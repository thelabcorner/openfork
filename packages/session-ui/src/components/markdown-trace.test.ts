import { expect, test } from "bun:test"
import { markdownTraceEnabled } from "./markdown-trace"

test("an explicit runtime enable gate keeps an installed trace callback off the hot path", () => {
  const target = globalThis as typeof globalThis & {
    __opencodeMarkdownTrace?: (event: unknown) => void
    __opencodeMarkdownTraceEnabled?: () => boolean
  }
  const callback = target.__opencodeMarkdownTrace
  const enabled = target.__opencodeMarkdownTraceEnabled

  try {
    target.__opencodeMarkdownTrace = () => {}
    target.__opencodeMarkdownTraceEnabled = () => false
    expect(markdownTraceEnabled()).toBe(false)

    target.__opencodeMarkdownTraceEnabled = () => true
    expect(markdownTraceEnabled()).toBe(true)

    delete target.__opencodeMarkdownTraceEnabled
    expect(markdownTraceEnabled()).toBe(true)
  } finally {
    if (callback) target.__opencodeMarkdownTrace = callback
    else delete target.__opencodeMarkdownTrace
    if (enabled) target.__opencodeMarkdownTraceEnabled = enabled
    else delete target.__opencodeMarkdownTraceEnabled
  }
})
