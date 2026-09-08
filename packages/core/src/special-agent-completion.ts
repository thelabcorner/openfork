import { LLMResponse, Message } from "@opencode-ai/llm"
import { Effect } from "effect"
import {
  preferredToolChoice,
  rememberAutoOnlyToolChoice,
  type ToolChoiceCapabilityIdentity,
} from "./tool-choice-compatibility"

export type ToolChoice = "required" | "auto"

export interface AdaptiveResult<A> {
  readonly value: A
  readonly toolChoice: ToolChoice
}

/**
 * Shared runtime negotiation for special-agent tool forcing.
 *
 * Strong forcing is attempted until an upstream explicitly proves that it only
 * accepts `auto`. That observation is retained by the shared capability memory,
 * so Prompt Revisor, Title, Goal Auditor, and future special agents all learn
 * from the same provider/model/route negotiation.
 */
export function runAdaptiveToolChoice<A, E>(input: {
  readonly identity: ToolChoiceCapabilityIdentity
  readonly preferred?: ToolChoice
  readonly run: (toolChoice: ToolChoice) => Effect.Effect<A, E>
  readonly onDowngrade?: () => Effect.Effect<void>
}): Effect.Effect<AdaptiveResult<A>, E> {
  const preferred = input.preferred ?? "required"
  const initial = preferredToolChoice(input.identity, preferred) as ToolChoice
  return input.run(initial).pipe(
    Effect.map((value) => ({ value, toolChoice: initial }) satisfies AdaptiveResult<A>),
    Effect.catch((error) => {
      if (initial !== "required" || !rememberAutoOnlyToolChoice(input.identity, error)) return Effect.fail(error)
      return (input.onDowngrade ?? (() => Effect.void))().pipe(
        Effect.andThen(input.run("auto")),
        Effect.map((value) => ({ value, toolChoice: "auto" as const })),
      )
    }),
  )
}

/** Convenience adapter for host runtimes that need the negotiated choice back. */
export function generateAdaptive<A, E>(input: {
  readonly identity: ToolChoiceCapabilityIdentity
  readonly requested: ToolChoice
  readonly generate: (toolChoice: ToolChoice) => Effect.Effect<A, E>
  readonly onDowngrade?: () => Effect.Effect<void>
}): Effect.Effect<{ readonly response: A; readonly toolChoice: ToolChoice }, E> {
  return runAdaptiveToolChoice({
    identity: input.identity,
    preferred: input.requested,
    run: input.generate,
    onDowngrade: input.onDowngrade,
  }).pipe(Effect.map((result) => ({ response: result.value, toolChoice: result.toolChoice })))
}

export type TerminalFailureReason = "missing" | "multiple" | "extra-tools" | "extra-content" | "invalid-payload"

export interface TerminalFailure {
  readonly toolName: string
  readonly reason: TerminalFailureReason
  readonly calls: ReadonlyArray<string>
  readonly repairs: number
  readonly detail?: string
}

export interface TerminalResult<A = LLMResponse["toolCalls"][number], M = Message> {
  readonly response: LLMResponse
  readonly call: LLMResponse["toolCalls"][number]
  readonly artifact: A
  readonly messages: ReadonlyArray<M>
  readonly repairs: number
}

export function repairPrompt(toolName: string, agentLabel = "special agent", detail?: string) {
  const why = detail?.trim() ? ` The host rejected the previous completion because: ${detail.trim()}.` : ""
  return `Protocol correction: your previous response did not complete correctly.${why} You are the ${agentLabel}, and the only valid successful completion is a single ${toolName} tool call. Do not answer with prose, Markdown, or an explanation. Call ${toolName} now with the finished structured artifact, exactly once and as the only content-producing action in the response.`
}

const callNames = (response: LLMResponse) =>
  response.toolCalls.filter((call) => call.providerExecuted !== true).map((call) => call.name)

export type TerminalInspection =
  | {
      readonly ok: true
      readonly call: LLMResponse["toolCalls"][number]
    }
  | {
      readonly ok: false
      readonly reason: Exclude<TerminalFailureReason, "invalid-payload">
      readonly calls: ReadonlyArray<string>
    }

/**
 * Append a failed completion attempt to the same canonical special-agent
 * transcript, settle any unresolved tool calls with host errors, then add the
 * protocol-correction turn. This keeps retry semantics provider-valid without
 * restarting the agent from the original prompt.
 */
export function appendCompletionRepair(
  messages: ReadonlyArray<Message>,
  response: LLMResponse,
  toolName: string,
  agentLabel?: string,
  detail?: string,
) {
  const next: Message[] = [...messages, response.message]
  for (const call of response.toolCalls.filter((item) => item.providerExecuted !== true)) {
    next.push(
      Message.tool({
        id: call.id,
        name: call.name,
        result: `Protocol error: this special-agent turn did not complete correctly. The required completion tool is ${toolName}.`,
        resultType: "error",
      }),
    )
  }
  next.push(Message.user(repairPrompt(toolName, agentLabel, detail)))
  return next
}

/**
 * Pure terminal-shape inspection shared by canonical special-agent runtimes and
 * legacy host adapters. Domain payload validation intentionally remains outside
 * this function.
 */
