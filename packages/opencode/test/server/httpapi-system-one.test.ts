import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { SystemOnePaths } from "../../src/server/routes/instance/httpapi/groups/system-one"
import { httpApiLayer, request, requestInDirectory } from "./httpapi-layer"

const it = testEffect(httpApiLayer)

function body(modelID: string, questions: Record<string, unknown>) {
  return JSON.stringify({
    providerID: "semantic-test",
    modelID,
    state: { candidate: "proof-1" },
    questions,
  })
}

const validQuestion = {
  verdict: {
    type: "noul",
    instructions: "The candidate should pass.",
  },
}

describe("System One HttpApi", () => {
  it.live("fails closed when no workspace or directory is supplied", () =>
    Effect.gen(function* () {
      const response = yield* request(SystemOnePaths.infer, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body("semantic", validQuestion),
      })

      expect(response.status).toBe(400)
      expect(yield* response.json).toMatchObject({
        _tag: "InvalidRequestError",
        kind: "MissingLocation",
        field: "directory",
      })
    }),
  )

  it.instance(
    "distinguishes unsupported language models from malformed System One requests",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance

        const language = yield* requestInDirectory(SystemOnePaths.infer, test.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: body("chat", validQuestion),
        })
        expect(language.status).toBe(400)
        expect(yield* language.json).toMatchObject({
          _tag: "InvalidRequestError",
          kind: "unsupported-model-primitive",
          field: "modelID",
        })

        // The semantic model resolves normally, but the empty question set is
        // rejected by the System One contract before any provider transport.
        const malformed = yield* requestInDirectory(SystemOnePaths.infer, test.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: body("semantic", {}),
        })
        expect(malformed.status).toBe(400)
        expect(yield* malformed.json).toMatchObject({
          _tag: "InvalidRequestError",
          kind: "system-one-request",
        })
      }),
    {
      git: true,
      config: {
        formatter: false,
        lsp: false,
        provider: {
          "semantic-test": {
            name: "Semantic Test",
            npm: "@ai-sdk/openai-compatible",
            api: "https://example.invalid/v1",
            options: { apiKey: "test-key" },
            models: {
              chat: { name: "Chat", primitive: "language" },
              semantic: { name: "Semantic", primitive: "system-one" },
            },
          },
        },
      },
    },
    15_000,
  )
})
