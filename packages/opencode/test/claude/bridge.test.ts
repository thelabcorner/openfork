import { describe, test, expect } from "bun:test"
import { BridgeStore, isSafeToolName, isAllowedTool, sanitizeOutput, validateScope, MAX_PENDING_PER_SESSION, MAX_OUTPUT_BYTES } from "../../src/claude/bridge"
import { Effect } from "effect"

const owner = { projectID: "proj-1", worktree: "/repo/proj1", directory: "/repo/proj1", cwd: "/repo/proj1" }
const otherScope = { projectID: "proj-2", worktree: "/repo/proj2", directory: "/repo/proj2", cwd: "/repo/proj2" }

function req(callID: string, tool = "read", scope = owner, sessionID = "sess-1") {
  return { callID, tool, input: { path: "/repo/proj1/file.ts" }, sessionID, scope }
}

describe("ClaudeBridge state machine", () => {
  test("park and complete exactly once", () => {
    const store = new BridgeStore()
    store.park(req("c1"))
    const out = store.complete("c1", { callID: "c1", status: "success", output: "ok" })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.result.isUntrusted).toBe(true)
    const second = store.complete("c1", { callID: "c1", status: "success", output: "again" })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.code).toBe("duplicate_continuation")
  })

  test("multiple pending tools resume correctly and independently", () => {
    const store = new BridgeStore()
    store.park(req("c1"))
    store.park(req("c2"))
    store.park(req("c3"))
    expect(store.list("sess-1").length).toBe(3)
    expect(store.complete("c2", { callID: "c2", status: "success", output: "two" }).ok).toBe(true)
    expect(store.complete("c1", { callID: "c1", status: "error", error: "fail" }).ok).toBe(true)
    // c3 still pending
    expect(store.get("c3")?.status).toBe("pending")
    expect(store.complete("c3", { callID: "c3", status: "success", output: "three" }).ok).toBe(true)
  })

  test("denied tools do not execute and are terminal", () => {
    const store = new BridgeStore()
    store.park(req("c1"))
    store.deny("c1")
    expect(store.get("c1")?.status).toBe("denied")
    const second = store.complete("c1", { callID: "c1", status: "success", output: "should fail" })
    expect(second.ok).toBe(false)
  })

  test("timeout is terminal and exact-once", () => {
    const store = new BridgeStore()
    store.park(req("c1"))
    store.timeout("c1")
    expect(store.get("c1")?.status).toBe("timedOut")
    expect(store.complete("c1", { callID: "c1", status: "success", output: "x" }).ok).toBe(false)
  })

  test("cancelled/disposed session rejects all pending bridges", () => {
    const store = new BridgeStore()
    store.park(req("c1", "read", owner, "sess-A"))
    store.park(req("c2", "read", owner, "sess-A"))
    store.park(req("c3", "read", owner, "sess-B"))
    const cancelled = store.cancelSession("sess-A")
    expect(cancelled.length).toBe(2)
    expect(store.get("c1")?.status).toBe("cancelled")
    expect(store.get("c2")?.status).toBe("cancelled")
    expect(store.get("c3")?.status).toBe("pending")

    const disposed = store.dispose()
    // only c3 was still pending
    expect(disposed.length).toBe(1)
    expect(store.isDisposed()).toBe(true)
    expect(() => store.park(req("c4"))).toThrow()
  })

  test("overflow: too many pending per session", () => {
    const store = new BridgeStore()
    for (let i = 0; i < MAX_PENDING_PER_SESSION; i++) store.park(req(`c${i}`, "read", owner, "sess-1"))
    expect(() => store.park(req(`c${MAX_PENDING_PER_SESSION}`))).toThrow()
  })

  test("duplicate callID rejected", () => {
    const store = new BridgeStore()
    store.park(req("dup"))
    expect(() => store.park(req("dup"))).toThrow()
  })

  test("invalid tool names rejected", () => {
    expect(isSafeToolName("")).toBe(false)
    expect(isSafeToolName("bash; rm -rf")).toBe(false)
    expect(isSafeToolName("../escape")).toBe(false)
    expect(isSafeToolName("read")).toBe(true)
  })

  test("isAllowedTool respects allowlist and denylist, no blanket allow", () => {
    const allowed = new Set(["read", "grep", "custom-tool"])
    expect(isAllowedTool("read", allowed)).toBe(false) // denylisted builtin
    expect(isAllowedTool("grep", allowed)).toBe(true)
    expect(isAllowedTool("custom-tool", allowed)).toBe(true)
    expect(isAllowedTool("bash", allowed)).toBe(false)
    expect(isAllowedTool("evil", allowed)).toBe(false)
    expect(isAllowedTool("evil", new Set())).toBe(false)
  })

  test("validateScope blocks cross-project", () => {
    expect(validateScope(owner, owner)).toBe(true)
    expect(validateScope(otherScope, owner)).toBe(false)
  })

  test("enforceScope cancels cross-project entries", () => {
    const store = new BridgeStore()
    store.park(req("c1", "grep", owner, "sess-1"))
    // Manually inject cross-project entry by bypassing park validation
    // Use a second store to simulate attacker
    const store2 = new BridgeStore()
    // park with other project scope
    store2.park(req("x1", "grep", otherScope, "sess-1"))
    // enforce owner scope cancels it
    const affected = store2.enforceScope(owner)
    expect(affected.length).toBe(1)
    expect(affected[0]?.status).toBe("cancelled")
  })

  test("untrusted result boundary: output is fenced and truncated", () => {
    const store = new BridgeStore()
    store.park(req("c1"))
    const huge = "a".repeat(MAX_OUTPUT_BYTES + 100)
    const out = store.complete("c1", { callID: "c1", status: "success", output: huge })
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.result.isUntrusted).toBe(true)
      expect(out.result.output!.length).toBeLessThan(huge.length)
      expect(out.result.output!).toContain("truncated")
    }
    // sanitizeOutput directly
    expect(sanitizeOutput("ok")).toBe("ok")
    expect(sanitizeOutput(huge).length).toBeLessThan(huge.length)
  })

  test("markExecuting transition", () => {
    const store = new BridgeStore()
    store.park(req("c1"))
    store.markExecuting("c1")
    expect(store.get("c1")?.status).toBe("executing")
    expect(() => store.markExecuting("c1")).toThrow()
  })

  test("Effect wrappers preserve exact-once semantics", async () => {
    const store = new BridgeStore()
    const { parkEffect, completeEffect } = await import("../../src/claude/bridge")
    const scope = owner
    const parked = await Effect.runPromise(parkEffect(store, req("eff1"), scope))
    expect(parked.request.callID).toBe("eff1")
    const result = await Effect.runPromise(completeEffect(store, "eff1", { callID: "eff1", status: "success", output: "done" }))
    expect(result.isUntrusted).toBe(true)
    // second complete should fail
    const exit = await Effect.runPromiseExit(completeEffect(store, "eff1", { callID: "eff1", status: "success", output: "again" }))
    // exit is failure
    const { Exit } = await import("effect")
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
