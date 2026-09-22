import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { OxpRuntimeRefresh } from "@/oxp/runtime-refresh"

afterEach(() => {
  OxpRuntimeRefresh.install(undefined)
})

describe("OXP runtime-refresh bridge", () => {
  test("publishes a stable host-bridge protocol version", () => {
    expect(OxpRuntimeRefresh.PROTOCOL_VERSION).toBe(1)
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
