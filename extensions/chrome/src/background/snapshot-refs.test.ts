import { describe, expect, test } from "bun:test"
import { SnapshotRefRegistry, type StorageAreaLike } from "./snapshot-refs"

const memoryStorage = (): StorageAreaLike & { values: Record<string, unknown> } => {
  const values: Record<string, unknown> = {}
  return {
    values,
    async get(key) { return { [key]: values[key] } },
    async set(items) { Object.assign(values, items) },
    async remove(key) { delete values[key] },
  }
}

describe("SnapshotRefRegistry", () => {
  test("persists versioned refs across service-worker registry instances", async () => {
    const storage = memoryStorage()
    const first = new SnapshotRefRegistry(storage, () => 100)
    const state = await first.replace(7, [{
      ref: "e1",
      center: { x: 12.4, y: 18.6 },
      selector: { value: "#save" },
      locator: { type: "css", value: "#save" },
    }])
    expect(state.refs.e1).toEqual({ x: 12, y: 19, selector: "#save", locator: { type: "css", value: "#save" } })

    const restarted = new SnapshotRefRegistry(storage, () => 1)
    expect(await restarted.get(7)).toEqual(state)
  })

  test("every replacement advances the version even inside one millisecond", async () => {
    const registry = new SnapshotRefRegistry(undefined, () => 42)
    const a = await registry.replace(1, [{ ref: "e1", center: { x: 1, y: 1 }, selector: { value: "#a" } }])
    const b = await registry.replace(1, [{ ref: "e1", center: { x: 2, y: 2 }, selector: { value: "#b" } }])
    expect(b.version).toBeGreaterThan(a.version)
    expect(b.refs.e1.selector).toBe("#b")
  })

  test("clear removes both cache and session persistence", async () => {
    const storage = memoryStorage()
    const registry = new SnapshotRefRegistry(storage, () => 100)
    await registry.replace(3, [{ ref: "e1", center: { x: 1, y: 2 }, selector: { value: "button" } }])
    await registry.clear(3)
    expect(await new SnapshotRefRegistry(storage).get(3)).toBeUndefined()
  })
})
