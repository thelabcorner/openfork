import { appendFile } from "node:fs/promises"
import { Effect, Logger } from "effect"
import { Credential } from "@opencode-ai/core/credential"
import * as CredentialResolver from "@opencode-ai/core/credential/resolver"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

interface Input {
  readonly db: string
  readonly credentialID: string
  readonly marker: string
}

const raw = process.argv[2]
if (!raw) {
  process.stderr.write("missing credential resolver child input\n")
  process.exit(2)
}
const input = JSON.parse(raw) as Input

const emit = (payload: Record<string, unknown>) => {
  process.stdout.write(JSON.stringify(payload) + "\n")
}

const nextCommand = async () => {
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true })
    const newline = buffer.indexOf("\n")
    if (newline >= 0) return buffer.slice(0, newline).trim()
  }
  return ""
}

const graph = AppNodeBuilder.build(
  LayerNode.group([Credential.node, CredentialResolver.node]),
  [[Database.node, Database.layerFromPath(input.db)]],
)

const program = Effect.gen(function* () {
  const resolver = yield* CredentialResolver.Service

  emit({ type: "ready", pid: process.pid })
  const command = yield* Effect.promise(nextCommand)
  if (command !== "go") return yield* Effect.die(new Error(`unexpected command: ${command}`))

  const resolved = yield* resolver.resolve(input.credentialID as Credential.ID, {
    shouldRefresh: (credential, _integrationID, now) => credential.expires <= now,
    refresh: (credential) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => appendFile(input.marker, `${process.pid}\n`, "utf8"))
        yield* Effect.sleep("350 millis")
        return Credential.OAuth.make({
          ...credential,
          access: `access-${process.pid}`,
          refresh: `refresh-${process.pid}`,
          expires: Number.MAX_SAFE_INTEGER,
        })
      }),
  })

  emit({
    type: "result",
    pid: process.pid,
    revision: resolved?.revision,
    access: resolved?.value.type === "oauth" ? resolved.value.access : undefined,
  })
})

await Effect.runPromise(
  Effect.provideService(Effect.scoped(program.pipe(Effect.provide(graph))), Logger.LogToStderr, true),
).catch((cause: unknown) => {
  const message = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)
  emit({ type: "fatal", message })
  process.exit(1)
})
process.exit(0)
