import { afterEach, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Checkpoint } from "@opencode-ai/core/checkpoint"
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
import { seedSessionRow } from "./checkpoint-seed"

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
const seedSession = seedSessionRow

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

      // Retained refs are checkpoint-owner scoped. Equal trees in other
      // checkpoints must not share a releasable ref.
      const ctx = yield* InstanceState.context
      const gitdir = path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree))
      for (const [slot, tree] of [
        ["before", row.before_snapshot!],
        ["after", row.after_snapshot!],
      ] as const) {
        const proc = Bun.spawnSync([
          "git",
          `--git-dir=${gitdir}`,
          "show-ref",
          "--verify",
          `refs/opencode/retained/${Checkpoint.snapshotRetentionKey(row.id, slot, tree)}`,
        ])
        expect(proc.exitCode).toBe(0)
      }
    }),
  { git: true },
)

it.instance(
  "retention reconciliation prunes orphan/stale refs while preserving durable and in-flight owners",
  () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const svc = yield* TurnCheckpoint.Service
      const snapshot = yield* Snapshot.Service
      const sessionID = "ses_checkpoint_retention_reconcile"
      yield* seedSession(sessionID)
      expect(yield* snapshot.track()).toBeTruthy()

      const first = yield* svc.begin({ sessionID: sessionID as any, userMessageID: "msg_ready" })
      yield* Fiber.join(first!.beforeFiber)
      yield* Effect.promise(() => Bun.write(path.join(tmp.directory, "retained.txt"), "ready"))
      yield* svc.finish(first)
      const ready = yield* pollWithTimeout(
        Effect.gen(function* () {
          const row = (yield* getRows(sessionID))[0]
          return row?.status === "ready" ? row : undefined
        }),
        "retention fixture never finalized",
        30_000,
      )
      yield* svc.quiesce(sessionID as any)

      const ctx = yield* InstanceState.context
      const gitdir = path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree))
      const commit = Bun.spawnSync([
        "git",
        "-c",
        "user.name=opencode",
        "-c",
        "user.email=opencode@localhost",
        `--git-dir=${gitdir}`,
        "commit-tree",
        ready.after_snapshot!,
        "-m",
        "retention-reconcile-fixture",
      ])
      expect(commit.exitCode).toBe(0)
      const commitID = commit.stdout.toString().trim()
      const validAfterRef = `refs/opencode/retained/${Checkpoint.snapshotRetentionKey(
        ready.id,
        "after",
        ready.after_snapshot!,
      )}`
      const staleAfterRef = `refs/opencode/retained/${Checkpoint.snapshotRetentionKey(ready.id, "after", "stale-tree")}`
      const orphanRef = `refs/opencode/retained/${Checkpoint.snapshotRetentionKey(
        "checkpoint-does-not-exist",
        "after",
        "orphan-tree",
      )}`
      for (const ref of [staleAfterRef, orphanRef]) {
        expect(Bun.spawnSync(["git", `--git-dir=${gitdir}`, "update-ref", ref, commitID]).exitCode).toBe(0)
      }

      const second = yield* svc.begin({ sessionID: sessionID as any, userMessageID: "msg_capturing" })
      yield* Fiber.join(second!.beforeFiber)
      const speculativeRef = `refs/opencode/retained/${Checkpoint.snapshotRetentionKey(
        second!.checkpointID,
        "after",
        "speculative-tree",
      )}`
      expect(Bun.spawnSync(["git", `--git-dir=${gitdir}`, "update-ref", speculativeRef, commitID]).exitCode).toBe(0)

      const firstSweep = yield* svc.reconcileRetention()
      expect(firstSweep.released).toBeGreaterThanOrEqual(2)
      expect(Bun.spawnSync(["git", `--git-dir=${gitdir}`, "show-ref", "--verify", validAfterRef]).exitCode).toBe(0)
      expect(Bun.spawnSync(["git", `--git-dir=${gitdir}`, "show-ref", "--verify", staleAfterRef]).exitCode).not.toBe(0)
      expect(Bun.spawnSync(["git", `--git-dir=${gitdir}`, "show-ref", "--verify", orphanRef]).exitCode).not.toBe(0)
      // New retention is pinned before finalize CAS, so capturing rows are
      // conservatively transparent to maintenance.
      expect(Bun.spawnSync(["git", `--git-dir=${gitdir}`, "show-ref", "--verify", speculativeRef]).exitCode).toBe(0)

      yield* svc.fail(second, { code: "fixture", message: "settle capturing row" })
      const secondSweep = yield* svc.reconcileRetention()
      expect(secondSweep.released).toBeGreaterThanOrEqual(1)
      expect(Bun.spawnSync(["git", `--git-dir=${gitdir}`, "show-ref", "--verify", speculativeRef]).exitCode).not.toBe(0)
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

