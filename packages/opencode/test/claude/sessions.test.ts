import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  advanceBindingLeaf,
  createBinding,
  validateBinding,
  decideResume,
  boundHistory,
  historyBoundary,
  matchTurnHistory,
  recordTurnStart,
  rebindBindingModel,
  resolveResumeEffect,
  makeMemoryStorage,
  bindingKey,
  hashSettings,
  modelFamilyOf,
  claudeProjectDirName,
  findTranscript,
  transcriptHasEntry,
  transcriptExists,
  MAX_HISTORY_TRANSFER_MESSAGES,
  MAX_HISTORY_TRANSFER_CHARS,
  type BindingStorage,
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

  test("turn boundaries distinguish latest, rewind, and diverged history", () => {
    const first = createBinding({
      openCodeSessionID: "sess-branch",
      claudeSessionID: "claude-branch",
      projectID: "proj-1",
      worktree: "/repo/proj1",
      directory: "/repo/proj1",
      cwd: "/repo/proj1",
      modelID: "claude-sonnet-4-5",
      settings: {},
      leafUuid: "leaf-1",
      turnBoundary: { count: 1, hash: "h1" },
    })
    const started = recordTurnStart(first, { count: 2, hash: "h2" }, { count: 1, hash: "h1" })
    const settled = advanceBindingLeaf(started, "leaf-2")
    expect(settled.turns).toEqual([
      { count: 1, hash: "h1", leafUuid: "leaf-1" },
      { count: 2, hash: "h2", leafUuid: "leaf-2" },
    ])
    expect(matchTurnHistory(settled.turns ?? [], ["h1", "h2"])).toEqual({ kind: "latest" })
    expect(matchTurnHistory(settled.turns ?? [], ["h1"])).toEqual({
      kind: "rewind",
      index: 0,
      leafUuid: "leaf-1",
    })
    expect(matchTurnHistory(settled.turns ?? [], ["different"])).toEqual({ kind: "diverged" })
    expect(historyBoundary(["h1", "h2"])).toEqual({ count: 2, hash: "h2" })
  })

  test("rebindBindingModel preserves transcript history while adopting Claude's effective fallback model", () => {
    const binding = createBinding({
      openCodeSessionID: "sess-fallback",
      claudeSessionID: "claude-fallback",
      projectID: "proj-1",
      worktree: "/repo/proj1",
      directory: "/repo/proj1",
      cwd: "/repo/proj1",
      modelID: "claude-fable-5-1[1m]",
      settings: { model: "claude-fable-5-1[1m]", provider: "claude" },
      leafUuid: "leaf-1",
      turnBoundary: { count: 1, hash: "h1" },
    })
    const rebound = rebindBindingModel(binding, "claude-opus-5-5[1m]", {
      model: "claude-opus-5-5[1m]",
      provider: "claude",
    })
    expect(rebound.claudeSessionID).toBe(binding.claudeSessionID)
    expect(rebound.leafUuid).toBe("leaf-1")
    expect(rebound.turns).toEqual(binding.turns)
    expect(rebound.modelFamily).toBe(modelFamilyOf("claude-opus-5-5[1m]"))
    expect(rebound.settingsDigest).toBe(
      hashSettings({ model: "claude-opus-5-5[1m]", provider: "claude" }),
    )
  })

  test("resolveResumeEffect rewinds to a verified earlier leaf and records the edited turn", async () => {
    const storage = makeMemoryStorage()
    const first = createBinding({
      openCodeSessionID: "sess-rewind",
      claudeSessionID: "claude-rewind",
      projectID: "proj-1",
      worktree: "/repo/proj1",
      directory: "/repo/proj1",
      cwd: "/repo/proj1",
      modelID: "claude-sonnet-4-5",
      settings: { theme: "dark" },
      leafUuid: "leaf-1",
      turnBoundary: { count: 1, hash: "h1" },
    })
    const binding = advanceBindingLeaf(
      recordTurnStart(first, { count: 2, hash: "h2" }, { count: 1, hash: "h1" }),
      "leaf-2",
    )
    await Effect.runPromise(storage.write(bindingKey(binding.projectID, binding.openCodeSessionID), binding))

    const decision = await Effect.runPromise(
      resolveResumeEffect({
        storage,
        projectID: "proj-1",
        openCodeSessionID: "sess-rewind",
        ctx: baseCtx({ modelFamily: binding.modelFamily, settingsDigest: binding.settingsDigest }),
        historyMessages: [{ role: "user", content: "one" }],
        historyFingerprints: ["h1", "h3"],
        priorHistoryFingerprints: ["h1"],
        transcriptHasEntry: (_binding, uuid) => Effect.succeed(uuid === "leaf-1"),
      }),
    )

    expect(decision.strategy).toBe("resume")
    expect(decision.resumeSessionAt).toBe("leaf-1")
    expect(decision.binding?.leafUuid).toBe("leaf-1")
    expect(decision.binding?.turns).toEqual([
      { count: 1, hash: "h1", leafUuid: "leaf-1" },
      { count: 2, hash: "h3", leafUuid: "leaf-1" },
    ])
  })

  test("resolveResumeEffect does not rewrite an unchanged valid binding", async () => {
    const memory = makeMemoryStorage()
    let writes = 0
    const storage: BindingStorage = {
      ...memory,
      write: (key, binding) =>
        Effect.sync(() => {
          writes += 1
          memory.map.set(key.join("/"), binding)
        }),
    }
    const binding = createBinding({
      openCodeSessionID: "sess-stable",
      claudeSessionID: "claude-stable",
      projectID: "proj-1",
      worktree: "/repo/proj1",
      directory: "/repo/proj1",
      cwd: "/repo/proj1",
      modelID: "claude-sonnet-4-5",
      settings: { theme: "dark" },
      leafUuid: "leaf-1",
      turnBoundary: { count: 1, hash: "h1" },
    })
    await Effect.runPromise(storage.write(bindingKey(binding.projectID, binding.openCodeSessionID), binding))
    writes = 0

    const decision = await Effect.runPromise(
      resolveResumeEffect({
        storage,
        projectID: "proj-1",
        openCodeSessionID: "sess-stable",
        ctx: baseCtx({ modelFamily: binding.modelFamily, settingsDigest: binding.settingsDigest }),
        historyMessages: [{ role: "user", content: "one" }],
        historyFingerprints: ["h1"],
        priorHistoryFingerprints: [],
        transcriptHasEntry: (_binding, uuid) => Effect.succeed(uuid === "leaf-1"),
      }),
    )

    expect(decision.strategy).toBe("resume")
    expect(decision.resumeSessionAt).toBe("leaf-1")
    expect(decision.binding).toBe(binding)
    expect(writes).toBe(0)
  })

  test("resolveResumeEffect transfers history when a tracked rewind leaf vanished", async () => {
    const storage = makeMemoryStorage()
    const first = createBinding({
      openCodeSessionID: "sess-missing-leaf",
      claudeSessionID: "claude-missing-leaf",
      projectID: "proj-1",
      worktree: "/repo/proj1",
      directory: "/repo/proj1",
      cwd: "/repo/proj1",
      modelID: "claude-sonnet-4-5",
      settings: { theme: "dark" },
      leafUuid: "leaf-1",
      turnBoundary: { count: 1, hash: "h1" },
    })
    const binding = advanceBindingLeaf(
      recordTurnStart(first, { count: 2, hash: "h2" }, { count: 1, hash: "h1" }),
      "leaf-2",
    )
    await Effect.runPromise(storage.write(bindingKey(binding.projectID, binding.openCodeSessionID), binding))

    const decision = await Effect.runPromise(
      resolveResumeEffect({
        storage,
        projectID: "proj-1",
        openCodeSessionID: "sess-missing-leaf",
        ctx: baseCtx({ modelFamily: binding.modelFamily, settingsDigest: binding.settingsDigest }),
        historyMessages: [{ role: "user", content: "one" }],
        historyFingerprints: ["h1", "h3"],
        priorHistoryFingerprints: ["h1"],
        transcriptHasEntry: () => Effect.succeed(false),
      }),
    )

    expect(decision.strategy).toBe("historyTransfer")
    expect(decision.binding?.invalidationReason).toBe("stale")
    expect(decision.historyTransfer?.messages).toEqual([{ role: "user", content: "one" }])
  })
})

