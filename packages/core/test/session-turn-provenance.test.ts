import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"

function message(input: {
  provenance?: SessionV1.UserTurnProvenance
  synthetic?: boolean
  compaction?: boolean
} = {}): SessionV1.WithParts {
  const info = {
    id: SessionV1.MessageID.ascending(),
    sessionID: "ses_provenance" as any,
    role: "user" as const,
    ...(input.provenance ? { provenance: input.provenance } : {}),
    time: { created: 1 },
    agent: "build",
    model: { providerID: "test" as any, modelID: "model" as any },
  } satisfies SessionV1.User

  const parts: SessionV1.Part[] = input.compaction
    ? [
        {
          id: SessionV1.PartID.ascending(),
          sessionID: info.sessionID,
          messageID: info.id,
          type: "compaction",
          auto: true,
        },
      ]
    : [
        {
          id: SessionV1.PartID.ascending(),
          sessionID: info.sessionID,
          messageID: info.id,
          type: "text",
          text: "work",
          ...(input.synthetic === undefined ? {} : { synthetic: input.synthetic }),
        },
      ]
  return { info, parts }
}

describe("SessionTurnProvenance", () => {
  test("backports current semantic message kinds without changing provider role", () => {
    const human = message({ provenance: SessionTurnProvenance.user(SessionTurnProvenance.Source.Prompt) })
    const continuation = message({
      provenance: SessionTurnProvenance.host(SessionTurnProvenance.Source.GoalContinuation, {
        sourceMessageID: human.info.id,
        ref: "reservation-1",
      }),
      synthetic: true,
    })
    const shell = message({ provenance: SessionTurnProvenance.user(SessionTurnProvenance.Source.Shell), synthetic: true })
    const approval = message({
      provenance: SessionTurnProvenance.user(SessionTurnProvenance.Source.PlanApproval),
      synthetic: true,
    })
    const compaction = message({
      provenance: SessionTurnProvenance.host(SessionTurnProvenance.Source.Compaction, {
        sourceMessageID: human.info.id,
      }),
      compaction: true,
    })

    expect(SessionTurnProvenance.semanticKind(human)).toBe("user")
    expect(SessionTurnProvenance.semanticKind(continuation)).toBe("synthetic")
    expect(SessionTurnProvenance.semanticKind(shell)).toBe("shell")
    expect(SessionTurnProvenance.semanticKind(approval)).toBe("synthetic")
    expect(SessionTurnProvenance.semanticKind(compaction)).toBe("compaction")
    expect(continuation.info.role).toBe("user")
    expect(SessionTurnProvenance.isUserOwnedTurn(approval)).toBe(true)
    expect(SessionTurnProvenance.isSemanticUserTurn(approval)).toBe(false)
  })

  test("worker and Goal selectors use provenance rather than provider role", () => {
    const human = message({ provenance: SessionTurnProvenance.user(SessionTurnProvenance.Source.Prompt) })
    const command = message({ provenance: SessionTurnProvenance.user(SessionTurnProvenance.Source.Command) })
    const hostPrompt = message({ provenance: SessionTurnProvenance.host(SessionTurnProvenance.Source.HostPrompt) })
    const scheduled = message({
      provenance: SessionTurnProvenance.host(SessionTurnProvenance.Source.ScheduledTaskRun, { ref: "str_test" }),
    })
    const shell = message({ provenance: SessionTurnProvenance.user(SessionTurnProvenance.Source.Shell), synthetic: true })
    const continuation = message({
      provenance: SessionTurnProvenance.host(SessionTurnProvenance.Source.GoalContinuation, {
        sourceMessageID: human.info.id,
      }),
      synthetic: true,
    })
    const backgroundShell = message({
      provenance: SessionTurnProvenance.host(SessionTurnProvenance.Source.BackgroundShellSummary, {
        sourceMessageID: human.info.id,
        ref: "job_test",
      }),
      synthetic: true,
    })

    expect(SessionTurnProvenance.isWorkerPromptTurn(human)).toBe(true)
    expect(SessionTurnProvenance.isWorkerPromptTurn(command)).toBe(true)
    expect(SessionTurnProvenance.isWorkerPromptTurn(hostPrompt)).toBe(true)
    expect(SessionTurnProvenance.isWorkerPromptTurn(scheduled)).toBe(true)
    expect(SessionTurnProvenance.isWorkerPromptTurn(shell)).toBe(false)
    expect(SessionTurnProvenance.isWorkerPromptTurn(continuation)).toBe(false)
    expect(SessionTurnProvenance.isWorkerPromptTurn(backgroundShell)).toBe(false)
    expect(SessionTurnProvenance.semanticKind(backgroundShell)).toBe("synthetic")
    expect(SessionTurnProvenance.causalRootMessageID(backgroundShell)).toBe(human.info.id)
    expect(SessionTurnProvenance.isGoalAuthorizationTurn(human)).toBe(true)
    expect(SessionTurnProvenance.isGoalAuthorizationTurn(command)).toBe(true)
    expect(SessionTurnProvenance.isGoalAuthorizationTurn(hostPrompt)).toBe(false)
    expect(SessionTurnProvenance.isGoalAuthorizationTurn(scheduled)).toBe(false)
    expect(SessionTurnProvenance.isDurableUserActionAuthorizationTurn(human)).toBe(true)
    expect(SessionTurnProvenance.isDurableUserActionAuthorizationTurn(command)).toBe(true)
    expect(SessionTurnProvenance.isDurableUserActionAuthorizationTurn(hostPrompt)).toBe(false)
    expect(SessionTurnProvenance.isDurableUserActionAuthorizationTurn(scheduled)).toBe(false)
    expect(SessionTurnProvenance.semanticKind(scheduled)).toBe("synthetic")
    expect(SessionTurnProvenance.causalRootMessageID(scheduled)).toBe(scheduled.info.id)
  })

  test("host lineage preserves and flattens the original causal/checkpoint root", () => {
    const source = message({ provenance: SessionTurnProvenance.user(SessionTurnProvenance.Source.Prompt) })
    const continuation = message({
      provenance: SessionTurnProvenance.host(SessionTurnProvenance.Source.GoalContinuation, {
        sourceMessageID: source.info.id,
        ref: "reservation-2",
      }),
      synthetic: true,
    })
    const recovery = message({
      provenance: SessionTurnProvenance.hostDerived(SessionTurnProvenance.Source.RecoveryContinuation, continuation.info),
      synthetic: true,
    })
    expect(SessionTurnProvenance.causalRootMessageID(continuation)).toBe(source.info.id)
    expect(SessionTurnProvenance.causalRootMessageID(recovery)).toBe(source.info.id)
    expect(SessionTurnProvenance.checkpointRootMessageID(recovery)).toBe(source.info.id)
    expect(
      SessionTurnProvenance.hasHostCorrelation(
        continuation,
        SessionTurnProvenance.Source.GoalContinuation,
        "reservation-2",
      ),
    ).toBe(true)
  })

  test("causal host sources fail closed when a producer omits lineage", () => {
    expect(() => SessionTurnProvenance.host(SessionTurnProvenance.Source.GoalContinuation)).toThrow(
      "requires a canonical sourceMessageID",
    )
    expect(() => SessionTurnProvenance.host(SessionTurnProvenance.Source.Compaction)).toThrow(
      "requires a canonical sourceMessageID",
    )
    expect(() => SessionTurnProvenance.host(SessionTurnProvenance.Source.HostPrompt)).not.toThrow()
    expect(() => SessionTurnProvenance.host(SessionTurnProvenance.Source.ScheduledTaskRun)).toThrow(
      "requires a durable correlation ref",
    )
  })

  test("first-party source ownership is enforced at trusted construction boundaries", () => {
    expect(() => SessionTurnProvenance.host(SessionTurnProvenance.Source.Prompt)).toThrow("owned by user")
    expect(() => SessionTurnProvenance.user(SessionTurnProvenance.Source.GoalContinuation)).toThrow("owned by host")
    expect(() => SessionTurnProvenance.user("plugin.custom")).not.toThrow()
    expect(() => SessionTurnProvenance.host("plugin.custom")).not.toThrow()
  })

  test("legacy rows resolve through the single compatibility fallback", () => {
    const legacyHuman = message()
    const legacySynthetic = message({ synthetic: true })
    const legacyShell = message({ synthetic: true })
    const shellText = legacyShell.parts.find((part) => part.type === "text")
    if (!shellText || shellText.type !== "text") throw new Error("Expected text part")
    shellText.text = "The following tool was executed by the user"
    expect(SessionTurnProvenance.resolve(legacyHuman)).toEqual({
      owner: "user",
      source: "legacy.user",
      confidence: "legacy-inferred",
    })
    expect(SessionTurnProvenance.resolve(legacySynthetic)).toEqual({
      owner: "host",
      source: "legacy.synthetic",
      confidence: "legacy-inferred",
    })
    expect(SessionTurnProvenance.resolve(legacyShell)).toEqual({
      owner: "user",
      source: "legacy.shell",
      confidence: "legacy-inferred",
    })
    expect(SessionTurnProvenance.semanticKind(legacyShell)).toBe("shell")
    expect(SessionTurnProvenance.isSemanticUserTurn(legacyShell)).toBe(false)
    expect(SessionTurnProvenance.isWorkerPromptTurn(legacyShell)).toBe(false)
    expect(SessionTurnProvenance.isGoalAuthorizationTurn(legacyShell)).toBe(false)
  })

  test("historical V1 turns keep authorship but cannot become live authority or lineage", () => {
    const historical = message({
      provenance: {
        ...SessionTurnProvenance.user(SessionTurnProvenance.Source.Prompt),
        lifetime: "historical",
      },
    })
    const correlated = message({
      provenance: {
        ...SessionTurnProvenance.host(SessionTurnProvenance.Source.ScheduledTaskRun, { ref: "str_historical" }),
        lifetime: "historical",
      },
      synthetic: true,
    })

    expect(SessionTurnProvenance.isSemanticUserTurn(historical)).toBe(true)
    expect(SessionTurnProvenance.isWorkerPromptTurn(historical)).toBe(false)
    expect(SessionTurnProvenance.isGoalAuthorizationTurn(historical)).toBe(false)
    expect(SessionTurnProvenance.causalRootMessageID(historical)).toBeUndefined()
    expect(
      SessionTurnProvenance.hasHostCorrelation(
        correlated,
        SessionTurnProvenance.Source.ScheduledTaskRun,
        "str_historical",
      ),
    ).toBe(false)

    const historicalState = message({
      provenance: {
        ...SessionTurnProvenance.host(SessionTurnProvenance.Source.GoalProgress, { ref: "goal.progress:old" }),
        lifetime: "historical",
      },
      synthetic: true,
    })
    expect(SessionTurnProvenance.hasStateSemanticsTurn(historicalState)).toBe(true)
    expect(SessionTurnProvenance.isStateProjectionTurn(historicalState)).toBe(false)
  })

  test("legacy Goal continuation correlation is quarantined in the provenance compatibility layer", () => {
    const source = message({ provenance: SessionTurnProvenance.user(SessionTurnProvenance.Source.Prompt) })
    const legacyContinuation = message({ synthetic: true })
    const text = legacyContinuation.parts.find((part) => part.type === "text")
    if (!text || text.type !== "text") throw new Error("Expected text part")
    text.metadata = {
      goalContinuationReservationID: "reservation-legacy",
      goalContinuationSourceMessageID: source.info.id,
    }

    expect(SessionTurnProvenance.hasGoalContinuationReservation(legacyContinuation, "reservation-legacy")).toBe(true)
    expect(SessionTurnProvenance.goalContinuationSourceMessageID(legacyContinuation)).toBe(source.info.id)
  })

  test("info-only consumers honor explicit provenance and preserve legacy compatibility", () => {
    const human = message({ provenance: SessionTurnProvenance.user(SessionTurnProvenance.Source.Prompt) })
    const host = message({
      provenance: SessionTurnProvenance.host(SessionTurnProvenance.Source.GoalContinuation, {
        sourceMessageID: human.info.id,
      }),
    })
    const scheduled = message({
      provenance: SessionTurnProvenance.host(SessionTurnProvenance.Source.ScheduledTaskRun, { ref: "str_test" }),
    })
    const shell = message({ provenance: SessionTurnProvenance.user(SessionTurnProvenance.Source.Shell) })
    const legacy = message()

    expect(SessionTurnProvenance.semanticKindInfo(human.info)).toBe("user")
    expect(SessionTurnProvenance.semanticKindInfo(host.info)).toBe("synthetic")
    expect(SessionTurnProvenance.semanticKindInfo(shell.info)).toBe("shell")
    expect(SessionTurnProvenance.isWorkerPromptInfo(human.info)).toBe(true)
    expect(SessionTurnProvenance.isWorkerPromptInfo(scheduled.info)).toBe(true)
    expect(SessionTurnProvenance.isWorkerPromptInfo(host.info)).toBe(false)
    expect(SessionTurnProvenance.resolveInfo(legacy.info)).toEqual({
      owner: "user",
      source: "legacy.user",
      confidence: "legacy-inferred",
    })
  })
})
