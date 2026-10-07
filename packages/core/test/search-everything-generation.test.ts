import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  compareShadow,
  getShadowStats,
  resetShadowSchedulerForTests,
  setShadowExecutorForTests,
} from "../src/search/everything"
import { searchFileMentionsFast } from "../src/search/mention-fast"

/**
 * Generation / cancellation lifecycle for the Everything shadow scheduler.
 *
 * Everything is OPTIONAL candidate discovery only; canonical OpenFork
 * FileSystemSearch owns matching, ranking, filtering, pagination, highlights,
 * and user-visible delivery. Nothing here gates or changes user-visible
 * behavior - these tests characterize and harden the measurement lane only.
 *
 * Offline by construction: the scheduler's provider call is injected, so no
 * live Everything 1.5.0.1423b / SDK3 3.0.0.9 server is required and the whole
 * suite runs on every platform (production default is win32-only).
 */

const nativeRow = (path: string) => ({
  kind: "file" as const,
  path,
  type: "file" as const,
  score: 100,
  positions: [],
  baseOffset: 15,
})

// Fixtures declare discardedPaths explicitly (always [] here: nothing was
// discarded). Omitting it while claiming basenameSubsequenceComplete is
// rejected by the executor seam, so a fixture can never certify by default.
const measured = (paths: string[]) => ({
  status: "measured" as const,
  paths: paths.map((path) => ({ path, isDir: false })),
  discardedPaths: [] as string[],
  basenameSubsequenceComplete: true,
  complete: true,
  requiredCount: paths.length,
  exhaustible: true,
})

const run = <T>(effect: Effect.Effect<T>) => Effect.runPromise(effect)

const shadow = (root: string, query: string) =>
  run(
    compareShadow({
      root,
      query,
      count: 512,
      native: [nativeRow("src/sear.ts")],
      limit: 1,
    }),
  )

afterAll(() => {
  // The shadow client is a module singleton, so a leaked fake would outlive
  // this file and reach any other suite importing the provider.
  setShadowExecutorForTests(undefined)
})

