import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"
import { ServerAuth } from "@/server/auth"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { ACPProfile } from "@/acp/profile"

type ACPStdinTransport = {
  stream: ReadableStream<Uint8Array>
  done: Promise<void>
}

function protocolStdin(): ACPStdinTransport {
  const inherited = (
    globalThis as typeof globalThis & { __OPENCODE_ACP_PROTOCOL_STDIN__?: ACPStdinTransport }
  ).__OPENCODE_ACP_PROTOCOL_STDIN__
  if (inherited) return inherited

  let settle: (() => void) | undefined
  let reject: ((error: Error) => void) | undefined
  let cleanup: (() => void) | undefined
  const done = new Promise<void>((resolve, rejectDone) => {
    settle = resolve
    reject = rejectDone
  })
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const onData = (chunk: Buffer) => {
        if (closed) return
        controller.enqueue(new Uint8Array(chunk))
        if ((controller.desiredSize ?? 1) <= 0) process.stdin.pause()
      }
      const finish = () => {
        if (closed) return
        closed = true
        cleanup?.()
        controller.close()
        settle?.()
      }
      const fail = (error: Error) => {
        if (closed) return
        closed = true
        cleanup?.()
        controller.error(error)
        reject?.(error)
      }
      cleanup = () => {
        process.stdin.off("data", onData)
        process.stdin.off("end", finish)
        process.stdin.off("close", finish)
        process.stdin.off("error", fail)
      }

      process.stdin.on("data", onData)
      process.stdin.once("end", finish)
      process.stdin.once("close", finish)
      process.stdin.once("error", fail)
      if (process.stdin.readableEnded || process.stdin.destroyed) {
        finish()
        return
      }
      process.stdin.resume()
    },
    pull() {
      if (!process.stdin.readableEnded && !process.stdin.destroyed) process.stdin.resume()
    },
    cancel() {
      cleanup?.()
      process.stdin.pause()
      settle?.()
    },
  })
  return { stream, done }
}

export const AcpCommand = effectCmd({
  command: "acp",
  describe: "start ACP (Agent Client Protocol) server",
  // ACP is a transport host: its internal HTTP server resolves instances from
  // each ACP session cwd. Eagerly hydrating an ambient CLI InstanceContext here
  // duplicates project/plugin bootstrap, slows JetBrains startup, and can keep
  // the subprocess alive after stdin closes.
  instance: false,
  builder: (yargs) => {
    return withNetworkOptions(yargs).option("cwd", {
      describe: "working directory",
      type: "string",
      default: process.cwd(),
    })
  },
  handler: Effect.fn("Cli.acp")(function* (args) {
    // src/index.ts reserves stdout before importing the CLI/plugin graph. Keep a
    // fallback for direct command-module tests, but normal ACP execution must
    // use the captured pre-bootstrap writer for protocol frames.
    const protocolWrite =
      (globalThis as typeof globalThis & { __OPENCODE_ACP_PROTOCOL_WRITE__?: typeof process.stdout.write })
        .__OPENCODE_ACP_PROTOCOL_WRITE__ ?? process.stdout.write.bind(process.stdout)
    process.env.OPENCODE_CLIENT = "acp"

    const { stream: output, done: stdinDone } = protocolStdin()

    const input = new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise<void>((resolve, reject) => {
          protocolWrite(chunk, (err) => {
            if (err) {
              reject(err)
            } else {
              resolve()
            }
          })
        })
      },
    })

    const { Server } = yield* Effect.promise(() => import("@/server/server"))
    const { ACP } = yield* Effect.promise(() => import("@/acp/agent"))
    ACPProfile.mark("cli.acp.handler")
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => ACPProfile.measure("cli.acp.server.listen", () => Server.listen(opts)))

    yield* Effect.gen(function* () {
      const sdk = createOpencodeClient({
        baseUrl: `http://${server.hostname}:${server.port}`,
        headers: ServerAuth.headers(),
      })
      const stream = ndJsonStream(input, output)
      const agent = ACP.init({ sdk })

      new AgentSideConnection((conn) => {
        ACPProfile.mark("cli.acp.connection.create")
        return agent.create(conn)
      }, stream)

      yield* Effect.logInfo("setup connection")
      yield* Effect.promise(() => stdinDone)
      ACPProfile.mark("cli.acp.stdin.eof")
    }).pipe(Effect.ensuring(Effect.promise(async () => {
      ACPProfile.mark("cli.acp.server.stop.before")
      await server.stop(true)
      ACPProfile.mark("cli.acp.server.stop.after")
    })))
  }),
})
