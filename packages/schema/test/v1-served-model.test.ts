import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionV1 } from "../src/session-v1"

const base = {
  id: "msg_1",
  sessionID: "sess_1",
  role: "assistant" as const,
  time: { created: 1 },
  parentID: "msg_0",
  modelID: "free",
  providerID: "openrouter",
  mode: "build",
  agent: "build",
  path: { cwd: "/tmp", root: "/tmp" },
  cost: 0,
  tokens: { input: 0, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
}

const decode = (value: unknown) => Schema.decodeUnknownSync(SessionV1.Assistant)(value)
const encode = (value: unknown) => Schema.encodeSync(SessionV1.Assistant)(value as SessionV1.Assistant)

describe("V1 assistant servedModel", () => {
  test("decodes a router-slug message with the resolved served model", () => {
    const message = decode({
      ...base,
      servedModel: { modelID: "upstage/solar-pro-4:free", providerID: "DeepInfra" },
    })
    expect(message.servedModel).toEqual({ modelID: "upstage/solar-pro-4:free", providerID: "DeepInfra" })
  })

  test("omits undefined servedModel keys on encode", () => {
    const withProvider = encode({ ...base, servedModel: { modelID: "upstage/solar-pro-4:free", providerID: "DeepInfra" } })
    expect(withProvider.servedModel).toEqual({ modelID: "upstage/solar-pro-4:free", providerID: "DeepInfra" })

    const withoutProvider = encode({ ...base, servedModel: { modelID: "upstage/solar-pro-4:free" } })
    expect(withoutProvider.servedModel).toEqual({ modelID: "upstage/solar-pro-4:free" })
    expect("providerID" in withoutProvider.servedModel!).toBe(false)
  })

  test("legacy messages without servedModel still decode and encode unchanged", () => {
    const message = decode(base)
    expect(message.servedModel).toBeUndefined()
    expect("servedModel" in encode(message)).toBe(false)
  })
})