it.instance(
  "concurrent begin calls share one authoritative handle for the same logical worker root",
  () =>
    Effect.gen(function* () {
      const svc = yield* TurnCheckpoint.Service
      const sessionID = "ses_checkpoint_concurrent_begin"
      yield* seedSession(sessionID)

      const turns = yield* Effect.all(
        Array.from({ length: 16 }, () =>
          svc.begin({ sessionID: sessionID as any, userMessageID: "msg_same_root" }),
        ),
        { concurrency: "unbounded" },
      )
      const first = turns[0]
      expect(first).toBeDefined()
      for (const turn of turns) {
        expect(turn).toBe(first)
        expect(turn?.checkpointID).toBe(first?.checkpointID)
        expect(turn?.ordinal).toBe(first?.ordinal)
      }
      expect(yield* getRows(sessionID)).toHaveLength(1)
    }),
  { git: true },
)

it.instance(
  "reopens a finalized checkpoint for the same canonical worker root and preserves the original rollback baseline",
  () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const dir = tmp.directory
      const svc = yield* TurnCheckpoint.Service
      const sessionID = "ses_checkpoint_reopen_ready"
      yield* seedSession(sessionID)

      yield* Effect.promise(() => Bun.write(path.join(dir, "base.txt"), "before"))
      const first = yield* svc.begin({ sessionID: sessionID as any, userMessageID: "msg_root" })
      expect(first).toBeDefined()
      const originalBefore = yield* Fiber.join(first!.beforeFiber)
      expect(originalBefore).toBeTruthy()
      if (!originalBefore) throw new Error("expected initial checkpoint snapshot")
      yield* Effect.promise(() => Bun.write(path.join(dir, "cycle-1.txt"), "one"))
      yield* svc.finish(first)

      const firstReady = yield* pollWithTimeout(
        Effect.gen(function* () {
          const rows = yield* getRows(sessionID)
          return rows[0]?.status === "ready" ? rows[0] : undefined
        }),
        "first logical cycle never finalized",
        30_000,
      )
      expect(firstReady.before_snapshot).toBe(originalBefore)
      const originalAfter = firstReady.after_snapshot
      expect(originalAfter).toBeTruthy()
      if (!originalAfter) throw new Error("expected finalized checkpoint snapshot")

      const second = yield* svc.begin({ sessionID: sessionID as any, userMessageID: "msg_root" })
      expect(second).toBeDefined()
      expect(second!.checkpointID).toBe(first!.checkpointID)
      expect(second!.ordinal).toBe(first!.ordinal)
      expect(yield* Fiber.join(second!.beforeFiber)).toBe(originalBefore)
      const reopened = (yield* getRows(sessionID))[0]!
      expect(reopened.status).toBe("capturing")
      // A crash/interruption before replacement finalize must not erase the
      // last known recoverable post-state. Capturing status keeps it inactive.
      expect(reopened.after_snapshot).toBe(originalAfter)

      yield* Effect.promise(() => Bun.write(path.join(dir, "cycle-2.txt"), "two"))
      yield* svc.finish(second)
      const final = yield* pollWithTimeout(
        Effect.gen(function* () {
          const rows = yield* getRows(sessionID)
          return rows[0]?.status === "ready" ? rows[0] : undefined
        }),
        "reopened logical checkpoint never finalized",
        30_000,
      )

      expect((yield* getRows(sessionID))).toHaveLength(1)
      expect(final.before_snapshot).toBe(originalBefore)
      expect(final.diff!.map((item) => item.path as string).sort()).toEqual(["cycle-1.txt", "cycle-2.txt"])

      yield* svc.quiesce(sessionID as any)
      const ctx = yield* InstanceState.context
      const gitdir = path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree))
      const oldAfterRef = `refs/opencode/retained/${Checkpoint.snapshotRetentionKey(
        final.id,
        "after",
        originalAfter!,
      )}`
      const currentAfterRef = `refs/opencode/retained/${Checkpoint.snapshotRetentionKey(
        final.id,
        "after",
        final.after_snapshot!,
      )}`
      expect(Bun.spawnSync(["git", `--git-dir=${gitdir}`, "show-ref", "--verify", oldAfterRef]).exitCode).not.toBe(0)
      expect(Bun.spawnSync(["git", `--git-dir=${gitdir}`, "show-ref", "--verify", currentAfterRef]).exitCode).toBe(0)
    }),
  { git: true },
)

