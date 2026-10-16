// Keep this file intentionally dependency-free at module evaluation time. ACP
// uses stdout as an NDJSON protocol transport, so we must reserve fd 1 before
// importing the CLI graph: user plugins can execute during those imports.
// The runtime guard below only imports node:fs/node:path helpers and runs before
// ACP detection so a helper script whose own arguments happen to contain `acp`
// cannot accidentally have its stdout redirected to the ACP transport.
const nestedScriptExit = await import("./util/javascript-runtime").then((mod) => mod.rerouteNestedStandaloneScript())
if (nestedScriptExit !== undefined) process.exit(nestedScriptExit)

const isACP = process.argv.slice(2).includes("acp")

if (isACP) {
  const protocolWrite = process.stdout.write.bind(process.stdout)
  ;(
    globalThis as typeof globalThis & { __OPENCODE_ACP_PROTOCOL_WRITE__?: typeof process.stdout.write }
  ).__OPENCODE_ACP_PROTOCOL_WRITE__ = protocolWrite

  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write
  const { Console } = await import("node:console")
  ;(globalThis as any).console = new Console({ stdout: process.stderr, stderr: process.stderr })
  process.env.OPENCODE_CLIENT = "acp"

  // Reserve stdin at the same pre-bootstrap boundary as stdout. JetBrains may
  // close or write the ACP pipe while the CLI graph/plugins are still loading;
  // attaching listeners only inside the acp command can therefore miss EOF
  // and strand the child process. Buffer protocol bytes in a Web stream until
  // the command consumes them, while pausing the OS pipe under backpressure.
  type ACPStdinTransport = {
    stream: ReadableStream<Uint8Array>
    done: Promise<void>
  }

  let settle: (() => void) | undefined
  let reject: ((error: Error) => void) | undefined
  let cleanup: (() => void) | undefined
  let firstActivity: ((kind: "data" | "eof") => void) | undefined
  let sawData = false
  const done = new Promise<void>((resolve, rejectDone) => {
    settle = resolve
    reject = rejectDone
  })
  const activity = new Promise<"data" | "eof">((resolve) => {
    firstActivity = resolve
  })

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const onData = (chunk: Buffer) => {
        if (closed) return
        if (!sawData) {
          sawData = true
          firstActivity?.("data")
        }
        controller.enqueue(new Uint8Array(chunk))
        if ((controller.desiredSize ?? 1) <= 0) process.stdin.pause()
      }
      const finish = () => {
        if (closed) return
        closed = true
        cleanup?.()
        controller.close()
        if (!sawData) firstActivity?.("eof")
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

  ;(
    globalThis as typeof globalThis & { __OPENCODE_ACP_PROTOCOL_STDIN__?: ACPStdinTransport }
  ).__OPENCODE_ACP_PROTOCOL_STDIN__ = { stream, done }

  // Do not hydrate AppRuntime/project/global services until an ACP client has
  // actually sent protocol input. An empty EOF means the host abandoned launch;
  // there is no request to service and therefore nothing to initialize or tear
  // down. This also makes IDE cancellation effectively constant-cost.
  if ((await activity) === "eof") process.exit(0)
}

await import("./cli-main")
