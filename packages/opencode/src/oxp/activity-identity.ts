import path from "node:path"
import { createHmac, randomBytes, randomUUID } from "node:crypto"
import { Context, Effect, Layer, Option, Schedule } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { OxpError } from "./error"
import type { ParentCorrelation } from "./parent-tool-epoch"

const KEY_BYTES = 32
const MAX_CORRELATION_BYTES = 1024
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/

export interface Correlation {
  readonly scheme: ParentCorrelation["scheme"]
  readonly digest: string
  readonly scope: ParentCorrelation["scope"]
}

export interface Interface {
  readonly pseudonymize: (
    correlation: ParentCorrelation,
  ) => Effect.Effect<Correlation, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/OxpActivityIdentity",
) {}
export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const fs = yield* FSUtil.Service
    const flock = yield* EffectFlock.Service
    const filepath = path.join(global.config, "oxp-activity.key")
    const lockKey = `oxp-activity-identity:${filepath}`
    let cached: Buffer | undefined

    const unavailable = (detail: string) =>
      new OxpError.DependencyUnavailable({ detail })

    const parse = (text: string) => {
      const value = text.trim()
      if (!KEY_PATTERN.test(value)) {
        throw unavailable("OXP activity correlation key is malformed")
      }
      const key = Buffer.from(value, "base64url")
      if (key.length !== KEY_BYTES) {
        throw unavailable("OXP activity correlation key is malformed")
      }
      return key
    }

    const publish = Effect.fn("OxpActivityIdentity.publish")(function* (
      value: string,
    ) {
      const temporary = `${filepath}.${process.pid}.${randomUUID()}.tmp`
      yield* fs.makeDirectory(path.dirname(filepath), { recursive: true }).pipe(
        Effect.mapError(() =>
          unavailable("Unable to create the OXP activity key directory"),
        ),
      )
      yield* fs
        .writeFileString(temporary, value + "\n", {
          flag: "wx",
          mode: 0o600,
        })
        .pipe(
          Effect.mapError(() =>
            unavailable("Unable to write the OXP activity key"),
          ),
        )
      yield* fs.rename(temporary, filepath).pipe(
        Effect.retry({ times: 8, schedule: Schedule.spaced("20 millis") }),
        Effect.catch((cause) =>
          fs.remove(temporary).pipe(
            Effect.ignore,
            Effect.andThen(
              Effect.fail(
                unavailable(
                  `Unable to publish the OXP activity key: ${String(cause)}`,
                ),
              ),
            ),
          ),
        ),
      )
    })

    const load = Effect.fn("OxpActivityIdentity.load")(function* () {
      if (cached) return cached
      return yield* Effect.gen(function* () {
          if (cached) return cached
          const raw = yield* fs.readFileString(filepath).pipe(
            Effect.map(Option.some),
            Effect.catchIf(
              (error) => error.reason._tag === "NotFound",
              () => Effect.succeed(Option.none<string>()),
            ),
            Effect.mapError(() =>
              unavailable("Unable to read the OXP activity key"),
            ),
          )
          if (Option.isSome(raw)) {
            cached = yield* Effect.try({
              try: () => parse(raw.value),
              catch: (cause) =>
                OxpError.isError(cause)
                  ? cause
                  : unavailable("OXP activity correlation key is malformed"),
            })
            return cached
          }
          const value = randomBytes(KEY_BYTES).toString("base64url")
          yield* publish(value)
          cached = Buffer.from(value, "base64url")
          return cached
        }).pipe(
        flock.withLock(lockKey),
        Effect.mapError((error) =>
          OxpError.isError(error)
            ? error
            : unavailable("Unable to lock the OXP activity key"),
        ),
      )
    })

    const pseudonymize = Effect.fn("OxpActivityIdentity.pseudonymize")(
      function* (correlation: ParentCorrelation) {
        const raw = correlation.value
        if (
          !raw ||
          Buffer.byteLength(raw, "utf8") > MAX_CORRELATION_BYTES
        ) {
          return yield* new OxpError.InvalidArgument({
            detail: "Invalid OXP parent correlation identifier",
          })
        }
        const key = yield* load()
        return {
          scheme: correlation.scheme,
          digest: createHmac("sha256", key)
            .update(correlation.scheme, "utf8")
            .update("\0")
            .update(raw, "utf8")
            .digest("base64url"),
          scope: correlation.scope,
        }
      },
    )

    return Service.of({ pseudonymize })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Global.node, FSUtil.node, EffectFlock.node],
})

export * as OxpActivityIdentity from "./activity-identity"
