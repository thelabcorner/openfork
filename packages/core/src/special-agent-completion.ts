import { LLMEvent, LLMResponse, Message, type Model } from "@opencode-ai/llm"
import { Duration, Effect } from "effect"
import * as Stream from "effect/Stream"
import {
  preferredToolChoice,
  rememberAutoOnlyToolChoice,
  type ToolChoiceCapabilityIdentity,
} from "./tool-choice-compatibility"

export type ToolChoice = "required" | "auto"

export const DEFAULT_SPECIAL_AGENT_TIMEOUT = Duration.minutes(5)

/**
 * Defensive terminal-tool result for runtimes that actually dispatch a
 * completion tool and feed its result back to the model. Normal special-agent
 * execution stops the provider stream as soon as the terminal tool-call event
 * is observed, so this text is a fallback rather than the primary stop signal.
 */
export function terminalCompletionAccepted(toolName: string) {
  return `Completion accepted via ${toolName}. END GENERATION NOW. Do not continue reasoning, emit prose or Markdown, or call any additional tools.`
}

const isTerminalToolCall = (toolName: string) => (event: LLMEvent) =>
  LLMEvent.is.toolCall(event) && event.providerExecuted !== true && event.name === toolName

/**
 * Consume a provider-neutral LLM event stream only until the special agent has
 * emitted its completed terminal tool call. `Stream.takeUntil` finalizes the
 * upstream stream scope as soon as that event is observed. Effect's HTTP client
 * aborts the active Fetch AbortController when a response stream is finalized,
 * and the WebSocket transport closes its acquireRelease-managed connection, so
 * this is an upstream cancellation signal rather than merely ignoring local
 * trailing events.
 *
 * Some protocols (notably OpenAI Chat) only publish the completed tool-call
 * event at their normal finish boundary. For those routes this is intentionally
 * a no-op optimization; for protocols that publish the tool call earlier, the
 * host deterministically stops consuming any trailing reasoning/text/tool work.
 */
export function collectUntilTerminalTool<E>(
  stream: Stream.Stream<LLMEvent, E>,
  toolName: string,
): Effect.Effect<LLMResponse | undefined, E> {
  const terminal = isTerminalToolCall(toolName)
  return stream.pipe(
    Stream.takeUntil(terminal),
    Stream.runCollect,
    Effect.map((chunk) => {
      const events = Array.from(chunk)
      const response = LLMResponse.fromEvents(events)
      if (response) return response
      if (!events.some(terminal)) return undefined
      return LLMResponse.fromEvents([...events, LLMEvent.finish({ reason: "tool-calls" })])
    }),
  )
}

/** Shared wall-clock guard for special-agent operations. Timeout interruption is
 * propagated through Effect scopes, so in-flight model/tool work is cancelled
 * rather than left running in the background. */
export function withSpecialAgentTimeout<A, E, E2>(
  effect: Effect.Effect<A, E>,
  orElse: () => Effect.Effect<A, E2>,
  duration: Duration.Input = DEFAULT_SPECIAL_AGENT_TIMEOUT,
): Effect.Effect<A, E | E2> {
  return effect.pipe(Effect.timeoutOrElse({ duration, orElse }))
}

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

export type TerminalFailureReason =
  | "missing"
  | "multiple"
  | "extra-tools"
  | "extra-content"
  | "invalid-payload"
  /**
   * The provider stopped at the output-token limit before the completion tool
   * call was finished. This is a host budget problem, not a model protocol
   * violation, so it is reported separately: retrying with the same budget
   * would truncate again, and the user-facing message must say so.
   */
  | "truncated"

/**
 * Per-attempt context handed to `generate` so runtimes can adapt the next
 * request to why the previous one failed - most importantly raising the output
 * token budget after a truncated attempt.
 */
export interface TerminalAttempt {
  readonly repairs: number
  readonly previous?: TerminalFailureReason
}

/**
 * Context handed to `validate` so domain validation can tighten or relax with
 * the remaining budget. `final` means no corrective retry is left, which is the
 * moment for a validator to salvage a partially usable artifact rather than
 * reject it and hand the user an error.
 */
export interface TerminalValidation {
  readonly repairs: number
  readonly final: boolean
}

