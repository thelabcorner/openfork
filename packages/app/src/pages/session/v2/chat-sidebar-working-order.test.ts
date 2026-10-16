import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { createChatSidebarWorkingOrder } from "./chat-sidebar-working-order"

const row = (id: string) => ({ id } as Session)

describe("sidebar working arrival-order policy", () => {
  test("returns the identical array on a zero-working cold paint", () => {
    const order = createChatSidebarWorkingOrder()
    const rows = [row("a"), row("b"), row("c")]
    expect(order.pin(rows, new Set())).toBe(rows)
    expect(order.pin(rows, new Set(["outside"]))).toBe(rows)
  })

  test("arrival order persists across reordered source rows and resets after idle", () => {
    const order = createChatSidebarWorkingOrder()
    const rows = [row("a"), row("b"), row("c")]
    expect(order.pin(rows, new Set(["b"])).map((row) => row.id)).toEqual(["b", "a", "c"])
    expect(order.pin(rows, new Set(["a", "b"])).map((row) => row.id)).toEqual(["b", "a", "c"])
    expect(order.pin([...rows].reverse(), new Set(["a", "b"])).map((row) => row.id))
      .toEqual(["b", "a", "c"])
    order.prune(new Set(["a", "b", "c"]), new Set(["a"]))
    expect(order.pin(rows, new Set(["a", "b"])).map((row) => row.id)).toEqual(["a", "b", "c"])
    order.clear()
    expect(order.pin(rows, new Set(["a", "b"])).map((row) => row.id)).toEqual(["a", "b", "c"])
  })

  test("randomized differential against the previous stateful pin policy", () => {
    let seed = 0x37168
    const rand = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % max
    }
    const oldArrivals = new Map<string, number>()
    let oldSequence = 0
    const legacyPin = (rows: Session[], working: ReadonlySet<string>): Session[] => {
      const pinned: Array<{ seq: number; session: Session }> = []
      const rest: Session[] = []
      for (const session of rows) {
        if (!working.has(session.id)) {
          oldArrivals.delete(session.id)
          rest.push(session)
          continue
        }
        const known = oldArrivals.get(session.id)
        const seq = known ?? ++oldSequence
        if (known === undefined) oldArrivals.set(session.id, seq)
        pinned.push({ seq, session })
      }
      return [...pinned.sort((a, b) => a.seq - b.seq).map((entry) => entry.session), ...rest]
    }
    const order = createChatSidebarWorkingOrder()
    const all = Array.from({ length: 120 }, (_, i) => row(`s${i}`))
    for (let step = 0; step < 700; step++) {
      const rows = all.filter(() => rand(4) !== 0)
      const working = new Set(all.filter(() => rand(12) === 0).map((row) => row.id))
      const visible = new Set(all.filter(() => rand(25) !== 0).map((row) => row.id))
      for (const id of oldArrivals.keys()) {
        if (!visible.has(id) || !working.has(id)) oldArrivals.delete(id)
      }
      order.prune(visible, working)
      expect(order.pin(rows, working).map((row) => row.id))
        .toEqual(legacyPin(rows, working).map((row) => row.id))
    }
  })
})