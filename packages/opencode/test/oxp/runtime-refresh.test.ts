import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { OxpRuntimeRefresh } from "@/oxp/runtime-refresh"

afterEach(() => {
  OxpRuntimeRefresh.install(undefined)
})

describe("OXP runtime-refresh bridge", () => {
  test("publishes a stable host-bridge protocol version", () => {
    expect(OxpRuntimeRefresh.PROTOCOL_VERSION).toBe(2)
  })

  test("reports a safe non-refreshable status without a Desktop host bridge", async () => {
    expect(await OxpRuntimeRefresh.status()).toEqual({
      refreshable: false,
      state: "stable",
      detail: "Transactional runtime refresh is unavailable in this host.",
    })
  })

  test("requires compare-and-swap identity for refresh", async () => {
    OxpRuntimeRefresh.install({
      status: async () => ({ refreshable: true, state: "stable" }),
      refresh: async () => {
        throw new Error("must not run")
      },
      arm: async () => {
        throw new Error("must not run")
      },
      accept: async () => {
        throw new Error("must not run")
      },
      rollback: async () => {
        throw new Error("must not run")
      },
    })

    const error = await Effect.runPromise(
      OxpRuntimeRefresh.execute({ action: "refresh" }).pipe(Effect.flip),
    )
    expect(error._tag).toBe("OXP_INVALID_ARGUMENT")
  })

  test("maps host conflict errors into the stable OXP error contract", async () => {
    OxpRuntimeRefresh.install({
      status: async () => ({ refreshable: true, state: "stable" }),
      refresh: async () => {
        throw Object.assign(new Error("stale runtime"), {
          code: "OXP_CONFLICT",
        })
      },
      arm: async () => {
        throw new Error("must not run")
      },
      accept: async () => {
        throw new Error("must not run")
      },
      rollback: async () => {
        throw new Error("must not run")
      },
    })

    const error = await Effect.runPromise(
      OxpRuntimeRefresh.execute({
        action: "refresh",
        expectedRuntimeID: `sha256:${"a".repeat(64)}`,
      }).pipe(Effect.flip),
    )
    expect(error).toMatchObject({
      _tag: "OXP_CONFLICT",
      detail: "stale runtime",
    })
  })

  test("arms a changed scheduled refresh only through the internal post-response hook", async () => {
    const previousID = `sha256:${"a".repeat(64)}`
    const candidateID = `sha256:${"b".repeat(64)}`
    let armCalls = 0
    OxpRuntimeRefresh.install({
      status: async () => ({
        refreshable: true,
        state: "stable",
        runtimeID: previousID,
      }),
      refresh: async () => ({
        action: "refresh",
        changed: true,
        status: {
          refreshable: true,
          state: "scheduled",
          runtimeID: previousID,
          trial: {
            id: "trial-response-barrier",
            previousRuntimeID: previousID,
            candidateRuntimeID: candidateID,
            phase: "scheduled",
          },
        },
      }),
      arm: async (trialID) => {
        expect(trialID).toBe("trial-response-barrier")
        armCalls += 1
      },
      accept: async () => {
        throw new Error("must not run")
      },
      rollback: async () => {
        throw new Error("must not run")
      },
    })

    const result = await Effect.runPromise(
      OxpRuntimeRefresh.execute({
        action: "refresh",
        expectedRuntimeID: previousID,
      }),
    )
    expect(armCalls).toBe(0)
    expect(result.afterResponse).toBeFunction()
    expect(result.structured).toMatchObject({
      action: "refresh",
      changed: true,
      status: { state: "scheduled" },
    })
    await result.afterResponse?.()
    expect(armCalls).toBe(1)
  })

  test("marks unchanged host refreshes as attempted but uncommitted", async () => {
    OxpRuntimeRefresh.install({
      status: async () => ({
        refreshable: true,
        state: "stable",
        runtimeID: `sha256:${"a".repeat(64)}`,
      }),
      refresh: async () => ({
        action: "refresh",
        changed: false,
        status: {
          refreshable: true,
          state: "stable",
          runtimeID: `sha256:${"a".repeat(64)}`,
          lastTransition: {
            trialID: "unchanged",
            outcome: "unchanged",
            at: 1,
          },
        },
      }),
      arm: async () => {
        throw new Error("must not run")
      },
      accept: async () => {
        throw new Error("must not run")
      },
      rollback: async () => {
        throw new Error("must not run")
      },
    })

    const result = await Effect.runPromise(
      OxpRuntimeRefresh.execute({
        action: "refresh",
        expectedRuntimeID: `sha256:${"a".repeat(64)}`,
      }),
    )
    expect(result.mutation).toEqual({ attempted: true, committed: false })
  })
})
