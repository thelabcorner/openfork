import { describe, expect, test } from "bun:test"
import { ledgerEntryAt, ledgerPageEnds, safeLedgerVirtualItems, sameLedgerVirtualRange } from "./session-context-virtual-rows"

describe("Context ledger virtual row index", () => {
  test("looks up exact rows across hundreds of stable chunks without flattening", () => {
    const pages = Array.from({ length: 400 }, (_, p) =>
      Array.from({ length: p === 399 ? 13 : 50 }, (_, i) => ({ messageID: `m-${p}-${i}` })),
    )
    const first = pages[0]!
    const ends = ledgerPageEnds(pages)
    expect(ends).toHaveLength(400)
    expect(ends.at(-1)).toBe(19963)
    expect(ledgerEntryAt(pages, ends, 0)).toBe(first[0])
    expect(ledgerEntryAt(pages, ends, 49)).toBe(first[49])
    expect(ledgerEntryAt(pages, ends, 50)).toBe(pages[1]![0])
    expect(ledgerEntryAt(pages, ends, 19949)).toBe(pages[398]![49])
    expect(ledgerEntryAt(pages, ends, 19950)).toBe(pages[399]![0])
    expect(ledgerEntryAt(pages, ends, 19962)).toBe(pages[399]![12])
    for (const index of [13, 172, 1435, 4000, 19204]) {
      const p = Math.floor(index / 50)
      expect(ledgerEntryAt(pages, ends, index)).toBe(pages[p]![index % 50])
    }
    expect(ledgerEntryAt(pages, ends, -1)).toBeUndefined()
    expect(ledgerEntryAt(pages, ends, 19963)).toBeUndefined()
    expect(ledgerEntryAt(pages, ends, 1.3)).toBeUndefined()
  })

  test("handles empty and variable-sized pages with the same key identity", () => {
    const pages = [
      [{ messageID: "a" }], [],
      [{ messageID: "b" }, { messageID: "c" }],
      [{ messageID: "d" }],
    ]
    const ends = ledgerPageEnds(pages)
    expect(ends).toEqual([1, 1, 3, 4])
    expect([0, 1, 2, 3].map((index) => ledgerEntryAt(pages, ends, index)?.messageID))
      .toEqual(["a", "b", "c", "d"])
  })
})

test("filters missing, stale-key and invalid virtual-core items before publication", () => {
  const items = [undefined, { index: 0, key: "first" }, undefined, { index: 7, key: "stale" },
    { index: 1, key: "wrong-session" }, { index: 1, key: "second" }]
  const rows = [{ messageID: "first" }, { messageID: "second" }]
  const valid = safeLedgerVirtualItems(items, rows.length, (index) => rows[index])
  expect(valid.map((item) => item.index)).toEqual([0, 1])
  expect(valid.every((item) => item !== undefined)).toBe(true)
  expect(safeLedgerVirtualItems(items, 0, () => undefined)).toEqual([])
})

test("repairs out-of-order and duplicate measurements without inventing rows", () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({ messageID: `m-${index}` }))
  const items = [rows[4], rows[2], rows[2], rows[0]].map((row) => ({
    index: Number(row!.messageID.slice(2)), key: row!.messageID,
  }))
  const valid = safeLedgerVirtualItems(items, rows.length, (index) => rows[index])
  expect(valid.map((item) => item.index)).toEqual([0, 2, 4])
})

test("600 rapid count-shrink and scroll changes produce complete, valid ranges", () => {
  const rows = Array.from({ length: 200 }, (_, index) => ({ messageID: `m-${index}` }))
  let previous: { index: number; key: string }[] = []
  let publications = 0
  for (let round = 0; round < 600; round++) {
    const count = [200, 1, 0, 50, 4, 175][round % 6]!
    const start = count > 15 ? (round * 17) % (count - 15) : 0
    const candidate = Array.from({ length: Math.min(count - start, 15) }, (_, i) => ({
      index: start + i, key: `m-${start + i}`,
    }))
    const raw = [undefined, ...candidate, { index: count + 3, key: "stale" }]
    const next = safeLedgerVirtualItems(raw, count, (index) => rows[index])
    if (!sameLedgerVirtualRange(previous, next)) {
      previous = next
      publications++
    }
    for (const item of previous) {
      expect(Number.isSafeInteger(item.index)).toBe(true)
      expect(item.key).toBe(`m-${item.index}`)
      expect(item.index).toBeLessThan(count)
    }
  }
  expect(publications).toBeGreaterThan(100)
})

test("unchanged measurement references are not republished", () => {
  const first = { index: 0, key: "a" }
  const second = { index: 1, key: "b" }
  expect(sameLedgerVirtualRange([first, second], [first, second])).toBe(true)
  expect(sameLedgerVirtualRange([first, second], [first, { ...second }])).toBe(false)
  expect(sameLedgerVirtualRange([first, second], [first])).toBe(false)
})
