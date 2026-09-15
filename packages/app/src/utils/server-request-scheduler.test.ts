import { describe, expect, test } from "bun:test"
import { createServerRequestScheduler } from "./server-request-scheduler"

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => (resolve = next))
  return { promise, resolve }
}

describe("createServerRequestScheduler", () => {
  test("reserves capacity by capping background concurrency", async () => {
    const scheduler = createServerRequestScheduler({ concurrency: 4, backgroundConcurrency: 2 })
    const a = deferred<void>()
    const b = deferred<void>()
    const c = deferred<void>()
    const runs: string[] = []

    const first = scheduler.schedule("background", async () => {
      runs.push("bg-a")
      await a.promise
    })
    const second = scheduler.schedule("background", async () => {
      runs.push("bg-b")
      await b.promise
    })
    const third = scheduler.schedule("background", async () => {
      runs.push("bg-c")
      await c.promise
    })
    await Promise.resolve()
    expect(runs).toEqual(["bg-a", "bg-b"])
    expect(scheduler.snapshot().queuedBackground).toBe(1)

    const interactive = scheduler.schedule("interactive", async () => runs.push("interactive"))
    await interactive
    expect(runs).toEqual(["bg-a", "bg-b", "interactive"])

    a.resolve()
    await first
    await Promise.resolve()
    await Promise.resolve()
    expect(runs).toContain("bg-c")
    b.resolve()
    c.resolve()
    await Promise.all([second, third])
  })

  test("throttles speculative background work while foreground work is active", async () => {
    const scheduler = createServerRequestScheduler({ concurrency: 5, backgroundConcurrency: 2 })
    let releaseInteractive!: () => void
    const interactiveBarrier = new Promise<void>((resolve) => (releaseInteractive = resolve))
    let releaseBackground!: () => void
    const backgroundBarrier = new Promise<void>((resolve) => (releaseBackground = resolve))
    let activeBackground = 0
    let peakBackground = 0

    const interactive = scheduler.schedule("interactive", () => interactiveBarrier, { kind: "foreground" })
    const background = Array.from({ length: 3 }, (_, index) =>
      scheduler.schedule(
        "background",
        async () => {
          activeBackground += 1
          peakBackground = Math.max(peakBackground, activeBackground)
          await backgroundBarrier
          activeBackground -= 1
        },
        { kind: `background-${index}` },
      ),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(peakBackground).toBe(1)
    expect(scheduler.snapshot().activeInteractive).toBe(1)
    expect(scheduler.snapshot().activeBackground).toBe(1)

    releaseInteractive()
    await interactive
    await Promise.resolve()
    await Promise.resolve()
    expect(scheduler.snapshot().activeBackground).toBe(2)

    releaseBackground()
    await Promise.all(background)
  })

  test("queued critical work jumps ahead of queued background work", async () => {
    const scheduler = createServerRequestScheduler({ concurrency: 1, backgroundConcurrency: 1 })
    const hold = deferred<void>()
    const order: string[] = []
    const running = scheduler.schedule("background", async () => {
      order.push("running")
      await hold.promise
    })
    const background = scheduler.schedule("background", async () => order.push("background"))
    const critical = scheduler.schedule("critical", async () => order.push("critical"))

    hold.resolve()
    await Promise.all([running, background, critical])
    expect(order).toEqual(["running", "critical", "background"])
  })

  test("keeps one transport slot reserved for late critical work", async () => {
    const scheduler = createServerRequestScheduler({ concurrency: 5, backgroundConcurrency: 2, criticalReserve: 1 })
    const holds = Array.from({ length: 4 }, () => deferred<void>())
    const runs: string[] = []

    const interactive = holds.map((hold, index) =>
      scheduler.schedule("interactive", async () => {
        runs.push(`interactive-${index}`)
        await hold.promise
      }),
    )
    const queued = scheduler.schedule("interactive", async () => runs.push("interactive-queued"))
    await Promise.resolve()
    expect(scheduler.snapshot().active).toBe(4)
    expect(scheduler.snapshot().queuedInteractive).toBe(1)

    const critical = scheduler.schedule("critical", async () => runs.push("critical"))
    await critical
    expect(runs.at(-1)).toBe("critical")
    expect(scheduler.snapshot().queuedInteractive).toBe(1)

    holds.forEach((hold) => hold.resolve())
    await Promise.all([...interactive, queued])
  })

  test("promotes keyed queued work when it becomes foreground", async () => {
    const scheduler = createServerRequestScheduler({ concurrency: 1, backgroundConcurrency: 1 })
    const hold = deferred<void>()
    const order: string[] = []
    const running = scheduler.schedule("interactive", () => hold.promise)
    const promoted = scheduler.schedule("background", async () => order.push("promoted"), { key: "session:1" })
    const other = scheduler.schedule("interactive", async () => order.push("other"))
    expect(scheduler.promote("session:1", "critical")).toBe(true)
    hold.resolve()
    await Promise.all([running, promoted, other])
    expect(order).toEqual(["promoted", "other"])
  })

  test("promotes every queued request in the same keyed lane", async () => {
    const scheduler = createServerRequestScheduler({ concurrency: 1, backgroundConcurrency: 1 })
    const hold = deferred<void>()
    const order: string[] = []
    const running = scheduler.schedule("interactive", () => hold.promise)
    const first = scheduler.schedule("background", async () => order.push("session-a"), { key: "session:1" })
    const second = scheduler.schedule("background", async () => order.push("session-b"), { key: "session:1" })
    const other = scheduler.schedule("interactive", async () => order.push("other"))

    expect(scheduler.promote("session:1", "critical")).toBe(true)
    hold.resolve()
    await Promise.all([running, first, second, other])
    expect(order).toEqual(["session-a", "session-b", "other"])
  })

  test("aborted queued work never consumes a slot", async () => {
    const scheduler = createServerRequestScheduler({ concurrency: 1, backgroundConcurrency: 1 })
    const hold = deferred<void>()
    const running = scheduler.schedule("interactive", () => hold.promise)
    const controller = new AbortController()
    let ran = false
    const queued = scheduler.schedule(
      "background",
      async () => {
        ran = true
      },
      { signal: controller.signal },
    )
    controller.abort()
    await expect(queued).rejects.toMatchObject({ name: "AbortError" })
    hold.resolve()
    await running
    expect(ran).toBe(false)
  })

  test("assimilates synchronous task results and synchronous throws", async () => {
    const scheduler = createServerRequestScheduler({ concurrency: 2, backgroundConcurrency: 1 })
    await expect(scheduler.schedule("interactive", () => 42 as never)).resolves.toBe(42)
    await expect(
      scheduler.schedule("interactive", () => {
        throw new Error("sync failure")
      }),
    ).rejects.toThrow("sync failure")
    expect(scheduler.snapshot().active).toBe(0)
  })

  test("separates queue wait from service time by request kind", async () => {
    let clock = 0
    const scheduler = createServerRequestScheduler({
      concurrency: 1,
      backgroundConcurrency: 1,
      now: () => clock,
    })
    const hold = deferred<void>()

    const first = scheduler.schedule(
      "interactive",
      async () => {
        clock = 7
        await hold.promise
        clock = 17
      },
      { kind: "file-tree" },
    )
    // The second request is enqueued at t=7 while the first owns the only slot.
    await Promise.resolve()
    const second = scheduler.schedule(
      "critical",
      async () => {
        clock = 23
      },
      { kind: "session-list" },
    )
    clock = 12
    hold.resolve()
    await first
    await second

    const snap = scheduler.snapshot()
    expect(snap.waitByKind["file-tree"]).toEqual({ count: 1, totalMs: 0, maxMs: 0 })
    expect(snap.serviceByKind["file-tree"]).toEqual({ count: 1, totalMs: 17, maxMs: 17 })
    expect(snap.waitByKind["session-list"]).toEqual({ count: 1, totalMs: 10, maxMs: 10 })
    expect(snap.serviceByKind["session-list"]).toEqual({ count: 1, totalMs: 6, maxMs: 6 })
    expect(snap.serviceTotal).toEqual({ critical: 6, interactive: 17, background: 0 })
    expect(snap.maxQueuedByKind["session-list"]).toBe(1)
  })

  test("detaches queue abort listeners immediately after admission", async () => {
    const scheduler = createServerRequestScheduler({ concurrency: 1, backgroundConcurrency: 1 })
    const hold = deferred<void>()
    const running = scheduler.schedule("interactive", () => hold.promise)
    const listeners = new Set<EventListenerOrEventListenerObject>()
    const signal = {
      aborted: false,
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => listeners.add(listener),
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => listeners.delete(listener),
    } as unknown as AbortSignal

    const queued = scheduler.schedule("background", async () => undefined, { signal, kind: "file-tree" })
    expect(listeners.size).toBe(1)
    hold.resolve()
    await running
    await queued
    expect(listeners.size).toBe(0)
  })

  test("protects a foreground session from a mixed session and filesystem herd", async () => {
    const scheduler = createServerRequestScheduler({ concurrency: 5, backgroundConcurrency: 2, criticalReserve: 1 })
    const holds = Array.from({ length: 4 }, () => deferred<void>())
    const starters: Array<Promise<unknown>> = [
      scheduler.schedule("background", () => holds[0]!.promise, { kind: "session-list" }),
      scheduler.schedule("background", () => holds[1]!.promise, { kind: "file-tree" }),
      scheduler.schedule("interactive", () => holds[2]!.promise, { kind: "file-read" }),
      scheduler.schedule("interactive", () => holds[3]!.promise, { kind: "session-info" }),
    ]

    const herd = Array.from({ length: 64 }, (_, index) =>
      scheduler.schedule("background", async () => index, {
        kind: index % 2 === 0 ? "session-list" : "file-tree",
        key: `${index % 2 === 0 ? "session-list" : "file-tree"}:${index}`,
      }),
    )
    await Promise.resolve()
    const before = scheduler.snapshot()
    expect(before.active).toBe(4)
    expect(before.activeBackground).toBe(2)
    expect(before.queuedBackground).toBe(64)

    let criticalStarted = false
    await scheduler.schedule(
      "critical",
      async () => {
        criticalStarted = true
      },
      { kind: "session-messages", key: "session:foreground" },
    )
    expect(criticalStarted).toBe(true)
    // The foreground request completed without releasing any of the four held
    // noncritical requests: the reserve is real capacity, not queue ordering.
    await Promise.resolve()
    expect(scheduler.snapshot().active).toBe(4)

    holds.forEach((hold) => hold.resolve())
    await Promise.all([...starters, ...herd])
    const after = scheduler.snapshot()
    expect(after.maxActive).toBe(5)
    expect(after.maxActiveBackground).toBe(2)
    expect(after.queuedBackground).toBe(0)
    expect(after.completedByKind["session-messages"]).toBe(1)
    expect(after.completedByKind["session-list"]).toBe(33)
    expect(after.completedByKind["file-tree"]).toBe(33)
  })
})
