import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { createLocalUsageCache, createOfficialUsageCache, bumpUsageCache, usageCacheGeneration } from "../../src/fork/usage-cache"

const OK_PAYLOAD = {
  usage: {
    rolling: { percent: 25, resetsAt: "2026-08-12T12:00:00.000Z", status: "ok" },
    weekly: { percent: 50, resetsAt: "2026-08-16T12:00:00.000Z" },
    monthly: { percent: 75, resetsAt: "2026-08-31T12:00:00.000Z" },
  },
}

function fakeResponse(payload: unknown, ok = true) {
  return new Response(JSON.stringify(payload), {
    status: ok ? 200 : 503,
    headers: { "content-type": "application/json" },
  })
}

describe("OfficialUsageCache (L1 remote gate)", () => {
  test("serves <=1 remote fetch per credential per 5m window regardless of request count", async () => {
    let now = 1_000_000
    let calls = 0
    const cache = createOfficialUsageCache({
      now: () => now,
      fetch: async () => {
        calls++
        return fakeResponse(OK_PAYLOAD)
      },
    })

    const run = () => Effect.runPromise(cache.get("cred_1", "sk-1"))
    const first = await run()
    expect(calls).toBe(1)
    expect(first.status).toBe("ok")
    expect(first.snapshot?.["5h"]?.percent).toBe(25)

    // 10 more requests inside the same 5m window: no new remote fetch.
    // (Advance 25s/step — 10 x 30s would equal the TTL exactly and correctly
    // open a new window on the final step; the gate is >= TTL.)
    for (let i = 0; i < 10; i++) {
      now += 25_000
      await run()
    }
    expect(calls).toBe(1)
  })

  test("concurrent callers share one in-flight fetch (single-flight)", async () => {
    let now = 2_000_000
    let calls = 0
    let resolveFetch: ((r: Response) => void) | undefined
    const cache = createOfficialUsageCache({
      now: () => now,
      fetch: () => {
        calls++
        return new Promise<Response>((resolve) => {
          resolveFetch = resolve
        })
      },
    })

    const pending = Promise.all([
      Effect.runPromise(cache.get("cred_1", "sk-1")),
      Effect.runPromise(cache.get("cred_1", "sk-1")),
      Effect.runPromise(cache.get("cred_1", "sk-1")),
    ])
    // Let the fibers reach the in-flight await, then resolve once.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(calls).toBe(1)
    resolveFetch?.(fakeResponse(OK_PAYLOAD))
    const results = await pending
    expect(results.every((r) => r.status === "ok")).toBe(true)
  })

  test("after the 5m window expires, exactly one more fetch happens", async () => {
    let now = 3_000_000
    let calls = 0
    const cache = createOfficialUsageCache({
      now: () => now,
      fetch: async () => {
        calls++
        return fakeResponse(OK_PAYLOAD)
      },
    })

    await Effect.runPromise(cache.get("cred_1", "sk-1"))
    expect(calls).toBe(1)

    now += 5 * 60 * 1000 + 1 // past the window
    await Effect.runPromise(cache.get("cred_1", "sk-1"))
    expect(calls).toBe(2)

    // Still inside the new window: cached.
    await Effect.runPromise(cache.get("cred_1", "sk-1"))
    expect(calls).toBe(2)
  })

  test("remote failure serves the last good snapshot as stale, then retries next window", async () => {
    let now = 4_000_000
    let calls = 0
    const cache = createOfficialUsageCache({
      now: () => now,
      fetch: async () => {
        calls++
        return calls === 1 ? fakeResponse(OK_PAYLOAD) : fakeResponse(undefined, false)
      },
    })

    const first = await Effect.runPromise(cache.get("cred_1", "sk-1"))
    expect(first.status).toBe("ok")

    now += 5 * 60 * 1000 + 1
    const stale = await Effect.runPromise(cache.get("cred_1", "sk-1"))
    expect(calls).toBe(2)
    expect(stale.status).toBe("stale")
    // Last good snapshot still served with age metadata.
    expect(stale.snapshot?.["5h"]?.percent).toBe(25)
    expect(stale.ageMs).toBeGreaterThan(5 * 60 * 1000)

    // No snapshot at all + failure => error status, no crash.
    const empty = await Effect.runPromise(cache.get("cred_never", "sk-2"))
    expect(empty.status).toBe("error")
    expect(empty.snapshot).toBeUndefined()
  })

  test("credential switch serves that credential's own gated snapshot; does not force a remote call", async () => {
    let now = 5_000_000
    let calls = 0
    const cache = createOfficialUsageCache({
      now: () => now,
      fetch: async () => {
        calls++
        return fakeResponse(OK_PAYLOAD)
      },
    })

    await Effect.runPromise(cache.get("cred_a", "sk-a"))
    expect(calls).toBe(1)

    // Switch to cred_b: first request fetches ITS snapshot (gate per credential).
    await Effect.runPromise(cache.get("cred_b", "sk-b"))
    expect(calls).toBe(2)

    // Switching BACK to cred_a inside its window: no new fetch.
    await Effect.runPromise(cache.get("cred_a", "sk-a"))
    expect(calls).toBe(2)
  })

  test("respects the fetch timeout (hung endpoint does not stall)", async () => {
    let now = 6_000_000
    const cache = createOfficialUsageCache({
      now: () => now,
      timeoutMs: 50,
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          // bun test (v1.3.14) does not dispatch AbortSignal.timeout's "abort"
          // event while the event loop is idle (verified in isolation; `bun
          // run`/production is unaffected). Keep the loop alive with a no-op
          // interval so the abort listener actually fires here.
          const keepAlive = setInterval(() => {}, 25)
          init?.signal?.addEventListener("abort", () => {
            clearInterval(keepAlive)
            reject(new DOMException("Aborted", "AbortError"))
          })
        }),
    })
    const result = await Effect.runPromise(cache.get("cred_1", "sk-1"))
    expect(result.status).toBe("error")
    expect(result.snapshot).toBeUndefined()
  })
})

describe("LocalUsageCache (L2) + generation", () => {
  test("caches within TTL and invalidates on generation bump", async () => {
    let now = 10_000_000
    let computes = 0
    const cache = createLocalUsageCache({ now: () => now })
    const compute = () =>
      Effect.sync(() => {
        computes++
        return { value: computes }
      })

    const first = await Effect.runPromise(cache.get(compute))
    expect(first).toEqual({ value: 1 })
    expect(computes).toBe(1)

    // Within TTL: no recompute.
    now += 5_000
    const second = await Effect.runPromise(cache.get(compute))
    expect(second).toEqual({ value: 1 })
    expect(computes).toBe(1)

    // Generation bump (recordUsage / mutation): recompute.
    bumpUsageCache()
    const third = await Effect.runPromise(cache.get(compute))
    expect(third).toEqual({ value: 2 })
    expect(computes).toBe(2)
  })

  test("expires after the TTL even without a generation bump", async () => {
    let now = 20_000_000
    let computes = 0
    const cache = createLocalUsageCache({ now: () => now, ttlMs: 15_000 })
    const compute = () =>
      Effect.sync(() => {
        computes++
        return { value: computes }
      })

    await Effect.runPromise(cache.get(compute))
    now += 16_000
    await Effect.runPromise(cache.get(compute))
    expect(computes).toBe(2)
  })

  test("generation counter is process-global state", () => {
    const before = usageCacheGeneration()
    bumpUsageCache()
    expect(usageCacheGeneration()).toBe(before + 1)
  })
})
