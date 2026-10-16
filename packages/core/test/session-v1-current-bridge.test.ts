import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { V1CurrentBridge } from "@opencode-ai/core/session/v1-current-bridge"
import { V1CurrentResidue } from "@opencode-ai/core/session/v1-current-residue"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

const sid = SessionSchema.ID.make("ses_bridge_fixture")
const aid = SessionV1.MessageID.make("msg_bridge_assistant")
const uid = SessionV1.MessageID.make("msg_bridge_user")
const model = ModelV2.ID.make("test-model")
const provider = ProviderV2.ID.make("test-provider")

const assistant = () => SessionV1.Assistant.make({
  id: aid, sessionID: sid, role: "assistant", time: {
    created: 20, requestSentAt: 21, firstTokenAt: 22, streamedAt: 25, completed: 30,
  },
  parentID: uid, modelID: model, providerID: provider,
  agent: "build", mode: "build", path: { cwd: "/workspace", root: "/workspace" },
  cost: 0.5, tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 1, write: 2 } },
})
const base = (id: string) => ({
  id: SessionV1.PartID.make(id), sessionID: sid, messageID: aid,
})

const text = () => SessionV1.TextPart.make({ ...base("prt_bridge_text"), type: "text", text: "Hello SVG" })
const reasoning = () => SessionV1.ReasoningPart.make({
  ...base("prt_bridge_reasoning"), type: "reasoning", text: "private signed reasoning",
  time: { start: 21, end: 24 }, metadata: { anthropic: { signature: "sig-1" } },
})
const tools = () => [
  SessionV1.ToolPart.make({
    ...base("prt_bridge_pending"), type: "tool", callID: "call_pending", tool: "shell",
    state: { status: "pending", input: { command: "pwd" }, raw: '{"command":"pwd"}' },
  }) as unknown as SessionV1.Part,
  SessionV1.ToolPart.make({
    ...base("prt_bridge_running"), type: "tool", callID: "call_running", tool: "shell",
    state: { status: "running", input: { command: "ls" }, metadata: { progress: 5 }, time: { start: 23 } },
  }) as unknown as SessionV1.Part,
  SessionV1.ToolPart.make({
    ...base("prt_bridge_completed"), type: "tool", callID: "call_completed", tool: "shell",
    state: { status: "completed", input: { command: "ls" }, output: "result",
      title: "shell", metadata: { exitCode: 0 }, time: { start: 23, end: 26 },
      attachments: [{
        ...base("prt_bridge_tool_attachment"), type: "file", mime: "image/png",
        url: "data:image/png;base64,AA==", filename: "plot.png",
      }],
    },
  }) as unknown as SessionV1.Part,
  SessionV1.ToolPart.make({
    ...base("prt_bridge_error"), type: "tool", callID: "call_error", tool: "shell",
    state: { status: "error", input: { command: "bad" }, error: "command failed",
      metadata: { exitCode: 1 }, time: { start: 24, end: 27 } },
  }) as unknown as SessionV1.Part,
]

