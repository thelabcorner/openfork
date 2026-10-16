import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { ledgerEntryAt, ledgerPageEnds, safeLedgerVirtualItems } from "@/components/session/session-context-virtual-rows"

describe("Context ledger virtual rows", () => {
  test("page lookup preserves newest-first indices across empty and appended pages", () => {
    const pages = [[{ messageID: "latest" }, { messageID: "middle" }], [], [{ messageID: "oldest" }]]
    const ends = ledgerPageEnds(pages)
    expect(ends).toEqual([2, 2, 3])
    expect([0, 1, 2, 3, -1, Number.NaN].map((index) => ledgerEntryAt(pages, ends, index)?.messageID))
      .toEqual(["latest", "middle", "oldest", undefined, undefined, undefined])
  })

  test("filters sparse, stale, invalid and missing measurements BEFORE keyed Solid reconciliation", () => {
    createRoot((dispose) => {
      const rows = [{ messageID: "a" }, { messageID: "b" }, { messageID: "c" }]
      const [visible, setVisible] = createStore<Array<{ index: number; start: number }>>([
        { index: 0, start: 0 },
        { index: 1, start: 45 },
        { index: 2, start: 90 },
      ])
      const sparse = Array.from({ length: 8 }, () => undefined as { index: number; start: number } | undefined)
      sparse[0] = { index: 0, start: 0 }
      sparse[2] = { index: 1, start: 45 }
      sparse[3] = { index: 2, start: 90 } // stale after count shrinks
      sparse[4] = { index: -1, start: 0 }
      sparse[5] = { index: Number.NaN, start: 0 }
      sparse[6] = { index: 100, start: 4500 }
      sparse[7] = { index: 1.25, start: 45 }

      expect(() => setVisible(reconcile(
        safeLedgerVirtualItems(sparse, 2, (index) => rows[index]),
        { key: "index" },
      ))).not.toThrow()
      expect(visible.map((row) => row.index)).toEqual([0, 1])

      // Empty window / session invalidation must never attempt to reconcile
      // a partially populated virtual range or retain rows from the old session.
      expect(() => setVisible(reconcile(
        safeLedgerVirtualItems([undefined, { index: 0, start: 0 }], 0, (index) => rows[index]),
        { key: "index" },
      ))).not.toThrow()
      expect(visible).toHaveLength(0)

      expect(() => setVisible(reconcile(
        safeLedgerVirtualItems([{ index: 0, start: 0 }], 1, (index) => [{ messageID: "new-session" }][index]),
        { key: "index" },
      ))).not.toThrow()
      expect(visible.map((row) => row.index)).toEqual([0])
      dispose()
    })
  })
})
