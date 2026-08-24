import { afterEach, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionCheckpointTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { Effect, Fiber, Layer, Cause, Exit } from "effect"
import path from "path"
import { TurnCheckpoint } from "../../src/session/checkpoint"
import { Snapshot } from "../../src/snapshot"
import { Truncate } from "@/tool/truncate"
import { Agent as AgentSvc } from "../../src/agent/agent"
import * as Tool from "../../src/tool/tool"
import { CheckpointTool } from "../../src/tool/checkpoint"
import {
  disposeAllInstances,
  testInstanceStoreLayer,
  TestInstance,
} from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { seedSessionRow } from "./checkpoint-seed"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([TurnCheckpoint.node, Snapshot.node, Database.node, Truncate.node, AgentSvc.node])),
    testInstanceStoreLayer,
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

const mockCtx = (sessionID: string): Tool.Context<any> => ({
  sessionID: sessionID as any,
  messageID: "prt_mock" as any,
  agent: "test",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

/** Build the tool def fresh for each assertion block. */
const getTool = Effect.gen(function* () {
  const info = yield* CheckpointTool
  return yield* info.init()
})

/** Tool validation errors are dies (git.ts house pattern) — assert on the defect message. */
const expectDie = Effect.fn("CheckpointToolTest.expectDie")(function* (
  effect: Effect.Effect<unknown, never, any>,
  match: string,
) {
  const exit = yield* Effect.exit(effect)
  expect(Exit.isFailure(exit)).toBe(true)
  const messages = Exit.isFailure(exit) ? Cause.prettyErrors(exit.cause).map(String).join("\n") : ""
  expect(messages).toContain(match)
})

/** Fabricate one completed turn: baseline join → writes → background finalize. */
const runTurn = Effect.fn("CheckpointToolTest.runTurn")(function* (
  svc: TurnCheckpoint.Interface,
  sessionID: string,
  userMessageID: string,
  dir: string,
  writes: Array<[string, string]>,
) {
  const turn = yield* svc.begin({ sessionID: sessionID as any, userMessageID })
  yield* Fiber.join(turn!.beforeFiber)
  for (const [name, content] of writes) {
    yield* Effect.promise(() => Bun.write(path.join(dir, name), content))
  }
  yield* svc.finish(turn)
  return yield* pollWithTimeout(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const row = yield* db
        .select()
        .from(SessionCheckpointTable)
        .where(eq(SessionCheckpointTable.user_message_id, userMessageID))
        .get()
        .pipe(Effect.orDie)
      return row && row.status !== "capturing" ? row : undefined
    }),
    `turn ${userMessageID} never finalized`,
    30_000,
  )
})

it.instance(
  "list on a fresh session guides instead of erroring",
  () =>
    Effect.gen(function* () {
      yield* seedSessionRow("ses_tool_empty")
      const tool = yield* getTool
      const res = yield* tool.execute({ mode: "list" }, mockCtx("ses_tool_empty"))
      expect(res.output).toContain(`count="0"`)
      expect(res.output).toContain("no checkpoints yet")
      expect(res.output).toContain("<hint>")
    }),
  { git: true },
)

it.instance(
  "view/diff miss errors teach valid ordinals; view shows detail incl. unicode paths",
  () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const dir = tmp.directory
      const svc = yield* TurnCheckpoint.Service
      const sessionID = "ses_tool_view"
      yield* seedSessionRow(sessionID)
      yield* runTurn(svc, sessionID, "msg_1", dir, [["отчёт-测试.txt", "héllo"]])

      const tool = yield* getTool

      // Miss errors are actionable.
      yield* expectDie(tool.execute({ mode: "view", ordinal: 99 }, mockCtx(sessionID)), "Valid ordinals: 1")

      // View renders full detail with escaped unicode path.
      const view = yield* tool.execute({ mode: "view", ordinal: 1 }, mockCtx(sessionID))
      expect(view.output).toContain("<ordinal>1</ordinal>")
      expect(view.output).toContain("<status>ready</status>")
      expect(view.output).toContain("отчёт-测试.txt")

      // Diff turn scope shows the patch.
      const diff = yield* tool.execute({ mode: "diff", ordinal: 1 }, mockCtx(sessionID))
      expect(diff.output).toContain('scope="turn"')
      expect(diff.output).toContain("héllo")

      // Diff on a capturing row degrades gracefully.
      yield* svc.begin({ sessionID: sessionID as any, userMessageID: "msg_2" })
      const cap = yield* tool.execute({ mode: "diff", ordinal: 2 }, mockCtx(sessionID))
      expect(cap.output).toContain("capturing")
      expect(cap.output).toContain("still in progress")
    }),
  { git: true },
)

