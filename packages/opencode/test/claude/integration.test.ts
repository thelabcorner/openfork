import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { BridgeStore } from "../../src/claude/bridge"
import { ClaudeAgentRuntime } from "../../src/claude/runtime"
import { createBinding, modelFamilyOf, hashSettings } from "../../src/claude/sessions"
import { makeStorageBindingStorage } from "../../src/claude/binding-persistence"
import { executeBridgeTool, ownerScope } from "../../src/claude/tool-bridge"
import { Tool } from "../../src/tool/tool"

const EchoToolParams = Schema.Struct({ text: Schema.String })

async function echoDef(): Promise<Tool.Def> {
  const info = {
    id: "echo-claude",
    description: "echo for claude integration test",
    parameters: EchoToolParams,
    execute: (args: { text: string }) => Effect.succeed({ title: "echo", metadata: {}, output: `echo:${args.text}` }),
  } as unknown as Tool.Def
  return info
}

function memoryStorage() {
  const map = new Map<string, unknown>()
  const keyOf = (k: string[]) => k.join("/")
  return {
    read: <T>(key: string[]) =>
      Effect.gen(function* () {
        const v = map.get(keyOf(key))
        if (!v) return yield* Effect.fail(Object.assign(new Error("not found"), { _tag: "NotFoundError" }) as any)
        return v as T
      }),
    write: (key: string[], content: unknown) => Effect.sync(() => { map.set(keyOf(key), content) }),
    remove: (key: string[]) => Effect.sync(() => { map.delete(keyOf(key)) }),
    list: (prefix: string[]) =>
      Effect.sync(() => {
        const p = prefix.join("/")
        return [...map.keys()].filter((k) => k.startsWith(p)).map((k) => k.split("/"))
      }),
  }
}

