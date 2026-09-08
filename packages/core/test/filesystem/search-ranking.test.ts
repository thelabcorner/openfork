import { describe, expect, test } from "bun:test"
import { mentionRecencyBoost, rankFileMentionResults } from "../../src/search/mention-ranking"
import type { Matcher } from "../../src/search/matcher"

const DAY = 24 * 60 * 60 * 1000

function file(path: string, score: number): Matcher.UnifiedResult {
  return { kind: "file", path, type: "file", score }
}

describe("mention file recency ranking", () => {
  test("recently edited files win lexical near-ties", () => {
    const now = Date.now()
    const metadata = new Map([
      ["old/foo.ts", { size: 10, mtime: now - 30 * DAY }],
      ["new/foo.ts", { size: 10, mtime: now }],
    ])
    const ranked = rankFileMentionResults(
      [file("old/foo.ts", 134), file("new/foo.ts", 134)],
      (path) => metadata.get(path),
      now,
    )
    expect(ranked.map((item) => item.path)).toEqual(["new/foo.ts", "old/foo.ts"])
    expect(ranked[0]!.score).toBe(140)
  })

  test("freshness cannot erase a strong lexical exact-name advantage", () => {
    const now = Date.now()
    const metadata = new Map([
      ["old/search.ts", { size: 10, mtime: now - 30 * DAY }],
      ["new/search-helper.ts", { size: 10, mtime: now }],
    ])
    const ranked = rankFileMentionResults(
      [file("old/search.ts", 191), file("new/search-helper.ts", 184)],
      (path) => metadata.get(path),
      now,
    )
    expect(ranked[0]?.path).toBe("old/search.ts")
  })

  test("live metadata replaces stale row metadata before ranking", () => {
    const now = Date.now()
    const ranked = rankFileMentionResults(
      [{ ...file("src/live.ts", 100), size: 1, mtime: now - 30 * DAY }],
      () => ({ size: 42, mtime: now, lineCount: 7 }),
      now,
    )
    expect(ranked[0]).toMatchObject({ size: 42, mtime: now, lineCount: 7, score: 106 })
  })

  test("recency decays and rejects unusable timestamps", () => {
    const now = Date.now()
    expect(mentionRecencyBoost(now, now)).toBe(6)
    expect(mentionRecencyBoost(now - DAY, now)).toBe(5)
    expect(mentionRecencyBoost(now - 14 * DAY, now)).toBe(0)
    expect(mentionRecencyBoost(undefined, now)).toBe(0)
    expect(mentionRecencyBoost(Number.NaN, now)).toBe(0)
  })
})
