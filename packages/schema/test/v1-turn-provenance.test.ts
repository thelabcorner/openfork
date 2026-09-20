import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionV1, UserTurnSource } from "../src/session-v1"

const base = {
  id: "msg_1",
  sessionID: "ses_1",
  role: "user" as const,
  time: { created: 1 },
  agent: "build",
  model: { providerID: "test", modelID: "model" },
}

describe("V1 user-turn provenance", () => {
  test("exports the canonical browser-safe source vocabulary", () => {
    expect(UserTurnSource).toEqual({
      Prompt: "prompt",
      Command: "command",
      Shell: "shell",
      PlanApproval: "plan.approval",
      GoalStart: "goal.start",
      GoalUpdate: "goal.update",
      HostPrompt: "host.prompt",
      ScheduledTaskRun: "scheduled-task.run",
      TaskSummary: "task.summary",
      BackgroundShellSummary: "background.shell.summary",
      GoalSpecification: "goal.spec",
      GoalProgress: "goal.progress",
      GoalContinuation: "goal.continuation",
      RecoveryContinuation: "recovery.continuation",
      UnknownFinishContinuation: "provider.unknown-finish.continuation",
      Compaction: "compaction",
      CompactionReplay: "compaction.replay",
      CompactionContinue: "compaction.continue",
      PromptRevisor: "special-agent.prompt-revisor",
      GoalRevisor: "special-agent.goal-revisor",
      SessionTitle: "special-agent.session-title",
      GoalAuditor: "special-agent.goal-auditor",
      SpadAuditor: "special-agent.spad-auditor",
      ProjectCopyName: "host-helper.project-copy-name",
      OxpSupervisor: "oxp.supervisor",
      OxpDelegation: "oxp.delegation",
      SwarmAssignment: "swarm.assignment",
      SwarmPeer: "swarm.peer",
      SwarmContinuation: "swarm.continuation",
      SwarmRecovery: "swarm.recovery",
      SwarmNotice: "swarm.notice",
    })
  })

  test("keeps source open-ended for V1 compatibility while preserving explicit ownership", () => {
    const sourceMessageID = SessionV1.MessageID.make("msg_root")
    const decoded = Schema.decodeUnknownSync(SessionV1.User)({
      ...base,
      provenance: { owner: "host", source: "future.host-source", sourceMessageID, ref: "ref-1" },
    })
    expect(decoded.provenance).toEqual({
      owner: "host",
      source: "future.host-source",
      sourceMessageID,
      ref: "ref-1",
    })
  })

  test("legacy user messages without provenance remain valid", () => {
    const decoded = Schema.decodeUnknownSync(SessionV1.User)(base)
    expect(decoded.provenance).toBeUndefined()
  })

  test("accepts the historical lifetime marker without widening its vocabulary", () => {
    const decoded = Schema.decodeUnknownSync(SessionV1.User)({
      ...base,
      provenance: { owner: "user", source: UserTurnSource.Prompt, lifetime: "historical" },
    })
    expect(decoded.provenance).toEqual({ owner: "user", source: UserTurnSource.Prompt, lifetime: "historical" })
    expect(() =>
      Schema.decodeUnknownSync(SessionV1.User)({
        ...base,
        provenance: { owner: "user", source: UserTurnSource.Prompt, lifetime: "ephemeral" },
      }),
    ).toThrow()
  })
})
