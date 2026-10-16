import { Effect } from "effect"
import * as SubagentDelegation from "@/session/subagent-delegation"
import { Agent as AgentContract } from "@opencode-ai/schema/agent"

/**
 * Host-owned runtime for the built-in `dreamer` special agent.
 *
 * Dreamer is a member of the host-owned special-agent class
 * (`AgentContract.isSpecialAgentID`), not an ordinary delegated subagent: its
 * only launch entry point is this runtime, invoked by the lazy `dream` tool.
 * Execution still rides the Task `BackgroundJob`/child Session lifecycle owner
 * — detached worker Session, `task` permission admission, durable transcript,
 * completion notifications, and owned cancellation — deliberately instead of
 * introducing a second scheduler or a second worker-termination mechanism.
 *
 * Unlike the `SpecialAgentSession` per-owner transcripts (Title, Goal Auditor,
 * Prompt Revisor) a Dreamer child remains a resumable worker Session, so it is
 * intentionally not stamped with `specialAgent` transcript metadata.
 */
export const DREAMER_AGENT_ID = "dreamer"

export const INVESTIGATION_DESCRIPTION = "Dreamer historical investigation"

export const investigationPrompt = (focus: string | undefined) =>
  focus
    ? "Investigate historical knowledge only; report dated evidence, contradictions and uncommitted memory proposals. Focus: " +
      focus
    : undefined

export interface LaunchInput {
  readonly focus?: string
  /** Existing Dreamer child Session ID to continue; omit to start a detached child. */
  readonly taskID?: string
}

export const make = Effect.gen(function* () {
  if (!AgentContract.isSpecialAgentID(DREAMER_AGENT_ID))
    return yield* Effect.die(new Error("dreamer is not classified as a host-owned special agent"))
  const delegation = yield* SubagentDelegation.make

  const launch = Effect.fn("DreamerRuntime.launch")(function* (
    input: LaunchInput,
    context: SubagentDelegation.ExecutionContext,
  ) {
    const result = yield* delegation.executeSpecialAgent(
      {
        description: INVESTIGATION_DESCRIPTION,
        prompt: investigationPrompt(input.focus),
        agent: DREAMER_AGENT_ID,
        taskID: input.taskID,
      },
      context,
    )
    if (typeof result.metadata.sessionId !== "string" || result.metadata.background !== true)
      return yield* Effect.die(new Error("Dreamer delegation did not return a detached child Session receipt"))
    return result
  })

  return { launch }
})

export * as DreamerRuntime from "./dreamer-runtime"