it.instance(
  "reopens an aborted checkpoint when the same worker root is resumed after preemption",
  () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const dir = tmp.directory
      const svc = yield* TurnCheckpoint.Service
      const sessionID = "ses_checkpoint_reopen_aborted"
      yield* seedSession(sessionID)

      const first = yield* svc.begin({ sessionID: sessionID as any, userMessageID: "msg_root" })
      const originalBefore = yield* Fiber.join(first!.beforeFiber)
      if (!originalBefore) throw new Error("expected aborted checkpoint snapshot")
      yield* Effect.promise(() => Bun.write(path.join(dir, "interrupted.txt"), "partial"))
      yield* svc.finishAborted(sessionID as any)

      const aborted = yield* pollWithTimeout(
        Effect.gen(function* () {
          const rows = yield* getRows(sessionID)
          return rows[0]?.status === "aborted" ? rows[0] : undefined
        }),
        "aborted logical checkpoint never finalized",
        30_000,
      )
      expect(aborted.before_snapshot).toBe(originalBefore)

      const resumed = yield* svc.begin({ sessionID: sessionID as any, userMessageID: "msg_root" })
      expect(resumed!.checkpointID).toBe(first!.checkpointID)
      expect(yield* Fiber.join(resumed!.beforeFiber)).toBe(originalBefore)
      yield* Effect.promise(() => Bun.write(path.join(dir, "resumed.txt"), "complete"))
      yield* svc.finish(resumed)

      const final = yield* pollWithTimeout(
        Effect.gen(function* () {
          const rows = yield* getRows(sessionID)
          return rows[0]?.status === "ready" ? rows[0] : undefined
        }),
        "resumed logical checkpoint never finalized",
        30_000,
      )
      expect((yield* getRows(sessionID))).toHaveLength(1)
      expect(final.diff!.map((item) => item.path as string).sort()).toEqual(["interrupted.txt", "resumed.txt"])
    }),
  { git: true },
)

it.instance(
  "hard-interrupted turn captures after-state with status aborted (t3 §47)",
  () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const dir = tmp.directory
      const svc = yield* TurnCheckpoint.Service
      const sessionID = "ses_checkpoint_test_4"
      yield* seedSession(sessionID)

      const turn = yield* svc.begin({ sessionID: sessionID as any, userMessageID: "msg_1" })
      expect(turn).toBeDefined()
      expect(yield* Fiber.join(turn!.beforeFiber)).toBeTruthy()

      // The model fucked up files before the hard kill.
      yield* Effect.promise(() => Bun.write(path.join(dir, "wrecked.txt"), "half-written"))

      // Simulates runLoop fiber death: prompt.ts wires onError → finishAborted.
      yield* svc.finishAborted(sessionID as any)

      const finalized = yield* pollWithTimeout(
        Effect.gen(function* () {
          const current = yield* getRows(sessionID)
          return current[0]?.status !== "capturing" ? current : undefined
        }),
        "aborted checkpoint never finalized",
        30_000,
      )
      const row = finalized[0]!
      expect(row.status).toBe("aborted")
      expect(row.after_snapshot).toBeTruthy()
      expect(row.before_snapshot).toBeTruthy()
      expect(row.files).toBeGreaterThanOrEqual(1)
      // Diff remains reviewable/revertible after abort.
      expect(row.diff!.map((d) => d.path as string)).toContain("wrecked.txt")
    }),
  { git: true },
)

