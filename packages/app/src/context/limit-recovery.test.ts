import { describe, expect, test } from "bun:test"
import type { SessionLimitRecoveryInfo } from "@opencode-ai/sdk/v2/client"
import { acceptRecoveryProjection } from "./limit-recovery"

const recovery = (generation: number) =>
  ({
    sessionID: "ses_test",
    generation,
  }) as SessionLimitRecoveryInfo

describe("limit recovery projection", () => {
  test("older projections and cleared generations cannot regress or resurrect recovery", () => {
    expect(acceptRecoveryProjection(undefined, undefined, recovery(1))).toBe(true)
    expect(acceptRecoveryProjection(recovery(2), undefined, recovery(1))).toBe(false)
    expect(acceptRecoveryProjection(recovery(2), undefined, recovery(2))).toBe(true)
    expect(acceptRecoveryProjection(recovery(2), undefined, recovery(3))).toBe(true)
    expect(acceptRecoveryProjection(null, 2, recovery(2))).toBe(false)
    expect(acceptRecoveryProjection(null, 2, recovery(1))).toBe(false)
    expect(acceptRecoveryProjection(null, 2, recovery(3))).toBe(true)
  })
})
