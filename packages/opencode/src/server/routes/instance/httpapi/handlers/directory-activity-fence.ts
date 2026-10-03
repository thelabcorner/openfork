import { DirectoryActivityFence } from "@opencode-ai/core/directory-activity-fence"
import { DirectoryMaintenanceGuard } from "@opencode-ai/core/directory-maintenance-guard"
import { Effect, Option } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"
import {
  ApiFenceAcquireError,
  FENCE_PROTOCOL_VERSION,
  FenceAcquirePayload,
  LoopbackRequiredError,
} from "../groups/directory-activity-fence"

function canonicalIPv4Loopback(value: string) {
  const octets = value.split(".")
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(octet))
  )
}

export function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  if (remoteAddress === undefined) return false
  const value = remoteAddress.trim().toLowerCase()
  if (value === "::1" || /^(?:0{1,4}:){7}0{0,3}1$/.test(value)) return true
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value)
  return canonicalIPv4Loopback(mapped === null ? value : mapped[1]!)
}

const requireLoopback = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  if (isLoopbackRemoteAddress(Option.getOrUndefined(request.remoteAddress))) return
  return yield* Effect.fail(
    new LoopbackRequiredError({
      name: "LoopbackRequiredError",
      data: { message: "Directory activity-fence authority is loopback-only." },
    }),
  )
})

function acquireError(error: DirectoryActivityFence.Error): ApiFenceAcquireError {
  if (error instanceof DirectoryMaintenanceGuard.InvalidDirectoryError)
    return new ApiFenceAcquireError({
      name: error._tag,
      data: { message: `Directory is not an existing physical directory: ${error.directory}`, directory: error.directory },
    })
  if (error instanceof DirectoryMaintenanceGuard.DuplicateDirectoryError)
    return new ApiFenceAcquireError({
      name: error._tag,
      data: { message: `Directories must be physically distinct: ${error.directory}`, directory: error.directory },
    })
  if (error instanceof DirectoryMaintenanceGuard.InsufficientDirectoriesError)
    return new ApiFenceAcquireError({
      name: error._tag,
      data: { message: "At least two directories are required.", count: error.count },
    })
  return new ApiFenceAcquireError({
    name: error._tag,
    data: { message: "Guard identity is not canonical.", guardId: error.guardId },
  })
}

export const directoryActivityFenceHandlers = HttpApiBuilder.group(
  RootHttpApi,
  "directoryActivityFence",
  (handlers) =>
    Effect.gen(function* () {
      const fence = yield* DirectoryActivityFence.Service

      const acquire = Effect.fn("DirectoryActivityFenceHttpApi.acquire")(function* (ctx: {
        payload: typeof FenceAcquirePayload.Type
      }) {
        yield* requireLoopback
        const result = yield* fence
          .acquire({ guardId: ctx.payload.guardId, directories: ctx.payload.directories })
          .pipe(Effect.mapError(acquireError))
        if (result.state === "blocked") {
          return { fenceProtocolVersion: FENCE_PROTOCOL_VERSION, ...result }
        }
        return {
          fenceProtocolVersion: FENCE_PROTOCOL_VERSION,
          state: result.state,
          token: {
            ...result.token,
            directories: [result.token.directories[0]!, result.token.directories[1]!] as const,
          },
        }
      })

      const health = Effect.fn("DirectoryActivityFenceHttpApi.health")(function* (ctx: {
        payload: { token: unknown }
      }) {
        yield* requireLoopback
        const result = yield* fence.assertHealthy(ctx.payload.token as DirectoryActivityFence.Handle)
        return { fenceProtocolVersion: FENCE_PROTOCOL_VERSION, ...result }
      })

      const release = Effect.fn("DirectoryActivityFenceHttpApi.release")(function* (ctx: {
        payload: { token: unknown }
      }) {
        yield* requireLoopback
        const result = yield* fence.release(ctx.payload.token as DirectoryActivityFence.Handle)
        return { fenceProtocolVersion: FENCE_PROTOCOL_VERSION, state: result }
      })

      return handlers.handle("acquire", acquire).handle("health", health).handle("release", release)
    }),
)
