export * as RuntimeOwner from "./runtime-owner"

import { eq } from "drizzle-orm"
import { Cause, Context, Duration, Effect, Fiber, Layer, Scope, Semaphore } from "effect"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { RuntimeOwnerTable } from "./runtime-owner.sql"

export type ID = string & { readonly __runtimeOwnerID: "RuntimeOwnerID" }

export interface Snapshot {
  readonly id: ID
  readonly pid: number
  readonly startedAt: number
  readonly heartbeatAt: number
  readonly controlEpoch: number
}

export interface Retention {
  /** Idempotent strong-reference release. */
  readonly release: Effect.Effect<void>
}

export type LocalDeathProof = "dead" | "alive-or-unknown" | "not-local-or-unknown"

export interface Interface {
  readonly id: ID
  readonly pid: number
  readonly startedAt: number
  /**
   * Retains process liveness while durable runtime authority is held.
   * The first retain starts one heartbeat fiber; the final release stops it.
   */
  readonly retain: Effect.Effect<Retention>
  readonly snapshot: (id: ID) => Effect.Effect<Snapshot | undefined>
  readonly proveLocalDeath: (id: ID) => Effect.Effect<LocalDeathProof>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/RuntimeOwner") {}

export const HEARTBEAT_INTERVAL_MS = 30_000

export interface MakeOptions {
  readonly id?: ID
  readonly pid?: number
  readonly startedAt?: number
  readonly heartbeatIntervalMs?: number
}

export const make = Effect.fn("RuntimeOwner.make")(function* (options: MakeOptions = {}) {
  const { db, readDb } = yield* Database.Service
  const scope = yield* Scope.Scope
  const id = options.id ?? (("runtime-owner:" + crypto.randomUUID()) as ID)
  const pid = options.pid ?? process.pid
  const startedAt = options.startedAt ?? Date.now()
  const heartbeatIntervalMs = Math.max(10, Math.floor(options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS))
  const mutex = Semaphore.makeUnsafe(1)
  let retainCount = 0
  let heartbeat: Fiber.Fiber<void, never> | undefined

  const ensureRow = Effect.fn("RuntimeOwner.ensureRow")(function* () {
    const now = Date.now()
    yield* db
      .insert(RuntimeOwnerTable)
      .values({
        id,
        pid,
        started_at: startedAt,
        heartbeat_at: now,
        control_epoch: 0,
      })
      .onConflictDoUpdate({
        target: RuntimeOwnerTable.id,
        set: { pid, heartbeat_at: now },
      })
      .run()
      .pipe(Effect.orDie)
  })

  const beat = Effect.fn("RuntimeOwner.heartbeat")(function* () {
    yield* db
      .update(RuntimeOwnerTable)
      .set({ heartbeat_at: Date.now() })
      .where(eq(RuntimeOwnerTable.id, id))
      .run()
      .pipe(Effect.orDie)
  })

  const startHeartbeat = Effect.fn("RuntimeOwner.startHeartbeat")(function* () {
    yield* ensureRow()
    heartbeat = yield* Effect.gen(function* () {
      for (;;) {
        yield* Effect.sleep(Duration.millis(heartbeatIntervalMs))
        yield* beat().pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logError("RuntimeOwner heartbeat failed; retrying", {
                  id,
                  cause: Cause.pretty(cause),
                }),
          ),
        )
      }
    }).pipe(Effect.forkIn(scope))
  })

  const retain = mutex.withPermit(
    Effect.gen(function* () {
      if (retainCount === 0) yield* startHeartbeat()
      retainCount++
      let released = false
      return {
        release: mutex.withPermit(
          Effect.gen(function* () {
            if (released) return
            released = true
            retainCount = Math.max(0, retainCount - 1)
            if (retainCount !== 0 || !heartbeat) return
            const current = heartbeat
            heartbeat = undefined
            yield* Fiber.interrupt(current)
          }),
        ),
      } satisfies Retention
    }),
  )

  const snapshot = Effect.fn("RuntimeOwner.snapshot")(function* (ownerID: ID) {
    const row = yield* readDb
      .select()
      .from(RuntimeOwnerTable)
      .where(eq(RuntimeOwnerTable.id, ownerID))
      .get()
      .pipe(Effect.orDie)
    if (!row) return undefined
    return {
      id: row.id as ID,
      pid: row.pid,
      startedAt: row.started_at,
      heartbeatAt: row.heartbeat_at,
      controlEpoch: row.control_epoch,
    } satisfies Snapshot
  })

  const proveLocalDeath = Effect.fn("RuntimeOwner.proveLocalDeath")(function* (ownerID: ID) {
    const owner = yield* snapshot(ownerID)
    if (!owner || owner.pid <= 0) return "not-local-or-unknown" as const
    if (ownerID === id || owner.pid === process.pid) return "alive-or-unknown" as const
    return yield* Effect.sync(() => {
      try {
        process.kill(owner.pid, 0)
        return "alive-or-unknown" as const
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String((error as { code?: unknown }).code)
            : undefined
        // ESRCH is the only local proof we accept. EPERM and platform-specific
        // failures remain conservative; PID reuse likewise reports alive.
        return code === "ESRCH" ? ("dead" as const) : ("alive-or-unknown" as const)
      }
    })
  })

  yield* Effect.addFinalizer(() =>
    mutex.withPermit(
      Effect.gen(function* () {
        retainCount = 0
        if (!heartbeat) return
        const current = heartbeat
        heartbeat = undefined
        yield* Fiber.interrupt(current)
      }),
    ),
  )

  return Service.of({ id, pid, startedAt, retain, snapshot, proveLocalDeath })
})

const layer = Layer.effect(Service, make())

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node],
})
