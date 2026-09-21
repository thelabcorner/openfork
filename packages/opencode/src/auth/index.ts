import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Effect, Layer, Record, Result, Schedule, Schema, Context, Semaphore } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const decode = Schema.decodeUnknownOption(Info)
    const mutation = yield* Semaphore.make(1)

    const all = Effect.fn("Auth.all")(function* () {
      if (process.env.OPENCODE_AUTH_CONTENT) {
        try {
          return JSON.parse(process.env.OPENCODE_AUTH_CONTENT)
        } catch (err) {}
      }

      const data = (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
      return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const writeAtomic = Effect.fn("Auth.writeAtomic")(function* (data: Record<string, Info>) {
      const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
      const content = JSON.stringify(data, null, 2)
      yield* fsys.writeFileString(temp, content).pipe(Effect.mapError(fail("Failed to write auth data")))
      yield* fsys.chmod(temp, 0o600).pipe(
        Effect.mapError(fail("Failed to secure auth data")),
        Effect.catch((cause) => fsys.remove(temp, { force: true }).pipe(Effect.ignore, Effect.andThen(Effect.fail(cause)))),
      )
      yield* fsys.rename(temp, file).pipe(
        Effect.retry({ times: 8, schedule: Schedule.spaced("20 millis") }),
        Effect.mapError(fail("Failed to replace auth data")),
        Effect.catch((cause) => fsys.remove(temp, { force: true }).pipe(Effect.ignore, Effect.andThen(Effect.fail(cause)))),
      )
    })

    const set = Effect.fn("Auth.set")((key: string, info: Info) =>
      mutation.withPermits(1)(
        Effect.gen(function* () {
          const norm = key.replace(/\/+$/, "")
          const data = yield* all()
          if (norm !== key) delete data[key]
          delete data[norm + "/"]
          yield* writeAtomic({ ...data, [norm]: info })
        }),
      ),
    )

    const remove = Effect.fn("Auth.remove")((key: string) =>
      mutation.withPermits(1)(
        Effect.gen(function* () {
          const norm = key.replace(/\/+$/, "")
          const data = yield* all()
          delete data[key]
          delete data[norm]
          yield* writeAtomic(data)
        }),
      ),
    )

    return Service.of({ get, all, set, remove })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node] })

export * as Auth from "."
