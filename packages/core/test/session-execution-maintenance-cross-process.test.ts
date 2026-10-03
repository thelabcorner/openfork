/**
 * Cross-process proof for the G2 execution/maintenance admission fence.
 *
 * The same-process race in `session-execution-owner-maintenance.test.ts` can
 * serialize inside one JS event loop before SQLite contention is exercised.
 * This test therefore runs two real Bun child processes against the SAME
 * file-backed SQLite database behind a start barrier:
 *   - child A: SessionExecutionOwner.tryAcquire(sessionID)
 *   - child B: DirectoryMaintenanceGuard.acquire({ guardId, directories })
 *
 * Both children use the real core Database.layerFromPath, RuntimeOwner, and
 * services, announce `ready` after their runtime exists, and only release
 * authority after the parent has recorded the winner. Each iteration asserts
 * that exactly one authority commits, that the loser reports the expected
 * blocked evidence, and that the durable database never contains an active
 * execution owner and an active guard over the same physical directory at the
 * same time. The winner/loser reversal (release -> retry in both directions)
 * runs every iteration, and the bounded loop keeps iterating (8..16) until
 * both winner classes have been observed so both reverse paths are proven.
 *
 * No worktrees, no W:, temp dirs and temp DB files only.
 */
import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq, inArray } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DirectoryMaintenanceGuard } from "@opencode-ai/core/directory-maintenance-guard"
import { DirectoryMaintenanceGuardTable } from "@opencode-ai/core/directory-maintenance-guard.sql"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { RuntimeOwner } from "@opencode-ai/core/runtime-owner"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionExecutionOwnerTable } from "@opencode-ai/core/session/execution-owner.sql"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"

const CORE_ROOT = join(import.meta.dir, "..")
const FIXTURE = join(import.meta.dir, "fixture", "session-execution-maintenance-cross-process-child.ts")
const MIN_ITERATIONS = 8
const MAX_ITERATIONS = 16
const COMMAND_TIMEOUT_MS = 60_000
const GUARD_ID = "guard-g2-cross-process"
const SQLITE_BUSY_CLASSIFICATION =
  "[SQLITE_BUSY] current Database config: primary busy_timeout=5000ms (readDb=250ms); " +
  "SessionExecutionOwner/DirectoryMaintenanceGuard authority transactions have no app-level retry " +
  "and fail closed via Effect.orDie (defect) after the SQLite wait expires. Reported, not hidden."

const nodes = () =>
  LayerNode.group([Database.node, RuntimeOwner.node, SessionExecutionOwner.node, DirectoryMaintenanceGuard.node])

const graphFor = (databasePath: string) =>
  AppNodeBuilder.build(nodes(), [[Database.node, Database.layerFromPath(databasePath)]])

const runGraph = <A, E>(databasePath: string, body: Effect.Effect<A, E, Database.Service>) =>
  Effect.runPromise(Effect.scoped(body).pipe(Effect.provide(graphFor(databasePath))))

