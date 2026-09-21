import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SystemOne as Contract } from "@opencode-ai/schema/system-one"
import { LLMError } from "../src/schema"
import { SystemOneClient } from "../src/system-one"
import { RequestExecutor } from "../src/route"
import { dynamicResponse } from "./lib/http"
import { it } from "./lib/effect"

const questions = {
  should_escalate: {
    type: "noul",
    instructions: "The case should be escalated.",
  },
  route: {
    type: "choice",
    instructions: "Choose the next route.",
    criteria: {
      allow: "Proceed normally",
      inspect: "Needs more inspection",
      reject: "Reject the candidate",
    },
  },
  quality: {
    type: "score",
    instructions: "Score the candidate quality.",
    criteria: ["poor", "acceptable", "excellent"],
  },
} satisfies Contract.Questions

const response = {
  model: "jev-1.13-free",
  answers: {
    should_escalate: { type: "noul", noul: 0.137 },
    route: {
      type: "choice",
      choice: "inspect",
      confidence: 0.71,
      probabilities: { allow: 0.17, inspect: 0.72, reject: 0.11 },
    },
    quality: {
      type: "score",
      score: 1.42,
      confidence: 0.63,
      probabilities: { "0": 0.08, "1": 0.42, "2": 0.5 },
      legend: { "0": "poor", "1": "acceptable", "2": "excellent" },
    },
  },
  usage: { input_tokens: 123, output_tokens: 17 },
  request_id: "req-preserve-me",
} as const

const unexpectedTransport = Layer.succeed(
  RequestExecutor.Service,
  RequestExecutor.Service.of({
    execute: () => Effect.die("System One validation should fail before transport"),
  }),
)

describe("SystemOneClient", () => {
  it.effect("posts the typed request to /systemone and preserves raw probabilities", () =>
    Effect.gen(function* () {
      let seenURL = ""
      let seenAuth = ""
      let seenBody: unknown
      const layer = dynamicResponse((input) =>
        Effect.sync(() => {
          seenURL = input.request.url
          seenAuth = input.request.headers.authorization ?? ""
          seenBody = JSON.parse(input.text)
          return input.respond(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } })
        }),
      )

      const result = yield* SystemOneClient.infer({
        baseURL: "https://opencode.ai/zen/v1/",
        model: "jev-1.13-free",
        state: { candidate: "proof-17", evidence: ["a", "b"] },
        questions,
        headers: { authorization: "Bearer secret-never-log" },
      }).pipe(Effect.provide(layer))

      expect(seenURL).toBe("https://opencode.ai/zen/v1/systemone")
      expect(seenAuth).toBe("Bearer secret-never-log")
      expect(seenBody).toEqual({
        model: "jev-1.13-free",
        state: { candidate: "proof-17", evidence: ["a", "b"] },
        questions,
      })
      expect(result.answers.should_escalate).toEqual({ type: "noul", noul: 0.137 })
      expect(result.answers.route).toEqual(response.answers.route)
      expect(result.answers.quality).toEqual(response.answers.quality)
      expect(result.raw).toEqual(response)
      expect((result.raw as Record<string, unknown>).request_id).toBe("req-preserve-me")
    }),
  )

  it.effect("keeps authentication failures distinct and redacts credentials", () =>
    Effect.gen(function* () {
      const secret = "credential-that-must-not-leak"
      const layer = dynamicResponse((input) =>
        Effect.succeed(
          input.respond(JSON.stringify({ error: { message: `bad key ${secret}` } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
        ),
      )
      const error = yield* SystemOneClient.infer({
        baseURL: "https://opencode.ai/zen/v1",
        model: "jev-1.13-free",
        state: "candidate",
        questions: { valid: questions.should_escalate },
        headers: { authorization: `Bearer ${secret}` },
      }).pipe(Effect.provide(layer), Effect.flip)

      expect(error).toBeInstanceOf(LLMError)
      if (!(error instanceof LLMError)) return
      expect(error.reason._tag).toBe("Authentication")
      expect(error.message).not.toContain(secret)
      expect(JSON.stringify(error)).not.toContain(secret)
    }),
  )

  it.effect("surfaces provider rate limits immediately instead of timing out in retry backoff", () =>
    Effect.gen(function* () {
      let attempts = 0
      const layer = dynamicResponse((input) =>
        Effect.sync(() => {
          attempts += 1
          return input.respond(
            JSON.stringify({
              type: "error",
              error: { type: "FreeUsageLimitError", message: "Rate limit exceeded. Please try again later." },
            }),
            {
              status: 429,
              headers: { "content-type": "application/json", "retry-after": "30" },
            },
          )
        }),
      )

      const error = yield* SystemOneClient.infer({
        baseURL: "https://opencode.ai/zen/v1",
        model: "jev-1.13-free",
        state: "candidate",
        questions: { valid: questions.should_escalate },
        timeoutMs: 50,
      }).pipe(Effect.provide(layer), Effect.flip)

      expect(error).toBeInstanceOf(LLMError)
      if (!(error instanceof LLMError)) return
      expect(error.reason).toMatchObject({ _tag: "RateLimit", retryAfterMs: 30_000 })
      expect(attempts).toBe(1)
    }),
  )

  it.effect("rejects malformed question sets before transport", () =>
    Effect.gen(function* () {
      const error = yield* SystemOneClient.infer({
        baseURL: "https://opencode.ai/zen/v1",
        model: "jev-1.13-free",
        state: "candidate",
        questions: {},
      }).pipe(Effect.provide(unexpectedTransport), Effect.flip)
      expect(error).toBeInstanceOf(LLMError)
      if (!(error instanceof LLMError)) return
      expect(error.reason._tag).toBe("InvalidRequest")
    }),
  )

  it.effect("rejects provider answers that do not match the requested typed question", () =>
    Effect.gen(function* () {
      const layer = dynamicResponse((input) =>
        Effect.succeed(
          input.respond(
            JSON.stringify({
              model: "jev-1.13-free",
              answers: { route: { type: "choice", choice: "allow", confidence: 0.9, probabilities: { allow: 1 } } },
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
            { status: 200 },
          ),
        ),
      )
      const error = yield* SystemOneClient.infer({
        baseURL: "https://opencode.ai/zen/v1",
        model: "jev-1.13-free",
        state: "candidate",
        questions: { route: questions.route },
      }).pipe(Effect.provide(layer), Effect.flip)
      expect(error).toBeInstanceOf(LLMError)
      if (!(error instanceof LLMError)) return
      expect(error.reason._tag).toBe("InvalidProviderOutput")
    }),
  )

  it.live("bounds the complete request with an interruptible timeout", () =>
    Effect.gen(function* () {
      const layer = dynamicResponse((input) =>
        Effect.sleep("100 millis").pipe(
          Effect.as(input.respond(JSON.stringify(response), { status: 200 })),
        ),
      )
      const error = yield* SystemOneClient.infer({
        baseURL: "https://opencode.ai/zen/v1",
        model: "jev-1.13-free",
        state: "candidate",
        questions,
        timeoutMs: 5,
      }).pipe(Effect.provide(layer), Effect.flip)
      expect(error).toBeInstanceOf(LLMError)
      if (!(error instanceof LLMError)) return
      expect(error.reason).toMatchObject({ _tag: "Transport", kind: "Timeout" })
    }),
  )
})
