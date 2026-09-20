import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { SessionMessage } from "../src/session/message"
import { SessionTurnProvenance } from "../src/session/turn-provenance"

const created = DateTime.makeUnsafe(0)
const id = (value: string) => SessionMessage.ID.make(`msg_${value}`)

const user = (value: string, provenance?: SessionMessage.Provenance) =>
  SessionMessage.User.make({
    id: id(value),
    type: "user",
    text: value,
    provenance,
    time: { created },
  })

describe("current Session turn provenance", () => {
  test("enforces first-party owner and causal-root construction", () => {
    expect(() => SessionTurnProvenance.host(SessionTurnProvenance.Source.Prompt)).toThrow("owned by user")
    expect(() => SessionTurnProvenance.user(SessionTurnProvenance.Source.GoalContinuation)).toThrow("owned by host")
    expect(() => SessionTurnProvenance.host(SessionTurnProvenance.Source.GoalContinuation)).toThrow(
      "requires a canonical sourceMessageID",
    )
    expect(() => SessionTurnProvenance.host(SessionTurnProvenance.Source.ScheduledTaskRun)).toThrow(
      "requires a durable correlation ref",
    )
  })

  test("distinguishes semantic user authority from trusted host worker roots", () => {
    const human = user("human", SessionTurnProvenance.user(SessionTurnProvenance.Source.Prompt))
    const host = user("host", SessionTurnProvenance.host(SessionTurnProvenance.Source.HostPrompt))
    const scheduled = user(
      "scheduled",
      SessionTurnProvenance.host(SessionTurnProvenance.Source.ScheduledTaskRun, { ref: "str_test" }),
    )
    expect(SessionTurnProvenance.isSemanticUserTurn(human)).toBe(true)
    expect(SessionTurnProvenance.isGoalAuthorizationTurn(human)).toBe(true)
    expect(SessionTurnProvenance.isDurableUserActionAuthorizationTurn(human)).toBe(true)
    expect(SessionTurnProvenance.isWorkerPromptTurn(host)).toBe(true)
    expect(SessionTurnProvenance.isWorkerPromptTurn(scheduled)).toBe(true)
    expect(SessionTurnProvenance.isSemanticUserTurn(host)).toBe(false)
    expect(SessionTurnProvenance.semanticKind(scheduled)).toBe("synthetic")
    expect(SessionTurnProvenance.isGoalAuthorizationTurn(host)).toBe(false)
    expect(SessionTurnProvenance.isGoalAuthorizationTurn(scheduled)).toBe(false)
    expect(SessionTurnProvenance.isDurableUserActionAuthorizationTurn(host)).toBe(false)
    expect(SessionTurnProvenance.isDurableUserActionAuthorizationTurn(scheduled)).toBe(false)
    expect(SessionTurnProvenance.causalRootMessageID(scheduled)).toBe(scheduled.id)
  })

  test("treats native root Synthetic producers as worker roots without granting user authority", () => {
    const scheduled = SessionMessage.Synthetic.make({
      id: id("scheduled-native"),
      type: "synthetic",
      sessionID: "ses_test" as never,
      text: "run scheduled work",
      provenance: SessionTurnProvenance.host(SessionTurnProvenance.Source.ScheduledTaskRun, {
        ref: "str_native_root",
      }),
      time: { created },
    })

    expect(SessionTurnProvenance.isWorkerPromptTurn(scheduled)).toBe(true)
    expect(SessionTurnProvenance.isSemanticUserTurn(scheduled)).toBe(false)
    expect(SessionTurnProvenance.isGoalAuthorizationTurn(scheduled)).toBe(false)
    expect(SessionTurnProvenance.causalRootMessageID(scheduled)).toBe(scheduled.id)
    expect(SessionTurnProvenance.currentWorkerRootMessageID([scheduled])).toBe(scheduled.id)
  })

  test("flattens derived Goal and compaction lineage to one worker root", () => {
    const root = user("root", SessionTurnProvenance.user(SessionTurnProvenance.Source.Prompt))
    const goal = SessionMessage.Synthetic.make({
      id: id("goal"),
      type: "synthetic",
      sessionID: "ses_test" as never,
      text: "continue",
      provenance: SessionTurnProvenance.hostDerived(SessionTurnProvenance.Source.GoalContinuation, root, {
        ref: "reservation-1",
      }),
      time: { created },
    })
    const compaction = SessionMessage.Compaction.make({
      id: id("compaction"),
      type: "compaction",
      reason: "auto",
      summary: "summary",
      recent: "recent",
      provenance: SessionTurnProvenance.hostDerived(SessionTurnProvenance.Source.Compaction, goal),
      time: { created },
    })
    expect(SessionTurnProvenance.causalRootMessageID(goal)).toBe(root.id)
    expect(SessionTurnProvenance.causalRootMessageID(compaction)).toBe(root.id)
    expect(SessionTurnProvenance.currentWorkerRootMessageID([root, goal, compaction])).toBe(root.id)
  })

  test("legacy derived rows may recover by adjacency but explicit broken lineage fails closed", () => {
    const root = user("legacy")
    const legacy = SessionMessage.Synthetic.make({
      id: id("legacy-synthetic"),
      type: "synthetic",
      sessionID: "ses_test" as never,
      text: "legacy",
      time: { created },
    })
    const malformed = SessionMessage.Synthetic.make({
      id: id("malformed"),
      type: "synthetic",
      sessionID: "ses_test" as never,
      text: "broken",
      provenance: { owner: "host", source: SessionTurnProvenance.Source.GoalContinuation },
      time: { created },
    })
    expect(SessionTurnProvenance.currentWorkerRootMessageID([root, legacy])).toBe(root.id)
    expect(SessionTurnProvenance.currentWorkerRootMessageID([root, malformed])).toBeUndefined()
  })

  test("state projections neither become nor obscure the active worker root", () => {
    const root = user("root-state", SessionTurnProvenance.user(SessionTurnProvenance.Source.Prompt))
    const state = SessionMessage.Synthetic.make({
      id: id("goal-state"),
      type: "synthetic",
      sessionID: "ses_test" as never,
      text: "goal progress",
      provenance: SessionTurnProvenance.host(SessionTurnProvenance.Source.GoalProgress, {
        ref: "goal.progress:gol_1:abc",
      }),
      time: { created },
    })

    expect(SessionTurnProvenance.causalRootMessageID(state)).toBeUndefined()
    expect(SessionTurnProvenance.isStateProjection(state)).toBe(true)
    expect(SessionTurnProvenance.currentWorkerRootMessageID([root, state])).toBe(root.id)
    expect(SessionTurnProvenance.requiresLegacyWorkerRootLookup([root, state])).toBe(false)
  })

  test("historical current turns preserve semantic presentation without live authority", () => {
    const root = user("live-before-history", SessionTurnProvenance.user(SessionTurnProvenance.Source.Prompt))
    const historical = user("historical", {
      ...SessionTurnProvenance.user(SessionTurnProvenance.Source.Prompt),
      lifetime: "historical",
    })
    const historicalContinuation = SessionMessage.Synthetic.make({
      id: id("historical-continuation"),
      type: "synthetic",
      sessionID: "ses_test" as never,
      text: "historical continuation",
      provenance: {
        ...SessionTurnProvenance.hostDerived(SessionTurnProvenance.Source.GoalContinuation, root),
        lifetime: "historical",
      },
      time: { created },
    })
    const historicalState = SessionMessage.Synthetic.make({
      id: id("historical-state"),
      type: "synthetic",
      sessionID: "ses_test" as never,
      text: "historical state",
      provenance: {
        ...SessionTurnProvenance.host(SessionTurnProvenance.Source.GoalProgress, { ref: "goal.progress:old" }),
        lifetime: "historical",
      },
      time: { created },
    })

    expect(SessionTurnProvenance.isSemanticUserTurn(historical)).toBe(true)
    expect(SessionTurnProvenance.isWorkerPromptTurn(historical)).toBe(false)
    expect(SessionTurnProvenance.isGoalAuthorizationTurn(historical)).toBe(false)
    expect(SessionTurnProvenance.causalRootMessageID(historical)).toBeUndefined()
    expect(SessionTurnProvenance.causalRootMessageID(historicalContinuation)).toBeUndefined()
    expect(SessionTurnProvenance.isStateProjection(historicalState)).toBe(false)
    expect(SessionTurnProvenance.hasStateSemantics(historicalState)).toBe(true)
    expect(SessionTurnProvenance.causalRootMessageID(historicalState)).toBeUndefined()
    expect(SessionTurnProvenance.currentWorkerRootMessageID([root, historicalContinuation])).toBe(root.id)
    expect(SessionTurnProvenance.currentWorkerRootMessageID([root, historicalState])).toBe(root.id)
    expect(SessionTurnProvenance.currentWorkerRootMessageID([root, historical])).toBe(root.id)
  })

  test("historical rows are transparent to legacy-root fallback discovery", () => {
    const legacy = SessionMessage.Synthetic.make({
      id: id("legacy-before-history"),
      type: "synthetic",
      sessionID: "ses_test" as never,
      text: "legacy derived row",
      time: { created },
    })
    const historical = user("historical-tail", {
      ...SessionTurnProvenance.user(SessionTurnProvenance.Source.Prompt),
      lifetime: "historical",
    })

    expect(SessionTurnProvenance.requiresLegacyWorkerRootLookup([legacy, historical])).toBe(true)
  })
})
