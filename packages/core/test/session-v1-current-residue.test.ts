import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { V1CurrentResidue } from "@opencode-ai/core/session/v1-current-residue"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

const sid = SessionSchema.ID.make("ses_residue_fixture")
const mid = SessionV1.MessageID.make("msg_residue_assistant")
const uid = SessionV1.MessageID.make("msg_residue_user")
const modelID = ModelV2.ID.make("model")
const providerID = ProviderV2.ID.make("provider")
const base = (id: string) => ({
  id: SessionV1.PartID.make(id), messageID: mid, sessionID: sid,
})

describe("compact lossless V1 residue over current message", () => {
  test("does not duplicate large V1 tool output/file attachments and survives JSON wire encode/decode", () => {
    const output = "vector-output-".repeat(40_000)
    const url = "data:image/png;base64," + "A".repeat(100_000)
    const source: SessionV1.WithParts = {
      info: SessionV1.Assistant.make({
        id: mid, sessionID: sid, role: "assistant", time: { created: 1, completed: 10 },
        parentID: uid, modelID, providerID, mode: "build", agent: "build",
        path: { cwd: "/work", root: "/" }, cost: 0,
        tokens: { input: 12, output: 1, reasoning: 3, cache: { read: 0, write: 0 } },
      }) as unknown as SessionV1.Assistant,
      parts: [
        SessionV1.ReasoningPart.make({
          ...base("prt_residue_reasoning"), type: "reasoning",
          text: "signed reasoning", metadata: { anthropic: { signature: "sealed" } },
          time: { start: 2, end: 3 },
        }) as unknown as SessionV1.Part,
        SessionV1.ToolPart.make({
          ...base("prt_residue_tool"), type: "tool",
          callID: "call_residue_tool", tool: "bash",
          metadata: { tracing: { count: 10 } },
          state: {
            status: "completed", input: { command: "render", flags: [1, 2, 3] },
            output, title: "Render", metadata: { renderer: "svg" },
            time: { start: 3, end: 9 },
            attachments: [{
              ...base("prt_residue_file"), type: "file", url, filename: "render.png", mime: "image/png",
              source: { type: "file", path: "/path", text: { value: "ref", start: 0, end: 3 } },
            }],
          },
        }) as unknown as SessionV1.Part,
        SessionV1.PatchPart.make({
          ...base("prt_residue_patch"), type: "patch", hash: "abc", files: ["package.json"],
        }) as unknown as SessionV1.Part,
      ],
    }
    const residue = V1CurrentResidue.lower(source)
    expect(residue.cutoverSafe).toBe(false)
    expect(V1CurrentResidue.restore(residue)).toEqual(source)
    expect((source.parts[1] as SessionV1.ToolPart).state.status).toBe("completed")
    expect(((source.parts[1] as SessionV1.ToolPart).state as SessionV1.ToolStateCompleted).output).toBe(output)
    const rawTemplate = JSON.stringify(residue.parts)
    expect(rawTemplate.includes(output)).toBe(false)
    expect(rawTemplate.includes(url)).toBe(false)
    expect(rawTemplate.length).toBeLessThan((output.length + url.length) * 0.1)
    const serialized = JSON.stringify(V1CurrentResidue.toWire(residue))
    // The candidate carries one copy of the output and attachment, while the
    // sparse residue carries only original identity/timing/metadata.
    expect(serialized.length).toBeGreaterThan(output.length + url.length)
    expect(serialized.length).toBeLessThan((output.length + url.length) * 1.05)
    const wire = JSON.parse(serialized) as ReturnType<typeof V1CurrentResidue.toWire>
    expect(V1CurrentResidue.restore(V1CurrentResidue.fromWire(wire))).toEqual(source)

    // Replacing current tool output cannot fool the original source digest.
    const tampered = structuredClone(wire) as any
    if (tampered.candidate.type !== "assistant") throw new Error("Expected assistant")
    const tool = tampered.candidate.content.find((p: { type: string }) => p.type === "tool")
    if (tool?.type !== "tool" || tool.state.status !== "completed")
      throw new Error("Expected settled tool")
    tool.state.content[0] = { type: "text", text: "forged" }
    expect(() => V1CurrentResidue.fromWire(tampered)).toThrow(/integrity mismatch/)
  })

  test("user text and large file URI roundtrip without duplicated source payloads", () => {
    const hugeUri = "data:text/plain;base64," + "B".repeat(160_000)
    const source: SessionV1.WithParts = {
      info: SessionV1.User.make({
        id: uid, sessionID: sid, role: "user", time: { created: 1 },
        agent: "build", model: { modelID, providerID },
        provenance: { owner: "host", source: "scheduled-task" },
        system: "keep all source policy",
      }) as unknown as SessionV1.User,
      parts: [
        SessionV1.TextPart.make({
          id: SessionV1.PartID.make("prt_residue_user_text"),
          messageID: uid, sessionID: sid, type: "text", text: "inspect source",
        }) as unknown as SessionV1.Part,
        SessionV1.FilePart.make({
          id: SessionV1.PartID.make("prt_residue_user_file"),
          messageID: uid, sessionID: sid, type: "file", mime: "text/plain",
          filename: "source.txt", url: hugeUri,
        }) as unknown as SessionV1.Part,
      ],
    }
    const residue = V1CurrentResidue.lower(source)
    const encoded = JSON.stringify(V1CurrentResidue.toWire(residue))
    expect(JSON.stringify(residue.parts).includes(hugeUri)).toBe(false)
    expect(encoded.length).toBeLessThan(hugeUri.length * 1.06)
    expect(V1CurrentResidue.restore(V1CurrentResidue.fromWire(
      JSON.parse(encoded) as ReturnType<typeof V1CurrentResidue.toWire>,
    ))).toEqual(source)
  })

  test("tampering with a V1-only field is detected after in-memory construction", () => {
    const original: SessionV1.WithParts = {
      info: SessionV1.Assistant.make({
        id: mid, sessionID: sid, role: "assistant", time: { created: 1 },
        parentID: uid, modelID, providerID, mode: "build", agent: "build",
        path: { cwd: "/work", root: "/" }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }) as unknown as SessionV1.Assistant,
      parts: [SessionV1.TextPart.make({ ...base("prt_residue_text"), type: "text", text: "hello" }) as unknown as SessionV1.Part],
    }
    const residue = V1CurrentResidue.lower(original)
    // Clone only the V1 header. structuredClone() of a decoded DateTime.Utc
    // candidate would strip its schema brand and fail for the wrong reason.
    const info = structuredClone(residue.info)
    if (info.role !== "assistant") throw new Error("Expected assistant")
    info.path.cwd = "/forged"
    const modified = { ...residue, info }
    expect(() => V1CurrentResidue.restore(modified)).toThrow(/integrity mismatch/)
  })
})