describe("Everything shadow generation lifecycle", () => {
  test("a rapid keystream collapses to the newest generation and publishes only that one", async () => {
    const started: string[] = []
    setShadowExecutorForTests(async (input) => {
      started.push(input.query)
      return measured(["src/sear.ts"])
    })

    const results = await Promise.all(["s", "se", "sea", "sear"].map((query) => shadow("C:\\repo", query)))

    // Only the in-flight generation and the newest pending generation ever
    // reach the provider. Intermediate keystrokes are rejected without work,
    // so latest-wins ordering does not fan out into N provider round trips.
    expect(started).toEqual(["s", "sear"])
    expect(results.map((result) => result.measured)).toEqual([false, false, false, true])
    expect(results.map((result) => result.skippedReason)).toEqual(["stale", "stale", "stale", undefined])
  })

  test("a superseded generation reports no coverage at all rather than perfect recall", async () => {
    setShadowExecutorForTests(async () => measured(["src/sear.ts"]))

    const [stale, fresh] = await Promise.all([shadow("C:\\repo", "s"), shadow("C:\\repo", "sear")])

    // A superseded generation is NO EVIDENCE. Reporting recall 1 here would
    // hand any consumer that forgets to check `measured` a perfect score for
    // a keystroke that was thrown away.
    expect(stale.measured).toBe(false)
    expect(stale.skippedReason).toBe("stale")
    expect(stale.recall).toBeUndefined()
    expect(stale.candidateCount).toBe(0)
    expect(stale.provenTopK).toBe(false)

    expect(fresh.measured).toBe(true)
    expect(fresh.recall).toBe(1)
  })

  test("superseded work is never cancelled: the in-flight provider call runs to completion", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const completed: string[] = []
    setShadowExecutorForTests(async (input) => {
      if (input.query === "s") await gate
      completed.push(input.query)
      return measured(["src/sear.ts"])
    })

    const first = shadow("C:\\repo", "s")
    const latest = shadow("C:\\repo", "sear")
    release()
    const results = await Promise.all([first, latest])

    // Documents the actual cancellation story: staleness is enforced at
    // publication only. The superseded generation's entire provider cost
    // (ready + exact + broad + optional second page) is still paid.
    expect(completed).toEqual(["s", "sear"])
    expect(results[0].skippedReason).toBe("stale")
    expect(results[1].measured).toBe(true)
  })

  test("a rapid cancel/restart loop never wedges the scheduler", async () => {
    setShadowExecutorForTests(async () => measured(["src/sear.ts"]))

    const many = await Promise.all(
      Array.from({ length: 50 }, (_, index) => shadow("C:\\repo", `q${index}`)),
    )

    expect(many.filter((result) => result.measured)).toHaveLength(1)
    expect(many.at(-1)?.measured).toBe(true)
    expect(many.filter((result) => result.skippedReason === "stale")).toHaveLength(49)

    // Scheduler is quiescent and still accepts work afterwards: the in-flight
    // slot is released, not leaked, by a superseded generation.
    const after = await shadow("C:\\repo", "after")
    expect(after.measured).toBe(true)
  })

  test("a poisoned provider mid-flight fails closed and does not wedge later generations", async () => {
    let call = 0
    setShadowExecutorForTests(async () => {
      call++
      if (call === 1) throw new Error("SDK3 pipe closed")
      return measured(["src/sear.ts"])
    })

    const first = await shadow("C:\\repo", "s")
    expect(first.measured).toBe(false)
    expect(first.skippedReason).toBe("unavailable")
    expect(first.recall).toBeUndefined()
    expect(first.provenTopK).toBe(false)

    // Provider restart: the next generation recovers cleanly.
    const second = await shadow("C:\\repo", "sear")
    expect(second.measured).toBe(true)
  })

  test("a busy provider fails closed and does not wedge later generations", async () => {
    let call = 0
    setShadowExecutorForTests(async () => {
      call++
      if (call === 1) return { status: "busy", paths: [], complete: false, requiredCount: 0, exhaustible: false }
      return measured(["src/sear.ts"])
    })

    const first = await shadow("C:\\repo", "s")
    expect(first.measured).toBe(false)
    expect(first.skippedReason).toBe("busy")
    expect(first.recall).toBeUndefined()

    const second = await shadow("C:\\repo", "sear")
    expect(second.measured).toBe(true)
  })

  test("publication binds to the newest generation's candidates, never a superseded one's", async () => {
    setShadowExecutorForTests(async (input) => measured([`src/${input.query}.ts`]))

    const results = await Promise.all(
      ["s", "se", "sea", "sear"].map((query) => shadow("C:\\repo", query)),
    )

    const published = results.at(-1)!
    expect(published.measured).toBe(true)
    expect(published.missing).toEqual([])
    expect(published.candidateCount).toBe(1)

    // No superseded generation leaked candidate rows into the published
    // comparison, and the caller's native array is never mutated.
    for (const stale of results.slice(0, -1)) {
      expect(stale.measured).toBe(false)
      expect(stale.candidateCount).toBe(0)
      expect(stale.missing).toEqual([])
    }
  })

  test("there is no candidate cache across generations, so identical requests re-run the provider", async () => {
    let calls = 0
    setShadowExecutorForTests(async () => {
      calls++
      return measured(["src/sear.ts"])
    })

    await shadow("C:\\repo", "sea")
    await shadow("C:\\repo", "sea")

    // Honest answer for cache-key completeness: there is no cache at all, so
    // there is no key that can be incomplete. The same fact is why keystroke
    // supersession is unavoidable - nothing can be reused between prefixes.
    expect(calls).toBe(2)
  })

  test("CHARACTERIZATION: generation ownership is process-global, so distinct roots supersede each other", async () => {
    const started: Array<{ root: string; query: string }> = []
    setShadowExecutorForTests(async (input) => {
      started.push({ root: input.root, query: input.query })
      return measured(["src/sear.ts"])
    })

    const [rootA, rootB] = await Promise.all([shadow("C:\\repoA", "alpha"), shadow("C:\\repoB", "beta")])

    // DEFECT (reported to integration-captain, not fixed in this lane):
    // shadowGeneration is a module-global counter not keyed by root, so a
    // keystroke in repo B marks repo A's in-flight shadow stale even though
    // repo A has no newer request of its own. Two FileSystemSearch instances
    // therefore share one generation counter and one in-flight slot.
    expect(started).toEqual([
      { root: "C:\\repoA", query: "alpha" },
      { root: "C:\\repoB", query: "beta" },
    ])
    expect(rootA.skippedReason).toBe("stale")
    expect(rootB.measured).toBe(true)
  })
})

