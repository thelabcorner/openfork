export * as IntegrationAuthKernel from "./auth-kernel"

import {
  Cause,
  Clock,
  Duration,
  Effect,
  Exit,
  Schedule,
  Schema,
  Scope,
  SynchronizedRef,
} from "effect"
import { Integration } from "@opencode-ai/schema/integration"
import { Credential } from "../credential"
import { EventV2 } from "../event"

export type OAuthAuthorization = {
  readonly url: string
  readonly instructions: string
} & (
  | {
      readonly mode: "auto"
      readonly callback: Effect.Effect<Credential.OAuth, unknown>
    }
  | {
      readonly mode: "code"
      readonly callback: (code: string) => Effect.Effect<Credential.OAuth, unknown>
    }
)

export interface OAuthImplementation {
  readonly integrationID: Integration.ID
  readonly method: Integration.OAuthMethod
  readonly authorize: (inputs: Integration.Inputs) => Effect.Effect<OAuthAuthorization, unknown, Scope.Scope>
  readonly refresh?: (credential: Credential.OAuth) => Effect.Effect<Credential.OAuth, unknown>
  readonly label?: (credential: Credential.OAuth) => string | undefined
}

export class CodeRequiredError extends Schema.TaggedErrorClass<CodeRequiredError>()("Integration.CodeRequired", {
  attemptID: Integration.AttemptID,
}) {}

export class AuthorizationError extends Schema.TaggedErrorClass<AuthorizationError>()("Integration.Authorization", {
  cause: Schema.Defect(),
}) {}

export interface Interface {
  readonly oauth: (input: {
    readonly integrationID: Integration.ID
    readonly methodID: Integration.MethodID
    readonly inputs: Integration.Inputs
    readonly label?: string
  }) => Effect.Effect<Integration.Attempt, AuthorizationError>
  readonly attempt: {
    readonly status: (attemptID: Integration.AttemptID) => Effect.Effect<Integration.AttemptStatus>
    readonly complete: (input: {
      readonly attemptID: Integration.AttemptID
      readonly code?: string
    }) => Effect.Effect<void, CodeRequiredError | AuthorizationError>
    readonly cancel: (attemptID: Integration.AttemptID) => Effect.Effect<void>
  }
}

const attemptLifetime = Duration.toMillis(Duration.minutes(10))
const terminalRetention = Duration.toMillis(Duration.minutes(1))
const scrubInterval = Duration.seconds(30)

type AttemptTime = { created: number; expires: number }

type PendingAttempt = {
  status: "pending"
  completing: boolean
  authorization: OAuthAuthorization
  integrationID: Integration.ID
  methodID: Integration.MethodID
  label?: string
  scope: Scope.Closeable
  time: AttemptTime
}

type TerminalAttempt = {
  status: "complete" | "failed" | "expired"
  message?: string
  removeAt: number
  time: AttemptTime
}

type AttemptEntry = PendingAttempt | TerminalAttempt

