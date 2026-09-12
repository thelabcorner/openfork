import { describe, expect, test } from "bun:test"
import { RecentThrashWatch } from "@/session/spad/thrash-v2"

function gen(w: RecentThrashWatch, resources: string[], narration: string, mutate = false) {
  w.markGeneration()
  for (const resource of resources) {
    w.pushTool(mutate ? "edit" : "read", mutate, resource)
    w.pushResult(resource, `stable:${resource}`)
  }
  w.pushNarration(narration)
  return w.evaluate("text")
}

describe("SPAD recent thrash watch", () => {
  test("detects sustained local re-exploration with recurring narration", () => {
    const w = new RecentThrashWatch()
    let hit
    for (let i = 0; i < 4; i++) {
      hit = gen(
        w,
        ["src/benchmark.ts:o1", "docs/measurement.md:o1", "src/benchmark.ts:o100"],
        "I am checking the benchmark measurement again to understand the same remaining issue.",
      )
    }
    expect(hit).toBeDefined()
    expect(w.metrics().reaccessRatio).toBe(1)
    expect(w.metrics().generationPeriod).toBe(1)
  })

  test("detects an alternating A/B generation-state cycle", () => {
    const w = new RecentThrashWatch()
    const a = "The native layer closes in a finalizer, so I am rechecking the same lifetime question."
    const b = "Neither helper opens a connection, so I am rechecking the same two call sites."
    expect(gen(w, ["sqlite.bun.ts:o120:l80"], a)).toBeUndefined()
    expect(gen(w, ["migration.ts:o90:l60", "database.ts:o1:l50"], b)).toBeUndefined()
    expect(gen(w, ["sqlite.bun.ts:o120:l80"], a)).toBeUndefined()
    const hit = gen(w, ["migration.ts:o90:l60", "database.ts:o1:l50"], b)
    expect(hit).toBeDefined()
    expect(w.metrics().generationPeriod).toBe(2)
    expect(w.metrics().recurringResourcePairs).toBe(2)
    expect(w.metrics().recurringNarrationPairs).toBe(2)
  })

  test("healthy exploration with new resources does not trigger", () => {
    const w = new RecentThrashWatch()
    let hit
    for (let i = 0; i < 8; i++)
      hit ??= gen(w, [`src/module-${i}.ts:o1`, `src/helper-${i}.ts:o1`], "I am inspecting the next independent module and recording new evidence.")
    expect(hit).toBeUndefined()
  })

  test("a mutation anywhere in the recent evidence window vetoes a hit", () => {
    const w = new RecentThrashWatch()
    gen(w, ["src/a.ts:o1", "src/b.ts:o1"], "Checking the same two files before making a concrete change.")
    gen(w, ["src/a.ts:o1", "src/b.ts:o1"], "Checking the same two files before making a concrete change.", true)
    gen(w, ["src/a.ts:o1", "src/b.ts:o1"], "Checking the same two files before making a concrete change.")
    expect(gen(w, ["src/a.ts:o1", "src/b.ts:o1"], "Checking the same two files before making a concrete change.")).toBeUndefined()
  })

  test("resource recurrence without narration recurrence is not enough", () => {
    const w = new RecentThrashWatch()
    const text = [
      "Inspecting parser ownership and import boundaries.",
      "Benchmark results show a new allocation hotspot in serialization.",
      "The test matrix now isolates a Windows-only file lock failure.",
      "Type checking reveals a distinct generic constraint regression.",
    ]
    let hit
    for (let i = 0; i < 4; i++) hit = gen(w, ["src/shared.ts:o1", "src/shared.ts:o80"], text[i]!)
    expect(hit).toBeUndefined()
  })

  test("old history cannot poison a later local window", () => {
    const w = new RecentThrashWatch()
    for (let i = 0; i < 6; i++) gen(w, [`src/old-${i}.ts:o1`], `Unique old exploration ${i} with unrelated evidence.`)
    let hit
    for (let i = 0; i < 3; i++)
      hit = gen(w, ["src/a.ts:o1", "src/b.ts:o1"], "Rechecking the same pair with the same explanation and no state change.")
    expect(hit).toBeUndefined()
    hit = gen(w, ["src/a.ts:o1", "src/b.ts:o1"], "Rechecking the same pair with the same explanation and no state change.")
    expect(hit).toBeDefined()
  })

  test("persistent cycle emits once until the episode breaks", () => {
    const w = new RecentThrashWatch()
    const narration = "Rechecking the same stable state without discovering anything new."
    let hits = 0
    for (let i = 0; i < 8; i++) if (gen(w, ["src/a.ts:o1", "src/b.ts:o1"], narration)) hits++
    expect(hits).toBe(1)

    gen(w, ["src/new.ts:o1"], "A genuinely different state breaks the periodic episode.")
    for (let i = 0; i < 4; i++) if (gen(w, ["src/a.ts:o1", "src/b.ts:o1"], narration)) hits++
    expect(hits).toBe(2)
  })

  test("same operation with changing results is not a repeated state", () => {
    const w = new RecentThrashWatch()
    let hit
    for (let i = 0; i < 6; i++) {
      w.markGeneration()
      w.pushTool("status", false, "job:42")
      w.pushResult("job:42", `progress:${i}`)
      w.pushNarration("Checking the same job status while it continues to make measurable progress.")
      hit ??= w.evaluate("text")
    }
    expect(hit).toBeUndefined()
  })

  test("narration fingerprint is invariant to streamed chunk boundaries", () => {
    const text = "Rechecking the same benchmark measurement with identical evidence and no state change."
    const a = new RecentThrashWatch()
    const b = new RecentThrashWatch()
    for (let generationIndex = 0; generationIndex < 4; generationIndex++) {
      a.markGeneration()
      b.markGeneration()
      for (const resource of ["src/a.ts:o1", "src/b.ts:o1"]) {
        a.pushTool("read", false, resource)
        b.pushTool("read", false, resource)
        a.pushResult(resource, `stable:${resource}`)
        b.pushResult(resource, `stable:${resource}`)
      }
      a.pushNarration(text)
      for (let i = 0; i < text.length; i += 7) b.pushNarration(text.slice(i, i + 7))
    }
    expect(a.metrics()).toEqual(b.metrics())
    expect(a.evaluate("text")).toBeDefined()
    expect(b.evaluate("text")).toBeDefined()
  })
})
