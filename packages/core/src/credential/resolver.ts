import { Context, Effect, Layer, Semaphore } from "effect"
import { dirname, resolve as resolvePath } from "node:path"
import { Credential } from "../credential"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { RUNTIME_LOCK_DIRNAME } from "../storage-identity"
import { Flock } from "../util/flock"

const refreshLockStaleMs = 5 * 60_000
const refreshLockTimeoutMs = refreshLockStaleMs + 30_000

export interface ResolveOptions<E> {
  readonly shouldRefresh: (
    credential: Credential.OAuth,
    integrationID: Credential.Info["integrationID"],
    now: number,
  ) => boolean
  /**
   * Return undefined when this credential is not refreshable anymore. This
   * preserves the current persisted value/revision without manufacturing a
   * secret mutation.
   */
  readonly refresh: (
    credential: Credential.OAuth,
    integrationID: Credential.Info["integrationID"],
  ) => Effect.Effect<Credential.OAuth | undefined, E>
}

export interface Resolved {
  readonly value: Credential.Value
  /**
   * Strictly monotonic trusted secret revision. Consumers may use this to
   * isolate authenticated-client caches from older token material.
   */
  readonly revision: number
}

export interface Interface {
  readonly resolve: <E>(id: Credential.ID, options: ResolveOptions<E>) => Effect.Effect<Resolved | undefined, E>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/CredentialResolver") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const { filename } = yield* Database.Service
    const refreshLockDir =
      filename === ":memory:" ? undefined : resolvePath(dirname(resolvePath(filename)), RUNTIME_LOCK_DIRNAME)

    // This map is owned by the one global CredentialResolver service, not by an
    // Integration runtime. Global and location-scoped callers therefore share
    // the same in-process refresh critical section.
    const locks = new Map<string, ReturnType<typeof Semaphore.makeUnsafe>>()
    const lock = (id: Credential.ID) => {
      const key = String(id)
      const current = locks.get(key)
      if (current) return current
      const created = Semaphore.makeUnsafe(1)
      locks.set(key, created)
      return created
    }

    const project = (credential: Credential.Info): Resolved => ({
      value: credential.value,
      revision: credential.revision,
    })

    const stale = <E>(credential: Credential.Info, options: ResolveOptions<E>, now: number) =>
      credential.value.type === "oauth" &&
      options.shouldRefresh(credential.value, credential.integrationID, now)

    const resolve = <E>(id: Credential.ID, options: ResolveOptions<E>): Effect.Effect<Resolved | undefined, E> =>
      Effect.gen(function* () {
        // Fast path deliberately stays outside the keyed semaphore so fresh
        // credentials and API keys remain parallel reads.
        const initial = yield* credentials.get(id)
        if (!initial) return undefined
        if (!stale(initial, options, Date.now())) return project(initial)

        return yield* lock(id).withPermit(
          Effect.scoped(
            Effect.gen(function* () {
              // Desktop/ACP processes may share one SQLite file. The DB-local
              // filesystem lease covers the remote refresh itself; CAS alone
              // cannot undo a provider-side rotating-refresh-token race.
              //
              // No SQLite transaction is held while this lease/network request
              // is live. Flock heartbeats active owners and eventually reaps a
              // crashed owner after the bounded stale window.
              if (refreshLockDir) {
                yield* Flock.effect(`credential-refresh:${id}`, {
                  dir: refreshLockDir,
                  staleMs: refreshLockStaleMs,
                  timeoutMs: refreshLockTimeoutMs,
                  baseDelayMs: 25,
                  maxDelayMs: 500,
                })
              }

              for (;;) {
                // Re-read only after both process-local and cross-process
                // ownership are acquired. A waiter observes the winner's token
                // rotation here and skips duplicate network I/O.
                const credential = yield* credentials.get(id)
                if (!credential) return undefined
                if (!stale(credential, options, Date.now())) return project(credential)
                if (credential.value.type !== "oauth") return project(credential)

                const refreshed = yield* options.refresh(credential.value, credential.integrationID)
                if (!refreshed) return project(credential)

                // Secret persistence is a revision CAS. If any trusted writer
                // changed/removed this credential while refresh was in flight,
                // never overwrite it with the older refresh result. Reconcile
                // from storage while still owning the refresh lock instead.
                const committed = yield* credentials.compareAndSwapValue(
                  credential.id,
                  credential.revision,
                  refreshed,
                )
                if (committed) return project(committed)
              }
            }),
          ),
        )
      })

    return Service.of({ resolve })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Credential.node, Database.node] })
