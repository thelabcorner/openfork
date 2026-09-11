import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SpecialAgentSessionContext } from "@opencode-ai/core/special-agent-session-context"

const epoch = DateTime.makeUnsafe(0)
const user = (text: string): SessionMessage.Message =>
  SessionMessage.User.make({
    id: SessionMessage.ID.create(),
    type: "user",
    text,
    files: [],
    agents: [],
    time: { created: epoch },
  })

const assistant = (text: string): SessionMessage.Message =>
  SessionMessage.Assistant.make({
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: "build",
    model: {
      id: SessionMessage.Assistant.fields.model.fields.id.make("m"),
      providerID: SessionMessage.Assistant.fields.model.fields.providerID.make("p"),
    },
    content: [{ type: "text", id: "t", text }],
    time: { created: epoch },
  })

const compaction = (summary: string, recent = ""): SessionMessage.Message =>
  SessionMessage.Compaction.make({
    id: SessionMessage.ID.create(),
    type: "compaction",
    reason: "auto",
    summary,
    recent,
    time: { created: epoch },
  })

describe("SpecialAgentSessionContext", () => {
  test("truncates an oversized recent turn instead of dropping the surrounding conversation", () => {
    const out = SpecialAgentSessionContext.assemble(
      [user("opening intent"), assistant("x".repeat(20_000)), user("implement it now")],
      { maxChars: 4_000, maxBlockChars: 2_000, pinOpeningUser: true },
    )
    expect(out).toContain("opening intent")
    expect(out).toContain("implement it now")
    expect(out).toContain("[truncated]")
  })

  test("pins the latest compaction and does not replay superseded pre-compaction turns", () => {
    const out = SpecialAgentSessionContext.assemble(
      [
        user("obsolete old request"),
        assistant("obsolete old answer"),
        compaction("Authoritative summary: build first-party swarms", "Recent decision: three members"),
        user("proceed with it"),
      ],
      { maxChars: 8_000, pinLatestCompaction: true, pinOpeningUser: true },
    )
    expect(out).toContain("Authoritative summary: build first-party swarms")
    expect(out).toContain("Recent decision: three members")
    expect(out).toContain("proceed with it")
    expect(out).not.toContain("obsolete old request")
    expect(out).not.toContain("obsolete old answer")
  })

  test("pins opening intent when no compaction exists", () => {
    const out = SpecialAgentSessionContext.assemble(
      [user("Build the swarm feature"), assistant("y".repeat(12_000)), user("continue")],
      { maxChars: 3_000, maxBlockChars: 1_800, pinOpeningUser: true },
    )
    expect(out).toContain("Build the swarm feature")
    expect(out).toContain("continue")
  })
})
