import { resolve } from "path"
import { describe, expect, test } from "bun:test"
import { isCodeRunTrace } from "@opencode-ai/schema/session-v1"
import {
  audioContents,
  completedToolContent,
  completedToolUpdate,
  completedToolRawOutput,
  extractImageAttachments,
  imageContents,
  pendingToolCall,
  shellOutputSnapshot,
  toLocations,
  toToolKind,
} from "../../src/acp/tool"

describe("acp tool conversion", () => {
  test("native Read forwards verified audio as ACP content without mistaking handles for bytes", () => {
    const wav = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]).toString("base64")
    const attachments = [
      { mime: "audio/wav", url: `data:audio/wav;base64,${wav}` },
      { mime: "audio/mpeg", url: `data:audio/mpeg;base64,${wav}` },
      { mime: "audio/wav", url: "https://external.example/voice.wav" },
      { mime: "video/mp4", url: "data:video/mp4;base64,AAAA" },
    ]
    expect(audioContents(attachments)).toEqual([
      { type: "content", content: { type: "audio", mimeType: "audio/wav", data: wav } },
    ])
    const read = completedToolContent("read", {
      status: "completed", input: { filePath: "voice.wav" },
      output: "Audio read successfully", attachments,
    })
    expect(read).toEqual([
      { type: "content", content: { type: "text", text: "Audio read successfully" } },
      { type: "content", content: { type: "audio", mimeType: "audio/wav", data: wav } },
    ])
    const edit = completedToolContent("edit", {
      status: "completed", input: {}, output: "Edited", attachments,
    })
    expect(JSON.stringify(edit)).not.toContain('"type":"audio"')
    const video = completedToolContent("read", {
      status: "completed", input: { filePath: "recording.mp4" },
      output: "Video read successfully",
      attachments: [{ mime: "video/mp4", url: "data:video/mp4;base64,AAAA" }],
    })
    expect(video).toEqual([
      { type: "content", content: { type: "text", text: "Video read successfully" } },
      { type: "content", content: { type: "text", text: expect.stringContaining("not decoded into ACP tool content") } },
    ])
  })
  test("ACP audio transfer has a 2 MiB combined encoded data budget", () => {
    const wav = Buffer.concat([
      Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]),
      Buffer.alloc(1200 * 1024),
    ]).toString("base64")
    expect(audioContents([
      { mime: "audio/wav", url: `data:audio/wav;base64,${wav}` },
      { mime: "audio/wav", url: `data:audio/wav;base64,${wav}` },
    ])).toHaveLength(1)
  })
  test("maps OpenCode tool ids to ACP tool kinds", () => {
    expect(toToolKind("bash")).toBe("execute")
    expect(toToolKind("shell")).toBe("execute")
    expect(toToolKind("web")).toBe("fetch")
    expect(toToolKind("webfetch")).toBe("fetch")
    expect(toToolKind("edit")).toBe("edit")
    expect(toToolKind("apply_patch")).toBe("edit")
    expect(toToolKind("patch")).toBe("edit")
    expect(toToolKind("write")).toBe("edit")
    expect(toToolKind("grep")).toBe("search")
    expect(toToolKind("glob")).toBe("search")
    expect(toToolKind("find")).toBe("search")
    expect(toToolKind("context7_resolve_library_id")).toBe("search")
    expect(toToolKind("context7_get_library_docs")).toBe("search")
    expect(toToolKind("read")).toBe("read")
    expect(toToolKind("task")).toBe("think")
    expect(toToolKind("custom_tool")).toBe("other")
  })

  test("extracts file locations from tool input", () => {
    expect(toLocations("read", { filePath: "/tmp/a.ts" })).toEqual([{ path: "/tmp/a.ts" }])
    expect(toLocations("edit", { filePath: "/tmp/b.ts" })).toEqual([{ path: "/tmp/b.ts" }])
    expect(toLocations("write", { filePath: "/tmp/c.ts" })).toEqual([{ path: "/tmp/c.ts" }])
    expect(toLocations("grep", { path: "/repo/src" })).toEqual([{ path: "/repo/src" }])
    expect(toLocations("glob", { path: "/repo/test" })).toEqual([{ path: "/repo/test" }])
    expect(toLocations("find", { path: "/repo/src" })).toEqual([{ path: "/repo/src" }])
    expect(toLocations("context7_get_library_docs", { path: "/docs" })).toEqual([{ path: "/docs" }])
    expect(toLocations("external_directory", { directories: ["/tmp/outside"], patterns: ["/tmp/outside/*"] })).toEqual([
      { path: "/tmp/outside" },
    ])
    expect(toLocations("bash", { cmd: "pwd" }, "/workspace")).toEqual([{ path: "/workspace" }])
    // Relative workdir resolves against cwd via the platform path resolver (backslashes on Windows).
    expect(toLocations("bash", { command: "pwd", workdir: "subdir" }, "/workspace")).toEqual([
      { path: resolve("/workspace", "subdir") },
    ])
    expect(toLocations("bash", { command: "pwd", workdir: "/abs/dir" }, "/workspace")).toEqual([{ path: "/abs/dir" }])
    expect(toLocations("bash", { command: "printf hello" })).toEqual([])
    expect(toLocations("read", { path: "/tmp/missing-file-path.ts" })).toEqual([])
  })

  test("builds completed content with text, edit diffs, and image attachments", () => {
    const image = Buffer.from("image-data").toString("base64")

    expect(
      completedToolContent("edit", {
        status: "completed",
        input: {
          filePath: "/tmp/file.ts",
          oldString: "before",
          newString: "after",
        },
        output: "edited /tmp/file.ts",
        attachments: [
          {
            type: "file",
            mime: "image/png",
            filename: "image.png",
            url: `data:image/png;base64,${image}`,
          },
          {
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "data:text/plain;base64,bm90ZQ==",
          },
        ],
      }),
    ).toEqual([
      {
        type: "content",
        content: { type: "text", text: "edited /tmp/file.ts" },
      },
      {
        type: "diff",
        path: "/tmp/file.ts",
        oldText: "before",
        newText: "after",
      },
      {
        type: "content",
        content: { type: "image", mimeType: "image/png", data: image },
      },
    ])
  })

  test("omits edit diffs until old and new text fields exist", () => {
    expect(
      completedToolContent("write", {
        status: "completed",
        input: {
          filePath: "/tmp/file.ts",
          content: "created",
        },
        output: "wrote /tmp/file.ts",
      }),
    ).toEqual([
      {
        type: "content",
        content: { type: "text", text: "wrote /tmp/file.ts" },
      },
    ])
  })

  test("sends completed tool calls as partial updates", () => {
    expect(
      pendingToolCall({
        toolCallId: "tool-1",
        toolName: "edit",
        state: {
          input: {
            filePath: "/tmp/file.ts",
            oldString: "before",
            newString: "after",
          },
        },
      }),
    ).toMatchObject({
      kind: "edit",
      locations: [{ path: "/tmp/file.ts" }],
      rawInput: {
        filePath: "/tmp/file.ts",
        oldString: "before",
        newString: "after",
      },
    })

    expect(
      completedToolUpdate({
        toolCallId: "tool-1",
        toolName: "edit",
        state: {
          status: "completed",
          input: {
            filePath: "/tmp/file.ts",
            oldString: "before",
            newString: "after",
          },
          output: "Edit applied successfully.",
        },
      }),
    ).toEqual({
      toolCallId: "tool-1",
      status: "completed",
      content: [
        {
          type: "content",
          content: { type: "text", text: "Edit applied successfully." },
        },
        {
          type: "diff",
          path: "/tmp/file.ts",
          oldText: "before",
          newText: "after",
        },
      ],
      rawOutput: {
        output: "Edit applied successfully.",
      },
    })

    expect(
      completedToolUpdate({
        toolCallId: "tool-1",
        toolName: "edit",
        state: {
          status: "completed",
          input: {
            filePath: "/tmp/file.ts",
            oldString: "before",
            newString: "after",
          },
          title: "file.ts",
          output: "Edit applied successfully.",
        },
      }),
    ).toMatchObject({
      toolCallId: "tool-1",
      status: "completed",
      title: "file.ts",
    })
  })

  test("uses clean read display text for completed content", () => {
    const output = [
      "<path>/tmp/file.ts</path>",
      "<type>file</type>",
      "<content>",
      "7: first",
      "8: second",
      "",
      "(End of file - total 8 lines)",
      "</content>",
    ].join("\n")
    const state = {
      status: "completed" as const,
      input: { filePath: "/tmp/file.ts" },
      output,
      metadata: {
        display: {
          type: "file",
          path: "/tmp/file.ts",
          text: "first\nsecond",
          lineStart: 7,
          lineEnd: 8,
          totalLines: 8,
          truncated: false,
        },
      },
    }

    expect(completedToolContent("read", state)).toEqual([
      {
        type: "content",
        content: { type: "text", text: "first\nsecond" },
      },
    ])
    expect(completedToolRawOutput(state)).toEqual({
      output,
      metadata: state.metadata,
    })
  })

  test("builds completed raw output with optional metadata and attachments", () => {
    const attachments = [
      {
        type: "file",
        mime: "image/jpeg",
        filename: "photo.jpg",
        url: "data:image/jpeg;base64,AAAA",
      },
    ]

    expect(
      completedToolRawOutput({
        status: "completed",
        input: {},
        output: "done",
        metadata: { exit: 0 },
        attachments,
      }),
    ).toEqual({
      output: "done",
      metadata: { exit: 0 },
      attachments,
    })

    expect(
      completedToolRawOutput({
        status: "completed",
        input: {},
        output: "done",
      }),
    ).toEqual({ output: "done" })
  })

  test("extracts image attachments only from data URLs", () => {
    const attachments = [
      {
        mime: "image/webp",
        url: "data:image/webp;charset=utf-8;base64,AAAA",
      },
      {
        mime: "image/png",
        url: "https://example.com/image.png",
      },
      {
        mime: "text/plain",
        url: "data:text/plain;base64,BBBB",
      },
    ]

    expect(extractImageAttachments(attachments)).toEqual([{ mimeType: "image/webp", data: "AAAA" }])
    expect(imageContents(attachments)).toEqual([
      {
        type: "content",
        content: { type: "image", mimeType: "image/webp", data: "AAAA" },
      },
    ])
  })

  test("preserves schema-owned CodeRunTrace metadata through generic ACP raw output", () => {
    const trace = {
      version: 1 as const,
      rootFrameID: "code:prt_acp",
      frames: [
        {
          frameID: "code:prt_acp#1",
          ref: "native:read",
          kind: "native" as const,
          depth: 0,
          startedAt: 1,
          finishedAt: 2,
          durationMs: 1,
          status: "succeeded" as const,
          attachmentCount: 0,
        },
      ],
      counters: { calls: 1, failed: 0, active: 0 },
    }
    expect(isCodeRunTrace(trace)).toBe(true)

    const update = completedToolUpdate({
      toolCallId: "call_code_acp",
      toolName: "code",
      state: {
        status: "completed",
        input: { action: "run" },
        output: '{"ok":true}',
        metadata: { action: "run", trace },
      },
    })

    expect(update.status).toBe("completed")
    const raw = update.rawOutput as { metadata?: { trace?: unknown } }
    expect(raw.metadata?.trace).toEqual(trace)
    expect(isCodeRunTrace(raw.metadata?.trace)).toBe(true)
  })

  test("reads shell output snapshot from string metadata output", () => {
    expect(shellOutputSnapshot({ metadata: { output: "line 1\nline 2" } })).toBe("line 1\nline 2")
    expect(shellOutputSnapshot({ metadata: { output: 42 } })).toBeUndefined()
    expect(shellOutputSnapshot({ metadata: undefined })).toBeUndefined()
  })
})
