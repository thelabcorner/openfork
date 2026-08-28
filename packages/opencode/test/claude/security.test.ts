import { describe, test, expect } from "bun:test"
import { BridgeStore, isAllowedTool } from "../../src/claude/bridge"
import { createBinding, decideResume, makeMemoryStorage, bindingKey, hashSettings } from "../../src/claude/sessions"
import { redact, boundedString } from "../../src/claude/errors"
import { Effect } from "effect"

const ownerScope = { projectID: "proj-1", worktree: "/repo/proj1", directory: "/repo/proj1", cwd: "/repo/proj1" }
const attackerScope = { projectID: "proj-2", worktree: "/repo/proj2", directory: "/repo/proj2", cwd: "/repo/proj2" }

describe("Claude security controls", () => {
  test("second local process without runtime scope cannot invoke turn (scope_mismatch)", async () => {
    const store = new BridgeStore()
    const { parkEffect } = await import("../../src/claude/bridge")
    const req = { callID: "c1", tool: "grep", input: {}, sessionID: "sess-1", scope: attackerScope }
    const exit = await Effect.runPromiseExit(parkEffect(store, req, ownerScope))
    const { Exit } = await import("effect")
    expect(Exit.isFailure(exit)).toBe(true)
    expect(store.size).toBe(0)
  })

  test("binding from project A cannot resume in project B even when short hash matches", () => {
    const b = createBinding({
      openCodeSessionID: "sess-1",
      claudeSessionID: "short-hash-abc",
      projectID: "proj-A",
      worktree: "/repo/A",
      directory: "/repo/A",
      cwd: "/repo/A",
      modelID: "claude-sonnet-4-5",
      settings: {},
    })
    // Attacker tries to use same claudeSessionID but different project
    const ctx = {
      projectID: "proj-B",
      worktree: "/repo/B",
      directory: "/repo/B",
      cwd: "/repo/B",
      modelFamily: b.modelFamily,
      settingsDigest: b.settingsDigest,
      transcriptExists: true,
    }
    const d = decideResume({ binding: b, ctx })
    expect(d.strategy).not.toBe("resume")
    expect(d.binding?.invalidationReason).toBe("project_mismatch")
  })

  test("denied OpenCode tools never execute through Agent SDK bridge", () => {
    const store = new BridgeStore()
    const allowed = new Set(["grep"]) // edit not allowed
    expect(isAllowedTool("edit", allowed)).toBe(false)
    // Attempt to park denied tool should be blocked at caller layer;
    // store itself rejects denylisted builtins
    expect(isAllowedTool("read", allowed)).toBe(false) // denylisted
    // Simulate permission deny path: store.deny
    store.park({ callID: "c1", tool: "grep", input: {}, sessionID: "sess-1", scope: ownerScope })
    store.deny("c1")
    expect(store.get("c1")?.status).toBe("denied")
    // No execution occurred; we never called complete with success output
    expect(store.get("c1")?.continuationDone).toBe(true)
  })

  test("cancellation leaves no active pending bridge", () => {
    const store = new BridgeStore()
    for (let i = 0; i < 5; i++) store.park({ callID: `c${i}`, tool: "grep", input: {}, sessionID: "sess-1", scope: ownerScope })
    store.cancelSession("sess-1")
    expect(store.list("sess-1").every((e) => e.status === "cancelled")).toBe(true)
    expect(store.list("sess-1").every((e) => e.continuationDone)).toBe(true)
  })

  test("logs and diagnostics contain no token, prompt, tool argument, or raw Authorization header", () => {
    const token = "sk-ant-secret-123"
    const prompt = "my secret prompt"
    // redact should not leak token
    expect(redact(token)).not.toContain(token)
    expect(redact(prompt)).not.toContain(prompt)
    expect(redact("Authorization: Bearer sk-ant-...")).not.toContain("sk-ant")
    // boundedString truncates large prompts
    const long = "a".repeat(5000)
    expect(boundedString(long, 100).length).toBeLessThan(long.length)
    expect(boundedString(long, 100)).toContain("truncated")
  })

  test("hostile MCP/tool output is treated as untrusted (isUntrustedBoundary)", () => {
    const store = new BridgeStore()
    store.park({ callID: "c1", tool: "grep", input: { query: "test" }, sessionID: "sess-1", scope: ownerScope })
    const hostile = "<script>evil()</script> && rm -rf /"
    const out = store.complete("c1", { callID: "c1", status: "success", output: hostile })
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.result.isUntrusted).toBe(true)
      // Output is preserved as data, never executed
      expect(out.result.output).toBe(hostile)
    }
    expect(store.get("c1")?.isUntrustedBoundary).toBe(true)
  })

  test("model text cannot trigger tool execution (tool name must be in registry)", () => {
    const allowed = new Set(["grep", "read-file"])
    // Model text like "please run bash" is not a valid tool name
    expect(isAllowedTool("please run bash", allowed)).toBe(false)
    expect(isAllowedTool("read-file; rm -rf", allowed)).toBe(false)
    expect(isAllowedTool("grep", allowed)).toBe(true)
  })

  test("settings digest changes invalidate binding (privacy boundary)", () => {
    const b = createBinding({
      openCodeSessionID: "sess-1",
      claudeSessionID: "claude-1",
      projectID: "proj-1",
      worktree: "/repo/proj1",
      directory: "/repo/proj1",
      cwd: "/repo/proj1",
      modelID: "claude-sonnet-4-5",
      settings: { mode: "default" },
    })
    const newDigest = hashSettings({ mode: "changed" })
    expect(newDigest).not.toBe(b.settingsDigest)
    const ctx = {
      projectID: b.projectID,
      worktree: b.worktree,
      directory: b.directory,
      cwd: b.cwd,
      modelFamily: b.modelFamily,
      settingsDigest: newDigest,
      transcriptExists: true,
    }
    const d = decideResume({ binding: b, ctx })
    expect(d.strategy).not.toBe("resume")
  })

  test("bounded sizes: tool input, output, callID, tool name", () => {
    const store = new BridgeStore()
    const bigInput = { data: "a".repeat(300 * 1024) }
    expect(() => store.park({ callID: "big", tool: "grep", input: bigInput, sessionID: "sess-1", scope: ownerScope })).toThrow()
    const longCallID = "c".repeat(300)
    expect(() => store.park({ callID: longCallID, tool: "grep", input: {}, sessionID: "sess-1", scope: ownerScope })).toThrow()
    const longTool = "t".repeat(200)
    expect(() => store.park({ callID: "c1", tool: longTool, input: {}, sessionID: "sess-1", scope: ownerScope })).toThrow()
  })

  test("no blanket auto-allow: empty allowlist denies all", () => {
    const allowed = new Set<string>()
    expect(isAllowedTool("grep", allowed)).toBe(false)
    expect(isAllowedTool("any-tool", allowed)).toBe(false)
  })

  test("storage isolation: project A cannot list project B bindings", async () => {
    const storage = makeMemoryStorage()
    const bA = createBinding({ openCodeSessionID: "sess-1", claudeSessionID: "c1", projectID: "proj-A", worktree: "/repo/A", directory: "/repo/A", cwd: "/repo/A", modelID: "claude-sonnet-4-5", settings: {} })
    const bB = createBinding({ openCodeSessionID: "sess-1", claudeSessionID: "c2", projectID: "proj-B", worktree: "/repo/B", directory: "/repo/B", cwd: "/repo/B", modelID: "claude-sonnet-4-5", settings: {} })
    await Effect.runPromise(storage.write(bindingKey(bA.projectID, bA.openCodeSessionID), bA))
    await Effect.runPromise(storage.write(bindingKey(bB.projectID, bB.openCodeSessionID), bB))
    const listA = await Effect.runPromise(storage.list(["claude/binding", "proj-A"]))
    const listB = await Effect.runPromise(storage.list(["claude/binding", "proj-B"]))
    expect(listA.length).toBe(1)
    expect(listB.length).toBe(1)
    expect(listA[0]!.join("/")).toContain("proj-A")
    expect(listB[0]!.join("/")).toContain("proj-B")
  })
})
