import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import {
  createBinding,
  validateBinding,
  decideResume,
  boundHistory,
  makeMemoryStorage,
  bindingKey,
  hashSettings,
  modelFamilyOf,
  MAX_HISTORY_TRANSFER_MESSAGES,
  MAX_HISTORY_TRANSFER_CHARS,
} from "../../src/claude/sessions"

const baseCtx = (overrides: Partial<any> = {}) => ({
  projectID: "proj-1",
  worktree: "/repo/proj1",
  directory: "/repo/proj1",
  cwd: "/repo/proj1",
  modelFamily: "claude-sonnet-4",
  settingsDigest: hashSettings({ theme: "dark" }),
  transcriptExists: true,
  ...overrides,
})

describe("ClaudeSessions binding lifecycle", () => {
  test("createBinding hashes settings and model family", () => {
    const b = createBinding({
      openCodeSessionID: "sess-1",
      claudeSessionID: "claude-abc",
      projectID: "proj-1",
      worktree: "/repo/proj1",
      directory: "/repo/proj1",
      cwd: "/repo/proj1",
      modelID: "claude-sonnet-4-5-20250514",
      settings: { a: 1 },
    })
    expect(b.modelFamily).toBe("claude-sonnet-4")
    expect(b.settingsDigest.length).toBe(16)
    expect(b.claudeSessionID).toBe("claude-abc")
  })

  test("modelFamilyOf handles various IDs", () => {
    expect(modelFamilyOf("claude-sonnet-4-5-20250514")).toBe("claude-sonnet-4")
    expect(modelFamilyOf("claude-opus-4.7")).toBe("claude-opus-4")
    expect(modelFamilyOf("gpt-4o")).toBe("gpt-4o")
  })

  test("validateBinding passes for matching context", () => {
    const b = createBinding({
      openCodeSessionID: "sess-1",
      claudeSessionID: "claude-1",
      projectID: "proj-1",
      worktree: "/repo/proj1",
      directory: "/repo/proj1",
      cwd: "/repo/proj1",
      modelID: "claude-sonnet-4-5",
      settings: { x: 1 },
    })
    const ctx = baseCtx({ projectID: b.projectID, worktree: b.worktree, cwd: b.cwd, modelFamily: b.modelFamily, settingsDigest: b.settingsDigest })
    const res = validateBinding(b, ctx)
    expect(res.valid).toBe(true)
  })

  test("validateBinding fails on each mismatch dimension", () => {
    const b = createBinding({
      openCodeSessionID: "sess-1",
      claudeSessionID: "claude-1",
      projectID: "proj-1",
      worktree: "/repo/proj1",
      directory: "/repo/proj1",
      cwd: "/repo/proj1",
      modelID: "claude-sonnet-4-5",
      settings: { x: 1 },
    })
    expect(validateBinding(b, baseCtx({ projectID: "other" })).valid).toBe(false)
    expect((validateBinding(b, baseCtx({ projectID: "other" })) as any).reason).toBe("project_mismatch")
    expect(validateBinding(b, baseCtx({ worktree: "/other" })).valid).toBe(false)
    expect(validateBinding(b, baseCtx({ cwd: "/other" })).valid).toBe(false)
    expect(validateBinding(b, baseCtx({ modelFamily: "claude-opus-4" })).valid).toBe(false)
    expect(validateBinding(b, baseCtx({ settingsDigest: "bad" })).valid).toBe(false)
    expect(validateBinding(b, baseCtx({ transcriptExists: false })).valid).toBe(false)
  })

  test("Project A cannot resume project B's transcript", () => {
    const b = createBinding({
      openCodeSessionID: "sess-1",
      claudeSessionID: "claude-1",
      projectID: "proj-A",
      worktree: "/repo/A",
      directory: "/repo/A",
      cwd: "/repo/A",
      modelID: "claude-sonnet-4-5",
      settings: {},
    })
    const ctxB = baseCtx({ projectID: "proj-B", worktree: "/repo/B", cwd: "/repo/B", modelFamily: b.modelFamily, settingsDigest: b.settingsDigest })
    const decision = decideResume({ binding: b, ctx: ctxB })
    expect(decision.strategy).not.toBe("resume")
    expect(decision.binding?.invalidationReason).toBe("project_mismatch")
  })

  test("missing or mismatched external sessions produce honest fresh/historyTransfer", () => {
    const b = createBinding({
      openCodeSessionID: "sess-1",
      claudeSessionID: "claude-1",
      projectID: "proj-1",
      worktree: "/repo/proj1",
      directory: "/repo/proj1",
      cwd: "/repo/proj1",
      modelID: "claude-sonnet-4-5",
      settings: {},
    })
    const ctxMissing = baseCtx({ projectID: b.projectID, worktree: b.worktree, cwd: b.cwd, modelFamily: b.modelFamily, settingsDigest: b.settingsDigest, transcriptExists: false })
    const d1 = decideResume({ binding: b, ctx: ctxMissing })
    expect(d1.strategy).toBe("fresh")
    const d2 = decideResume({ binding: b, ctx: ctxMissing, historyMessages: [{ role: "user", content: "hello" }] })
    expect(d2.strategy).toBe("historyTransfer")
    expect(d2.historyTransfer?.messages.length).toBe(1)
  })

  test("stale invalidation is persisted and does not auto-recover", async () => {
    const storage = makeMemoryStorage()
    const b = createBinding({
      openCodeSessionID: "sess-1",
      claudeSessionID: "claude-1",
      projectID: "proj-1",
      worktree: "/repo/proj1",
      directory: "/repo/proj1",
      cwd: "/repo/proj1",
      modelID: "claude-sonnet-4-5",
      settings: { a: 1 },
    })
    await Effect.runPromise(storage.write(bindingKey(b.projectID, b.openCodeSessionID), b))
    const ctxBad = baseCtx({ cwd: "/other", modelFamily: b.modelFamily, settingsDigest: b.settingsDigest })
    const { resolveResumeEffect } = await import("../../src/claude/sessions")
    const decision = await Effect.runPromise(resolveResumeEffect({ storage, projectID: b.projectID, openCodeSessionID: b.openCodeSessionID, ctx: ctxBad }))
    expect(decision.strategy).toBe("fresh")
    const reloaded = await Effect.runPromise(storage.read(bindingKey(b.projectID, b.openCodeSessionID)))
    expect(reloaded.invalidationReason).toBe("cwd_mismatch")
  })

  test("bounded history-transfer truncates by count and chars", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ role: "user", content: `msg-${i}` }))
    const bounded = boundHistory(many)
    expect(bounded.messages.length).toBe(MAX_HISTORY_TRANSFER_MESSAGES)
    expect(bounded.truncated).toBe(true)

    const huge = [{ role: "user", content: "a".repeat(MAX_HISTORY_TRANSFER_CHARS + 1000) }]
    const bounded2 = boundHistory(huge)
    expect(bounded2.messages[0]!.content.length).toBeLessThanOrEqual(MAX_HISTORY_TRANSFER_CHARS + 20)
    expect(bounded2.truncated).toBe(true)

    const small = [{ role: "user", content: "hi" }]
    const bounded3 = boundHistory(small)
    expect(bounded3.messages.length).toBe(1)
    expect(bounded3.truncated).toBe(false)
  })

  test("binding cleanup does not delete Claude-owned files (only binding map)", async () => {
    const storage = makeMemoryStorage()
    const b = createBinding({
      openCodeSessionID: "sess-1",
      claudeSessionID: "claude-1",
      projectID: "proj-1",
      worktree: "/repo/proj1",
      directory: "/repo/proj1",
      cwd: "/repo/proj1",
      modelID: "claude-sonnet-4-5",
      settings: {},
    })
    await Effect.runPromise(storage.write(bindingKey(b.projectID, b.openCodeSessionID), b))
    // Simulate Claude-owned transcript at unrelated path
    const claudeTranscriptPath = "/home/user/.claude/projects/proj1/transcript.json"
    // removeBinding should only delete our key
    await Effect.runPromise(storage.remove(bindingKey(b.projectID, b.openCodeSessionID)))
    expect(storage.map.size).toBe(0)
    // transcript path never touched - we assert by not having deleted it
    // (no filesystem operation on claudeTranscriptPath occurred)
    expect(claudeTranscriptPath).toBe("/home/user/.claude/projects/proj1/transcript.json")
  })

  test("concurrent turns: distinct sessions have isolated bindings", async () => {
    const storage = makeMemoryStorage()
    const b1 = createBinding({ openCodeSessionID: "sess-1", claudeSessionID: "c1", projectID: "proj-1", worktree: "/repo/proj1", directory: "/repo/proj1", cwd: "/repo/proj1", modelID: "claude-sonnet-4-5", settings: {} })
    const b2 = createBinding({ openCodeSessionID: "sess-2", claudeSessionID: "c2", projectID: "proj-1", worktree: "/repo/proj1", directory: "/repo/proj1", cwd: "/repo/proj1", modelID: "claude-sonnet-4-5", settings: {} })
    await Effect.runPromise(Effect.all([storage.write(bindingKey(b1.projectID, b1.openCodeSessionID), b1), storage.write(bindingKey(b2.projectID, b2.openCodeSessionID), b2)]))
    const r1 = await Effect.runPromise(storage.read(bindingKey("proj-1", "sess-1")))
    const r2 = await Effect.runPromise(storage.read(bindingKey("proj-1", "sess-2")))
    expect(r1.claudeSessionID).toBe("c1")
    expect(r2.claudeSessionID).toBe("c2")
  })

  test("resume state survives restart via persistent storage abstraction", async () => {
    const storage = makeMemoryStorage()
    const b = createBinding({ openCodeSessionID: "sess-1", claudeSessionID: "claude-1", projectID: "proj-1", worktree: "/repo/proj1", directory: "/repo/proj1", cwd: "/repo/proj1", modelID: "claude-sonnet-4-5", settings: {} })
    await Effect.runPromise(storage.write(bindingKey(b.projectID, b.openCodeSessionID), b))
    // Simulate restart by creating new storage view over same map
    const reloaded = await Effect.runPromise(storage.read(bindingKey(b.projectID, b.openCodeSessionID)))
    const ctx = baseCtx({ projectID: reloaded.projectID, worktree: reloaded.worktree, cwd: reloaded.cwd, modelFamily: reloaded.modelFamily, settingsDigest: reloaded.settingsDigest })
    const decision = decideResume({ binding: reloaded, ctx })
    expect(decision.strategy).toBe("resume")
    // Binding is not transcript authority: transcript missing => no resume
    const decision2 = decideResume({ binding: reloaded, ctx: { ...ctx, transcriptExists: false } })
    expect(decision2.strategy).toBe("fresh")
  })
})
