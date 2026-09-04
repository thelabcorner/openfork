import { describe, expect, test } from "bun:test"
import { parseShellOutput } from "./shell-output"

describe("parseShellOutput", () => {
  test("normalizes line endings and returns plain output without ANSI controls", () => {
    // CRLF is a line break; a lone CR returns to column zero, so "three"
    // overwrites "two" rather than appearing on a line of its own.
    const parsed = parseShellOutput("one\r\ntwo\rthree\u001b[0m")

    expect(parsed.text).toBe("one\nthree")
    expect(parsed.segments).toEqual([{ text: "one\nthree", style: {} }])
  })

  test("applies standard colors and resets them", () => {
    const parsed = parseShellOutput("\u001b[31mred\u001b[1;32mbold green\u001b[0m plain")

    expect(parsed.segments).toEqual([
      { text: "red", style: { foreground: "var(--shell-ansi-red)" } },
      {
        text: "bold green",
        style: { foreground: "var(--shell-ansi-green)", bold: true },
      },
      { text: " plain", style: {} },
    ])
  })

  test("supports 256-color, truecolor, background, and text attributes", () => {
    const parsed = parseShellOutput("\u001b[38;5;196mred\u001b[48;2;1;2;3m\u001b[4;9mmarked\u001b[39;49;24;29mplain")

    expect(parsed.segments).toEqual([
      { text: "red", style: { foreground: "#ff0000" } },
      {
        text: "marked",
        style: {
          foreground: "#ff0000",
          background: "#010203",
          decoration: "underline line-through",
        },
      },
      { text: "plain", style: {} },
    ])
  })

  test("removes non-SGR ANSI controls without dropping surrounding text", () => {
    const parsed = parseShellOutput("before\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007after\u001b[?25l")

    expect(parsed.text).toBe("beforelinkafter")
    expect(parsed.segments).toEqual([{ text: "beforelinkafter", style: {} }])
  })

  test("collapses a redrawn progress line instead of stacking copies of it", () => {
    const parsed = parseShellOutput("done\n  10%\r  50%\r 100%\ndone\n")

    // A terminal shows one line here; treating \r as a newline showed three.
    expect(parsed.text).toBe("done\n 100%\ndone\n")
  })

  test("keeps colour set before an overwritten write", () => {
    const parsed = parseShellOutput("\u001b\[32mworking\rok")

    expect(parsed.segments).toEqual([{ text: "ok", style: { foreground: "var(--shell-ansi-green)" } }])
  })

  test("treats erase-line as a line rewrite", () => {
    const parsed = parseShellOutput("stale output\u001b\[2Kfresh\n")

    expect(parsed.text).toBe("fresh\n")
  })

  test("still normalises CRLF", () => {
    const parsed = parseShellOutput("a\r\nb")

    expect(parsed.text).toBe("a\nb")
  })

  test("merges adjacent text with the same effective style", () => {
    const parsed = parseShellOutput("a\u001b[31mb\u001b[31mc\u001b[39md")

    expect(parsed.segments).toEqual([
      { text: "a", style: {} },
      { text: "bc", style: { foreground: "var(--shell-ansi-red)" } },
      { text: "d", style: {} },
    ])
  })
})
