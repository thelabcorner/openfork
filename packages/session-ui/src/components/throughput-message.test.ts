import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2"
import { toThroughputMessage } from "./throughput-message"

const user = (source: string, owner: "user" | "host" = "host", lifetime?: "historical") =>
  ({
    id: `msg_${source}`,
    sessionID: "ses_test",
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: { providerID: "test", modelID: "model" },
    provenance: { owner, source, ...(lifetime ? { lifetime } : {}) },
  }) as Message

describe("toThroughputMessage", () => {
  test("projects replaceable host state as a transparent throughput role", () => {
    expect(toThroughputMessage(user("goal.spec")).role).toBe("state")
    expect(toThroughputMessage(user("goal.progress")).role).toBe("state")
  })

  test("keeps host continuation and real user turns as request boundaries", () => {
    expect(toThroughputMessage(user("goal.continuation")).role).toBe("user")
    expect(toThroughputMessage(user("prompt", "user")).role).toBe("user")
  })

  test("keeps historical state-shaped provenance structurally transparent", () => {
    expect(toThroughputMessage(user("goal.progress", "host", "historical")).role).toBe("state")
  })
})
