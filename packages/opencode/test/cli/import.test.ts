import { test, expect } from "bun:test"
import {
  formatImportFileError,
  parseShareUrl,
  sanitizeImportedMessage,
  sanitizeImportedSessionInfo,
  shouldAttachShareAuthHeaders,
  transformShareData,
  type ShareData,
} from "../../src/cli/cmd/import"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { PlatformError } from "effect"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"

test("imported Sessions cannot mint producer-owned aggregate identity", () => {
  const info = sanitizeImportedSessionInfo({
    id: "ses_import" as any,
    slug: "import",
    projectID: "project" as any,
    directory: "/tmp/import" as any,
    title: "Imported",
    version: "test",
    time: { created: 1, updated: 1 },
    metadata: {
      ordinary: "keep",
      specialAgent: "goal_auditor",
      specialAgentOwnerKind: "goal",
      specialAgentOwnerID: "spoof",
      goalID: "goal_spoof",
      parentSessionID: "ses_spoof",
      scheduledTaskID: "stk_spoof",
      scheduledTaskRunID: "str_spoof",
    },
  } as any)

  expect(info.metadata).toEqual({ ordinary: "keep" })
})

test("imported turns preserve authorship but cannot mint live worker or Goal authority", () => {
  const imported = sanitizeImportedMessage({
    info: {
      id: "msg_import_user",
      sessionID: "ses_import",
      role: "user",
      provenance: { owner: "user", source: SessionTurnProvenance.Source.Prompt },
      time: { created: 1 },
      agent: "build",
      model: { providerID: "test", modelID: "test" },
    },
    parts: [
      {
        id: "prt_import_user",
        sessionID: "ses_import",
        messageID: "msg_import_user",
        type: "text",
        text: "historical user request",
      },
    ],
  } as any)!

  expect(imported.info.role).toBe("user")
  if (imported.info.role !== "user") throw new Error("expected imported user turn")
  expect(imported.info.provenance).toMatchObject({ owner: "user", source: "prompt", lifetime: "historical" })
  expect(SessionTurnProvenance.isSemanticUserTurn(imported)).toBe(true)
  expect(SessionTurnProvenance.isWorkerPromptTurn(imported)).toBe(false)
  expect(SessionTurnProvenance.isGoalAuthorizationTurn(imported)).toBe(false)
  expect(SessionTurnProvenance.causalRootMessageID(imported)).toBeUndefined()
})

test("import resolves unstamped legacy ownership once and drops orphaned Goal STATE", () => {
  const legacy = sanitizeImportedMessage({
    info: {
      id: "msg_legacy",
      sessionID: "ses_import",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "test", modelID: "test" },
    },
    parts: [
      {
        id: "prt_legacy",
        sessionID: "ses_import",
        messageID: "msg_legacy",
        type: "text",
        text: "legacy synthetic continuation",
        synthetic: true,
      },
    ],
  } as any)!
  if (legacy.info.role !== "user") throw new Error("expected imported legacy user-role turn")
  expect(legacy.info.provenance).toMatchObject({
    owner: "host",
    source: "legacy.synthetic",
    lifetime: "historical",
  })

  const state = sanitizeImportedMessage({
    info: {
      id: "msg_state",
      sessionID: "ses_import",
      role: "user",
      provenance: { owner: "host", source: SessionTurnProvenance.Source.GoalSpecification },
      time: { created: 2 },
      agent: "build",
      model: { providerID: "test", modelID: "test" },
    },
    parts: [
      {
        id: "prt_state",
        sessionID: "ses_import",
        messageID: "msg_state",
        type: "text",
        text: "stale goal projection",
        synthetic: true,
      },
    ],
  } as any)
  expect(state).toBeUndefined()

  const alreadyHistoricalState = sanitizeImportedMessage({
    info: {
      id: "msg_state_historical",
      sessionID: "ses_import",
      role: "user",
      provenance: {
        owner: "host",
        source: SessionTurnProvenance.Source.GoalProgress,
        lifetime: "historical",
      },
      time: { created: 3 },
      agent: "build",
      model: { providerID: "test", modelID: "test" },
    },
    parts: [],
  } as any)
  expect(alreadyHistoricalState).toBeUndefined()
})

test("formats import file errors", () => {
  expect(
    formatImportFileError(
      "test.json",
      new PlatformError.PlatformError(
        new PlatformError.SystemError({
          _tag: "NotFound",
          module: "FileSystem",
          method: "readFileString",
        }),
      ),
    ),
  ).toBe("File not found: test.json")
  expect(
    formatImportFileError(
      "test.json",
      new PlatformError.PlatformError(
        new PlatformError.SystemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "readFileString",
        }),
      ),
    ),
  ).toBe("Failed to read file: Permission denied")
  expect(
    formatImportFileError(
      "test.json",
      new FSUtil.FileSystemError({ method: "readJson", cause: new SyntaxError("Unexpected token") }),
    ),
  ).toBe("Invalid JSON in test.json: Unexpected token")
})

// parseShareUrl tests
test("parses valid share URLs", () => {
  expect(parseShareUrl("https://opncd.ai/share/Jsj3hNIW")).toBe("Jsj3hNIW")
  expect(parseShareUrl("https://custom.example.com/share/abc123")).toBe("abc123")
  expect(parseShareUrl("http://localhost:3000/share/test_id-123")).toBe("test_id-123")
})

test("rejects invalid URLs", () => {
  expect(parseShareUrl("https://opncd.ai/s/Jsj3hNIW")).toBeNull() // legacy format
  expect(parseShareUrl("https://opncd.ai/share/")).toBeNull()
  expect(parseShareUrl("https://opncd.ai/share/id/extra")).toBeNull()
  expect(parseShareUrl("not-a-url")).toBeNull()
})

test("only attaches share auth headers for same-origin URLs", () => {
  expect(shouldAttachShareAuthHeaders("https://control.example.com/share/abc", "https://control.example.com")).toBe(
    true,
  )
  expect(shouldAttachShareAuthHeaders("https://other.example.com/share/abc", "https://control.example.com")).toBe(false)
  expect(shouldAttachShareAuthHeaders("https://control.example.com:443/share/abc", "https://control.example.com")).toBe(
    true,
  )
  expect(shouldAttachShareAuthHeaders("not-a-url", "https://control.example.com")).toBe(false)
})

// transformShareData tests
test("transforms share data to storage format", () => {
  const data: ShareData[] = [
    { type: "session", data: { id: "sess-1", title: "Test" } as any },
    { type: "message", data: { id: "msg-1", sessionID: "sess-1" } as any },
    { type: "part", data: { id: "part-1", messageID: "msg-1" } as any },
    { type: "part", data: { id: "part-2", messageID: "msg-1" } as any },
  ]

  const result = transformShareData(data)!

  expect(result.info.id).toBe("sess-1")
  expect(result.messages).toHaveLength(1)
  expect(result.messages[0].parts).toHaveLength(2)
})

test("returns null for invalid share data", () => {
  expect(transformShareData([])).toBeNull()
  expect(transformShareData([{ type: "message", data: {} as any }])).toBeNull()
  expect(transformShareData([{ type: "session", data: { id: "s" } as any }])).toBeNull() // no messages
})
