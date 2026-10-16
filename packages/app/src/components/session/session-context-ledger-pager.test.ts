import { describe, expect, test } from "bun:test"
import { createSessionContextLedgerPager } from "./session-context-ledger-pager"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

type Entry = { messageID: string }
type Page = {
  entries: Entry[]
  hasMore: boolean
  nextCursor?: string
  mode: "chronological" | "compacted"
}
const page = (ids: string[], nextCursor?: string): Page => ({
  entries: ids.map((messageID) => ({ messageID })),
  hasMore: !!nextCursor,
  nextCursor,
  mode: "chronological",
})

describe("bounded Context ledger pager", () => {
  test("slow totals are accepted only for the exact current event revision", async () => {
    const obsolete = deferred<{ revision: number; totals?: {
      messageCount: number; excludedCount: number; pinnedCount: number; editedCount: number;
      estimatedTokens: number; estimatedTokensExcluded: number
    } }>()
    const current = deferred<{ revision: number; totals?: {
      messageCount: number; excludedCount: number; pinnedCount: number; editedCount: number;
      estimatedTokens: number; estimatedTokensExcluded: number
    } }>()
    const valid = { messageCount: 80, excludedCount: 1, pinnedCount: 0,
      editedCount: 0, estimatedTokens: 3200, estimatedTokensExcluded: 10 }
    let invocation = 0
    let session = "a"
    const snapshots: Array<import("./session-context-ledger-pager").ContextLedgerPageState<Entry> | null> = []
    const errors: string[] = []
    const pager = createSessionContextLedgerPager({
      load: async () => ({ ...page(["newest"], "more"), revision: ++invocation }),
      loadTotals: async () => invocation === 1 ? obsolete.promise : current.promise,
      currentSession: () => session,
      receive: (state) => snapshots.push(state),
      error: (error) => errors.push(String(error)),
    })
    await pager.read("a")
    await Promise.resolve()
    await pager.read("a", true)
    await Promise.resolve()
    obsolete.resolve({ revision: 1, totals: { ...valid, messageCount: 999 } })
    for (let i = 0; i < 4; i++) await Promise.resolve()
    expect(snapshots.at(-1)?.revision).toBe(2)
    expect(snapshots.at(-1)?.authoritativeTotals).toBeUndefined()
    current.resolve({ revision: 2, totals: valid })
    for (let i = 0; i < 4; i++) await Promise.resolve()
    expect(snapshots.at(-1)?.authoritativeTotals).toEqual(valid)
    expect(typeof Object.getOwnPropertyDescriptor(snapshots.at(-1)!, "entries")?.get).toBe("function")
    session = "b"
    pager.invalidate()
    expect(snapshots.at(-1)).toBeNull()
    expect(errors).toEqual([])
  })

  test("rejects totals from an external writer revision without mutating loaded rows", async () => {
    const snapshots: Array<import("./session-context-ledger-pager").ContextLedgerPageState<Entry>> = []
    const pager = createSessionContextLedgerPager({
      load: async () => ({ ...page(["newest"], "older"), revision: 55 }),
      loadTotals: async () => ({ revision: 56, totals: {
        messageCount: 100, excludedCount: 0, pinnedCount: 0, editedCount: 0,
        estimatedTokens: 400, estimatedTokensExcluded: 0,
      } }),
      currentSession: () => "a",
      receive: (state) => { if (state) snapshots.push(state) },
      error: (error) => { throw error },
    })
    await pager.read("a")
    for (let i = 0; i < 4; i++) await Promise.resolve()
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.loadedCount).toBe(1)
    expect(snapshots[0]!.authoritativeTotals).toBeUndefined()
  })

  test("keeps authoritative server totals independent from loaded-only page counts", async () => {
    const totals = {
      messageCount: 5018, excludedCount: 3, pinnedCount: 2, editedCount: 1,
      estimatedTokens: 124000, estimatedTokensExcluded: 100,
    }
    const snapshots: Array<import("./session-context-ledger-pager").ContextLedgerPageState<Entry>> = []
    const errors: string[] = []
    const pager = createSessionContextLedgerPager({
      load: async (_, cursor) => cursor
        ? page(["oldest"])
        : { ...page(["newest"], "older"), authoritativeTotals: totals },
      currentSession: () => "session-a",
      receive: (state) => { if (state) snapshots.push(state) },
      error: (error) => errors.push(String(error)),
    })
    await pager.read("session-a")
    expect(snapshots[0]!.loadedCount).toBe(1)
    expect(snapshots[0]!.totals.messageCount).toBe(1)
    expect(snapshots[0]!.authoritativeTotals).toEqual(totals)
    await pager.more()
    expect(snapshots[1]!.loadedCount).toBe(2)
    expect(snapshots[1]!.authoritativeTotals).toBe(totals)
    expect(snapshots[1]!.totals.messageCount).toBe(2)
    expect(errors).toEqual([])
    await pager.read("session-a", true)
    expect(snapshots.at(-1)!.authoritativeTotals).toEqual(totals)
  })

  test("retains immutable page identities and accumulates exact loaded-only facts without flattening history", async () => {
    type Row = Entry & { excluded: boolean; pinned: boolean; edited: boolean; tokenEstimate: number }
    const make = (messageID: string, tokenEstimate: number, flags?: Partial<Row>): Row => ({
      messageID, tokenEstimate, excluded: false, pinned: false, edited: false, ...flags,
    })
    const snapshots: Array<import("./session-context-ledger-pager").ContextLedgerPageState<Row>> = []
    const pager = createSessionContextLedgerPager<Row>({
      load: async (_, cursor) => cursor
        ? { ...page([]), entries: [make("old-excluded", 7, { excluded: true })], mode: "chronological" }
        : { ...page([], "older"), entries: [
          make("new-pinned", 12, { pinned: true }),
          make("new-edited", 5, { edited: true }),
        ], mode: "chronological" },
      currentSession: () => "a",
      receive: (state) => { if (state) snapshots.push(state) },
      error: (error) => { throw error },
      classify: (row) => row,
    })
    await pager.read("a")
    const firstPage = snapshots[0]!.pages[0]
    expect(snapshots[0]!.loadedCount).toBe(2)
    expect(snapshots[0]!.totals).toEqual({
      messageCount: 2, excludedCount: 0, pinnedCount: 1, editedCount: 1,
      estimatedTokens: 17, estimatedTokensExcluded: 0,
    })
    await pager.more()
    expect(snapshots[1]!.pages[0]).toBe(firstPage)
    expect(snapshots[1]!.pages).toHaveLength(2)
    expect(snapshots[0]!.totals.messageCount).toBe(2)
    expect(snapshots[1]!.loadedCount).toBe(3)
    expect(snapshots[1]!.totals).toEqual({
      messageCount: 3, excludedCount: 1, pinnedCount: 1, editedCount: 1,
      estimatedTokens: 17, estimatedTokensExcluded: 7,
    })
    expect(snapshots[1]!.entries.map((item) => item.messageID))
      .toEqual(["new-edited", "new-pinned", "old-excluded"])
  })

  test("merges successive chronological wire pages into newest-first UI order", async () => {
    const fetched: Array<string | undefined> = []
    const snapshots: string[][] = []
    const pager = createSessionContextLedgerPager({
      load: async (_, cursor) => {
        fetched.push(cursor)
        return cursor === undefined ? page(["4", "5"], "before5")
          : cursor === "before5" ? page(["2", "3"], "before3")
          : page(["1"])
      },
      currentSession: () => "session-a",
      receive: (state) => { if (state) snapshots.push(state.entries.map((e) => e.messageID)) },
      error: (error) => { throw error },
    })
    await pager.read("session-a")
    await pager.more()
    await pager.more()
    await pager.more()
    expect(fetched).toEqual([undefined, "before5", "before3"])
    expect(snapshots).toEqual([["5", "4"], ["5", "4", "3", "2"], ["5", "4", "3", "2", "1"]])
  })

  test("coalesces simultaneous reads, keeps older data on a failed continuation", async () => {
    const next = deferred<Page>()
    const errors: string[] = []
    let loads = 0
    let state: string[] = []
    const pager = createSessionContextLedgerPager({
      load: async (_, cursor) => {
        loads++
        return cursor ? next.promise : page(["3", "4"], "older")
      },
      currentSession: () => "a",
      receive: (s) => { state = s?.entries.map((e) => e.messageID) ?? [] },
      error: (error) => errors.push(String(error)),
    })
    const a = pager.read("a")
    const b = pager.read("a")
    expect(b).toBe(a)
    await a
    const c = pager.more()
    const d = pager.more()
    expect(c).toBe(d)
    await Promise.resolve()
    next.reject("network")
    await c
    expect(loads).toBe(2)
    expect(state).toEqual(["4", "3"])
    expect(errors).toEqual(["network"])
  })

  test("invalidate and A-B-A switches fence stale responses", async () => {
    const old = deferred<Page>()
    let session = "a"
    const emitted: string[][] = []
    let calls = 0
    const pager = createSessionContextLedgerPager({
      load: async () => (++calls === 1 ? old.promise : page(["9"])),
      currentSession: () => session,
      receive: (state) => emitted.push(state?.entries.map((e) => e.messageID) ?? []),
      error: (error) => { throw error },
    })
    const initial = pager.read("a")
    await Promise.resolve()
    session = "b"
    await pager.read("b")
    session = "a"
    await pager.read("a")
    old.resolve(page(["1"]))
    await initial
    expect(emitted.at(-1)).toEqual(["9"])
    expect(emitted.some((rows) => rows.includes("1"))).toBe(false)
  })

  test("rejects duplicate IDs and invalid cursors without corrupting accumulated rows", async () => {
    const errors: string[] = []
    let current: string[] = []
    const pager = createSessionContextLedgerPager({
      load: async (_, cursor) => cursor ? page(["2"]) : page(["2", "3"], "older"),
      currentSession: () => "a",
      receive: (state) => { current = state?.entries.map((e) => e.messageID) ?? [] },
      error: (error) => errors.push(String(error)),
    })
    await pager.read("a")
    await pager.more()
    expect(current).toEqual(["3", "2"])
    expect(errors[0]).toContain("duplicate")
  })

  test("a mutation refresh supersedes a prior unfinished page request", async () => {
    const old = deferred<Page>()
    const seen: string[][] = []
    let loads = 0
    const pager = createSessionContextLedgerPager({
      load: async () => ++loads === 1 ? old.promise : page(["new"]),
      currentSession: () => "a",
      receive: (state) => seen.push(state?.entries.map((e) => e.messageID) ?? []),
      error: (error) => { throw error },
    })
    const obsolete = pager.read("a")
    await Promise.resolve()
    await pager.read("a", true)
    old.resolve(page(["old"]))
    await obsolete
    expect(seen.at(-1)).toEqual(["new"])
    expect(seen.some((ids) => ids.includes("old"))).toBe(false)
  })

  test("revision-invalid cursors drop partial data and restart from the first page on retry", async () => {
    let calls = 0
    const errors: string[] = []
    let rows: string[] = []
    const pager = createSessionContextLedgerPager({
      load: async (_, cursor) => {
        calls++
        if (cursor) throw new Error("Context ledger changed during pagination")
        return calls === 1 ? page(["old"], "old-cursor") : page(["new"])
      },
      currentSession: () => "a",
      receive: (state) => { rows = state?.entries.map((entry) => entry.messageID) ?? [] },
      error: (reason) => errors.push(String(reason)),
    })
    await pager.read("a")
    expect(rows).toEqual(["old"])
    await pager.more()
    expect(rows).toEqual([])
    expect(errors).toHaveLength(1)
    await pager.read("a")
    expect(rows).toEqual(["new"])
    expect(calls).toBe(3)
  })
})
