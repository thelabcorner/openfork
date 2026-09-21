import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { interactionGate } from "@/session/ingress"
import { SessionID } from "@/session/schema"

const sessionID = SessionID.make("ses_ingress_gate")
const otherSessionID = SessionID.make("ses_other")

describe("SessionIngress interaction gate", () => {
  test("successful question/permission lists preserve the matching session fence", async () => {
    const question = await Effect.runPromise(
      interactionGate({
        sessionID,
        questions: () => Effect.succeed([{ sessionID }]),
        permissions: () => Effect.succeed([{ sessionID: otherSessionID }]),
      }),
    )
    expect(question).toEqual({ hasQuestion: true, hasPermission: false, blocked: true })

    const permission = await Effect.runPromise(
      interactionGate({
        sessionID,
        questions: () => Effect.succeed([{ sessionID: otherSessionID }]),
        permissions: () => Effect.succeed([{ sessionID }]),
      }),
    )
    expect(permission).toEqual({ hasQuestion: false, hasPermission: true, blocked: true })
  })

  test("unrelated sessions do not gate and list defects are contained", async () => {
    const unrelated = await Effect.runPromise(
      interactionGate({
        sessionID,
        questions: () => Effect.succeed([{ sessionID: otherSessionID }]),
        permissions: () => Effect.succeed([]),
      }),
    )
    expect(unrelated.blocked).toBe(false)

    const failed = await Effect.runPromise(
      interactionGate({
        sessionID,
        questions: () => Effect.die("question list unavailable"),
        permissions: () => Effect.die("permission list unavailable"),
      }),
    )
    expect(failed).toEqual({ hasQuestion: false, hasPermission: false, blocked: false })
  })
})
