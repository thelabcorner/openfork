import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { LLM, Message, Model, type LLMRequest } from "@opencode-ai/llm"
import { LLMClient, RequestExecutor } from "@opencode-ai/llm/route"
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { providerRequestHeaders } from "@opencode-ai/core/session/runner/provider-request-headers"
import { OpenCodeHostedUserAgent } from "@opencode-ai/core/installation/version"

/**
 * Final provider-boundary proof for the Core direct-LLM request classes.
 *
 * P5B-S1 proved installed `ai@6.0.168` `generateObject` lowercases headers and
 * appends an ` ai/<version>` suffix before `LanguageModelV3.doGenerate`, and
 * P5B-W1 proved `streamText` does not. Core never goes through the AI SDK, so
 * the equivalent risk is different: does Core's own route client preserve
 * `http.headers` all the way onto the `HttpClientRequest` its transport would
 * send?
 *
 * These tests drive the REAL `LLMClient.layer` and intercept
 * `RequestExecutor.Service`, the last boundary before bytes leave the process.
 * Asserting on a constructed `LLMRequest` alone would not be proof.
 */

const hostedModel = Model.make({
  id: "space-bunny-free",
  provider: "opencode",
  route: OpenAIChat.route.with({ endpoint: { baseURL: "https://opencode.ai/zen/v1" } }),
})

const thirdPartyModel = Model.make({ id: "gpt-4o-mini", provider: "openai", route: OpenAIChat.route })

/** Runs one request through the real client and returns what the transport saw. */
const transportHeaders = (request: LLMRequest) =>
  Effect.gen(function* () {
    const seen: HttpClientRequest.HttpClientRequest[] = []
    const executor = Layer.succeed(
      RequestExecutor.Service,
      RequestExecutor.Service.of({
        execute: (outgoing) =>
          Effect.sync(() => {
            seen.push(outgoing)
            return HttpClientResponse.fromWeb(outgoing, new Response("data: [DONE]\n\n", { status: 200 }))
          }),
      }),
    )
    yield* Effect.gen(function* () {
      const client = yield* LLMClient.Service
      // A provider-level failure is acceptable: the transport was still reached,
      // and reaching it is the boundary under test.
      yield* client.stream(request).pipe(Stream.runForEach(() => Effect.void), Effect.ignore)
    }).pipe(Effect.provide(LLMClient.layer), Effect.provide(executor), Effect.scoped)
    const first = seen[0]
    if (!first) return undefined
    return new Map(
      Object.entries(first.headers as unknown as Record<string, string>).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    )
  })

describe("Core route client preserves hosted identity to the transport", () => {
  const identity = providerRequestHeaders({
    providerID: "opencode",
    projectID: "prj_1",
    sessionID: "ses_1",
    requestID: "req_1",
  })

  test("an OpenCode-hosted request reaches the transport with exact hosted headers", () =>
    Effect.runPromise(
      transportHeaders(LLM.request({ model: hostedModel, http: { headers: identity }, messages: [Message.user("hi")] })),
    ).then((sent) => {
      expect(sent).toBeDefined()
      // Case-insensitive lookup: the wire header name casing is not the contract.
      expect(sent!.get("user-agent")).toBe(OpenCodeHostedUserAgent())
      expect(sent!.get("x-opencode-project")).toBe("prj_1")
      expect(sent!.get("x-opencode-session")).toBe("ses_1")
      expect(sent!.get("x-opencode-request")).toBe("req_1")
      expect(sent!.get("x-opencode-client")).toBeDefined()
      // No AI-SDK-style suffix may be appended by the Core client.
      expect(sent!.get("user-agent")).not.toContain(" ai/")
    }),
  )

  test("hosted identity is stable across repeated requests from the same builder", () =>
    Effect.gen(function* () {
      const first = yield* transportHeaders(
        LLM.request({ model: hostedModel, http: { headers: identity }, messages: [Message.user("hi")] }),
      )
      const second = yield* transportHeaders(
        LLM.request({ model: hostedModel, http: { headers: identity }, messages: [Message.user("hi")] }),
      )
      return { first, second }
    }).pipe(Effect.runPromise).then(({ first, second }) => {
      expect(second!.get("user-agent")).toBe(first!.get("user-agent"))
      expect(second!.get("user-agent")).toBe(OpenCodeHostedUserAgent())
    }),
  )

  test("a third-party request keeps generic affinity identity and claims nothing hosted", () =>
    Effect.runPromise(
      transportHeaders(
        LLM.request({
          model: thirdPartyModel,
          http: {
            headers: providerRequestHeaders({
              providerID: "openai",
              projectID: "prj_1",
              sessionID: "ses_1",
              requestID: "req_1",
            }),
          },
          messages: [Message.user("hi")],
        }),
      ),
    ).then((sent) => {
      expect(sent).toBeDefined()
      expect(sent!.get("user-agent")).toBeUndefined()
      expect(sent!.get("x-opencode-session")).toBeUndefined()
      expect(sent!.get("x-session-affinity")).toBe("ses_1")
    }),
  )
})
