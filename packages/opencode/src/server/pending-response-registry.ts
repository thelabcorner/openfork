import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Cause, Context, Duration, Effect, Layer, Queue, Schema } from "effect"
import { ServerEvent } from "@opencode-ai/schema/server-event"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { EventV2Bridge } from "@/event-v2-bridge"

export type Kind = "permission" | "question"

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("PendingResponse.NotFoundError", {
  requestID: Schema.String,
}) {}

export interface Registration {
  readonly kind: Kind
  readonly requestID: string
  readonly sessionID: string
  readonly directory: string
  readonly snapshot: unknown
  /** The V1 Permission/Question service remains authoritative for semantics. */
  readonly settle: (payload: unknown) => Effect.Effect<void, NotFoundError>
}

export interface RouteInput {
  readonly kind: Kind
  readonly requestID: string
  readonly directory: string
  readonly sessionID?: string
  readonly payload: unknown
}

export interface ListInput {
  readonly kind: Kind
  readonly directory: string
}

export interface Interface {
  readonly register: (input: Registration) => Effect.Effect<Effect.Effect<void>>
  readonly settle: (input: RouteInput) => Effect.Effect<void, NotFoundError>
  readonly list: (input: ListInput) => Effect.Effect<ReadonlyArray<unknown>>
  /** Enqueue transient V1 response events without making the control route wait for listeners. */
  readonly notify: (effect: Effect.Effect<void, unknown>, directory: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PendingResponseRegistry") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const pending = new Map<string, Registration & { token: symbol; settling: boolean }>()
    const notifications = yield* Queue.bounded<Effect.Effect<void, unknown>>(128)
    const events = yield* EventV2Bridge.Service
    const dirtyDirectories = new Set<string>()
    let invalidateAll = false
    let overflowEpisode = false
    yield* Effect.addFinalizer(() => Effect.sync(() => pending.clear()))
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const next = yield* Queue.take(notifications)
          yield* next.pipe(
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterrupts(cause),
              (cause) => Effect.logWarning("pending response event notification failed", { cause }),
            ),
          )
          const invalidations = invalidateAll ? [undefined] : Array.from(dirtyDirectories)
          invalidateAll = false
          dirtyDirectories.clear()
          overflowEpisode = false
          for (const directory of invalidations) {
            let published = false
            let delay = 100
            while (!published) {
              published = yield* events
                .publish(
                  ServerEvent.PendingResponseStateInvalidated,
                  directory ? {} : { all: true },
                  directory ? { location: { directory: AbsolutePath.make(directory) } } : undefined,
                )
                .pipe(
                  Effect.as(true),
                  Effect.catchCauseIf(
                    (cause) => !Cause.hasInterrupts(cause),
                    (cause) =>
                      Effect.logWarning("pending response invalidation publish failed; retrying", {
                        directory,
                        cause,
                      }).pipe(Effect.as(false)),
                  ),
                )
              if (!published) {
                yield* Effect.sleep(Duration.millis(delay))
                delay = Math.min(delay * 2, 5_000)
              }
            }
          }
        }),
      ),
    )
    const key = (kind: Kind, requestID: string) => `${kind}:${requestID}`

    return Service.of({
      register: Effect.fn("PendingResponseRegistry.register")(function* (input) {
        const id = key(input.kind, input.requestID)
        if (pending.has(id)) return yield* Effect.die(new Error(`duplicate active ${input.kind} request ID`))
        const entry = { ...input, token: Symbol(input.requestID), settling: false }
        pending.set(id, entry)
        return Effect.sync(() => {
          if (pending.get(id) === entry) pending.delete(id)
        })
      }),
      settle: Effect.fn("PendingResponseRegistry.settle")(function* (input) {
        const id = key(input.kind, input.requestID)
        const entry = pending.get(id)
        if (
          !entry ||
          entry.directory !== input.directory ||
          (input.sessionID !== undefined && entry.sessionID !== input.sessionID) ||
          entry.settling
        ) {
          return yield* new NotFoundError({ requestID: input.requestID })
        }

        entry.settling = true
        return yield* Effect.uninterruptible(
          entry.settle(input.payload).pipe(
            Effect.tap(() => Effect.sync(() => {
              if (pending.get(id) === entry) pending.delete(id)
            })),
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (pending.get(id) === entry && exit._tag === "Failure") entry.settling = false
              }),
            ),
          ),
        )
      }),
      list: Effect.fn("PendingResponseRegistry.list")(function* (input) {
        return Array.from(pending.values())
          .filter((entry) => entry.kind === input.kind && entry.directory === input.directory)
          .map((entry) => entry.snapshot)
      }),
      notify: Effect.fn("PendingResponseRegistry.notify")(function* (effect, directory) {
        const accepted = Queue.offerUnsafe(notifications, effect)
        if (!accepted) {
          if (!invalidateAll) {
            if (dirtyDirectories.size < 32 || dirtyDirectories.has(directory)) dirtyDirectories.add(directory)
            else invalidateAll = true
          }
          if (!overflowEpisode) {
            overflowEpisode = true
            yield* Effect.logWarning("pending response event notification queue is full; scheduling snapshot recovery", {
              directory,
            })
          }
        }
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [EventV2Bridge.node] })

export * as PendingResponseRegistry from "./pending-response-registry"
