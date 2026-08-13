import { BrowserHostBroker } from "@opencode-ai/core/browser/host-broker"
import { Effect, Schema } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { InvalidRequestError } from "@opencode-ai/protocol/errors"
import { HostRegistrationInfo } from "@opencode-ai/protocol/groups/browser"
import { Api } from "../api"

const decodeHostInfo = Schema.decodeUnknownSync(HostRegistrationInfo)

export const BrowserHandler = HttpApiBuilder.group(Api, "server.browser", (handlers) =>
  Effect.gen(function* () {
    const broker = yield* BrowserHostBroker.Service

    return handlers
      .handle(
        "browser.host.hello",
        Effect.fn(function* (ctx) {
          // ctx.payload is schema-decoded against the protocol HostRegistration;
          // it is structurally assignable to the core Broker's registration shape.
          return yield* broker.register(ctx.payload).pipe(
            Effect.mapError((error) => new InvalidRequestError({ message: `Failed to register browser host: ${error}` })),
          )
        }),
      )
      .handle(
        "browser.event",
        Effect.fn(function* (ctx) {
          yield* broker.pushEvent(ctx.payload)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "browser.hosts",
        Effect.fn(function* () {
          const rows = yield* broker.list()
          // Core returns plain-string identifiers; re-encode through the protocol
          // schema so the wire carries the branded session/workspace/directory types.
          return { data: rows.map((row) => decodeHostInfo(row)) }
        }),
      )
  }),
)