const seedProjectAndSession = (sessionID: SessionSchema.ID, directory: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: sessionID,
        directory,
        title: "cross-process maintenance race",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const readFenceState = (databasePath: string, sessionID: SessionSchema.ID, keys: readonly string[]) =>
  runGraph(
    databasePath,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const guards = yield* db
        .select()
        .from(DirectoryMaintenanceGuardTable)
        .where(inArray(DirectoryMaintenanceGuardTable.directory, [...keys]))
        .all()
        .pipe(Effect.orDie)
      const owners = yield* db
        .select()
        .from(SessionExecutionOwnerTable)
        .where(eq(SessionExecutionOwnerTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      return {
        activeGuards: guards.filter((row) => row.state !== "released"),
        heldOwners: owners.filter((row) => row.owner_id !== null),
      }
    }),
  )

type Role = "owner" | "guard"

interface OwnerToken {
  readonly sessionID?: string
  readonly ownerID: string
  readonly generation: number
}

interface GuardToken {
  readonly acquisitionId: string
  readonly guardId?: string
  readonly ownerID: string
  readonly generation: number
}

interface GuardEvidence {
  readonly directory: string
  readonly guardId: string
  readonly ownerID: string
  readonly acquisitionId: string
  readonly generation: number
  readonly state: string
}

interface ExecutingEvidence {
  readonly sessionID: string
  readonly ownerID: string
  readonly generation: number
  readonly persistedDirectory: string
  readonly directory: string | null
}

type OwnerAttemptResult =
  | { readonly state: "acquired"; readonly token: OwnerToken }
  | { readonly state: "busy"; readonly snapshot?: unknown }
  | { readonly state: "maintenance-blocked"; readonly reason?: string; readonly guards?: ReadonlyArray<GuardEvidence> }

type GuardAttemptResult =
  | { readonly state: "acquired"; readonly token: GuardToken }
  | { readonly state: "blocked"; readonly executing?: ReadonlyArray<ExecutingEvidence> }

type AttemptResult = OwnerAttemptResult | GuardAttemptResult

type ChildEvent =
  | { type: "ready"; role: "owner" | "guard"; ownerID: string; pid: number }
  | { type: "result"; round: "go" | "retry"; result: AttemptResult }
  | { type: "released"; round: "release"; result: string }
  | { type: "error"; message: string; round?: string; sqliteBusy?: boolean }
  | { type: "fatal"; message: string; sqliteBusy?: boolean }

interface ChildHandle<R extends Role> {
  readonly role: R
  send(command: "go" | "retry" | "release" | "exit"): void
  next(timeoutMs?: number): Promise<ChildEvent>
  exited(): Promise<number>
  stderr(): string
  terminate(): Promise<void>
}

const startChild = <R extends Role>(input: {
  readonly role: R
  readonly db: string
  readonly sessionID: string
  readonly guardId: string
  readonly directories: readonly string[]
}): ChildHandle<R> => {
  const proc = spawn(process.execPath, [FIXTURE, JSON.stringify(input)], {
    cwd: CORE_ROOT,
    stdio: "pipe",
  })
  const stdout = proc.stdout
  const stdin = proc.stdin
  if (!stdout || !stdin) throw new Error(`failed to open stdio for ${input.role} child`)

  const pending: string[] = []
  const waiters: Array<(line: string | null) => void> = []
  let buffer = ""
  stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8")
    for (;;) {
      const index = buffer.indexOf("\n")
      if (index < 0) break
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line.length === 0) continue
      const waiter = waiters.shift()
      if (waiter) waiter(line)
      else pending.push(line)
    }
  })
  stdout.on("end", () => {
    for (const waiter of waiters.splice(0)) waiter(null)
  })

  const stderrChunks: Buffer[] = []
  proc.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)))
  const stderr = () => Buffer.concat(stderrChunks).toString("utf8")

  const exitCode = new Promise<number>((resolve) => proc.on("close", (code) => resolve(code ?? 1)))

  const nextLine = () =>
    new Promise<string | null>((resolve) => {
      const queued = pending.shift()
      if (queued !== undefined) resolve(queued)
      else waiters.push(resolve)
    })

  return {
    role: input.role,
    send: (command) => {
      stdin.write(command + "\n")
    },
    next: (timeoutMs = COMMAND_TIMEOUT_MS) =>
      new Promise<ChildEvent>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `${input.role} child timed out after ${timeoutMs}ms waiting for output` +
                (stderr().length > 0 ? `\nstderr:\n${stderr()}` : ""),
            ),
          )
        }, timeoutMs)
        void nextLine().then((line) => {
          clearTimeout(timer)
          if (line === null) {
            reject(new Error(`${input.role} child closed stdout unexpectedly\nstderr:\n${stderr()}`))
            return
          }
          resolve(JSON.parse(line) as ChildEvent)
        })
      }),
    exited: () => exitCode,
    stderr,
    terminate: async () => {
      if (proc.exitCode !== null || proc.signalCode !== null) return
      const closed = new Promise<void>((resolve) => proc.once("close", () => resolve()))
      if (process.platform !== "win32" || !proc.pid) {
        proc.kill()
        await closed
        return
      }
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" })
        killer.on("close", () => {
          proc.kill()
          resolve()
        })
        killer.on("error", () => {
          proc.kill()
          resolve()
        })
      })
      await closed
    },
  }
}

