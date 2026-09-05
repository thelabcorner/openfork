import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { INSTANCE_EXPECT_HEADER, instanceIdentity } from "@/server/shared/instance-identity"

/**
 * Refuses requests addressed to a *different* opencode process.
 *
 * A client that has verified an instance can pin every later request to it by
 * sending `x-opencode-expect-instance`. Without this, "am I talking to the
 * right server?" can only ever be answered about a previous request: ports are
 * recycled, and on a machine running several opencodes the next connection to
 * the same port may reach a different process. Answering here — inside the
 * process being addressed — is the only check that cannot be raced.
 *
 * Absent header means "no preference", so this is invisible to clients that do
 * not opt in.
 */
export const instancePin = HttpRouter.middleware(
  (effect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const expected = request.headers[INSTANCE_EXPECT_HEADER]
      if (!expected) return yield* effect

      const actual = instanceIdentity().instanceID
      if (expected === actual) return yield* effect

      // 409, not 404/403: the request is well-formed and authorized, it just
      // arrived at the wrong process. The body names both sides so the client
      // can say which instance it actually reached.
      return HttpServerResponse.jsonUnsafe(
        {
          name: "InstanceMismatchError",
          data: {
            message: "This request was addressed to a different opencode instance.",
            expected,
            actual,
          },
        },
        { status: 409, headers: { "cache-control": "no-store" } },
      )
    }),
  { global: true },
)
