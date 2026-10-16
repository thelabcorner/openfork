import { describe, expect, test } from "bun:test"
import { createCommandCatalogOwner } from "./command-catalog"

describe("command catalog owner", () => {
  test("shares one interactive load and commits once across picker and submit demand", async () => {
    let release!: (value: string[]) => void
    const gate = new Promise<string[]>((resolve) => (release = resolve))
    const loads: string[] = []
    const commits: Array<{ directory: string; commands: string[] }> = []
    const owner = createCommandCatalogOwner({
      load: async (directory) => {
        loads.push(directory)
        return gate
      },
      commit: (directory, commands) => commits.push({ directory, commands }),
    })

    const picker = owner.ensure("/workspace")
    const submit = owner.ensure("/workspace")
    expect(loads).toEqual(["/workspace"])
    release(["review"])
    await expect(Promise.all([picker, submit])).resolves.toEqual([["review"], ["review"]])
    expect(commits).toEqual([{ directory: "/workspace", commands: ["review"] }])
  })

  test("retries a failed load and ignores results invalidated during the request", async () => {
    let attempts = 0
    let release!: (value: string[]) => void
    const gate = new Promise<string[]>((resolve) => (release = resolve))
    const commits: string[][] = []
    let current = true
    const owner = createCommandCatalogOwner({
      load: async () => {
        attempts++
        if (attempts === 1) throw new Error("transient")
        return gate
      },
      commit: (_directory, commands) => commits.push(commands),
    })

    await expect(owner.ensure("/workspace")).rejects.toThrow("transient")
    const stale = owner.ensure("/workspace", () => current)
    owner.invalidate("/workspace")
    current = false
    release(["stale"])
    await expect(stale).resolves.toEqual([])
    expect(commits).toEqual([])
    await expect(owner.ensure("/workspace")).resolves.toEqual(["stale"])
    expect(attempts).toBe(3)
    expect(commits).toEqual([["stale"]])
  })

  test("does not commit after the selected target changes", async () => {
    let current = true
    const commits: string[][] = []
    const owner = createCommandCatalogOwner({
      load: async () => ["review"],
      commit: (_directory, commands) => commits.push(commands),
    })
    const pending = owner.ensure("/workspace", () => current)
    current = false
    await expect(pending).resolves.toEqual([])
    expect(commits).toEqual([])
  })

  test("retries an invalidated catalog while the selected target is still current", async () => {
    let release!: (value: string[]) => void
    const staleGate = new Promise<string[]>((resolve) => (release = resolve))
    let loads = 0
    const commits: string[][] = []
    const owner = createCommandCatalogOwner({
      load: async () => {
        loads++
        return loads === 1 ? staleGate : ["fresh"]
      },
      commit: (_directory, commands) => commits.push(commands),
    })
    const pending = owner.ensure("/workspace", () => true)
    owner.invalidate("/workspace")
    release(["stale"])
    await expect(pending).resolves.toEqual(["fresh"])
    expect(loads).toBe(2)
    expect(commits).toEqual([["fresh"]])
  })
})
