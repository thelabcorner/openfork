import { describe, expect, test } from "bun:test"
import { createLatestStateRequest } from "./latest-state-request"

function controlledScheduler() {
  const queue: Array<{
    run: () => Promise<void>
    signal: AbortSignal
    resolve: () => void
    reject: (error: unknown) => void
    onAbort: () => void
  }> = []
  return {
    queue,
    schedule(run: () => Promise<void>, input: { signal: AbortSignal }) {
      return new Promise<void>((resolve, reject) => {
        const entry = {
          run,
          signal: input.signal,
          resolve,
          reject,
          onAbort: () => {
            const index = queue.indexOf(entry)
            if (index < 0) return
            queue.splice(index, 1)
            reject(new DOMException("Aborted", "AbortError"))
          },
        }
        if (input.signal.aborted) {
          reject(new DOMException("Aborted", "AbortError"))
          return
        }
        input.signal.addEventListener("abort", entry.onAbort, { once: true })
        queue.push(entry)
      })
    },
    async runNext() {
      const entry = queue.shift()
      if (!entry) throw new Error("No scheduled request")
      entry.signal.removeEventListener("abort", entry.onAbort)
      try {
        await entry.run()
        entry.resolve()
      } catch (error) {
        entry.reject(error)
      }
      await Promise.resolve()
    },
  }
}

describe("createLatestStateRequest", () => {
  test("a queued request sends the newest desired value and is promoted", async () => {
    const scheduler = controlledScheduler()
    const sent: string[][] = []
    let promoted = 0
    const request = createLatestStateRequest<string[]>({
      kind: "interest",
      key: JSON.stringify,
      schedule: scheduler.schedule,
      promote: () => promoted++,
      send: async (sessions) => {
        sent.push(sessions)
        return { status: "updated" }
      },
    })

    request.setDesired(["old"])
    request.setReady(true)
    request.setDesired(["latest"])

    expect(scheduler.queue).toHaveLength(1)
    expect(promoted).toBe(1)
    await scheduler.runNext()
    await Promise.resolve()
    expect(sent).toEqual([["latest"]])
    expect(request.snapshot().acknowledgedKey).toBe('["latest"]')
    request.dispose()
  })

  test("aborts an active older update before sending the newest desired state", async () => {
    const scheduler = controlledScheduler()
    const sent: string[][] = []
    let releaseOld!: () => void
    const request = createLatestStateRequest<string[]>({
      kind: "interest",
      key: JSON.stringify,
      schedule: scheduler.schedule,
      promote: () => {},
      send: async (sessions, signal) => {
        sent.push(sessions)
        if (sessions[0] === "old")
          await new Promise<void>((resolve, reject) => {
            releaseOld = resolve
            signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
          })
        return { status: "updated" }
      },
    })

    request.setDesired(["old"])
    request.setReady(true)
    const first = scheduler.runNext()
    await Promise.resolve()
    request.setDesired(["new"])
    expect(sent).toEqual([["old"]])
    expect(scheduler.queue).toHaveLength(0)

    await first
    await Promise.resolve()
    expect(scheduler.queue).toHaveLength(1)
    await scheduler.runNext()
    await Promise.resolve()
    expect(sent).toEqual([["old"], ["new"]])
    expect(request.snapshot().acknowledgedKey).toBe('["new"]')
    releaseOld()
    request.dispose()
  })

  test("cancels an unstarted queued request when its stream is no longer ready", async () => {
    const scheduler = controlledScheduler()
    const sent: string[][] = []
    const request = createLatestStateRequest<string[]>({
      kind: "interest",
      key: JSON.stringify,
      schedule: scheduler.schedule,
      promote: () => {},
      send: async (sessions) => {
        sent.push(sessions)
        return { status: "updated" }
      },
    })

    request.setDesired(["visible"])
    request.setReady(true)
    request.setReady(false)
    await Promise.resolve()
    expect(scheduler.queue).toHaveLength(0)
    expect(sent).toEqual([])
    request.dispose()
  })

  test("rebases a superseded generation once and sends the latest desired value", async () => {
    const scheduler = controlledScheduler()
    const sent: Array<{ generation: number; sessions: string[] }> = []
    const request = createLatestStateRequest<{ generation: number; sessions: string[] }>({
      kind: "interest",
      key: (value) => `${value.generation}:${JSON.stringify(value.sessions)}`,
      schedule: scheduler.schedule,
      promote: () => {},
      rebase: (value, serverGeneration) => {
        const generation = Math.max(value.generation, serverGeneration) + 1
        return Number.isSafeInteger(generation) ? { ...value, generation } : undefined
      },
      send: async (value) => {
        sent.push(value)
        return sent.length === 1 ? { status: "superseded", generation: 3 } : { status: "updated" }
      },
    })

    request.setDesired({ generation: 1, sessions: ["latest"] })
    request.setReady(true)
    await scheduler.runNext()
    await Promise.resolve()
    expect(scheduler.queue).toHaveLength(1)
    await scheduler.runNext()
    await Promise.resolve()
    expect(sent).toEqual([
      { generation: 1, sessions: ["latest"] },
      { generation: 4, sessions: ["latest"] },
    ])
    expect(request.snapshot().acknowledgedKey).toBe('4:["latest"]')
    expect(scheduler.queue).toHaveLength(0)
    request.dispose()
  })

  test("does not let a stale deferred response suppress the newest desired request", async () => {
    const scheduler = controlledScheduler()
    const sent: string[][] = []
    let release!: (result: { status: "deferred" }) => void
    const request = createLatestStateRequest<string[]>({
      kind: "interest",
      key: JSON.stringify,
      schedule: scheduler.schedule,
      promote: () => {},
      send: async (sessions) => {
        sent.push(sessions)
        if (sessions[0] === "old") return await new Promise((resolve) => (release = resolve))
        return { status: "updated" }
      },
    })

    request.setDesired(["old"])
    request.setReady(true)
    const first = scheduler.runNext()
    await Promise.resolve()
    request.setDesired(["latest"])
    release({ status: "deferred" })
    await first
    await Promise.resolve()
    expect(scheduler.queue).toHaveLength(1)
    await scheduler.runNext()
    await Promise.resolve()
    expect(sent).toEqual([["old"], ["latest"]])
    expect(request.snapshot().acknowledgedKey).toBe('["latest"]')
    request.dispose()
  })

  test("blocks safely when the server generation cannot be incremented", async () => {
    const scheduler = controlledScheduler()
    const request = createLatestStateRequest<{ generation: number }>({
      kind: "interest",
      key: (value) => String(value.generation),
      schedule: scheduler.schedule,
      promote: () => {},
      rebase: () => undefined,
      send: async () => ({ status: "superseded", generation: Number.MAX_SAFE_INTEGER }),
    })

    request.setDesired({ generation: 1 })
    request.setReady(true)
    await scheduler.runNext()
    await Promise.resolve()
    expect(request.snapshot().blocked).toBe("server generation cannot be safely rebased")
    expect(scheduler.queue).toHaveLength(0)
    request.setDesired({ generation: 2 })
    expect(scheduler.queue).toHaveLength(0)
    request.dispose()
  })
})