it.instance(
  "T3 #1434 regression: 18 sequential writes land in one turn diff; no-op follow-up turn diffs zero",
  () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const dir = tmp.directory
      const svc = yield* TurnCheckpoint.Service
      const sessionID = "ses_checkpoint_test_5"
      yield* seedSession(sessionID)

      const turn1 = yield* svc.begin({ sessionID: sessionID as any, userMessageID: "msg_1" })
      yield* Fiber.join(turn1!.beforeFiber)

      // 18 distinct sequential tool-style writes, including a unicode path.
      for (let i = 0; i < 17; i++) {
        yield* Effect.promise(() => Bun.write(path.join(dir, `gen-${i}.txt`), `content-${i}`))
      }
      yield* Effect.promise(() => Bun.write(path.join(dir, "отчёт-测试-😀.txt"), "unicode"))

      yield* svc.finish(turn1)
      const done1 = yield* pollWithTimeout(
        Effect.gen(function* () {
          const current = yield* getRows(sessionID)
          return current[0]?.status === "ready" ? current : undefined
        }),
        "turn 1 never finalized",
        30_000,
      )
      const row1 = done1[0]!
      expect(row1.files).toBe(18)
      const paths = row1.diff!.map((d) => d.path as string)
      expect(paths).toContain("отчёт-测试-😀.txt")

      // Second, no-op turn: zero file changes but still a checkpoint row.
      const turn2 = yield* svc.begin({ sessionID: sessionID as any, userMessageID: "msg_2" })
      yield* Fiber.join(turn2!.beforeFiber)
      yield* svc.finish(turn2)
      const done2 = yield* pollWithTimeout(
        Effect.gen(function* () {
          const all = yield* getRows(sessionID)
          const second = all.find((r) => r.user_message_id === "msg_2")
          return second && second.status !== "capturing" ? second : undefined
        }),
        "turn 2 never finalized",
        30_000,
      )
      expect(done2.status).toBe("ready")
      expect(done2.files).toBe(0)
      expect(done2.additions).toBe(0)
    }),
  { git: true },
)

it.instance(
  ">2MiB new untracked file degrades status to partial with exclusion recorded (t3 §53)",
  () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const dir = tmp.directory
      const svc = yield* TurnCheckpoint.Service
      const sessionID = "ses_checkpoint_test_6"
      yield* seedSession(sessionID)

      const turn = yield* svc.begin({ sessionID: sessionID as any, userMessageID: "msg_1" })
      yield* Fiber.join(turn!.beforeFiber)

      yield* Effect.promise(() => Bun.write(path.join(dir, "small.txt"), "fine"))
      yield* Effect.promise(() => Bun.write(path.join(dir, "big.bin"), Buffer.alloc(3 * 1024 * 1024, 0x61)))

      yield* svc.finish(turn)
      const finalized = yield* pollWithTimeout(
        Effect.gen(function* () {
          const current = yield* getRows(sessionID)
          return current[0]?.status !== "capturing" ? current : undefined
        }),
        "turn never finalized",
        30_000,
      )
      const row = finalized[0]!
      expect(row.status).toBe("partial")
      expect(row.excluded).toHaveLength(1)
      expect(row.excluded![0]!.path as string).toBe("big.bin")
      // Only the tracked-size file made it into the captured tree/diff.
      expect(row.files).toBe(1)
      expect(row.diff![0]!.path as string).toBe("small.txt")
    }),
  { git: true },
)

it.instance(
  "manual edits between turns are excluded from the next turn's diff (t3 §42/§43 attribution)",
  () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const dir = tmp.directory
      const svc = yield* TurnCheckpoint.Service
      const sessionID = "ses_checkpoint_test_7"
      yield* seedSession(sessionID)

      // Turn 1: agent writes base.txt.
      const turn1 = yield* svc.begin({ sessionID: sessionID as any, userMessageID: "msg_1" })
      yield* Fiber.join(turn1!.beforeFiber)
      yield* Effect.promise(() => Bun.write(path.join(dir, "base.txt"), "agent output"))
      yield* svc.finish(turn1)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const current = yield* getRows(sessionID)
          return current[0]?.status === "ready" ? current : undefined
        }),
        "turn 1 never finalized",
        30_000,
      )

      // Manual user edit BETWEEN turns.
      yield* Effect.promise(() => Bun.write(path.join(dir, "manual.txt"), "human edit"))

      // Turn 2: agent writes agent.txt; baseline already contains manual.txt.
      const turn2 = yield* svc.begin({ sessionID: sessionID as any, userMessageID: "msg_2" })
      yield* Fiber.join(turn2!.beforeFiber)
      yield* Effect.promise(() => Bun.write(path.join(dir, "agent.txt"), "more agent output"))
      yield* svc.finish(turn2)

      const row2 = yield* pollWithTimeout(
        Effect.gen(function* () {
          const all = yield* getRows(sessionID)
          const second = all.find((r) => r.user_message_id === "msg_2")
          return second && second.status === "ready" ? second : undefined
        }),
        "turn 2 never finalized",
        30_000,
      )
      expect(row2.files).toBe(1)
      expect(row2.diff![0]!.path as string).toBe("agent.txt")
    }),
  { git: true },
)
