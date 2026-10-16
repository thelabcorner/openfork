import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import { classifyV1ShadowMessage, projectV1ShadowCandidate } from "../../src/session/lace-shadow-v1"

const make = (id: string, role: "assistant" | "user", parts: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
  ({ info: { id, role, ...extra }, parts }) as unknown as SessionV1.WithParts

const assistant = make("assistant-1", "assistant", [{ type: "text", text: "Confirmed the test fixtures pass." }], { finish: "end_turn" })
const user = make("user-1", "user", [{ type: "text", text: "Never change my provider." }],
  { provenance: SessionTurnProvenance.user(SessionTurnProvenance.Source.Prompt) })

describe("LACE V1 provenance-bound shadow projector", () => {
  test("assistant-only text is a candidate; the human objective cannot be abstracted", () => {
    expect(classifyV1ShadowMessage(assistant).disposition).toBe("candidate-assistant-text")
    expect(classifyV1ShadowMessage(user).mustStayRaw).toBe(true)
    const input = {
      messages: [user, assistant],
      sources: [
        { messageID: "user-1", revision: "rev-u", renderedText: "Never change my provider." },
        { messageID: "assistant-1", revision: "rev-a", renderedText: "Confirmed the test fixtures pass." },
      ],
      maxCharacters: 500,
    }
    expect(() => projectV1ShadowCandidate({
      ...input, choices: [{ id: "user-1", mode: "omit" as const }],
    })).toThrow()
    const candidate = projectV1ShadowCandidate({
      ...input,
      choices: [{ id: "assistant-1", mode: "abstract", text: "Tests passed.", validatedRevision: "rev-a", independentlyVerified: true }],
    })
    expect(candidate.parts.map((part) => part.text)).toEqual(["Never change my provider.", "Tests passed."])
    expect(assistant.parts[0]).toMatchObject({ text: "Confirmed the test fixtures pass." })
  })

  test("Goal STATE is not a historical summary source even if it appears as user-role text", () => {
    const goalState = make("goal-state", "user", [{ type: "text", text: "Current Goal progress" }], {
      provenance: SessionTurnProvenance.host(SessionTurnProvenance.Source.GoalSpecification),
    })
    expect(classifyV1ShadowMessage(goalState)).toMatchObject({
      disposition: "reproject-authoritative-state", reprojectFromOwner: true,
    })
    expect(() => projectV1ShadowCandidate({
      messages: [goalState],
      sources: [{ messageID: "goal-state", renderedText: "Current Goal progress", revision: "rev-goal" }],
      choices: [],
      maxCharacters: 500,
    })).toThrow("reprojected")
  })

  test("tool causality, reasoning, summary checkpoints, and multimodal rows remain RAW", () => {
    for (const [message, kind] of [
      [make("pending", "assistant", [{ type: "tool", tool: "bash", state: { status: "pending" } }]), "protected-tool-causality"],
      [make("complete", "assistant", [{ type: "tool", tool: "bash", state: { status: "completed", output: "ok" } }]), "protected-tool-causality"],
      [make("thinking", "assistant", [{ type: "reasoning", text: "provider-native" }]), "protected-reasoning"],
      [make("sum", "assistant", [{ type: "text", text: "Summary" }], { summary: true }), "protected-checkpoint"],
      [make("media", "assistant", [{ type: "file", url: "inline-image" }]), "protected-multimodal"],
    ] as const) {
      expect(classifyV1ShadowMessage(message)).toMatchObject({ disposition: kind, mustStayRaw: true })
    }
  })

  test("unfinished assistant text and opaque provider metadata are not valid abstractable history", () => {
    const unfinished = make("unfinished", "assistant", [{ type: "text", text: "Streaming..." }])
    const marked = make("marked", "assistant", [{ type: "text", text: "Response", metadata: { providerMarker: true } }], { finish: "end_turn" })
    const reasoningState = make("native", "assistant", [{ type: "text", text: "Response", providerMetadata: { openai: { encrypted: "opaque" } } }], { finish: "end_turn" })
    expect(classifyV1ShadowMessage(unfinished).disposition).toBe("protected-unsettled")
    expect(classifyV1ShadowMessage(marked).disposition).toBe("protected-provider-metadata")
    expect(classifyV1ShadowMessage(reasoningState).disposition).toBe("protected-provider-metadata")
  })

  test("source order, mandatory revisions, and independent summary validation fail closed", () => {
    const sources = [{ messageID: "assistant-1", revision: "r1", renderedText: "Verified" }]
    expect(() => projectV1ShadowCandidate({
      messages: [assistant], sources: [{ ...sources[0]!, messageID: "wrong" }], choices: [], maxCharacters: 100,
    })).toThrow("order mismatch")
    expect(() => projectV1ShadowCandidate({
      messages: [assistant], sources: [{ ...sources[0]!, revision: "" }], choices: [], maxCharacters: 100,
    })).toThrow("revision")
    expect(() => projectV1ShadowCandidate({
      messages: [assistant], sources,
      choices: [{ id: "assistant-1", mode: "abstract", text: "Approximate", validatedRevision: "r1", independentlyVerified: false }],
      maxCharacters: 100,
    })).toThrow("unverified")
    expect(() => projectV1ShadowCandidate({
      messages: [assistant], sources,
      choices: [{ id: "assistant-1", mode: "abstract", text: "Verified", validatedRevision: "outdated", independentlyVerified: true }],
      maxCharacters: 100,
    })).toThrow("stale")
  })
})