/**
 * Keystream-lifecycle lane extension: per-stage abort, wasted-work ledger,
 * stale-never-merges adversarial proof, cache-key completeness, and native
 * isolation. Appended without touching the nine baseline tests above.
 *
 * Leak-point map (mirrors the ShadowStage contract in everything.ts):
 *   creation (coalesced, zero work) -> pipe-wait -> paging -> decode -> fence
 *   -> rerank -> proof -> publication (final guard, zero coverage for stale).
 */

describe("generation abort at every pipeline stage", () => {
  type Stage = "pipe-wait" | "paging" | "decode" | "fence" | "rerank" | "proof"
  const STAGES: Stage[] = ["pipe-wait", "paging", "decode", "fence", "rerank", "proof"]

  test.each(STAGES)("a job superseded at %s aborts there and never reaches publish", async (rawTarget) => {
    const target: Stage = rawTarget
    resetShadowSchedulerForTests()
    const log: Record<string, string[]> = {}
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const note = (query: string, stage: string) => {
      ;(log[query] ??= []).push(stage)
    }
    setShadowExecutorForTests(async (input, ctx) => {
      const staged = async (stage: Stage) => {
        note(input.query, stage)
        if (input.query === "s" && stage === target) {
          // Park the stale job AT the target stage until the newer generation
          // exists, then prove the abort fires instead of continuing.
          await gate
        }
        ctx.check(stage)
      }
      await staged("pipe-wait")
      await staged("paging")
      await staged("decode")
      if (input.query === "s" && target === "fence") {
        note(input.query, "fence-start")
        for (let i = 0; i < 256; i++) {
          if (i === 128) await gate
          if ((i & 15) === 0) ctx.check("fence")
        }
        note(input.query, "fence")
      } else {
        await staged("fence")
      }
      await staged("rerank")
      await staged("proof")
      return measured(["src/sear.ts"])
    })

    const first = shadow("C:\\repo", "s")
    // Wait until the stale job parks at its target stage (still current, so
    // earlier checks pass and no work is skipped yet).
    const parked = async () => {
      const deadline = Date.now() + 2000
      for (;;) {
        const seen = log["s"] ?? []
        const waiting =
          target === "fence" ? seen.includes("fence-start") : seen.includes(target)
        if (waiting) return
        if (Date.now() > deadline) throw new Error(`stale job never parked at ${target}: ${seen.join(",")}`)
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
    }
    await parked()
    const latest = shadow("C:\\repo", "sear")
    release()
    const [stale, fresh] = await Promise.all([first, latest])

    expect(stale.measured).toBe(false)
    expect(stale.skippedReason).toBe("stale")
    expect(stale.candidateCount).toBe(0)
    expect(fresh.measured).toBe(true)
    const stats = getShadowStats()
    expect(stats.abortedByStage[target]).toBeGreaterThanOrEqual(1)
    // The stale job never published coverage and never ran later stages: its
    // log stops at (or inside) the target while the fresh job runs the full
    // pipeline to proof.
    expect((log["sear"] ?? []).join(",")).toContain("proof")
    if (target !== "proof") {
      const staleLog = (log["s"] ?? []).join(",")
      const later = STAGES.slice(STAGES.indexOf(target) + 1).filter((s) => s !== "fence" || target !== "fence")
      for (const stage of later) {
        if (stage === target) continue
        // fence-start is a marker, not a completed stage.
        expect(staleLog).not.toContain(`${stage}` === "fence" && staleLog.includes("fence-start") ? "__impossible__" : stage)
      }
    }
  })

  test("a non-cooperative provider is still contained at publication with zero coverage", async () => {
    resetShadowSchedulerForTests()
    // Ignores ctx entirely: models a provider that cannot abort mid-flight.
    // The scheduler must still contain it at the final guard.
    setShadowExecutorForTests(async () => measured(["src/stale-leak.ts"]))
    const [stale, fresh] = await Promise.all([shadow("C:\\repo", "s"), shadow("C:\\repo", "sear")])
    expect(stale.measured).toBe(false)
    expect(stale.skippedReason).toBe("stale")
    expect(stale.candidateCount).toBe(0)
    expect(stale.missing).toEqual([])
    expect(stale.recall).toBeUndefined()
    expect(stale.provenTopK).toBe(false)
    expect(fresh.measured).toBe(true)
  })
})

describe("wasted superseded work is measured and abort reduces it", () => {
  const ITEMS = 5000

  const fenceExecutor = (cooperative: boolean, waste: { items: number; bytes: number }) =>
    async (input: { query: string }, ctx: { check: (stage: "fence") => void }) => {
      // Yield so the superseding keystroke queues while this job is in-flight;
      // without this the synchronous loop would finish before the newer
      // generation exists and there would be nothing to abort (both jobs would
      // fence the full page, which is exactly the publication-only baseline).
      await new Promise((resolve) => setTimeout(resolve, 0))
      // Simulated IPC: one 64-byte row per fenced candidate.
      for (let i = 0; i < ITEMS; i++) {
        if (cooperative && (i & 31) === 0) ctx.check("fence")
        waste.items++
        waste.bytes += 64
      }
      return measured(["src/sear.ts"])
    }

  test("cooperative fence abort processes a fraction of the rows a publication-only job wastes", async () => {
    // Baseline: publication-only containment (no mid-pipe abort). The stale
    // job pays the full 5000-row fence before being discarded at publish.
    resetShadowSchedulerForTests()
    const baselineWaste = { items: 0, bytes: 0 }
    setShadowExecutorForTests(fenceExecutor(false, baselineWaste) as never)
    const [baselineStale] = await Promise.all([shadow("C:\\repo", "s"), shadow("C:\\repo", "sear")])
    expect(baselineStale.skippedReason).toBe("stale")
    // Both generations fence the full page: the stale job wastes ITEMS rows
    // before publication-only containment discards it, plus ITEMS for fresh.
    expect(baselineWaste.items).toBe(2 * ITEMS)

    // With abort: the stale job is superseded before its first fence check
    // (sear queues synchronously while s is still in its executor), so the
    // very first cooperative check throws and almost no rows are fenced.
    resetShadowSchedulerForTests()
    const abortWaste = { items: 0, bytes: 0 }
    setShadowExecutorForTests(fenceExecutor(true, abortWaste) as never)
    const [abortedStale, fresh] = await Promise.all([shadow("C:\\repo", "s"), shadow("C:\\repo", "sear")])
    expect(abortedStale.skippedReason).toBe("stale")
    expect(fresh.measured).toBe(true)
    const stats = getShadowStats()
    expect(stats.abortedByStage["fence"]).toBeGreaterThanOrEqual(1)
    // CPU (rows fenced) and IPC (bytes decoded) both collapse, proving the
    // abort reduces work rather than merely being scheduled.
    expect(abortWaste.items).toBeLessThan(baselineWaste.items)
    expect(abortWaste.bytes).toBeLessThan(baselineWaste.bytes)
    // Fresh still fences its full page; the stale job aborts at its first
    // fence check (<=32 rows), saving ~5000 rows / ~320KB of IPC decode.
    expect(abortWaste.items).toBeLessThanOrEqual(ITEMS + 32)
    expect(abortWaste.bytes).toBeLessThanOrEqual((ITEMS + 32) * 64)
    expect(baselineWaste.items - abortWaste.items).toBeGreaterThanOrEqual(ITEMS - 32)
  })
})

describe("stale results can never merge into a newer generation", () => {
  test("adversarial per-query candidates never cross generations", async () => {
    resetShadowSchedulerForTests()
    setShadowExecutorForTests(async (input) => measured([`src/${input.query}.ts`]))
    const runWithNative = (query: string, nativePath: string) =>
      run(compareShadow({ root: "C:\\repo", query, count: 512, native: [nativeRow(nativePath)], limit: 1 }))
    const [stale, fresh] = await Promise.all([
      runWithNative("s", "src/s.ts"),
      runWithNative("sear", "src/sear.ts"),
    ])
    expect(stale.measured).toBe(false)
    expect(stale.candidateCount).toBe(0)
    expect(stale.missing).toEqual([])
    expect(fresh.measured).toBe(true)
    // The published comparison is bound to the newest generation's inputs
    // only: its candidates cover the newest native row and the stale row
    // "src/s.ts" appears nowhere in the fresh publication.
    expect(fresh.missing).toEqual([])
    expect(fresh.candidateCount).toBe(1)
    expect(fresh.coveredTopK).toBe(1)
    expect(JSON.stringify(fresh)).not.toContain("src/s.ts")
  })
})

describe("cache-key completeness", () => {
  test("every generation re-runs the provider: root, query, count, limit and corpus are all key", async () => {
    resetShadowSchedulerForTests()
    const seen: Array<{ root: string; query: string; initialCount: number }> = []
    setShadowExecutorForTests(async (input) => {
      seen.push({ root: input.root, query: input.query, initialCount: input.initialCount })
      return measured(["src/sear.ts"])
    })
    const runWith = (root: string, query: string, count: number) =>
      run(compareShadow({ root, query, count, native: [nativeRow("src/sear.ts")], limit: 1 }))
    // Sequential identical requests: no cache, both run.
    await runWith("C:\\repo", "sea", 512)
    await runWith("C:\\repo", "sea", 512)
    // Varied keys: every dimension re-runs independently (nothing is keyed
    // by a query prefix or any incomplete subset).
    await runWith("C:\\repoB", "sea", 512)
    await runWith("C:\\repo", "sear", 512)
    await runWith("C:\\repo", "sea", 1024)
    expect(seen).toEqual([
      { root: "C:\\repo", query: "sea", initialCount: 512 },
      { root: "C:\\repo", query: "sea", initialCount: 512 },
      { root: "C:\\repoB", query: "sea", initialCount: 512 },
      { root: "C:\\repo", query: "sear", initialCount: 512 },
      { root: "C:\\repo", query: "sea", initialCount: 1024 },
    ])
  })

  test("rerank corpus is per-generation: identical queries over different corpora score independently", () => {
    // mention-fast corpusCache is keyed by array identity and derived purely
    // from contents, so two arrays with equal contents score equally (no
    // stale cross-generation cache) and different corpora never share rows.
    const corpusA = [{ path: "src/sear.ts", isDir: false }]
    const corpusB = [{ path: "src/sear.ts", isDir: false }]
    const corpusC = [{ path: "src/other.ts", isDir: false }]
    const a = searchFileMentionsFast(corpusA, { query: "sear", limit: 5, offset: 0 })
    const b = searchFileMentionsFast(corpusB, { query: "sear", limit: 5, offset: 0 })
    const c = searchFileMentionsFast(corpusC, { query: "sear", limit: 5, offset: 0 })
    expect(a.results.map((r) => [r.path, r.score])).toEqual(b.results.map((r) => [r.path, r.score]))
    expect(c.results.some((r) => r.path === "src/sear.ts")).toBe(false)
  })
})

describe("shadow path never delays or mutates native delivery", () => {
  test("compareShadow never mutates the caller native/corpus arrays", async () => {
    resetShadowSchedulerForTests()
    setShadowExecutorForTests(async (input) => measured([`src/${input.query}.ts`]))
    const native = [nativeRow("src/sear.ts")]
    const corpus = [{ path: "src/sear.ts", isDir: false }]
    const nativeSnapshot = JSON.parse(JSON.stringify(native))
    const corpusSnapshot = JSON.parse(JSON.stringify(corpus))
    Object.freeze(native)
    Object.freeze(corpus)
    const result = await run(
      compareShadow({ root: "C:\\repo", query: "sear", count: 512, native, corpus, limit: 1 }),
    )
    expect(result.measured).toBe(true)
    expect(JSON.parse(JSON.stringify(native))).toEqual(nativeSnapshot)
    expect(JSON.parse(JSON.stringify(corpus))).toEqual(corpusSnapshot)
  })

  test("native scoring resolves while a gated shadow is still pending (forkDetach isolation)", async () => {
    resetShadowSchedulerForTests()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    setShadowExecutorForTests(async () => {
      await gate
      return measured(["src/sear.ts"])
    })
    // Mirrors filesystem/search.ts: native page is computed synchronously and
    // the shadow is forkDetached (never awaited for delivery).
    const shadowPromise = shadow("C:\\repo", "sear")
    const nativePage = searchFileMentionsFast([{ path: "src/sear.ts", isDir: false }], {
      query: "sear",
      limit: 1,
      offset: 0,
    })
    expect(nativePage.results.length).toBe(1)
    let shadowSettled = false
    void shadowPromise.then(() => {
      shadowSettled = true
    })
    // Native is already delivered while the shadow is still gated.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(shadowSettled).toBe(false)
    release()
    const shadowed = await shadowPromise
    expect(shadowed.measured).toBe(true)
  })
})

describe("executor seam cannot certify by default", () => {
  test("a fixture claiming a complete source without discardedPaths is rejected, not silently certified", async () => {
    resetShadowSchedulerForTests()
    setShadowExecutorForTests(async () => ({
      status: "measured" as const,
      paths: [{ path: "src/sear.ts", isDir: false }],
      // discardedPaths omitted while claiming a completed certifying source:
      // production would be certifying on forgotten discards.
      basenameSubsequenceComplete: true,
      complete: true,
      requiredCount: 1,
      exhaustible: true,
    }))
    const result = await shadow("C:\\repo", "sear")
    // Fails closed as unavailable (never a stale/transport conflation) and
    // carries no proof fields at all.
    expect(result.measured).toBe(false)
    expect(result.provenTopK).toBe(false)
    expect(result.candidateCount).toBe(0)
    expect(result.recall).toBeUndefined()
    expect(result.skippedReason).toBe("unavailable")
    // The scheduler still accepts work afterwards: no wedge.
    setShadowExecutorForTests(async () => measured(["src/sear.ts"]))
    const after = await shadow("C:\\repo", "sear")
    expect(after.measured).toBe(true)
  })

  test("an explicitly declared empty discard set still certifies honestly", async () => {
    resetShadowSchedulerForTests()
    setShadowExecutorForTests(async () => ({
      status: "measured" as const,
      paths: [{ path: "src/sear.ts", isDir: false }],
      discardedPaths: [],
      basenameSubsequenceComplete: true,
      complete: true,
      requiredCount: 1,
      exhaustible: true,
    }))
    const result = await shadow("C:\\repo", "sear")
    expect(result.measured).toBe(true)
    expect(result.discardedCount).toBe(0)
    expect(result.discardedCoverageSafe).toBe(true)
  })
})
