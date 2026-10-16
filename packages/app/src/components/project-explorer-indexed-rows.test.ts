import { describe, expect, test } from "bun:test"
import { IndexedRowSequence } from "./project-explorer-indexed-rows"

type Row = { node: { path: string }; value: number }
const row = (id: number): Row => ({ node: { path: `path-${id}` }, value: id })
const ids = (rows: readonly Row[]) => rows.map((item) => item.value)

describe("IndexedRowSequence", () => {
  test("empty, invalid coordinates, duplicate safety, metadata and unchanged identity", () => {
    const sequence = new IndexedRowSequence<Row>()
    expect(sequence.length).toBe(0)
    expect(sequence.get(0)).toBeUndefined()
    expect(sequence.indexOf("unknown")).toBe(-1)
    expect(() => sequence.splice(-1, 0)).toThrow()
    sequence.splice(0, 0, [row(1), row(2), row(3)])
    expect(ids(sequence.toArray())).toEqual([1, 2, 3])
    expect(sequence.indexOf("path-1")).toBe(0)
    expect(sequence.indexOf("path-3")).toBe(2)
    expect(() => sequence.splice(0, 1, [row(3)])).toThrow()
    expect(() => sequence.splice(3, 0, [row(2)])).toThrow()
    expect(() => sequence.splice(0, 0, [row(5), row(5)])).toThrow()
    const oldRevision = sequence.version
    const oldKeysVersion = sequence.keysVersion
    sequence.splice(1, 1, [row(4)])
    expect(sequence.version).toBe(oldRevision + 1)
    expect(sequence.keysVersion).toBeGreaterThan(oldKeysVersion)
    expect(ids(sequence.toArray())).toEqual([1, 4, 3])
    expect(sequence.row("path-4")?.value).toBe(4)
    expect(sequence.row("path-2")).toBeUndefined()
    expect(sequence.get(2)?.value).toBe(3)
    const previousKeyVersion = sequence.keysVersion
    const previousChunkCount = sequence.chunkCount
    sequence.splice(1, 1, [{ node: { path: "path-4" }, value: 4_004 }])
    expect(sequence.keysVersion).toBe(previousKeyVersion)
    expect(sequence.chunkCount).toBe(previousChunkCount)
    expect(sequence.row("path-4")?.value).toBe(4_004)
    expect(sequence.get(0)).toBe(sequence.toArray()[0]!)
    sequence.splice(0, 3)
    expect(sequence.toArray()).toEqual([])
    expect(sequence.length).toBe(0)
    expect(sequence.indexOf("path-1")).toBe(-1)
  })

  test("50k indexed reads agree with dense array even after edits crossing chunk boundaries", () => {
    const reference = Array.from({ length: 50_000 }, (_, id) => row(id))
    const sequence = new IndexedRowSequence(reference)
    expect(sequence.length).toBe(50_000)
    expect(sequence.maxDepth()).toBeLessThan(60)
    for (let position = 0; position < reference.length; position += 37) {
      expect(sequence.get(position)).toBe(reference[position])
      expect(sequence.indexOf(reference[position]!.node.path)).toBe(position)
    }
    const inserted = Array.from({ length: 400 }, (_, i) => row(60_000 + i))
    reference.splice(31_999, 259, ...inserted)
    sequence.splice(31_999, 259, inserted)
    expect(sequence.length).toBe(reference.length)
    expect(sequence.toArray()).toEqual(reference)
    for (let position = 0; position < reference.length; position += 31) {
      expect(sequence.get(position)).toBe(reference[position])
      expect(sequence.indexOf(reference[position]!.node.path)).toBe(position)
    }
  })

  test("5k deterministic splices, inserts, deletes and moves retain reference parity", () => {
    let seed = 0x79a17
    const random = (max: number) => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return (seed >>> 0) % max
    }
    let nextID = 1_000
    const reference: Row[] = Array.from({ length: 900 }, (_, i) => row(i))
    const sequence = new IndexedRowSequence(reference)
    for (let step = 0; step < 5_000; step++) {
      const position = random(reference.length + 1)
      const available = reference.length - position
      const remove = random(Math.min(available, 40) + 1)
      const addCount = random(35)
      const inserted = Array.from({ length: addCount }, () => row(nextID++))
      reference.splice(position, remove, ...inserted)
      sequence.splice(position, remove, inserted)
      expect(sequence.length).toBe(reference.length)
      if (step % 47 !== 0) {
        const target = random(reference.length)
        expect(sequence.get(target)).toBe(reference[target])
        expect(sequence.indexOf(reference[target]!.node.path)).toBe(target)
        continue
      }
      expect(ids(sequence.toArray())).toEqual(ids(reference))
      for (let index = 0; index < reference.length; index += 79) {
        expect(sequence.get(index)).toBe(reference[index])
        expect(sequence.indexOf(reference[index]!.node.path)).toBe(index)
      }
    }
    expect(sequence.toArray()).toEqual(reference)
    expect(sequence.maxDepth()).toBeLessThan(75)
  })

  test("long-lived 50k row index retains compact chunk bounds under 5k adversarial edits", () => {
    let seed = 1234567
    const random = (max: number) => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return (seed >>> 0) % max
    }
    let nextID = 50_000
    const reference = Array.from({ length: 50_000 }, (_, i) => row(i))
    const sequence = new IndexedRowSequence(reference)
    for (let i = 0; i < 5_000; i++) {
      const position = random(reference.length)
      const removal = Math.min(random(5), reference.length - position)
      const added = Array.from({ length: random(5) }, () => row(nextID++))
      reference.splice(position, removal, ...added)
      sequence.splice(position, removal, added)
      if (i % 103 === 0) {
        expect(sequence.length).toBe(reference.length)
        expect(sequence.chunkCount).toBeLessThanOrEqual(Math.max(128, Math.ceil(sequence.length / 128) * 3))
        const inspect = random(sequence.length)
        expect(sequence.get(inspect)).toBe(reference[inspect])
        expect(sequence.indexOf(reference[inspect]!.node.path)).toBe(inspect)
      }
    }
    // Local boundary coalescing should avoid global compaction entirely on
    // this representative 5k-edit workload.
    expect(sequence.compactions).toBe(0)
    expect(sequence.toArray()).toEqual(reference)
    expect(sequence.maxDepth()).toBeLessThan(75)
    expect(sequence.chunkCount).toBeLessThan(1_300)
    for (let i = 0; i < reference.length; i += 17) {
      expect(sequence.indexOf(reference[i]!.node.path)).toBe(i)
    }
  })
})
