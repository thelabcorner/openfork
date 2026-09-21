export * as SystemOneClient from "./system-one"

import { Duration, Effect, Schema } from "effect"
import { Headers } from "effect/unstable/http"
import { SystemOne as Contract } from "@opencode-ai/schema/system-one"
import {
  InvalidProviderOutputReason,
  InvalidRequestReason,
  LLMError,
  TransportReason,
} from "./schema"
import { RequestExecutor } from "./route/executor"
import * as ProviderShared from "./protocols/shared"

const MODULE = "SystemOne"
const METHOD = "infer"
export const DEFAULT_TIMEOUT_MS = 10_000

const WireRequest = Schema.Struct({
  model: Schema.String,
  state: Contract.Content,
  questions: Contract.Questions,
})

const encodeWireRequest = Schema.encodeSync(Schema.fromJsonString(WireRequest))
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

export interface Input {
  readonly baseURL: string
  readonly model: string
  readonly state: Contract.Content
  readonly questions: Contract.Questions
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}

export interface Output {
  readonly model: string
  readonly answers: Readonly<Record<string, Contract.Answer>>
  readonly usage: Contract.Usage
  readonly raw: typeof Schema.Json.Type
}

const invalidRequest = (message: string) =>
  new LLMError({
    module: MODULE,
    method: METHOD,
    reason: new InvalidRequestReason({ message }),
  })

const invalidOutput = (message: string, raw?: string) =>
  new LLMError({
    module: MODULE,
    method: METHOD,
    reason: new InvalidProviderOutputReason({ message, route: "system-one", raw }),
  })

const transportError = (message: string, kind?: string) =>
  new LLMError({
    module: MODULE,
    method: METHOD,
    reason: new TransportReason({ message, kind }),
  })

export function endpoint(baseURL: string): string {
  const base = baseURL.replace(/\/+$/, "")
  return base.endsWith("/systemone") ? base : `${base}/systemone`
}

export function validateQuestions(questions: Contract.Questions): void {
  const entries = Object.entries(questions)
  if (entries.length === 0) throw invalidRequest("System One requires at least one question")
  for (const [id, question] of entries) {
    if (!id.trim()) throw invalidRequest("System One question ids must not be empty")
    if (question.type === "choice" && Object.keys(question.criteria).length === 0) {
      throw invalidRequest(`System One choice question "${id}" requires at least one criterion`)
    }
    if (question.type === "score" && (question.criteria.length < 2 || question.criteria.length > 10)) {
      throw invalidRequest(`System One score question "${id}" requires between 2 and 10 ordered criteria`)
    }
  }
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidOutput(`${field} must be an object`)
  return value as Record<string, unknown>
}

function finite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalidOutput(`${field} must be a finite number`)
  return value
}

function probability(value: unknown, field: string): number {
  const result = finite(value, field)
  if (result < 0 || result > 1) throw invalidOutput(`${field} must be between 0 and 1`)
  return result
}

function probabilityRecord(value: unknown, field: string): Record<string, number> {
  const source = object(value, field)
  return Object.fromEntries(Object.entries(source).map(([key, item]) => [key, probability(item, `${field}.${key}`)]))
}

function exactKeys(actual: Record<string, unknown>, expected: ReadonlyArray<string>, field: string) {
  const expectedSet = new Set(expected)
  const actualKeys = Object.keys(actual)
  if (actualKeys.length !== expected.length || actualKeys.some((key) => !expectedSet.has(key))) {
    throw invalidOutput(`${field} keys must exactly match the requested criteria`)
  }
}

