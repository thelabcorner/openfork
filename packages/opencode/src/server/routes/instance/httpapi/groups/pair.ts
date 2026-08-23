import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { described } from "./metadata"

export const PairPaths = {
  begin: "/pair/begin",
  claim: "/pair/claim",
} as const

export const PairBeginResult = Schema.Struct({
  code: Schema.String,
  /** Same-origin URL carrying the code as a #pair= fragment (never a query param — keeps the code out of logs/history), suitable for a QR code. */
  url: Schema.String,
  expiresAt: Schema.String,
}).annotate({ identifier: "PairBeginResult" })

export const PairClaimInput = Schema.Struct({
  code: Schema.String,
  name: Schema.optional(Schema.String),
})

export const PairedDeviceInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
})

export const PairClaimResult = Schema.Struct({
  /** One-time device token (base64url of 32 random bytes). Shown once, never retrievable again. */
  token: Schema.String,
  device: PairedDeviceInfo,
  server: Schema.Struct({ name: Schema.String, version: Schema.String }),
}).annotate({ identifier: "PairClaimResult" })

export class ApiPairCodeError extends Schema.ErrorClass<ApiPairCodeError>("PairCodeError")(
  {
    name: Schema.Literal("PairCodeError"),
    data: Schema.Struct({
      message: Schema.String,
      reason: Schema.Literals(["invalid", "expired", "exhausted"]),
    }),
  },
  { httpApiStatus: 400 },
) {}

export class ApiClaimRateLimitedError extends Schema.ErrorClass<ApiClaimRateLimitedError>("ClaimRateLimitedError")(
  {
    name: Schema.Literal("ClaimRateLimitedError"),
    data: Schema.Struct({
      message: Schema.String,
      retryAfterMs: Schema.Number,
    }),
  },
  { httpApiStatus: 429 },
) {}

// /pair/begin requires auth (the desktop mints codes); /pair/claim is
// UNAUTHENTICATED BY DESIGN — it IS the auth bootstrap — so the two live in
// separate HttpApi surfaces instead of riding group-level Authorization.
export const PairBeginApi = HttpApi.make("pair-begin").add(
  HttpApiGroup.make("pair-begin")
    .add(
      HttpApiEndpoint.post("begin", PairPaths.begin, {
        success: described(PairBeginResult, "Single-use pairing code minted"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "pair.begin",
          summary: "Begin device pairing",
          description:
            "Mint a single-use six-character pairing code that expires in 90 seconds and dies after five failed claims.",
        }),
      ),
    )
    .middleware(Authorization)
    .annotateMerge(OpenApi.annotations({ title: "pair-begin", description: "Authenticated pairing-code minting." })),
)

export const PairClaimApi = HttpApi.make("pair-claim").add(
  HttpApiGroup.make("pair-claim")
    .add(
      HttpApiEndpoint.post("claim", PairPaths.claim, {
        payload: PairClaimInput,
        success: described(PairClaimResult, "Device paired; one-time token issued"),
        error: [ApiPairCodeError, ApiClaimRateLimitedError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "pair.claim",
          summary: "Claim a pairing code",
          description:
            "Exchange a valid pairing code for a one-time device token. Unauthenticated by design; rate-limited per code and per client IP.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({ title: "pair-claim", description: "Public pairing-code claim (auth bootstrap)." }),
    ),
)