/**
 * Shared output-budget escalation. A truncated attempt is retried with a larger
 * budget (bounded by `cap`, and by the provider/model maximum downstream);
 * every other failure reason keeps the base budget.
 */
export function retryMaxTokens(base: number, attempt: TerminalAttempt | undefined, cap = base * 4) {
  if (attempt?.previous !== "truncated") return base
  return Math.min(cap, Math.max(base, base * 2 * Math.max(1, attempt.repairs)))
}

/** Provider/model output ceiling as declared by the route or model defaults. */
export function modelOutputLimit(model: Model) {
  return model.defaults?.limits?.output ?? model.route.defaults.limits?.output
}

/**
 * Clamp a requested output budget to the model ceiling. Special agents ask for a
 * generous budget so long artifacts are not truncated mid-tool-call; providers
 * reject a request above their own maximum, so the ask has to be bounded.
 */
export function boundedMaxTokens(model: Model, requested: number) {
  const limit = modelOutputLimit(model)
  return limit === undefined ? requested : Math.min(requested, limit)
}

export const TRUNCATION_DETAIL =
  "the previous response hit the output token limit and was cut off before the completion tool call finished. Emit the completion tool call first, and keep the artifact as short as the task allows"

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
  return `Protocol correction: your previous response did not complete correctly.${why} You are the ${agentLabel}, and the only valid successful completion is a single ${toolName} tool call. Do not answer with prose, Markdown, or an explanation. Call ${toolName} now with the finished structured artifact, exactly once and as the only content-producing action in the response. IMMEDIATELY END GENERATION after the ${toolName} call. Do not reason, write text, or call another tool after it.`
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
      /**
       * Completion-tool calls that were actually present. A malformed *shape*
       * can still carry a usable artifact, which lets the protocol salvage the
       * work instead of failing the user once retries are exhausted.
       */
      readonly terminal: ReadonlyArray<LLMResponse["toolCalls"][number]>
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
 *
 * A single authoritative completion-tool call wins even if the provider/model
 * also emitted incidental prose. The host discards that prose and consumes only
 * the typed artifact. This keeps the protocol strict where it matters (the
 * artifact) without turning harmless model chatter into a user-visible failure.
 */
export function inspectTerminalCompletion(response: LLMResponse, toolName: string): TerminalInspection {
  const calls = response.toolCalls.filter((call) => call.providerExecuted !== true)
  const terminal = calls.filter((call) => call.name === toolName)
  const names = calls.map((call) => call.name)
  if (terminal.length === 1 && calls.length === 1) return { ok: true, call: terminal[0]! }
  const failure = (reason: Exclude<TerminalFailureReason, "invalid-payload">): TerminalInspection => ({
    ok: false,
    reason,
    calls: names,
    terminal,
  })
  if (terminal.length > 1) return failure("multiple")
  // A provider that stopped at the output limit never had a chance to emit the
  // completion tool call. Reporting that as "missing" both misleads the user and
  // sends a protocol correction the model cannot act on.
  if (terminal.length === 0) return failure(response.finishReason === "length" ? "truncated" : "missing")
  return failure("extra-tools")
}

/**
 * Shared terminal-artifact protocol for special agents.
 *
 * The previous assistant response is carried into the retry transcript before
 * the host correction is appended. Missing tools, wrong/multiple tools, and
 * invalid payloads all get the same bounded corrective retry. If a response has
 * exactly one valid completion-tool call plus incidental prose, the tool call is
 * authoritative and the prose is ignored. Arbitrary prose without the completion
 * tool is never interpreted as the artifact.
 */
/**
 * Transcript-format-agnostic terminal completion loop. This is the actual
 * protocol state machine; canonical Core callers use runTerminalCompletion,
 * while legacy host runtimes provide only a serialization adapter for their
 * message format.
 */
