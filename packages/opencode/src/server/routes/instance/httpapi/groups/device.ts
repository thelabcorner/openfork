import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { described } from "./metadata"

export const DevicePaths = {
  list: "/devices",
  remove: "/devices/:deviceID",
} as const

export const DeviceInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** First 8 characters of the one-time token — display only, never authenticates. */
  tokenPrefix: Schema.String,
  createdAt: Schema.String,
  lastSeenAt: Schema.optional(Schema.String),
  revokedAt: Schema.optional(Schema.String),
}).annotate({ identifier: "Device.Info" })

export const DeviceApi = HttpApi.make("device").add(
  HttpApiGroup.make("device")
    .add(
      HttpApiEndpoint.get("list", DevicePaths.list, {
        success: described(Schema.Array(DeviceInfo), "Paired devices"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "device.list",
          summary: "List paired devices",
          description: "List every registered device, oldest first, including revoked ones.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.delete("remove", DevicePaths.remove, {
        params: { deviceID: Schema.String },
        success: described(Schema.Boolean, "True when the device existed and was revoked"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "device.remove",
          summary: "Revoke a device",
          description: "Soft-revoke a device; its token stops authenticating immediately.",
        }),
      ),
    )
    .middleware(Authorization)
    .annotateMerge(OpenApi.annotations({ title: "device", description: "Paired-device management." })),
)
