import { describe, expect, test } from "bun:test"
import { SessionDormantRecovery } from "@opencode-ai/core/session/dormant-recovery"
import { SessionSchema } from "@opencode-ai/core/session/schema"

const id = (n: number) => SessionSchema.ID.make(`ses_dormant_repair_${n}`)

describe("bounded dormant crash recovery admission", () => {
  test("selects only interrupted, not genuinely active generations", () => {
    const states = new Map([
      [id(0), { type: "busy" as const }],
      [id(1), { type: "interrupted" as const }],
      [id(2), { type: "busy" as const }],
      [id(3), { type: "interrupted" as const }],
    ])
    expect(SessionDormantRecovery.selectDormantCandidates(states)).toEqual({
      ids: [id(1), id(3)], truncated: false,
    })
  })

  test("never expands an operator's boot repair budget past sixteen owners", () => {
    const statuses = new Map(Array.from({ length: 32 }, (_, n) =>
      [id(n), { type: "interrupted" as const }] as const,
    ))
    const planned = SessionDormantRecovery.selectDormantCandidates(statuses, 1_000_000)
    expect(planned.ids).toHaveLength(16)
    expect(planned.truncated).toBe(true)
    expect(SessionDormantRecovery.selectDormantCandidates(statuses, 0)).toEqual({
      ids: [], truncated: true,
    })
  })

})
