import { describe, expect, test } from "bun:test"
import { createRefreshQueue } from "./queue"
import { directoryKey } from "./utils"

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

describe("createRefreshQueue", () => {
  test("disposal during a refresh prevents queued and future requests", async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const calls: string[] = []
    const queue = createRefreshQueue({
      paused: () => false,
      bootstrap: () => pending,
      bootstrapInstance: (dir) => {
        calls.push(dir)
      },
    })
    queue.refresh()
    queue.push("before")
    await tick()
    queue.dispose()
    queue.push("after")
    queue.refresh()
    release()
    await tick()
    await tick()
    expect(calls).toEqual([])
  })

  test("a rejected request does not let another batch overlap its sibling", async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const calls: string[] = []
    const queue = createRefreshQueue({
      paused: () => false,
      bootstrap: async () => {},
      bootstrapInstance: (dir) => {
        calls.push(dir)
        if (dir === "fail") throw new Error("expected refresh failure")
        if (dir === "slow") return pending
      },
    })
    queue.push("fail")
    queue.push("slow")
    queue.push("next")
    await tick()
    await tick()
    expect(calls).toEqual(["fail", "slow"])
    release()
    await tick()
    await tick()
    expect(calls).toEqual(["fail", "slow", "next"])
    queue.dispose()
  })

  test("clears queued directories by normalized key", async () => {
    const calls: string[] = []
    const queue = createRefreshQueue({
      paused: () => false,
      key: directoryKey,
      bootstrap: async () => {},
      bootstrapInstance: (directory) => {
        calls.push(directory)
      },
    })

    queue.push("C:\\tmp\\demo")
    queue.clear("C:/tmp/demo")

    await tick()

    expect(calls).toEqual([])
    queue.dispose()
  })

  test("passes the original directory to bootstrapInstance", async () => {
    const calls: string[] = []
    const queue = createRefreshQueue({
      paused: () => false,
      key: directoryKey,
      bootstrap: async () => {},
      bootstrapInstance: (directory) => {
        calls.push(directory)
      },
    })

    queue.push("C:\\tmp\\demo")

    await tick()

    expect(calls).toEqual(["C:\\tmp\\demo"])
    queue.dispose()
  })
})
