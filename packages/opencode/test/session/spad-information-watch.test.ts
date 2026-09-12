import { describe, expect, test } from "bun:test"
import { InformationRecurrenceWatch } from "@/session/spad/information-watch"

describe("SPAD unchanged-result recurrence watch", () => {
  test("requires four consecutive generations by default", () => {
    const watch = new InformationRecurrenceWatch()
    for (let i = 0; i < 3; i++) {
      watch.markGeneration()
      expect(watch.pushResult("read:file:a:o1", "same output")).toBeUndefined()
    }
    watch.markGeneration()
    const hit = watch.pushResult("read:file:a:o1", "same output")
    expect(hit?.recurrences).toBe(4)
    expect(hit?.startGeneration).toBe(0)
    expect(hit?.endGeneration).toBe(3)
  })

  test("changed result restarts the streak", () => {
    const watch = new InformationRecurrenceWatch({ minConsecutiveGenerations: 3 })
    watch.markGeneration(); watch.pushResult("status:x", "pending")
    watch.markGeneration(); watch.pushResult("status:x", "running")
    watch.markGeneration(); expect(watch.pushResult("status:x", "running")).toBeUndefined()
    watch.markGeneration(); expect(watch.pushResult("status:x", "running")?.recurrences).toBe(3)
  })

  test("a generation gap breaks recurrence", () => {
    const watch = new InformationRecurrenceWatch({ minConsecutiveGenerations: 3 })
    watch.markGeneration(); watch.pushResult("read:a", "same")
    watch.markGeneration()
    watch.markGeneration(); watch.pushResult("read:a", "same")
    watch.markGeneration(); expect(watch.pushResult("read:a", "same")).toBeUndefined()
  })

  test("host progress clears recurrence", () => {
    const watch = new InformationRecurrenceWatch({ minConsecutiveGenerations: 3 })
    watch.markGeneration(); watch.pushResult("read:a", "same")
    watch.markGeneration(); watch.pushResult("read:a", "same")
    watch.markProgress()
    watch.markGeneration(); expect(watch.pushResult("read:a", "same")).toBeUndefined()
  })

  test("same-generation repetition does not inflate cross-generation evidence", () => {
    const watch = new InformationRecurrenceWatch({ minConsecutiveGenerations: 2 })
    watch.markGeneration()
    expect(watch.pushResult("read:a", "same")).toBeUndefined()
    expect(watch.pushResult("read:a", "same")).toBeUndefined()
    watch.markGeneration()
    expect(watch.pushResult("read:a", "same")?.recurrences).toBe(2)
  })

  test("emits once per unchanged-result episode", () => {
    const watch = new InformationRecurrenceWatch({ minConsecutiveGenerations: 3 })
    const hits = []
    for (let generation = 0; generation < 6; generation++) {
      watch.markGeneration()
      const hit = watch.pushResult("read:file.ts:o1:l50", "same bytes")
      if (hit) hits.push(hit)
    }
    expect(hits).toHaveLength(1)
    expect(hits[0]?.recurrences).toBe(3)

    watch.markGeneration()
    watch.pushResult("read:file.ts:o1:l50", "changed bytes")
    for (let generation = 0; generation < 3; generation++) {
      watch.markGeneration()
      const hit = watch.pushResult("read:file.ts:o1:l50", "new stable bytes")
      if (hit) hits.push(hit)
    }
    expect(hits).toHaveLength(2)
  })
})
