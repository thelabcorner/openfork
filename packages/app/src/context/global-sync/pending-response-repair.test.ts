import { describe, expect, test } from "bun:test"
import { createPendingResponseRepairOwner } from "./pending-response-repair"
import { reconcilePendingBySession } from "./pending-response-snapshot"

const flush = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve()
}

describe("pending response invalidation owner", () => {
  test.each([1, 3, 6])("repairs loaded directory snapshots after invalidation for %i directories", async (count) => {
    const directories = Array.from({ length: count }, (_, index) => `/project/${index}`)
    const loaded = new Set(directories)
    const state = new Map(
      directories.map((directory) => [directory, {
        permission: { [`${directory}:old`]: [{ sessionID: `${directory}:old`, id: "p-stale" }] },
        question: { [`${directory}:old`]: [{ sessionID: `${directory}:old`, id: "q-stale" }] },
      }]),
    )
    const calls: string[] = []
    const requestCounts = { permission: 0, question: 0 }
    const owner = createPendingResponseRepairOwner({
      directories: () => directories,
      active: (directory) => loaded.has(directory),
      repair: async (directory) => {
        calls.push(directory)
        // Fake the same two authoritative list requests issued by ServerSync.
        const sdk = {
          permission: { list: async () => { requestCounts.permission++; return { data: [{ sessionID: `${directory}:session`, id: "p-current" }] } } },
          question: { list: async () => { requestCounts.question++; return { data: [{ sessionID: `${directory}:session`, id: "q-current" }] } } },
        }
        const [permission, question] = await Promise.all([sdk.permission.list(), sdk.question.list()])
        const previous = state.get(directory)!
        state.set(directory, {
          permission: reconcilePendingBySession(previous.permission, permission.data),
          question: reconcilePendingBySession(previous.question, question.data),
        })
      },
    })

    // Loaded children do not depend on tabs; each directory gets one bounded repair.
    for (const directory of directories) {
      owner.invalidate(directory, false)
    }
    await owner.whenIdle()

    expect(calls).toHaveLength(count)
    for (const directory of directories) {
      expect(state.get(directory)).toEqual({
        permission: { [`${directory}:old`]: [], [`${directory}:session`]: [{ sessionID: `${directory}:session`, id: "p-current" }] },
        question: { [`${directory}:old`]: [], [`${directory}:session`]: [{ sessionID: `${directory}:session`, id: "q-current" }] },
      })
    }
    expect(requestCounts).toEqual({ permission: count, question: count })
    owner.dispose()
  })

  test("global invalidation is bounded to loaded directories and disposal drops queued work", async () => {
    const directories = Array.from({ length: 6 }, (_, index) => `/project/${index}`)
    const loaded = new Set(directories)
    const started = deferred<void>()
    const release = deferred<void>()
    const calls: string[] = []
    const owner = createPendingResponseRepairOwner({
      directories: () => directories,
      active: (directory) => loaded.has(directory),
      repair: async (directory) => {
        calls.push(directory)
        if (calls.length === 1) {
          started.resolve()
          await release.promise
        }
      },
    })
    owner.invalidate("", true)
    await started.promise
    owner.invalidate("/project/5", false)
    owner.dispose()
    release.resolve()
    await flush()
    expect(calls).toEqual(["/project/0"])
    await owner.whenIdle()
  })

  test("retries a failed snapshot without new input while other directories keep progressing", async () => {
    const directories = Array.from({ length: 6 }, (_, index) => `/project/${index}`)
    const attempts = new Map<string, number>()
    const otherDirectoriesDone = deferred<void>()
    let completedOthers = 0
    const owner = createPendingResponseRepairOwner({
      directories: () => directories,
      active: () => true,
      repair: async (directory) => {
        const attempt = (attempts.get(directory) ?? 0) + 1
        attempts.set(directory, attempt)
        if (directory === directories[0] && attempt === 1) throw new Error("temporary 503")
        if (directory !== directories[0] && ++completedOthers === directories.length - 1) otherDirectoriesDone.resolve()
      },
    })
    owner.invalidate("", true)
    const firstWaiter = owner.whenIdle()
    const secondWaiter = owner.whenIdle()
    await otherDirectoriesDone.promise
    expect(attempts.get(directories[0])).toBe(1)
    await Promise.all([firstWaiter, secondWaiter])
    expect(attempts.get(directories[0])).toBe(2)
    expect(completedOthers).toBe(directories.length - 1)
    owner.dispose()
  })

  test("teardown cancels the capped-backoff retry timer", async () => {
    let attempts = 0
    const owner = createPendingResponseRepairOwner({
      directories: () => ["/project"],
      active: () => true,
      repair: async () => {
        attempts++
        throw new Error("temporary 503")
      },
    })
    owner.invalidate("/project", false)
    await flush()
    expect(attempts).toBe(1)
    owner.dispose()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(attempts).toBe(1)
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => (resolve = next))
  return { promise, resolve }
}
