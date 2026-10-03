import { describe, expect, test } from "bun:test"
import { shouldRefreshSessionContext, type SessionContextRefreshState } from "./session-context-refresh"

const state = (
  active: boolean,
  sessionID: string | undefined,
  phase: string | undefined,
  updatedAt: number | undefined,
): SessionContextRefreshState => [active, sessionID, phase, updatedAt]

describe("shouldRefreshSessionContext", () => {
  test("does not turn first telemetry hydration into a duplicate projection request", () => {
    expect(
      shouldRefreshSessionContext(
        state(true, "ses_a", "idle", 100),
        state(true, "ses_a", undefined, undefined),
      ),
    ).toBeFalse()
  })

  test("refreshes when the same session reaches a newer idle watermark", () => {
    expect(
      shouldRefreshSessionContext(
        state(true, "ses_a", "idle", 200),
        state(true, "ses_a", "idle", 100),
      ),
    ).toBeTrue()

    expect(
      shouldRefreshSessionContext(
        state(true, "ses_a", "idle", 200),
        state(true, "ses_a", "generating", 150),
      ),
    ).toBeTrue()
  })

  test("refreshes on a generating-to-idle transition even within the same millisecond", () => {
    expect(
      shouldRefreshSessionContext(
        state(true, "ses_a", "idle", 200),
        state(true, "ses_a", "generating", 200),
      ),
    ).toBeTrue()
  })

  test("does not refresh on non-idle telemetry churn", () => {
    expect(
      shouldRefreshSessionContext(
        state(true, "ses_a", "generating", 200),
        state(true, "ses_a", "reasoning", 150),
      ),
    ).toBeFalse()
  })

  test("reactivation catches up only for the same session", () => {
    expect(
      shouldRefreshSessionContext(
        state(true, "ses_a", "idle", 100),
        state(false, "ses_a", "idle", 100),
      ),
    ).toBeTrue()

    expect(
      shouldRefreshSessionContext(
        state(true, "ses_b", "idle", 100),
        state(false, "ses_a", "idle", 100),
      ),
    ).toBeFalse()
  })
})
