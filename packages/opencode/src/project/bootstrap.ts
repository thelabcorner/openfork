import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "@/lsp/lsp"
import { Snapshot } from "../snapshot"
import * as Project from "./project"
import * as Vcs from "./vcs"
import { InstanceState } from "@/effect/instance-state"
import { ShareNext } from "@/share/share-next"
import { ToolReload } from "@/tool/reload"
import { Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { Service } from "./bootstrap-service"

export { Service } from "./bootstrap-service"
export type { Interface } from "./bootstrap-service"

/**
 * Logs how long one bootstrap step took for this directory. Cold-start
 * attribution: every directory-scoped HTTP request queues behind the full
 * InstanceBootstrap.run (see InstanceStore.boot), so these lines identify
 * which init is the tail latency without attaching a profiler.
 */
const timed = <A, E, R>(directory: string, label: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const startedAt = Date.now()
    const value = yield* effect
    yield* Effect.logInfo("instance init complete", { directory, service: label, ms: Date.now() - startedAt })
    return value
  })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Yield each bootstrap dep at layer init so `run` itself has R = never.
    // InstanceStore imports only the lightweight tag from bootstrap-service.ts,
    // so it can depend on bootstrap without importing this implementation graph.
    const config = yield* Config.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const plugin = yield* Plugin.Service
    const project = yield* Project.Service
    const shareNext = yield* ShareNext.Service
    const snapshot = yield* Snapshot.Service
    const vcs = yield* Vcs.Service
    const toolReload = yield* ToolReload.Service

    // Request-gating half: InstanceStore unblocks queued requests as soon as
    // this completes. Keep it fast — nothing speculative belongs here.
    const gate = Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      yield* Effect.logInfo("bootstrapping", { directory: ctx.directory })
      // everything depends on config so eager load it for nice traces
      yield* timed(ctx.directory, "config", config.get())
      // Plugin can mutate config so it has to be initialized before anything else.
      yield* timed(ctx.directory, "plugin", plugin.init())
      // ToolReload starts its watcher subscription + poll fallback for this instance;
      // start() materializes the per-directory state and is non-blocking.
      yield* timed(ctx.directory, "toolReload", toolReload.start()).pipe(
        Effect.catchCause((cause) => Effect.logWarning("tool reload init failed", { cause })),
      )
    }).pipe(Effect.withSpan("InstanceBootstrap.gate"))

    // Non-gating half: eager per-service materialization. Services also
    // materialize lazily via InstanceState.get on first use (single-flighted by
    // ScopedCache), so a slow init here delays warm caches, never requests.
    const warmup = Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      yield* Effect.forEach(
        [
          ["lsp", lsp],
          ["shareNext", shareNext],
          ["format", format],
          ["vcs", vcs],
          ["snapshot", snapshot],
          ["project", project],
        ] as const,
        ([name, service]) =>
          timed(ctx.directory, name, service.init()).pipe(
            Effect.catchCause((cause) => Effect.logWarning("init failed", { cause })),
          ),
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.withSpan("InstanceBootstrap.warmup"))
    })

    return Service.of({ gate, warmup })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [Config.node, Format.node, LSP.node, Plugin.node, Project.node, ShareNext.node, Snapshot.node, Vcs.node, ToolReload.node],
})

export * as InstanceBootstrap from "./bootstrap"
