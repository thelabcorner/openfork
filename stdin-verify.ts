import { Effect, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"

// Spawn a node process that echoes stdin back, then verify we can send twice.
const program = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner
  const script = `
    let buf = "";
    process.stdin.on("data", (d) => { buf += d; process.stdout.write("GOT:" + d.toString().trim() + "\\n") });
    process.stdin.on("end", () => { process.stdout.write("STDIN_ENDED\\n") });
  `
  const handle = yield* spawner.spawn(
    ChildProcess.make(process.execPath, ["-e", script], {
      stdin: { stream: "pipe", endOnDone: false },
      stdout: { stream: "pipe" },
    } as any),
  )

  // Collect output
  const collected: string[] = []
  yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) => Effect.sync(() => collected.push(chunk))).pipe(
    Effect.forkScoped,
  )

  // write first chunk
  yield* Stream.run(Stream.make(new TextEncoder().encode("hello\n")), handle.stdin).pipe(
    Effect.catchAll((e) => Effect.logError("first write failed", { e })),
  )

  // write second chunk
  yield* Stream.run(Stream.make(new TextEncoder().encode("world\n")), handle.stdin).pipe(
    Effect.catchAll((e) => Effect.logError("second write failed", { e })),
  )

  yield* Effect.sleep("1 second")
  console.log("COLLECTED:", JSON.stringify(collected.join("")))

  // now end stdin
  yield* Stream.run(Stream.empty, handle.stdin).pipe(Effect.catchAll((e) => Effect.logError("end failed", { e })))

  yield* Effect.sleep("1 second")
  console.log("AFTER END:", JSON.stringify(collected.join("")))

  const code = yield* handle.exitCode.pipe(Effect.timeout("3 seconds"))
  console.log("EXIT CODE:", code._tag === "Some" ? code.value : null)
})

const layer = LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node]))

Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))