function answer(id: string, question: Contract.Question, value: unknown): Contract.Answer {
  const raw = object(value, `answers.${id}`)
  if (raw.type !== question.type) {
    throw invalidOutput(`answers.${id}.type must match requested question type "${question.type}"`)
  }
  if (question.type === "noul") {
    return { type: "noul", noul: probability(raw.noul, `answers.${id}.noul`) }
  }

  const confidence = probability(raw.confidence, `answers.${id}.confidence`)
  const probabilities = probabilityRecord(raw.probabilities, `answers.${id}.probabilities`)

  if (question.type === "choice") {
    if (typeof raw.choice !== "string" || !(raw.choice in question.criteria)) {
      throw invalidOutput(`answers.${id}.choice must be one of the requested criteria`)
    }
    exactKeys(probabilities, Object.keys(question.criteria), `answers.${id}.probabilities`)
    return { type: "choice", choice: raw.choice, confidence, probabilities }
  }

  const score = finite(raw.score, `answers.${id}.score`)
  if (score < 0 || score > question.criteria.length - 1) {
    throw invalidOutput(`answers.${id}.score must be between 0 and ${question.criteria.length - 1}`)
  }
  const expected = question.criteria.map((_, index) => String(index))
  exactKeys(probabilities, expected, `answers.${id}.probabilities`)
  const legend = object(raw.legend, `answers.${id}.legend`)
  exactKeys(legend, expected, `answers.${id}.legend`)
  if (!Schema.is(Schema.Record(Schema.String, Contract.Criterion))(legend)) {
    throw invalidOutput(`answers.${id}.legend contains invalid criterion content`)
  }
  return {
    type: "score",
    score,
    confidence,
    probabilities,
    legend,
  }
}

export function decodeResponse(questions: Contract.Questions, raw: typeof Schema.Json.Type): Output {
  const body = object(raw, "response")
  if (typeof body.model !== "string" || body.model.length === 0) {
    throw invalidOutput("response.model must be a non-empty string")
  }
  const source = object(body.answers, "response.answers")
  exactKeys(source, Object.keys(questions), "response.answers")
  const answers = Object.fromEntries(
    Object.entries(questions).map(([id, question]) => [id, answer(id, question, source[id])]),
  )
  const usage = object(body.usage, "response.usage")
  const inputTokens = finite(usage.input_tokens, "response.usage.input_tokens")
  const outputTokens = finite(usage.output_tokens, "response.usage.output_tokens")
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(outputTokens) || outputTokens < 0) {
    throw invalidOutput("response usage token counts must be non-negative safe integers")
  }
  return {
    model: body.model,
    answers,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    raw,
  }
}

export const infer = Effect.fn("SystemOneClient.infer")(function* (input: Input) {
  yield* Effect.try({
    try: () => validateQuestions(input.questions),
    catch: (error) =>
      error instanceof LLMError ? error : invalidRequest("System One request validation failed"),
  })
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return yield* invalidRequest("System One timeoutMs must be a positive safe integer")
  }

  const executor = yield* RequestExecutor.Service
  const body = encodeWireRequest({
    model: input.model,
    state: input.state,
    questions: input.questions,
  })
  const request = ProviderShared.jsonPost({
    url: endpoint(input.baseURL),
    body,
    headers: Headers.fromInput(input.headers ?? {}),
  })

  // System One is a semantic control-plane primitive: callers need the first
  // provider classification (notably RateLimit/QuotaExceeded) so they can make
  // an explicit fallback/escalation decision. Shared chat transport retries
  // remain unchanged; this path deliberately opts out instead of allowing
  // retry backoff to consume the operation deadline and masquerade as timeout.
  const execute = executor.execute(request, { retry: false }).pipe(
    Effect.flatMap((response) =>
      response.text.pipe(
        Effect.mapError(() => transportError("Failed to read System One response body", "ResponseBody")),
      ),
    ),
    Effect.flatMap((text) =>
      decodeJson(text).pipe(
        Effect.mapError(() => invalidOutput("System One upstream returned invalid JSON", text.slice(0, 4096))),
      ),
    ),
    Effect.flatMap((raw) =>
      Effect.try({
        try: () => decodeResponse(input.questions, raw),
        catch: (error) =>
          error instanceof LLMError ? error : invalidOutput("System One upstream returned an invalid response"),
      }),
    ),
  )

  return yield* Effect.raceFirst(
    execute,
    Effect.sleep(Duration.millis(timeoutMs)).pipe(
      Effect.flatMap(() => Effect.fail(transportError(`System One request timed out after ${timeoutMs}ms`, "Timeout"))),
    ),
  )
})
