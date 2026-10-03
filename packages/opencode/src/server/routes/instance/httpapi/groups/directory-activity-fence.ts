import { PositiveInt } from "@opencode-ai/core/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"

const root = "/experimental/directory-activity-fence"

export const FENCE_PROTOCOL_VERSION = 1 as const
const FenceProtocolVersion = Schema.Literal(FENCE_PROTOCOL_VERSION)

export const DirectoryActivityFencePaths = {
  acquire: `${root}/acquire`,
  health: `${root}/health`,
  release: `${root}/release`,
} as const

export class ApiFenceAcquireError extends Schema.ErrorClass<ApiFenceAcquireError>("FenceAcquireError")(
  {
    name: Schema.String,
    data: Schema.Struct({
      message: Schema.String,
      directory: Schema.optional(Schema.String),
      count: Schema.optional(Schema.Number),
      guardId: Schema.optional(Schema.String),
    }),
  },
  { httpApiStatus: 400 },
) {}

export class LoopbackRequiredError extends Schema.ErrorClass<LoopbackRequiredError>("LoopbackRequiredError")(
  {
    name: Schema.String,
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 403 },
) {}

export const FenceAcquirePayload = Schema.Struct({
  guardId: Schema.String,
  directories: Schema.Tuple([Schema.String, Schema.String]),
})

export const FenceTokenPayload = Schema.Struct({ token: Schema.Unknown })

const FenceToken = Schema.Struct({
  acquisitionId: Schema.String,
  guardId: Schema.String,
  ownerID: Schema.String,
  generation: PositiveInt,
  directories: Schema.Tuple([Schema.String, Schema.String]),
})

const FenceBlockedDirectory = Schema.Struct({
  directory: Schema.String,
  guardId: Schema.String,
  ownerID: Schema.String,
  acquisitionId: Schema.String,
  generation: PositiveInt,
  state: Schema.Union([Schema.Literal("active"), Schema.Literal("reconcile_required")]),
})

const FenceExecutingBlocker = Schema.Struct({
  sessionID: Schema.String,
  ownerID: Schema.String,
  generation: PositiveInt,
  persistedDirectory: Schema.String,
  directory: Schema.NullOr(Schema.String),
  recoveryOwnerID: Schema.optional(Schema.String),
})

export const FenceAcquireResult = Schema.Union([
  Schema.Struct({
    fenceProtocolVersion: FenceProtocolVersion,
    state: Schema.Literal("acquired"),
    token: FenceToken,
  }),
  Schema.Struct({
    fenceProtocolVersion: FenceProtocolVersion,
    state: Schema.Literal("blocked"),
    blocked: Schema.Array(FenceBlockedDirectory),
    executing: Schema.Array(FenceExecutingBlocker),
  }),
])

export const FenceHealthResult = Schema.Union([
  Schema.Struct({
    fenceProtocolVersion: FenceProtocolVersion,
    state: Schema.Literal("healthy"),
  }),
  Schema.Struct({
    fenceProtocolVersion: FenceProtocolVersion,
    state: Schema.Literal("unhealthy"),
    issues: Schema.Array(
      Schema.Struct({
        directory: Schema.String,
        reason: Schema.String,
      }),
    ),
  }),
])

export const FenceReleaseResult = Schema.Struct({
  fenceProtocolVersion: FenceProtocolVersion,
  state: Schema.Union([Schema.Literal("released"), Schema.Literal("stale")]),
})

export const DirectoryActivityFenceApi = HttpApi.make("directoryActivityFence").add(
  HttpApiGroup.make("directoryActivityFence")
    .add(
      HttpApiEndpoint.post("acquire", DirectoryActivityFencePaths.acquire, {
        payload: FenceAcquirePayload,
        success: described(FenceAcquireResult, "Fence acquisition outcome"),
        error: [ApiFenceAcquireError, LoopbackRequiredError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.directoryActivityFence.acquire",
          summary: "Acquire directory activity fence",
          description:
            "Tier 0, authenticated, loopback-only, and instance-pinned. Acquire maintenance authority over exactly two physical directories. Maintenance blockers and active execution blockers remain structurally distinct.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("health", DirectoryActivityFencePaths.health, {
        payload: FenceTokenPayload,
        success: described(FenceHealthResult, "Fence health outcome"),
        error: LoopbackRequiredError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.directoryActivityFence.health",
          summary: "Check directory activity fence health",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("release", DirectoryActivityFencePaths.release, {
        payload: FenceTokenPayload,
        success: described(FenceReleaseResult, "Fence release outcome"),
        error: LoopbackRequiredError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.directoryActivityFence.release",
          summary: "Release directory activity fence",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "directoryActivityFence",
        description: "Tier 0 directory maintenance authority transport.",
      }),
    ),
)
