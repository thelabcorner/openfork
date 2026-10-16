import { describe, expect, test } from "bun:test"
import { V1CurrentBridge } from "@opencode-ai/core/session/v1-current-bridge"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { projectCurrentToV1 } from "@/session/message-v2"

const sid = SessionSchema.ID.make("ses_v1_differential")
const uid = SessionV1.MessageID.make("msg_differential_user")
const aid = SessionV1.MessageID.make("msg_differential_assistant")
const modelID = ModelV2.ID.make("test-model")
const providerID = ProviderV2.ID.make("test-provider")

describe("V1 → current → V1 adapter differential evidence", () => {
  test("does not mistake semantic presentation parity for lossless storage parity", () => {
    const user: SessionV1.WithParts = {
      info: SessionV1.User.make({
        id: uid, sessionID: sid, role: "user", time: { created: 100 },
        agent: "build", model: { modelID, providerID },
        provenance: { owner: "host", source: "goal-continuation" },
        system: "source-owned prompt policy", tools: { bash: false },
      }) as unknown as SessionV1.User,
      parts: [SessionV1.TextPart.make({
        id: SessionV1.PartID.make("prt_diff_user"), messageID: uid,
        sessionID: sid, type: "text", text: "run tests",
      }) as unknown as SessionV1.Part],
    }
    const toolID = SessionV1.PartID.make("prt_diff_original_tool")
    const textID = SessionV1.PartID.make("prt_diff_original_text")
    const assistant: SessionV1.WithParts = {
      info: SessionV1.Assistant.make({
        id: aid, sessionID: sid, role: "assistant",
        time: { created: 101, completed: 110 },
        parentID: uid, agent: "build", mode: "build", providerID, modelID,
        path: { cwd: "/original/working-dir", root: "/original" },
        cost: 0.01, tokens: { input: 12, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      }) as unknown as SessionV1.Assistant,
      parts: [
        SessionV1.TextPart.make({
          id: textID, messageID: aid, sessionID: sid,
          type: "text", text: "executed", time: { start: 103, end: 107 },
        }) as unknown as SessionV1.Part,
        SessionV1.ToolPart.make({
          id: toolID, messageID: aid, sessionID: sid,
          type: "tool", callID: "call_diff_original", tool: "bash",
          state: {
            status: "completed", input: { command: "pwd" }, output: "/original",
            title: "shell", metadata: { exitCode: 0, env: "test" },
            time: { start: 103, end: 109 },
          },
        }) as unknown as SessionV1.Part,
        SessionV1.PatchPart.make({
          id: SessionV1.PartID.make("prt_diff_unmodeled_patch"), messageID: aid,
          sessionID: sid, type: "patch", hash: "abc", files: ["file.ts"],
        }) as unknown as SessionV1.Part,
      ],
    }
    const envelopeUser = V1CurrentBridge.lower(user)
    const envelopeAssistant = V1CurrentBridge.lower(assistant)
    expect(envelopeAssistant.cutoverSafe).toBe(false)
    expect(envelopeAssistant.blockers).toEqual(expect.arrayContaining([
      "unsupported-part:patch:prt_diff_unmodeled_patch", "v1-assistant-parent-path-policy",
    ]))

    const presented = projectCurrentToV1(
      sid, [envelopeUser.candidate!, envelopeAssistant.candidate!],
    )
    expect(presented.map((part) => part.info.role)).toEqual(["user", "assistant"])
    expect(presented[1]?.parts.find((part) => part.type === "tool"))
      .toMatchObject({ callID: "call_diff_original", tool: "bash" })
    expect(presented[1]?.parts.find((part) => part.type === "text"))
      .toMatchObject({ text: "executed" })

    // Existing current→V1 adapter manufactures presentation part identities;
    // it also cannot reconstitute V1-only patch/metadata/path/system policy.
    expect(presented[1]?.parts.some((part) => part.id === toolID)).toBe(false)
    expect(presented[1]?.parts.some((part) => part.type === "patch")).toBe(false)
    if (presented[1]?.info.role !== "assistant") throw new Error("Expected assistant")
    expect(presented[1].info.path.cwd).not.toBe("/original/working-dir")
    expect(V1CurrentBridge.restore(envelopeUser)).toEqual(user)
    expect(V1CurrentBridge.restore(envelopeAssistant)).toEqual(assistant)
  })
})
