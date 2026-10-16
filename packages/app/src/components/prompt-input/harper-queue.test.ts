import { describe, expect, test } from "bun:test"
import { HarperLatestQueue } from "./harper-queue"

function controlled() {
  const jobs: { input: string; finish: (value: string) => void; fail: (error: Error) => void }[] = []
  const queue = new HarperLatestQueue<string, string>((input) =>
    new Promise<string>((resolve, reject) => jobs.push({ input, finish: resolve, fail: reject })), 3)
  return { queue, jobs }
}
const cancelled = (work: Promise<string>) => work.then(
  () => "completed",
  (error: Error) => error.name,
)
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

describe("shared local grammar worker latest-only scheduling", () => {
  test("never dispatches intermediate drafts from one composer while worker is active", async () => {
    const { queue, jobs } = controlled()
    const a = Symbol("a")
    const first = cancelled(queue.run(a, "first"))
    await flush()
    expect(jobs.map((job) => job.input)).toEqual(["first"])
    const second = cancelled(queue.run(a, "second"))
    const third = cancelled(queue.run(a, "third"))
    const last = queue.run(a, "latest")
    expect(queue.stats).toEqual({ active: 1, pending: 1 })
    expect(await first).toBe("AbortError")
    expect(await second).toBe("AbortError")
    expect(await third).toBe("AbortError")
    jobs[0].finish("obsolete")
    await flush()
    expect(jobs.map((job) => job.input)).toEqual(["first", "latest"])
    jobs[1].finish("latest-feedback")
    expect(await last).toBe("latest-feedback")
    await flush()
    expect(queue.stats).toEqual({ active: 0, pending: 0 })
  })

  test("different session owners retain FIFO fairness while edits coalesce", async () => {
    const { queue, jobs } = controlled()
    const a = Symbol("a"), b = Symbol("b"), c = Symbol("c")
    const a1 = cancelled(queue.run(a, "a1"))
    await flush()
    const b1 = cancelled(queue.run(b, "b1"))
    const c1 = queue.run(c, "c1")
    const b2 = queue.run(b, "b2")
    expect(await b1).toBe("AbortError")
    jobs[0].finish("a1")
    await flush()
    expect(await a1).toBe("completed")
    // Replacement of B goes after C; B cannot starve C.
    expect(jobs.map((job) => job.input)).toEqual(["a1", "c1"])
    jobs[1].finish("c1")
    await flush()
    expect(await c1).toBe("c1")
    expect(jobs.map((job) => job.input)).toEqual(["a1", "c1", "b2"])
    jobs[2].finish("b2")
    expect(await b2).toBe("b2")
  })

  test("hard queue cap drops oldest pending work rather than growing without bound", async () => {
    const { queue, jobs } = controlled()
    const owner = Symbol("active")
    const running = queue.run(owner, "running")
    await flush()
    const s = [Symbol(), Symbol(), Symbol(), Symbol()]
    const oldest = cancelled(queue.run(s[0], "1"))
    const other = [queue.run(s[1], "2"), queue.run(s[2], "3"), queue.run(s[3], "4")]
    expect(queue.stats).toEqual({ active: 1, pending: 3 })
    expect(await oldest).toBe("AbortError")
    jobs[0].finish("running")
    await running
    for (let i = 0; i < 3; i++) {
      await flush()
      expect(jobs[i + 1].input).toBe(String(i + 2))
      jobs[i + 1].finish(String(i + 2))
      expect(await other[i]).toBe(String(i + 2))
    }
  })

  test("abort promptly cancels waiting and active callers, never dispatches cancelled input", async () => {
    const { queue, jobs } = controlled()
    const a = Symbol("a"), b = Symbol("b"), c = Symbol("c")
    const active = new AbortController()
    const waiting = new AbortController()
    const running = cancelled(queue.run(a, "active", active.signal))
    await flush()
    const pending = cancelled(queue.run(b, "do-not-run", waiting.signal))
    const next = queue.run(c, "fresh")
    active.abort()
    waiting.abort()
    expect(await running).toBe("AbortError")
    expect(await pending).toBe("AbortError")
    expect(queue.stats).toEqual({ active: 1, pending: 1 })
    jobs[0].finish("wasted")
    await flush()
    expect(jobs.map((job) => job.input)).toEqual(["active", "fresh"])
    jobs[1].finish("done")
    expect(await next).toBe("done")
  })

  test("disposing cancels all owners immediately, including work waiting on WASM", async () => {
    const { queue, jobs } = controlled()
    const first = cancelled(queue.run(Symbol("one"), "in-flight"))
    await flush()
    const second = cancelled(queue.run(Symbol("two"), "queued"))
    queue.dispose()
    expect(await first).toBe("AbortError")
    expect(await second).toBe("AbortError")
    jobs[0].finish("after-dispose")
    await flush()
    expect(jobs.map((job) => job.input)).toEqual(["in-flight"])
    expect(queue.stats.pending).toBe(0)
    expect(await cancelled(queue.run(Symbol("three"), "never"))).toBe("AbortError")
  })

  test("execution failure does not poison other owners or violate the single-flight budget", async () => {
    const { queue, jobs } = controlled()
    const a = cancelled(queue.run(Symbol(), "failing"))
    await flush()
    const b = queue.run(Symbol(), "recover")
    jobs[0].fail(new Error("injected failure"))
    expect(await a).toBe("Error")
    await flush()
    expect(jobs.map((job) => job.input)).toEqual(["failing", "recover"])
    jobs[1].finish("recovered")
    expect(await b).toBe("recovered")
  })

  test("1,000 rapid revisions submit just the first physical job and the final one", async () => {
    const { queue, jobs } = controlled()
    const owner = Symbol("rapid-composer")
    const first = cancelled(queue.run(owner, "original"))
    await flush()
    const outdated: Promise<string>[] = []
    for (let i = 0; i < 1_000; i++) {
      outdated.push(cancelled(queue.run(owner, "revision-" + i)))
      expect(queue.stats).toEqual({ active: 1, pending: 1 })
    }
    expect(await first).toBe("AbortError")
    expect((await Promise.all(outdated.slice(0, -1))).every((result) => result === "AbortError")).toBe(true)
    expect(jobs.map((job) => job.input)).toEqual(["original"])
    jobs[0].finish("old")
    await flush()
    expect(jobs.map((job) => job.input)).toEqual(["original", "revision-999"])
    jobs[1].finish("new")
    expect(await outdated[outdated.length - 1]).toBe("completed")
    expect(queue.stats.pending).toBe(0)
  })

  test("already-aborted calls and invalid capacity are rejected safely", async () => {
    expect(() => new HarperLatestQueue(async (x: string) => x, 0)).toThrow()
    const { queue } = controlled()
    const controller = new AbortController()
    controller.abort()
    expect(await cancelled(queue.run(Symbol(), "never", controller.signal))).toBe("AbortError")
    expect(queue.stats).toEqual({ active: 0, pending: 0 })
  })
})