export function runTerminalCompletionWithTranscript<M, A = LLMResponse["toolCalls"][number], E = never>(input: {
  readonly messages: ReadonlyArray<M>
  readonly toolName: string
  readonly agentLabel?: string
  readonly maxRepairs?: number
  readonly generate: (messages: ReadonlyArray<M>, attempt: TerminalAttempt) => Effect.Effect<LLMResponse, E>
  readonly appendRepair: (messages: ReadonlyArray<M>, response: LLMResponse, detail?: string) => ReadonlyArray<M>
  readonly validate?: (
    call: LLMResponse["toolCalls"][number],
    context: TerminalValidation,
  ) => Effect.Effect<A, string>
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
    if (repairs < maxRepairs) return loop(input.appendRepair(messages, response, detail), repairs + 1, reason)
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

  /**
   * A structurally malformed turn (extra tool calls alongside the completion, or
   * repeated completion calls) can still carry a fully valid artifact. The
   * protocol keeps asking for a clean turn while retries remain, but once they
   * are exhausted, committing the last valid artifact beats discarding finished
   * work over turn shape. Missing and truncated completions have nothing to
   * salvage and still fail.
   */
  const salvage = (
    response: LLMResponse,
    messages: ReadonlyArray<M>,
    repairs: number,
    inspection: Extract<TerminalInspection, { ok: false }>,
  ): Effect.Effect<TerminalResult<A, M>, E> | undefined => {
    if (repairs < maxRepairs) return undefined
    const call = inspection.terminal.at(-1)
    if (!call) return undefined
    if (!input.validate) return Effect.succeed({ response, call, artifact: call as A, messages, repairs })
    return input.validate(call, { repairs, final: true }).pipe(
      Effect.map((artifact) => ({ response, call, artifact, messages, repairs })),
      Effect.catch(() => fail(response, messages, repairs, inspection.reason)),
    )
  }

  const loop = (
    messages: ReadonlyArray<M>,
    repairs: number,
    previous?: TerminalFailureReason,
  ): Effect.Effect<TerminalResult<A, M>, E> =>
    input.generate(messages, { repairs, ...(previous ? { previous } : {}) }).pipe(
      Effect.flatMap((response) => {
        const inspection = inspectTerminalCompletion(response, input.toolName)
        if (!inspection.ok) {
          return (
            salvage(response, messages, repairs, inspection) ??
            fail(
              response,
              messages,
              repairs,
              inspection.reason,
              inspection.reason === "truncated" ? TRUNCATION_DETAIL : undefined,
            )
          )
        }

        const call = inspection.call
        if (!input.validate) {
          return Effect.succeed({ response, call, artifact: call as A, messages, repairs })
        }
        return input.validate(call, { repairs, final: repairs >= maxRepairs }).pipe(
          Effect.map((artifact) => ({ response, call, artifact, messages, repairs })),
          Effect.catch((detail) =>
            fail(
              response,
              messages,
              repairs,
              // A completion tool call cut off mid-payload decodes as an invalid
              // artifact. Attribute it to the budget so the retry gets more room
              // instead of repeating the same doomed request.
              response.finishReason === "length" ? "truncated" : "invalid-payload",
              response.finishReason === "length" ? `${detail} (${TRUNCATION_DETAIL})` : detail,
            ),
          ),
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
  readonly generate: (messages: ReadonlyArray<Message>, attempt: TerminalAttempt) => Effect.Effect<LLMResponse, E>
  readonly validate?: (
    call: LLMResponse["toolCalls"][number],
    context: TerminalValidation,
  ) => Effect.Effect<A, string>
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
  /**
   * Corrective attempts *after* the first repair turn. Defaults to one extra
   * attempt: a single all-or-nothing retry turns a routine protocol wobble into
   * a user-visible failure.
   */
  readonly maxRepairs?: number
  readonly generate: (messages: ReadonlyArray<Message>, attempt: TerminalAttempt) => Effect.Effect<LLMResponse, E>
  readonly validate?: (
    call: LLMResponse["toolCalls"][number],
    context: TerminalValidation,
  ) => Effect.Effect<A, string>
  readonly invalid: (failure: TerminalFailure) => E
}): Effect.Effect<TerminalResult<A>, E> {
  return runTerminalCompletion({
    messages: appendCompletionRepair(input.messages, input.response, input.toolName, input.agentLabel, input.detail),
    toolName: input.toolName,
    agentLabel: input.agentLabel,
    maxRepairs: input.maxRepairs ?? 1,
    generate: input.generate,
    validate: input.validate,
    invalid: input.invalid,
  })
}
