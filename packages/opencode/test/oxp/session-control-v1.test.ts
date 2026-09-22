import { afterAll, describe, expect, test } from "bun:test"
import { Effect, ManagedRuntime } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceStore } from "@/project/instance-store"
import { OxpSessionControl } from "@/oxp/session-control"
import { OxpSessionControlV1 } from "@/oxp/session-control-v1"
import { Session } from "@/session/session"
import { tmpdir } from "../fixture/fixture"
import { pollWithTimeout } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const llmRuntime = ManagedRuntime.make(TestLLMServer.layer)
const controlRuntime = ManagedRuntime.make(OxpSessionControlV1.layer)

afterAll(async () => {
  await controlRuntime.dispose()
  await llmRuntime.dispose()
})

const isTitleRequest = (hit: { body: Record<string, unknown> }) => {
  const tools = hit.body.tools
  return Array.isArray(tools) && JSON.stringify(tools).includes("generated_title")
}

const response = (text: string) => reply().text(text).stop().item()

const inInstance = <A, E, R>(directory: string, effect: Effect.Effect<A, E, R>) =>
  InstanceStore.Service.use((instances) => instances.provide({ directory }, effect))

const assistantText = (messages: readonly SessionV1.WithParts[]) => {
  const assistant = [...messages].reverse().find((message) => message.info.role === "assistant")
  if (!assistant) return undefined
  return assistant.parts
    .filter((part): part is Extract<(typeof assistant.parts)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
}

describe("OxpSessionControlV1 supervised turn lifetime", () => {
  test("send returns while its supervised turn survives the control request", async () => {
    const llm = await llmRuntime.runPromise(TestLLMServer)
    await llmRuntime.runPromise(
      llm.pushMatch((hit) => !isTitleRequest(hit), response("session control send result")),
    )

    const tmp = await tmpdir({ config: testProviderConfig(llm.url) })
    try {
      const session = await AppRuntime.runPromise(
        inInstance(
          tmp.path,
          Session.Service.use((sessions) => sessions.create({ title: "OXP Session send scope" })),
        ),
      )
      const target: OxpSessionControl.Target = {
        directory: tmp.path,
        sessionID: session.id,
      }

      const admitted = await controlRuntime.runPromise(
        OxpSessionControl.Service.use((control) =>
          control.send(target, {
            actorRef: "oxp:test-session-control",
            text: "produce the send result",
          }),
        ),
      )

      expect(admitted.paused).toBe(false)
      expect(admitted.admittedMessageID.length).toBeGreaterThan(0)

      const text = await AppRuntime.runPromise(
        inInstance(
          tmp.path,
          Session.Service.use((sessions) =>
            pollWithTimeout(
              Effect.gen(function* () {
                const messages = yield* sessions.messages({ sessionID: session.id })
                const text = assistantText(messages)
                return text?.includes("session control send result") ? text : undefined
              }),
              "OXP Session send fiber did not outlive the control request",
              "20 seconds",
            ),
          ),
        ),
      )

      expect(text).toContain("session control send result")
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  }, 60_000)

  test("resume drains a paused admitted turn on the layer-owned scope", async () => {
    const llm = await llmRuntime.runPromise(TestLLMServer)
    await llmRuntime.runPromise(
      llm.pushMatch((hit) => !isTitleRequest(hit), response("session control resume result")),
    )

    const tmp = await tmpdir({ config: testProviderConfig(llm.url) })
    try {
      const session = await AppRuntime.runPromise(
        inInstance(
          tmp.path,
          Session.Service.use((sessions) => sessions.create({ title: "OXP Session resume scope" })),
        ),
      )
      const target: OxpSessionControl.Target = {
        directory: tmp.path,
        sessionID: session.id,
      }

      await controlRuntime.runPromise(
        OxpSessionControl.Service.use((control) => control.pause(target)),
      )

      const admitted = await controlRuntime.runPromise(
        OxpSessionControl.Service.use((control) =>
          control.send(target, {
            actorRef: "oxp:test-session-control",
            text: "produce the resume result",
          }),
        ),
      )
      expect(admitted.paused).toBe(true)

      await controlRuntime.runPromise(
        OxpSessionControl.Service.use((control) => control.resume(target)),
      )

      const text = await AppRuntime.runPromise(
        inInstance(
          tmp.path,
          Session.Service.use((sessions) =>
            pollWithTimeout(
              Effect.gen(function* () {
                const messages = yield* sessions.messages({ sessionID: session.id })
                const text = assistantText(messages)
                return text?.includes("session control resume result") ? text : undefined
              }),
              "OXP Session resume fiber did not survive the control request",
              "20 seconds",
            ),
          ),
        ),
      )

      expect(text).toContain("session control resume result")
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  }, 60_000)
})