export function make(
  resolveImplementation: (
    integrationID: Integration.ID,
    methodID: Integration.MethodID,
  ) => OAuthImplementation | undefined,
): Effect.Effect<Interface, never, Credential.Service | EventV2.Service | Scope.Scope> {
  return Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const events = yield* EventV2.Service
    const scope = yield* Scope.Scope
    const attempts = SynchronizedRef.makeUnsafe(new Map<Integration.AttemptID, AttemptEntry>())

    const authorize = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new AuthorizationError({ cause })))

    const close = (attemptScope: Scope.Closeable) =>
      Scope.close(attemptScope, Exit.void).pipe(Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)

    const message = (cause: Cause.Cause<unknown>) => {
      const error = Cause.squash(cause)
      return error instanceof Error ? error.message : String(error)
    }

    const settle = Effect.fnUntraced(function* (
      attemptID: Integration.AttemptID,
      exit: Exit.Exit<Credential.OAuth, unknown>,
    ) {
      const now = yield* Clock.currentTimeMillis
      const result = yield* SynchronizedRef.modify(attempts, (current) => {
        const attempt = current.get(attemptID)
        if (!attempt || attempt.status !== "pending") return [undefined, current]
        const terminal: TerminalAttempt = Exit.isSuccess(exit)
          ? { status: "complete", time: attempt.time, removeAt: now + terminalRetention }
          : { status: "failed", message: message(exit.cause), time: attempt.time, removeAt: now + terminalRetention }
        return [attempt, new Map(current).set(attemptID, terminal)]
      })
      if (!result) return

      if (Exit.isSuccess(exit)) {
        const implementation = resolveImplementation(result.integrationID, result.methodID)
        yield* credentials.add({
          integrationID: result.integrationID,
          label: result.label ?? implementation?.label?.(exit.value),
          value: exit.value,
        })
        yield* events.publish(Integration.Event.ConnectionUpdated, { integrationID: result.integrationID })
        yield* events.publish(Integration.Event.Updated, {})
      }

      yield* close(result.scope)
    })

    const scrub = Effect.fnUntraced(function* () {
      const now = yield* Clock.currentTimeMillis
      const expired = yield* SynchronizedRef.modify(attempts, (current) => {
        const next = new Map(current)
        const scopes: Scope.Closeable[] = []
        for (const [id, attempt] of current) {
          if (attempt.status === "pending" && attempt.time.expires <= now) {
            scopes.push(attempt.scope)
            next.set(id, { status: "expired", time: attempt.time, removeAt: now + terminalRetention })
            continue
          }
          if (attempt.status !== "pending" && attempt.removeAt <= now) next.delete(id)
        }
        return [scopes, next]
      })
      yield* Effect.forEach(expired, close, { discard: true })
    })

    yield* scrub().pipe(Effect.repeat(Schedule.spaced(scrubInterval)), Effect.forkIn(scope))

    const oauth = Effect.fn("IntegrationAuthKernel.oauth")(function* (input: {
      readonly integrationID: Integration.ID
      readonly methodID: Integration.MethodID
      readonly inputs: Integration.Inputs
      readonly label?: string
    }) {
      const method = resolveImplementation(input.integrationID, input.methodID)
      if (!method) {
        return yield* Effect.die(`OAuth method not found: ${input.integrationID}/${input.methodID}`)
      }

      const attemptScope = yield* Scope.fork(scope)
      const authorization = yield* authorize(method.authorize(input.inputs)).pipe(
        Scope.provide(attemptScope),
        Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(attemptScope, exit) : Effect.void)),
      )
      const id = Integration.AttemptID.create()
      const created = yield* Clock.currentTimeMillis
      const time = { created, expires: created + attemptLifetime }

      yield* SynchronizedRef.update(attempts, (current) =>
        new Map(current).set(id, {
          status: "pending",
          completing: authorization.mode === "auto",
          authorization,
          integrationID: input.integrationID,
          methodID: input.methodID,
          label: input.label,
          scope: attemptScope,
          time,
        }),
      )

      if (authorization.mode === "auto") {
        yield* authorization.callback.pipe(
          Effect.exit,
          Effect.flatMap((exit) => settle(id, exit)),
          Effect.forkIn(attemptScope, { startImmediately: true }),
        )
      }

      return new Integration.Attempt({
        attemptID: id,
        url: authorization.url,
        instructions: authorization.instructions,
        mode: authorization.mode,
        time,
      })
    })

    const attempt = {
      status: Effect.fn("IntegrationAuthKernel.attempt.status")(function* (attemptID: Integration.AttemptID) {
        const current = (yield* SynchronizedRef.get(attempts)).get(attemptID)
        if (!current) return yield* Effect.die(`OAuth attempt not found: ${attemptID}`)
        if (current.status === "failed") {
          return {
            status: current.status,
            message: current.message ?? "Authorization failed",
            time: current.time,
          } satisfies Integration.AttemptStatus
        }
        return { status: current.status, time: current.time } satisfies Integration.AttemptStatus
      }),
      complete: Effect.fn("IntegrationAuthKernel.attempt.complete")(function* (input: {
        readonly attemptID: Integration.AttemptID
        readonly code?: string
      }) {
        const current = yield* SynchronizedRef.modify(attempts, (entries) => {
          const match = entries.get(input.attemptID)
          if (!match || match.status !== "pending" || match.completing) return [match, entries]
          if (match.authorization.mode === "code" && input.code === undefined) return [match, entries]
          return [match, new Map(entries).set(input.attemptID, { ...match, completing: true })]
        })

        if (!current) return yield* Effect.die(`OAuth attempt not found: ${input.attemptID}`)
        if (current.status !== "pending") return
        if (current.authorization.mode === "code" && input.code === undefined) {
          return yield* new CodeRequiredError({ attemptID: input.attemptID })
        }
        if (current.completing) return yield* Effect.die(`OAuth attempt already completing: ${input.attemptID}`)

        const callback =
          current.authorization.mode === "auto"
            ? current.authorization.callback
            : current.authorization.callback(input.code as string)
        const exit = yield* authorize(callback).pipe(Effect.exit)
        yield* settle(input.attemptID, exit)
        if (Exit.isFailure(exit)) return yield* exit
      }),
      cancel: Effect.fn("IntegrationAuthKernel.attempt.cancel")(function* (attemptID: Integration.AttemptID) {
        const current = yield* SynchronizedRef.modify(attempts, (entries) => {
          const match = entries.get(attemptID)
          if (!match || match.status !== "pending") return [undefined, entries]
          const next = new Map(entries)
          next.delete(attemptID)
          return [match, next]
        })
        if (current) yield* Scope.close(current.scope, Exit.void)
      }),
    }

    return { oauth, attempt }
  })
}