it.instance(
  "search filters by touchedPath and query; empty matches guide",
  () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const dir = tmp.directory
      const svc = yield* TurnCheckpoint.Service
      const sessionID = "ses_tool_search"
      yield* seedSessionRow(sessionID)
      yield* runTurn(svc, sessionID, "msg_1", dir, [["src/auth/login.ts", "a"]])
      yield* runTurn(svc, sessionID, "msg_2", dir, [["docs/readme.md", "b"]])

      const tool = yield* getTool

      const byPath = yield* tool.execute({ mode: "search", touchedPath: "auth/login.ts" }, mockCtx(sessionID))
      expect(byPath.output).toContain("login.ts")
      expect(byPath.output).not.toContain("readme.md")

      const byQuery = yield* tool.execute({ mode: "search", query: "readme" }, mockCtx(sessionID))
      expect(byQuery.output).toContain("readme.md")
      expect(byQuery.output).not.toContain("login.ts")

      const none = yield* tool.execute({ mode: "search", query: "zzz-nothing" }, mockCtx(sessionID))
      expect(none.output).toContain(`count="0"`)
      expect(none.output).toContain("no checkpoints match your filters")
    }),
  { git: true },
)

it.instance(
  "diff scopes: turn shows only that turn; session is cumulative",
  () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const dir = tmp.directory
      const svc = yield* TurnCheckpoint.Service
      const sessionID = "ses_tool_diff"
      yield* seedSessionRow(sessionID)
      yield* runTurn(svc, sessionID, "msg_1", dir, [["a.txt", "one"]])
      yield* runTurn(svc, sessionID, "msg_2", dir, [["b.txt", "two"]])

      const tool = yield* getTool

      const turnScope = yield* tool.execute({ mode: "diff", ordinal: 2, scope: "turn" }, mockCtx(sessionID))
      expect(turnScope.output).toContain("b.txt")
      expect(turnScope.output).not.toContain(">one<")

      const sessionScope = yield* tool.execute({ mode: "diff", ordinal: 2, scope: "session" }, mockCtx(sessionID))
      expect(sessionScope.output).toContain("a.txt")
      expect(sessionScope.output).toContain("b.txt")
    }),
  { git: true },
)

