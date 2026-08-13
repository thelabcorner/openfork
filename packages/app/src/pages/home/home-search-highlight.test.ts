import { describe, expect, test } from "bun:test"
import { splitHighlight } from "./home-search-highlight"

describe("splitHighlight", () => {
  test("flags exact term matches case-insensitively", () => {
    expect(splitHighlight("Fix the FTS5 index", ["fts5"])).toEqual([
      { text: "Fix the ", match: false },
      { text: "FTS5", match: true },
      { text: " index", match: false },
    ])
  })

  test("matches multiple terms, longest first to avoid double-marking overlaps", () => {
    expect(splitHighlight("Sessions and messages", ["messages", "session"])).toEqual([
      { text: "Session", match: true },
      { text: "s and ", match: false },
      { text: "messages", match: true },
    ])
  })

  test("marks every occurrence of a term", () => {
    expect(splitHighlight("a foo b foo c", ["foo"])).toEqual([
      { text: "a ", match: false },
      { text: "foo", match: true },
      { text: " b ", match: false },
      { text: "foo", match: true },
      { text: " c", match: false },
    ])
  })

  test("returns a single unmatched segment when no term hits", () => {
    expect(splitHighlight("no match here", ["zzz"])).toEqual([{ text: "no match here", match: false }])
  })

  test("returns a single unmatched segment for empty terms", () => {
    expect(splitHighlight("plain text", [])).toEqual([{ text: "plain text", match: false }])
  })

  test("handles empty text", () => {
    expect(splitHighlight("", ["foo"])).toEqual([{ text: "", match: false }])
  })
})