describe("V1 → current shadow differential bridge", () => {
  test("accepts valid V2 candidates while retaining exact IDs, reasoning metadata and four tool states", () => {
    const source: SessionV1.WithParts = {
      info: assistant(), parts: [text(), reasoning(), ...tools()],
    }
    const lowered = V1CurrentBridge.lower(source)
    expect(lowered.cutoverSafe).toBe(false)
    expect(lowered.version).toBe(1)
    expect(lowered.candidate?.type).toBe("assistant")
    // lower() has already decoded encoded timestamps into DateTime.Utc.
    // A second decode expects milliseconds and would be an invalid double
    // transform. Validate the decoded domain type instead.
    expect(Schema.is(SessionMessage.Message)(lowered.candidate)).toBe(true)
    const candidate = lowered.candidate!
    expect(candidate.type).toBe("assistant")
    if (candidate.type !== "assistant") throw Error("Expected current assistant")
    expect(candidate.content.map((part) => part.type)).toEqual([
      "text", "reasoning", "tool", "tool", "tool", "tool",
    ])
    expect(candidate.content.filter((part) => part.type === "tool")
      .map((part) => [part.id, part.state.status])).toEqual([
      ["call_pending", "pending"], ["call_running", "running"],
      ["call_completed", "completed"], ["call_error", "error"],
    ])
    expect(lowered.mappings.map((part) => part.partID)).toEqual(source.parts.map((part) => part.id))
    expect(lowered.blockers).toContain("v1-extra:prt_bridge_reasoning")
    expect(lowered.blockers).toContain("v1-assistant-parent-path-policy")
    expect(V1CurrentBridge.restore(lowered)).toEqual(source)
    // Restore makes an independent copy; mutating the source cannot affect a
    // migration record, and hash verifies preservation of original trace data.
    source.parts.pop()
    expect(V1CurrentBridge.restore(lowered).parts).toHaveLength(6)
    expect(V1CurrentBridge.lower(V1CurrentBridge.restore(lowered)).sourceHash).toBe(lowered.sourceHash)
  })

  test("archives unsupported part kinds without silently lowering them to V2 assistant content", () => {
    const unsupported: SessionV1.Part[] = [
      SessionV1.FilePart.make({
        ...base("prt_bridge_file"), type: "file", mime: "image/png",
        url: "file:///picture.png", filename: "picture.png",
      }),
      SessionV1.SnapshotPart.make({ ...base("prt_bridge_snapshot"), type: "snapshot", snapshot: "sha1" }),
      SessionV1.PatchPart.make({ ...base("prt_bridge_patch"), type: "patch", hash: "sha2", files: ["a.ts"] }) as unknown as SessionV1.Part,
      SessionV1.StepStartPart.make({ ...base("prt_bridge_step_start"), type: "step-start", snapshot: "sha3" }),
      SessionV1.StepFinishPart.make({
        ...base("prt_bridge_step_finish"), type: "step-finish", reason: "stop",
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
      SessionV1.CompactionPart.make({
        ...base("prt_bridge_compaction"), type: "compaction", auto: true,
        continueAfter: false, pending: true, checkpoint_message_id: uid,
      }),
      SessionV1.AgentPart.make({ ...base("prt_bridge_agent"), type: "agent", name: "review" }),
      SessionV1.SubtaskPart.make({
        ...base("prt_bridge_subtask"), type: "subtask", prompt: "inspect",
        description: "review", agent: "build",
      }),
      SessionV1.RetryPart.make({
        ...base("prt_bridge_retry"), type: "retry", attempt: 1,
        error: { name: "APIError", data: { message: "retry", isRetryable: true } },
        time: { created: 25 },
      }) as unknown as SessionV1.Part,
    ]
    const source: SessionV1.WithParts = { info: assistant(), parts: [...unsupported, text()] }
    const env = V1CurrentBridge.lower(source)
    expect(env.mappings.filter((p) => p.destination === "legacy-bridge")).toHaveLength(9)
    expect(env.mappings.at(-1)).toMatchObject({
      partID: "prt_bridge_text", destination: "assistant-content",
    })
    expect(env.blockers.filter((b) => b.startsWith("unsupported-part:"))).toHaveLength(9)
    expect((env.candidate as SessionMessage.Assistant).content).toHaveLength(1)
    expect(V1CurrentBridge.restore(env)).toEqual(source)
    // The compact wire residue must retain *all nine* V1-only part kinds,
    // not just the frequently-seen patch/file kinds, and reconstruct exact
    // sequence order after actual JSON encoding/decoding.
    const wire = V1CurrentResidue.toWire(V1CurrentResidue.lower(source))
    expect(V1CurrentResidue.restore(V1CurrentResidue.fromWire(
      JSON.parse(JSON.stringify(wire)) as typeof wire,
    ))).toEqual(source)
  })

  test("retains host-owned user provenance, file source, execution policy and multiple text pieces", () => {
    const user = SessionV1.User.make({
      id: uid, sessionID: sid, role: "user", time: { created: 11 },
      provenance: { owner: "host", source: "goal-continuation" },
      agent: "build", model: { modelID: model, providerID: provider },
      system: "extra system override", tools: { bash: false },
    }) as unknown as SessionV1.User
    const source: SessionV1.WithParts = {
      info: user,
      parts: [
        SessionV1.TextPart.make({
          id: SessionV1.PartID.make("prt_user_1"), sessionID: sid, messageID: uid,
          type: "text", text: "one", synthetic: true,
        }),
        SessionV1.TextPart.make({
          id: SessionV1.PartID.make("prt_user_2"), sessionID: sid, messageID: uid,
          type: "text", text: "two",
        }),
        SessionV1.FilePart.make({
          id: SessionV1.PartID.make("prt_user_file"), sessionID: sid, messageID: uid,
          type: "file", mime: "text/plain", url: "file:///a.txt", filename: "a.txt",
          source: { type: "file", path: "/a.txt", text: { value: "txt", start: 0, end: 3 } },
        }),
      ],
    }
    const env = V1CurrentBridge.lower(source)
    expect(env.candidate?.type).toBe("user")
    expect(env.blockers).toContain("v1-user-execution-policy")
    expect(env.blockers).toContain("multiple-user-text-parts")
    expect(env.blockers).toContain("file-source:prt_user_file")
    expect(V1CurrentBridge.restore(env)).toEqual(source)
  })

  test("rejects foreign parts, duplicate identities and tampered differential envelopes", () => {
    const input: SessionV1.WithParts = { info: assistant(), parts: [text()] }
    const envelope = V1CurrentBridge.lower(input)
    expect(() => V1CurrentBridge.lower({
      ...input,
      parts: [{ ...text(), sessionID: SessionSchema.ID.make("ses_other") }],
    })).toThrow(/Foreign V1 part/)
    expect(() => V1CurrentBridge.lower({ ...input, parts: [text(), text()] }))
      .toThrow(/Duplicate V1 part/)
    // Current assistant-content IDs cannot share a namespace if an unusual
    // V1 tool call ID equals a text part ID. A V2 lookup by ID would otherwise
    // select the wrong content or silently overwrite an event overlay.
    const unusualTool = tools()[0] as SessionV1.ToolPart
    expect(() => V1CurrentBridge.lower({
      ...input, parts: [text(), { ...unusualTool, callID: text().id }],
    })).toThrow(/Colliding V2 content identity/)
    const modified = structuredClone(envelope)
    modified.source.parts[0] = { ...text(), text: "changed" }
    expect(() => V1CurrentBridge.restore(modified)).toThrow(/integrity mismatch/)
    const swapped = {
      ...structuredClone(envelope),
      candidate: { ...envelope.candidate!, metadata: { forged: true } } as SessionMessage.Message,
    }
    expect(() => V1CurrentBridge.restore(swapped)).toThrow(/differential mismatch/)
  })
})