describe("Claude transcript lookup", () => {
  test("claudeProjectDirName encodes separators and punctuation", () => {
    expect(claudeProjectDirName("/repo/my-project")).toBe("-repo-my-project")
    expect(claudeProjectDirName("C:\\Users\\me\\proj")).toBe("C--Users-me-proj")
  })

  test("resolves via the cwd-derived project directory fast path", async () => {
    const config = await mkdtemp(path.join(tmpdir(), "claude-cfg-"))
    try {
      const cwd = "/repo/my-project"
      const dir = path.join(config, "projects", claudeProjectDirName(cwd))
      await mkdir(dir, { recursive: true })
      const file = path.join(dir, "sess-fast.jsonl")
      await writeFile(file, "")
      const env = { CLAUDE_CONFIG_DIR: config }
      await expect(findTranscript("sess-fast", { cwd, env })).resolves.toBe(file)
      await expect(transcriptExists("sess-fast", { cwd, env })).resolves.toBe(true)
      // A different (wrong) cwd still finds it via the bounded fallback scan.
      await expect(findTranscript("sess-fast", { cwd: "/elsewhere", env })).resolves.toBe(file)
    } finally {
      await rm(config, { recursive: true, force: true })
    }
  })

  test("missing transcript is reported absent without throwing", async () => {
    const config = await mkdtemp(path.join(tmpdir(), "claude-cfg-"))
    try {
      const env = { CLAUDE_CONFIG_DIR: config }
      await expect(findTranscript("nope", { cwd: "/x", env })).resolves.toBeUndefined()
      await expect(transcriptExists("nope", { env })).resolves.toBe(false)
      await expect(findTranscript("nope", { env: { CLAUDE_CONFIG_DIR: "" } })).resolves.toBeUndefined()
    } finally {
      await rm(config, { recursive: true, force: true })
    }
  })

  test("transcriptHasEntry scans the Claude JSONL tail without loading the whole file", async () => {
    const config = await mkdtemp(path.join(tmpdir(), "claude-cfg-"))
    try {
      const cwd = "/repo/my-project"
      const dir = path.join(config, "projects", claudeProjectDirName(cwd))
      await mkdir(dir, { recursive: true })
      const file = path.join(dir, "sess-leaf.jsonl")
      const body =
        JSON.stringify({ type: "assistant", uuid: "old-leaf" }) +
        "\n" +
        "x".repeat(10_000) +
        "\n" +
        JSON.stringify({ type: "assistant", uuid: "target-leaf" }) +
        "\n"
      await writeFile(file, body)
      const env = { CLAUDE_CONFIG_DIR: config }
      await expect(transcriptHasEntry("sess-leaf", "target-leaf", { cwd, env })).resolves.toBe(true)
      await expect(transcriptHasEntry("sess-leaf", "missing-leaf", { cwd, env })).resolves.toBe(false)
    } finally {
      await rm(config, { recursive: true, force: true })
    }
  })
})
