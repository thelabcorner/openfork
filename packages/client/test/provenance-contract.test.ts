import { expect, test } from "bun:test"
import { OpenCode } from "../src"
import type { SessionsPromptInput } from "../src"

test("prompt provenance is server-owned: request cannot serialize it while response preserves it", async () => {
  type PromptAcceptsProvenance = "provenance" extends keyof SessionsPromptInput ? true : false
  const promptAcceptsProvenance: PromptAcceptsProvenance = false
  let body: unknown
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (_input, init) => {
      body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body
      return Response.json({
        data: {
          admittedSeq: 1,
          id: "msg_test",
          sessionID: "ses_test",
          prompt: { text: "Hello" },
          delivery: "steer",
          provenance: { owner: "user", source: "prompt" },
          timeCreated: 1,
        },
      })
    },
  })

  // Extra object properties are possible from plain JavaScript or an unsafe
  // cast. The generated client must still serialize only the declared request
  // contract and never forward caller-controlled authority metadata.
  const forged = {
    sessionID: "ses_test",
    prompt: { text: "Hello" },
    resume: false,
    provenance: { owner: "host", source: "host.prompt" },
  } as const
  const admitted = await client.sessions.prompt(forged)

  expect(promptAcceptsProvenance).toBe(false)
  expect(body).toEqual({ prompt: { text: "Hello" }, resume: false })
  expect(admitted.provenance).toEqual({ owner: "user", source: "prompt" })
})