export function inspectTerminalCompletion(response: LLMResponse, toolName: string): TerminalInspection {
  const calls = response.toolCalls.filter((call) => call.providerExecuted !== true)
  const terminal = calls.filter((call) => call.name === toolName)
  const names = calls.map((call) => call.name)
  if (calls.length === 0) return { ok: false, reason: "missing", calls: names }
  if (terminal.length > 1) return { ok: false, reason: "multiple", calls: names }
  if (terminal.length === 0) return { ok: false, reason: "missing", calls: names }
  if (calls.length !== 1) return { ok: false, reason: "extra-tools", calls: names }
  if (response.text.trim()) return { ok: false, reason: "extra-content", calls: names }
  return { ok: true, call: terminal[0]! }
}

/**
 * Shared terminal-artifact protocol for special agents.
 *
 * The previous assistant response is carried into the retry transcript before
 * the host correction is appended. Missing tools, wrong/multiple tools, prose
 * alongside the completion call, and invalid payloads all get the same bounded
 * corrective retry. Arbitrary prose is never interpreted as the artifact.
 */
/**
 * Transcript-format-agnostic terminal completion loop. This is the actual
 * protocol state machine; canonical Core callers use runTerminalCompletion,
 * while legacy host runtimes provide only a serialization adapter for their
 * message format.
 */
export function runTerminalCompletionWithTranscript<
  M,
  A = LLMResponse["toolCalls"][number],
  E = never,
>(input: {
  readonly messages: ReadonlyArray<M>
  readonly toolName: string
  readonly agentLabel?: string
  readonly maxRepairs?: number
  readonly generate: (messages: ReadonlyArray<M>) => Effect.Effect<LLMResponse, E>
  readonly appendRepair: (
    messages: ReadonlyArray<M>,
    response: LLMResponse,
    detail?: string,
  ) => ReadonlyArray<M>
  readonly validate?: (call: LLMResponse["toolCalls"][number]) => Effect.Effect<A, string>
  readonly invalid: (failure: TerminalFailure) => E
}): Effect.Effect<TerminalResult<A, M>, E> {
  const maxRepairs = Math.max(0, input.maxRepairs ?? 1)

  const fail = (
    response: LLMResponse,
    messages: ReadonlyArray<M>,
    repairs: number,
    reason: TerminalFailureReason,
    detail?: string,
  ): Effect.Effect<TerminalResult<A, M>, E> => {
    if (repairs < maxRepairs) return loop(input.appendRepair(messages, response, detail), repairs + 1)
    return Effect.fail(
      input.invalid({
        toolName: input.toolName,
        reason,
        calls: callNames(response),
        repairs,
        ...(detail ? { detail } : {}),
      }),
    )
  }

  const loop = (messages: ReadonlyArray<M>, repairs: number): Effect.Effect<TerminalResult<A, M>, E> =>
    input.generate(messages).pipe(
      Effect.flatMap((response) => {
        const inspection = inspectTerminalCompletion(response, input.toolName)
        if (!inspection.ok) return fail(response, messages, repairs, inspection.reason)

        const call = inspection.call
        if (!input.validate) {
          return Effect.succeed({ response, call, artifact: call as A, messages, repairs })
        }
        return input.validate(call).pipe(
          Effect.map((artifact) => ({ response, call, artifact, messages, repairs })),
          Effect.catch((detail) => fail(response, messages, repairs, "invalid-payload", detail)),
        )
      }),
    )

  return loop(input.messages, 0)
}

export function runTerminalCompletion<A = LLMResponse["toolCalls"][number], E = never>(input: {
  readonly messages: ReadonlyArray<Message>
  readonly toolName: string
  readonly agentLabel?: string
  readonly maxRepairs?: number
  readonly generate: (messages: ReadonlyArray<Message>) => Effect.Effect<LLMResponse, E>
  readonly validate?: (call: LLMResponse["toolCalls"][number]) => Effect.Effect<A, string>
  readonly invalid: (failure: TerminalFailure) => E
}): Effect.Effect<TerminalResult<A>, E> {
  return runTerminalCompletionWithTranscript({
    ...input,
    appendRepair: (messages, response, detail) =>
      appendCompletionRepair(messages, response, input.toolName, input.agentLabel, detail),
  })
}

/**
 * Repair an already-produced malformed terminal attempt without replaying its
 * original generation. Agentic loops use this after prose/no-tool, mixed tool
 * usage, or an invalid terminal payload when the next turn should continue the
 * same transcript and commit the artifact immediately.
 */
export function repairMissingCompletion<A = LLMResponse["toolCalls"][number], E = never>(input: {
  readonly messages: ReadonlyArray<Message>
  readonly response: LLMResponse
  readonly toolName: string
  readonly agentLabel?: string
  readonly detail?: string
  readonly generate: (messages: ReadonlyArray<Message>) => Effect.Effect<LLMResponse, E>
  readonly validate?: (call: LLMResponse["toolCalls"][number]) => Effect.Effect<A, string>
  readonly invalid: (failure: TerminalFailure) => E
}): Effect.Effect<TerminalResult<A>, E> {
  return runTerminalCompletion({
    messages: appendCompletionRepair(input.messages, input.response, input.toolName, input.agentLabel, input.detail),
    toolName: input.toolName,
    agentLabel: input.agentLabel,
    maxRepairs: 0,
    generate: input.generate,
    validate: input.validate,
    invalid: input.invalid,
  })
}
