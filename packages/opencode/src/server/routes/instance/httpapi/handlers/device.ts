import { Device } from "@opencode-ai/core/device"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { DeviceApi, DeviceInfo } from "../groups/device"

function wire(info: Device.Info): typeof DeviceInfo.Type {
  return {
    id: info.id,
    name: info.name,
    tokenPrefix: info.tokenPrefix,
    createdAt: info.createdAt,
    lastSeenAt: info.lastSeenAt,
    revokedAt: info.revokedAt,
  }
}

export const deviceHandlers = HttpApiBuilder.group(DeviceApi, "device", (handlers) =>
  Effect.gen(function* () {
    const devices = yield* Device.Service

    return handlers
      .handle(
        "list",
        Effect.fn("DeviceHttpApi.list")(function* () {
          return (yield* devices.list()).map(wire)
        }),
      )
      .handle(
        "remove",
        Effect.fn("DeviceHttpApi.remove")(function* (ctx: { params: { deviceID: string } }) {
          return yield* devices.revoke(ctx.params.deviceID)
        }),
      )
  }),
)
