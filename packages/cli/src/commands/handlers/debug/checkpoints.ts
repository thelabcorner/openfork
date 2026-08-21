import { EOL } from "os"
import * as Effect from "effect/Effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { Daemon } from "../../../services/daemon"

export default Runtime.handler(
  Commands.commands.debug.commands.checkpoints,
  Effect.fn("cli.debug.checkpoints")(function* (ctx) {
    const daemon = yield* Daemon.Service
    const client = yield* daemon.client()
    const response = yield* Effect.promise(() =>
      client.v2.session.checkpoint.list({
        sessionID: ctx.params.sessionID,
        location: { directory: process.cwd() },
      }),
    )
    process.stdout.write(
      JSON.stringify(
        response.data?.data.toSorted((a, b) => a.ordinal - b.ordinal),
        null,
        2,
      ) + EOL,
    )
  }),
)