function expectResult(handle: ChildHandle<"owner">, command: string): Promise<OwnerAttemptResult>
function expectResult(handle: ChildHandle<"guard">, command: string): Promise<GuardAttemptResult>
function expectResult(handle: ChildHandle<Role>, command: string): Promise<AttemptResult>
async function expectResult(handle: ChildHandle<Role>, command: string): Promise<AttemptResult> {
  const event = await handle.next()
  if (event.type === "error" || event.type === "fatal") {
    throw new Error(
      `cross-process ${handle.role} child failed during ${command}: ${event.message}` +
        (event.sqliteBusy ? `\n${SQLITE_BUSY_CLASSIFICATION}` : "") +
        (handle.stderr().length > 0 ? `\nstderr:\n${handle.stderr()}` : ""),
    )
  }
  if (event.type !== "result") {
    throw new Error(`expected a ${command} result from ${handle.role} child, got ${JSON.stringify(event)}`)
  }
  return event.result
}

const expectReleased = async (handle: ChildHandle<Role>) => {
  const event = await handle.next()
  if (event.type !== "released") {
    throw new Error(`${handle.role} child did not report a release: ${JSON.stringify(event)}`)
  }
  expect(event.result).toBe("released")
}

describe("SessionExecutionOwner / DirectoryMaintenanceGuard cross-process admission fence", () => {
  test(
    "exactly one authority commits across two real processes on one file-backed database",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "openfork-execution-cross-process-"))
      const databasePath = join(root, "openfork.db")
      const alpha = join(root, "alpha")
      const bravo = join(root, "bravo")
      const sessionID = SessionSchema.ID.make("ses_g2_cross_process")
      let ownerChild: ChildHandle<"owner"> | undefined
      let guardChild: ChildHandle<"guard"> | undefined
      try {
        await Promise.all([mkdir(alpha, { recursive: true }), mkdir(bravo, { recursive: true })])
        const alphaKey = DirectoryMaintenanceGuard.existingDirectoryKey(alpha, process.platform)
        const bravoKey = DirectoryMaintenanceGuard.existingDirectoryKey(bravo, process.platform)
        if (alphaKey === undefined || bravoKey === undefined) throw new Error("expected physical directory keys")
        await runGraph(databasePath, seedProjectAndSession(sessionID, alpha))

        ownerChild = startChild({
          role: "owner",
          db: databasePath,
          sessionID,
          guardId: GUARD_ID,
          directories: [alpha, bravo],
        })
        guardChild = startChild({
          role: "guard",
          db: databasePath,
          sessionID,
          guardId: GUARD_ID,
          directories: [alpha, bravo],
        })

        const [ownerReady, guardReady] = await Promise.all([ownerChild.next(), guardChild.next()])
        if (ownerReady.type !== "ready" || guardReady.type !== "ready") {
          throw new Error(`expected both children ready, got ${JSON.stringify([ownerReady, guardReady])}`)
        }
        expect(ownerReady.ownerID).not.toBe(guardReady.ownerID)

        const winners = new Set<"owner" | "guard">()
        let iterations = 0
        for (; iterations < MAX_ITERATIONS; iterations++) {
          const owner = ownerChild
          const guard = guardChild
          if (!owner || !guard) throw new Error("children not started")

          // First prove both serialized first-writer orderings deterministically,
          // then exercise true concurrent races without depending on scheduler luck
          // to produce both winner classes.
          let ownerResult: OwnerAttemptResult
          let guardResult: GuardAttemptResult
          if (iterations === 0) {
            owner.send("go")
            ownerResult = await expectResult(owner, "go")
            expect(ownerResult.state).toBe("acquired")
            guard.send("go")
            guardResult = await expectResult(guard, "go")
          } else if (iterations === 1) {
            guard.send("go")
            guardResult = await expectResult(guard, "go")
            expect(guardResult.state).toBe("acquired")
            owner.send("go")
            ownerResult = await expectResult(owner, "go")
          } else {
            owner.send("go")
            guard.send("go")
            ;[ownerResult, guardResult] = await Promise.all([
              expectResult(owner, "go"),
              expectResult(guard, "go"),
            ])
          }

          const ownerWon = ownerResult.state === "acquired"
          const guardWon = guardResult.state === "acquired"
          expect([ownerWon, guardWon].filter(Boolean)).toHaveLength(1)

          if (ownerWon) {
            if (ownerResult.state !== "acquired") throw new Error(`owner winner reported ${ownerResult.state}`)
            const token = ownerResult.token
            if (!token) throw new Error("owner winner reported no token")
            if (guardResult.state !== "blocked") throw new Error(`guard loser reported ${guardResult.state}`)
            expect(guardResult.state).toBe("blocked")
            expect(guardResult.executing).toEqual([
              {
                sessionID,
                ownerID: ownerReady.ownerID,
                generation: token.generation,
                persistedDirectory: alpha,
                directory: alphaKey,
              },
            ])
          } else {
            if (guardResult.state !== "acquired") throw new Error(`guard winner reported ${guardResult.state}`)
            const token = guardResult.token
            if (!token) throw new Error("guard winner reported no token")
            if (ownerResult.state !== "maintenance-blocked") throw new Error(`owner loser reported ${ownerResult.state}`)
            expect(ownerResult.state).toBe("maintenance-blocked")
            expect(ownerResult.reason).toBe("guard-active")
            expect(ownerResult.guards).toEqual([
              {
                directory: alphaKey,
                guardId: GUARD_ID,
                ownerID: guardReady.ownerID,
                acquisitionId: token.acquisitionId,
                generation: token.generation,
                state: "active",
              },
            ])
          }

          // Durable invariant: never an active execution owner together with an
          // active guard over the same physical directory set.
          const raced = await readFenceState(databasePath, sessionID, [alphaKey, bravoKey])
          expect(raced.activeGuards.length > 0 && raced.heldOwners.length > 0).toBe(false)
          if (ownerWon) expect(raced.activeGuards).toHaveLength(0)
          else expect(raced.heldOwners).toHaveLength(0)

          const winner = ownerWon ? owner : guard
          const loser = ownerWon ? guard : owner

          // Winner releases only after the parent recorded the winner.
          winner.send("release")
          await expectReleased(winner)

          // Forward reversal: loser retries after the winner released.
          loser.send("retry")
          const retry = await expectResult(loser, "retry")
          expect(retry.state).toBe("acquired")
          const reversed = await readFenceState(databasePath, sessionID, [alphaKey, bravoKey])
          if (loser.role === "owner") {
            expect(reversed.activeGuards).toHaveLength(0)
            expect(reversed.heldOwners).toHaveLength(1)
          } else {
            expect(reversed.heldOwners).toHaveLength(0)
            expect(reversed.activeGuards).toHaveLength(2)
          }
          loser.send("release")
          await expectReleased(loser)

          // Reverse release/retry for the original winner class.
          winner.send("retry")
          const reverse = await expectResult(winner, "retry")
          expect(reverse.state).toBe("acquired")
          winner.send("release")
          await expectReleased(winner)

          winners.add(ownerWon ? "owner" : "guard")
          if (iterations + 1 >= MIN_ITERATIONS && winners.size === 2) break
        }
        expect(winners.size).toBe(2)

        const final = await readFenceState(databasePath, sessionID, [alphaKey, bravoKey])
        expect(final.activeGuards).toHaveLength(0)
        expect(final.heldOwners).toHaveLength(0)

        ownerChild.send("exit")
        guardChild.send("exit")
        const codes = await Promise.all([ownerChild.exited(), guardChild.exited()])
        expect(codes).toEqual([0, 0])
        for (const handle of [ownerChild, guardChild]) {
          const text = handle.stderr()
          if (/sqlite_busy|database is locked|database table is locked/i.test(text)) {
            throw new Error(`${handle.role} child stderr contained SQLITE_BUSY\n${SQLITE_BUSY_CLASSIFICATION}\n${text}`)
          }
        }
      } finally {
        await ownerChild?.terminate().catch(() => undefined)
        await guardChild?.terminate().catch(() => undefined)
        await rm(root, { recursive: true, force: true })
      }
    },
    180_000,
  )
})