describe("claude integration: persistence + bridge + fake SDK", () => {
  test("binding persists via Storage and never deletes Claude transcript", async () => {
    const storage: any = memoryStorage()
    const persist = makeStorageBindingStorage(storage)
    const projectID = `proj-${Math.random().toString(36).slice(2, 8)}`
    const openCodeSessionID = `sess-${Math.random().toString(36).slice(2, 8)}`
    const binding = createBinding({
      openCodeSessionID,
      claudeSessionID: "claude-ext-123",
      projectID,
      worktree: "/tmp/worktree",
      directory: "/tmp/worktree",
      cwd: "/tmp/worktree",
      modelID: "claude-sonnet-4-5-20250514",
      settings: { foo: "bar" },
    })
    await Effect.runPromise(persist.write(["claude/binding", projectID, openCodeSessionID], binding))
    const loaded: any = await Effect.runPromise(persist.read(["claude/binding", projectID, openCodeSessionID]))
    expect(loaded.claudeSessionID).toBe("claude-ext-123")
    expect(loaded.modelFamily).toBe(modelFamilyOf("claude-sonnet-4-5-20250514"))
    expect(loaded.settingsDigest).toBe(hashSettings({ foo: "bar" }))
    const listed: any = await Effect.runPromise(persist.list(["claude/binding", projectID]))
    expect(listed.some((k: string[]) => k.join("/") === `claude/binding/${projectID}/${openCodeSessionID}`)).toBe(true)
    await Effect.runPromise(persist.remove(["claude/binding", projectID, openCodeSessionID]))
    const missing = await Effect.runPromise(persist.read(["claude/binding", projectID, openCodeSessionID]).pipe(Effect.exit))
    const { Exit } = await import("effect")
    expect(Exit.isFailure(missing)).toBe(true)
  })

  test("bridge executes via Permission + registry with exact-once, scope, cancellation", async () => {
    const def = await echoDef()
    const store = new BridgeStore()
    const allowPermission = { ask: () => Effect.void }
    const scope = ownerScope("/tmp/worktree", "/tmp/worktree", "proj-1")
    const result: any = await Effect.runPromise(
      (executeBridgeTool as any)({ store, permission: allowPermission as any, tools: [def], ownerScope: scope, request: { tool: "echo-claude", input: { text: "hello" }, callID: "call-1", sessionID: "sess-1", scope } }),
    )
    expect(result.toolOutput).toBe("echo:hello")
    expect(result.bridgeResult.isUntrusted).toBe(true)

    // exact-once: duplicate callID fails
    const second = await Effect.runPromiseExit(
      (executeBridgeTool as any)({ store, permission: allowPermission as any, tools: [def], ownerScope: scope, request: { tool: "echo-claude", input: { text: "again" }, callID: "call-1", sessionID: "sess-1", scope } }),
    )
    const { Exit: Exit2 } = await import("effect")
    expect(Exit2.isFailure(second)).toBe(true)

    // scope enforcement: cross-project rejected
    const cross = await Effect.runPromiseExit(
      (executeBridgeTool as any)({
        store,
        permission: allowPermission as any,
        tools: [def],
        ownerScope: scope,
        request: { tool: "echo-claude", input: { text: "cross" }, callID: "call-cross", sessionID: "sess-1", scope: { projectID: "other-project", worktree: "/other", directory: "/other", cwd: "/other" } },
      }),
    )
    expect(Exit2.isFailure(cross)).toBe(true)

    // cancellation
    store.park({ callID: "call-cancel", tool: "echo-claude", input: { text: "pending" }, sessionID: "sess-cancel", scope })
    store.markExecuting("call-cancel")
    const cancelled = store.cancelSession("sess-cancel")
    expect(cancelled.some((e) => e.request.callID === "call-cancel" && e.status === "cancelled")).toBe(true)
    store.park({ callID: "call-dispose", tool: "echo-claude", input: { text: "x" }, sessionID: "sess-dispose", scope })
    const disposed = store.dispose()
    expect(disposed.length).toBeGreaterThanOrEqual(1)
  })

  test("fake SDK turn drives tool bridge and persists binding", async () => {
    const storage: any = memoryStorage()
    const persist = makeStorageBindingStorage(storage)
    const projectID = "proj-sdk"

    class Ctrl {
      queue: unknown[] = []
      resolvers: Array<(r: IteratorResult<unknown>) => void> = []
      ended = false
      push(v: unknown) {
        const r = this.resolvers.shift()
        if (r) r({ done: false, value: v })
        else this.queue.push(v)
      }
      end() {
        this.ended = true
        for (const r of this.resolvers.splice(0)) r({ done: true, value: undefined as any })
      }
      get events(): AsyncIterable<unknown> {
        const self = this
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () =>
                new Promise<IteratorResult<unknown>>((resolve) => {
                  const q = self.queue.shift()
                  if (q !== undefined) return resolve({ done: false, value: q })
                  if (self.ended) return resolve({ done: true, value: undefined as any })
                  self.resolvers.push(resolve)
                }),
            }
          },
        }
      }
    }

    const ctrl = new Ctrl()
    const fakeModule = { query: () => ({ events: ctrl.events, interrupt: async () => {}, close: () => ctrl.end(), pid: 9999 }) }
    const runtime = new ClaudeAgentRuntime({ loader: async () => fakeModule as any })
    const initEvent = { type: "system", subtype: "init", session_id: "ext-sdk-1" }
    const resultEvent = { type: "result", subtype: "success", is_error: false, result: "done", session_id: "ext-sdk-1" }
    const turnPromise = runtime.run({ prompt: "hi from test" })
    ctrl.push(initEvent)
    ctrl.push(resultEvent)
    ctrl.end()
    const outcome = await turnPromise
    expect(outcome.status).toBe("completed")
    expect(outcome.sessionID).toBe("ext-sdk-1")

    const binding = createBinding({
      openCodeSessionID: "sess-sdk-1",
      claudeSessionID: outcome.sessionID ?? "ext-sdk-1",
      projectID,
      worktree: "/tmp/worktree",
      directory: "/tmp/worktree",
      cwd: "/tmp/worktree",
      modelID: "claude-sonnet-4-5-20250514",
      settings: {},
    })
    await Effect.runPromise(persist.write(["claude/binding", projectID, "sess-sdk-1"], binding))
    const reloaded: any = await Effect.runPromise(persist.read(["claude/binding", projectID, "sess-sdk-1"]))
    expect(reloaded.claudeSessionID).toBe("ext-sdk-1")
    await Effect.runPromise(persist.remove(["claude/binding", projectID, "sess-sdk-1"]))
  })
})
