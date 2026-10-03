import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import * as AppBackgroundJob from "../../src/background/job"
import { GoalAutomation } from "@opencode-ai/core/goal/automation"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import * as CurrentParts from "@opencode-ai/core/session/current-parts"
import { SessionTelemetry } from "@opencode-ai/core/session/telemetry"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Config, Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import * as Http from "node:http"
import { Session } from "../../src/session/session"
import { MessageID, PartID, type SessionID as SessionIDType } from "../../src/session/schema"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { Workspace } from "../../src/control-plane/workspace"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { SessionRunState } from "../../src/session/run-state"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { provideInstanceEffect } from "../fixture/fixture"

const directory = process.env.OPENFORK_RENDERER_GATE_DIRECTORY
if (!directory) throw new Error("OPENFORK_RENDERER_GATE_DIRECTORY is required")

const noopBootstrapLayer = Layer.succeed(
  InstanceBootstrap.Service,
  InstanceBootstrap.Service.of({ gate: Effect.void, warmup: Effect.void }),
)
const appLayer = AppNodeBuilder.build(
  LayerNode.group([
    InstanceStore.node,
    Project.node,
    Session.node,
    Workspace.node,
    Database.node,
    SessionTelemetry.node,
    SessionExecutionOwner.node,
    GoalAutomation.node,
    SessionRunState.node,
    AppBackgroundJob.node,
    CurrentParts.node,
    Ripgrep.node,
  ]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer]],
)
let boundServer: Http.Server | undefined
const served: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(HttpApiApp.routes, {
  disableListenLog: true,
  disableLogger: true,
})
const nodeServer = NodeHttpServer.layer(() => (boundServer = Http.createServer()), { host: "127.0.0.1", port: 0 }).pipe(
  Layer.provide(NodeServices.layer),
)
const servedRoutes = served.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provide(nodeServer),
  Layer.provide(NodeServices.layer),
)
const runtime = Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(Layer.mergeAll(appLayer, servedRoutes))
      const address = boundServer?.address()
      if (!address || typeof address === "string") throw new Error("test HttpApi did not bind an ephemeral TCP port")
      const url = `http://127.0.0.1:${address.port}/`
      process.stdout.write(`OPENFORK_RENDERER_GATE_READY ${url}\n`)
      const { stdin } = process
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            let buffer = ""
            stdin.setEncoding("utf8")
            stdin.on("data", (chunk: string) => {
              buffer += chunk
              while (true) {
                const end = buffer.indexOf("\n")
                if (end < 0) break
                const line = buffer.slice(0, end)
                buffer = buffer.slice(end + 1)
                if (!line) continue
                const command = JSON.parse(line) as { id: string; action: string; sessions?: string[]; session?: string }
                void Effect.runPromise(Effect.provideContext(runCommand(command), context)).then(
                  (result) => process.stdout.write(`OPENFORK_RENDERER_GATE_RESULT ${JSON.stringify({ id: command.id, result })}\n`),
                  (error) => process.stdout.write(`OPENFORK_RENDERER_GATE_ERROR ${JSON.stringify({ id: command.id, error: String(error) })}\n`),
                )
              }
            })
            stdin.on("end", resolve)
          }),
      )
    }),
  ),
).catch((error) => {
  process.stderr.write(`OPENFORK_RENDERER_GATE_FATAL ${String(error)}\n${error instanceof Error ? error.stack : ""}\n`)
  process.exitCode = 1
})

function runCommand(command: { id: string; action: string; sessions?: string[]; session?: string }) {
  return Effect.gen(function* () {
    const session = yield* Session.Service
    if (command.action === "seed") {
      const result = yield* Effect.gen(function* () {
        const entries: Array<{ sessionID: SessionIDType; messageID: string; partID: string; text: string }> = []
        for (let index = 0; index < 6; index++) {
          const info = yield* session.create({ title: `renderer gate ${index + 1}` })
          const message = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: info.id,
            agent: "build",
            model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
            time: { created: Date.now() },
          })
          const text = `Real TestHttpApi completed history ${info.id}. `.repeat(80)
          const part = yield* session.updatePart({
            id: PartID.ascending(),
            sessionID: info.id,
            messageID: message.id,
            type: "text",
            text,
          })
          entries.push({ sessionID: info.id, messageID: message.id, partID: part.id, text })
        }
        return entries
      }).pipe(provideInstanceEffect(directory!))
      return result
    }
    if (command.action === "deltas" || command.action === "cursor-marker") {
      const result = yield* Effect.gen(function* () {
        const sessionIDs = command.action === "cursor-marker" ? (command.session ? [command.session] : []) : (command.sessions ?? [])
        const entries = yield* Effect.forEach(sessionIDs, (sessionID) => session.get(sessionID as SessionIDType))
        const output: string[] = []
        for (const info of entries) {
          if (!info) continue
          const messages = yield* session.messages({ sessionID: info.id, limit: 1 })
          const message = messages[0]
          const part = message?.parts.find((item) => item.type === "text")
          if (!message || !part || part.type !== "text") continue
          const marker = command.action === "cursor-marker" ? `cursor-tail-${info.id}` : `real-sse-tail-${info.id}`
          const delta = `\n\n${marker}`
          yield* session.updatePartDelta({ sessionID: info.id, messageID: message.info.id, partID: part.id, field: "text", delta, offset: part.text.length })
          output.push(info.id)
        }
        return output
      }).pipe(provideInstanceEffect(directory!))
      return result
    }
    if (command.action === "gap" && command.session) {
      const result = yield* Effect.gen(function* () {
        const sessionID = command.session as SessionIDType
        const info = yield* session.get(sessionID)
        if (!info) return false
        const messages = yield* session.messages({ sessionID, limit: 1 })
        const message = messages[0]
        const part = message?.parts.find((item) => item.type === "text")
        if (!message || !part || part.type !== "text") return false
        yield* session.updatePartDelta({ sessionID, messageID: message.info.id, partID: part.id, field: "text", delta: "bad-offset", offset: Number.MAX_SAFE_INTEGER })
        yield* session.updatePart({ ...part, text: `${part.text}\n\nrepaired-after-gap-${sessionID}` })
        return true
      }).pipe(provideInstanceEffect(directory!))
      return result
    }
    return undefined
  })
}

process.on("SIGTERM", () => {
  process.stdin.destroy()
})