it.instance(
  "restore: wrong confirm refuses untouched; dry-run previews deletions without mutating; apply restores + records pre-revert safety point",
  () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const dir = tmp.directory
      const svc = yield* TurnCheckpoint.Service
      const sessionID = "ses_tool_restore"
      yield* seedSessionRow(sessionID)
      yield* runTurn(svc, sessionID, "msg_1", dir, [["base.txt", "v1"]])
      yield* runTurn(svc, sessionID, "msg_2", dir, [
        ["base.txt", "v2"],
        ["extra.txt", "new file"],
      ])

      const tool = yield* getTool
      const ctx = mockCtx(sessionID)
      const baseTxt = path.join(dir, "base.txt")
      const extraTxt = path.join(dir, "extra.txt")
      expect(yield* Effect.promise(() => Bun.file(baseTxt).text())).toBe("v2")

      // 1. Missing confirm token → refuse; filesystem untouched.
      yield* expectDie(
        tool.execute({ mode: "restore", ordinal: 1, dryRun: false }, ctx),
        "RESTORE_CHECKPOINT",
      )
      expect(yield* Effect.promise(() => Bun.file(baseTxt).text())).toBe("v2")
      expect(yield* Effect.promise(() => Bun.file(extraTxt).exists())).toBe(true)

      // 2. Dry-run (default): preview flags the future deletion, mutates nothing.
      const preview = yield* tool.execute({ mode: "restore", ordinal: 1 }, ctx)
      expect(preview.output).toContain("restore-preview")
      expect(preview.output).toContain("willDelete")
      expect(preview.output).toContain("extra.txt")
      expect(preview.metadata.changed).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(baseTxt).text())).toBe("v2")
      expect(yield* Effect.promise(() => Bun.file(extraTxt).exists())).toBe(true)

      // 3. Apply: workspace matches checkpoint 1; pre-revert safety row recorded.
      const applied = yield* tool.execute(
        { mode: "restore", ordinal: 1, dryRun: false, confirm: "RESTORE_CHECKPOINT" },
        ctx,
      )
      expect(applied.metadata.restored).toBe(true)
      expect(typeof applied.metadata.safetyOrdinal).toBe("number")
      // Post-restore re-capture may differ from the target tree by index
      // residue (informational only); real proof is the filesystem below.
      expect(yield* Effect.promise(() => Bun.file(baseTxt).text())).toBe("v1")
      expect(yield* Effect.promise(() => Bun.file(extraTxt).exists())).toBe(false)

      // Safety point exists, is ready/pre-revert, and is restorable itself (undo).
      const rows = yield* pollWithTimeout(
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const all = yield* db
            .select()
            .from(SessionCheckpointTable)
            .where(eq(SessionCheckpointTable.session_id, sessionID as any))
            .all()
            .pipe(Effect.orDie)
          const safety = all.find((r) => r.kind === "pre-revert")
          return safety && safety.status === "ready" ? all : undefined
        }),
        "pre-revert safety row never landed",
        30_000,
      )
      const safety = rows.find((r) => r.kind === "pre-revert")!
      expect(safety.ordinal).toBe(3)
      expect(safety.after_snapshot).toBeTruthy()

      // Undo works: restoring to the safety ordinal brings back the v2 world.
      const undo = yield* tool.execute(
        { mode: "restore", ordinal: safety.ordinal, dryRun: false, confirm: "RESTORE_CHECKPOINT" },
        ctx,
      )
      expect(undo.metadata.restored).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(baseTxt).text())).toBe("v2")
      expect(yield* Effect.promise(() => Bun.file(extraTxt).exists())).toBe(true)
    }),
  { git: true },
  120_000,
)

it.instance(
  "restore refuses capturing rows and cross-epoch targets",
  () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const dir = tmp.directory
      const svc = yield* TurnCheckpoint.Service
      const sessionID = "ses_tool_guard"
      yield* seedSessionRow(sessionID)
      yield* runTurn(svc, sessionID, "msg_1", dir, [["keep.txt", "original"]])

      const tool = yield* getTool
      const ctx = mockCtx(sessionID)

      // Capturing row → refused.
      yield* svc.begin({ sessionID: sessionID as any, userMessageID: "msg_cap" })
      yield* expectDie(
        tool.execute({ mode: "restore", ordinal: 2, dryRun: false, confirm: "RESTORE_CHECKPOINT" }, ctx),
        "capturing",
      )

      // Epoch tamper → refused with identity explanation; file untouched.
      const db = (yield* Database.Service).db
      yield* db
        .update(SessionCheckpointTable)
        .set({ epoch: "bogus-epoch" })
        .where(eq(SessionCheckpointTable.ordinal, 1))
        .run()
        .pipe(Effect.orDie)
      yield* expectDie(
        tool.execute({ mode: "restore", ordinal: 1, dryRun: false, confirm: "RESTORE_CHECKPOINT" }, ctx),
        "different worktree identity",
      )
      expect(yield* Effect.promise(() => Bun.file(path.join(dir, "keep.txt")).text())).toBe("original")
    }),
  { git: true },
)
