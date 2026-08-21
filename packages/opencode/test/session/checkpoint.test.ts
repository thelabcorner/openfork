import { afterEach, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionCheckpointTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Hash } from "@opencode-ai/core/util/hash"
import { Global } from "@opencode-ai/core/global"
import { eq } from "drizzle-orm"
import { Effect, Fiber, Layer } from "effect"
import path from "path"
import { TurnCheckpoint } from "../../src/session/checkpoint"
import { Snapshot } from "../../src/snapshot"
import { InstanceState } from "@/effect/instance-state"
import {
  disposeAllInstances,
  testInstanceStoreLayer,
  TestInstance,
} from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([TurnCheckpoint.node, Snapshot.node, Database.node])),
    testInstanceStoreLayer,
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

/** Seed project + session rows matching the test instance so checkpoint FKs resolve. */
const seedSession = Effect.fn("CheckpointTest.seedSession")(function* (sessionID: string) {
  const db = (yield* Database.Service).db
  const ctx = yield* InstanceState.context
  const now = Date.now()
  yield* db
    .insert(ProjectTable)
    .values({
      id: ctx.project.id as any,
      worktree: ctx.worktree as any,
      sandboxes: [],
      time_created: now,
      time_updated: now,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID as any,
      project_id: ctx.project.id as any,
      slug: "checkpoint-test",
      directory: ctx.directory as any,
      title: "checkpoint test",
      version: "0.0.0",
      time_created: now,
      time_updated: now,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const getRows = Effect.fn("CheckpointTest.getRows")(function* (sessionID: string) {
  const db = (yield* Database.Service).db
  return yield* db
    .select()
    .from(SessionCheckpointTable)
    .where(eq(SessionCheckpointTable.session_id, sessionID as any))
    .all()
    .pipe(Effect.orDie)
})

it.instance(
  "begin/finish captures a per-turn checkpoint with diff and retained refs",
  () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const dir = tmp.directory
      const svc = yield* TurnCheckpoint.Service
      const snapshot = yield* Snapshot.Service

      yield* seedSession("ses_checkpoint_test_1")

      // Pre-turn state.
      yield* Effect.promise(() => Bun.write(path.join(dir, "a.txt"), "hello"))

      // Warm the shadow repo so the background finalize measures capture+diff,
      // not cold git bootstrap. Production repos are always warm.
      expect(yield* snapshot.track()).toBeTruthy()

      // Performance contract: begin does no blocking git work — the row exists
      // and is capturing immediately. The pre-turn capture is forked, not awaited.
      const turn = yield* svc.begin({ sessionID: "ses_checkpoint_test_1" as any, userMessageID: "msg_1" })
      expect(turn).toBeDefined()

      let rows = yield* getRows("ses_checkpoint_test_1")
      expect(rows).toHaveLength(1)
      expect(rows[0]!.status).toBe("capturing")
      expect(rows[0]!.before_snapshot).toBeNull()

      // Join the forked baseline capture to prove it started at begin time
      // (pre-tool) — then mutate the worktree.
      expect(yield* Fiber.join(turn!.beforeFiber)).toBeTruthy()

      // The agent fucks up some files.
      yield* Effect.promise(() => Bun.write(path.join(dir, "a.txt"), "changed"))
      yield* Effect.promise(() => Bun.write(path.join(dir, "b.txt"), "new file"))

      // finish returns immediately (background finalize); poll for the row to land.
      const started = Date.now()
      yield* svc.finish(turn)

      const finalized = yield* pollWithTimeout(
        Effect.gen(function* () {
          const current = yield* getRows("ses_checkpoint_test_1")
          return current[0]?.status === "ready" ? current : undefined
        }),
        "turn checkpoint never finalized",
        30_000,
      )
      // finish itself was non-blocking on the turn-completion path.
      expect(Date.now() - started).toBeLessThan(5_000)

      const row = finalized[0]!
      expect(row.status).toBe("ready")
      expect(row.after_snapshot).toBeTruthy()
      expect(row.before_snapshot).toBeTruthy()
      expect(row.kind).toBe("turn")
      expect(row.user_message_id).toBe("msg_1")
      expect(row.finalized_at).toBeGreaterThan(0)
      expect(row.files).toBe(2)
      expect(row.additions).toBeGreaterThan(0)
      expect(row.diff).toHaveLength(2)
      expect(row.diff!.map((d) => d.path as string).sort()).toEqual(["a.txt", "b.txt"])

      // Diff is recomputable from trees via the shared shadow repo.
      const rediff = yield* snapshot.diffFull(row.before_snapshot!, row.after_snapshot!)
      expect(rediff.length).toBe(2)

      // Retained refs pin both trees against GC pruning (t3 §45).
      const ctx = yield* InstanceState.context
      const gitdir = path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree))
      for (const tree of [row.before_snapshot!, row.after_snapshot!]) {
        const proc = Bun.spawnSync([
          "git",
          `--git-dir=${gitdir}`,
          "show-ref",
          "--verify",
          `refs/opencode/retained/${tree}`,
        ])
        expect(proc.exitCode).toBe(0)
      }
    }),
  { git: true },
)

it.instance(
  "fail() CAS-marks capturing rows; finish afterwards cannot resurrect",
  () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const svc = yield* TurnCheckpoint.Service
      yield* seedSession("ses_checkpoint_test_2")

      const turn = yield* svc.begin({ sessionID: "ses_checkpoint_test_2" as any, userMessageID: "msg_1" })
      expect(turn).toBeDefined()

      yield* svc.fail(turn, { code: "aborted", message: "user aborted" })
      const rows = yield* getRows("ses_checkpoint_test_2")
      expect(rows).toHaveLength(1)
      expect(rows[0]!.status).toBe("error")
      expect(rows[0]!.error?.code).toBe("aborted")

      // Background finalize CAS-fails on the error row — status stays error.
      yield* svc.finish(turn)
      yield* Effect.sleep(200)
      const after = yield* getRows("ses_checkpoint_test_2")
      expect(after[0]!.status).toBe("error")
    }),
  { git: true },
)

it.instance(
  "begin reconciles an existing capturing row for the same user message (resume)",
  () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const svc = yield* TurnCheckpoint.Service
      yield* seedSession("ses_checkpoint_test_3")

      const first = yield* svc.begin({ sessionID: "ses_checkpoint_test_3" as any, userMessageID: "msg_resume" })
      expect(first).toBeDefined()

      // Resume of the same logical turn: same user message → same row, same ordinal.
      const second = yield* svc.begin({ sessionID: "ses_checkpoint_test_3" as any, userMessageID: "msg_resume" })
      expect(second).toBeDefined()
      expect(second!.checkpointID).toBe(first!.checkpointID)
      expect(second!.ordinal).toBe(first!.ordinal)

      let rows = yield* getRows("ses_checkpoint_test_3")
      expect(rows).toHaveLength(1)

      // A different user message gets a new ordinal and its own row.
      const third = yield* svc.begin({ sessionID: "ses_checkpoint_test_3" as any, userMessageID: "msg_next" })
      expect(third).toBeDefined()
      expect(third!.ordinal).toBe(first!.ordinal + 1)
      rows = yield* getRows("ses_checkpoint_test_3")
      expect(rows).toHaveLength(2)
    }),
  { git: true },
)
