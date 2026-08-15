// Shared SessionV2 + runner + SessionTitle test harness with a scriptable fake
// LLM client and fake catalog. Mirrors session-runner.test.ts's layer
// construction so pause and title tests exercise the real drain machinery.

import { LLMClient, LLMError, LLMEvent, LLMResponse, Model, TransportReason, type LLMRequest } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { Deferred, Effect, Layer, Stream } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { QuestionV2 } from "@opencode-ai/core/question"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import * as SessionRunnerLLM from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionTitle } from "@opencode-ai/core/session/title"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Catalog } from "@opencode-ai/core/catalog"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { Integration } from "@opencode-ai/core/integration"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { testEffect } from "./effect"

/** A runnable fake model used by the drain and the session-model cascade fallback. */
export const sessionModel = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })

export const transportFailure = (message = "Provider unavailable") =>
  new LLMError({ module: "test", method: "stream", reason: new TransportReason({ message }) })

/** Provider events for one clean text-completion turn. */
export const textCompletion = (chunks: readonly string[]): LLMEvent[] => {
  const id = "text-completion"
  return [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.textStart({ id }),
    ...chunks.map((text) => LLMEvent.textDelta({ id, text })),
    LLMEvent.textEnd({ id }),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    LLMEvent.finish({ reason: "stop" }),
  ]
}

/** A fake catalog model record resolvable by the model cascade. */
export const catalogModel = (providerID: string, id: string): ModelV2.Info =>
  ModelV2.Info.make({
    id: ModelV2.ID.make(id),
    providerID: ProviderV2.ID.make(providerID),
    family: ModelV2.Family.make("fake"),
    name: id,
    api: { id: ModelV2.ID.make(id), type: "aisdk", package: "@ai-sdk/openai" },
    capabilities: { tools: false, input: ["text"], output: ["text"] },
    request: { headers: {}, body: {} },
    variants: [],
    time: { released: 0 },
    cost: [{ input: 1, output: 1 }],
    status: "active",
    enabled: true,
    limit: { context: 10_000, output: 1_000 },
  })

export type Harness = {
  readonly it: ReturnType<typeof testEffect>
  /** Runner provider-turn requests, in order. */
  readonly requests: LLMRequest[]
  /** SessionTitle LLM requests, in order. */
  readonly titleRequests: LLMRequest[]
  /** Push the next provider-turn event list (drain). */
  readonly enqueueCompletion: (events: LLMEvent[]) => void
  /** Push the next title-generation response (must include a terminal finish). */
  readonly enqueueTitle: (events: LLMEvent[]) => void
  /** Fail the next title-generation call. */
  readonly failNextTitle: (error: LLMError) => void
  /** Set config entries (small_model / title_prompt) for the current test. */
  readonly setConfig: (patch: Partial<Record<"small_model" | "title_prompt", string>>) => void
  /** Register a catalog model reachable via model.get(providerID, id). */
  readonly addCatalogModel: (model: ModelV2.Info) => void
  /** Register a catalog small-model choice for one provider. */
  readonly setCatalogSmall: (providerID: string, model: ModelV2.Info) => void
  /** Override the session-model cascade fallback model. */
  readonly setSessionModel: (model: Model) => void
  /** Gate the next provider stream until released (mid-drain pause/stop tests). */
  readonly setStreamGate: (gate: Deferred.Deferred<void>) => void
  /** Signal when the gated provider stream has started. */
  readonly setStreamStarted: (started: Deferred.Deferred<void>) => void
  /** Clear closure state shared across tests (DB is fresh per test, this is not). */
  readonly reset: () => void
}

export const makeHarness = (): Harness => {
  const requests: LLMRequest[] = []
  const titleRequests: LLMRequest[] = []
  const completions: LLMEvent[][] = []
  let titleQueue: Array<Effect.Effect<LLMResponse, LLMError>> = []
  let currentSessionModel = sessionModel
  const configEntries: Config.Entry[] = [
    new Config.Document({
      type: "document",
      info: new Config.Info({
        compaction: new ConfigCompaction.Info({ buffer: 3_000, keep: new ConfigCompaction.Keep({ tokens: 1_000 }) }),
      }),
    }),
  ]
  const catalogModels = new Map<string, ModelV2.Info>()
  const catalogSmall = new Map<string, ModelV2.Info>()
  let streamGate: Deferred.Deferred<void> | undefined
  let streamStarted: Deferred.Deferred<void> | undefined

  const client = Layer.succeed(
    LLMClient.Service,
    LLMClient.Service.of({
      prepare: () => Effect.die("unused"),
      stream: (request: LLMRequest) => {
        requests.push(request)
        const events = completions.shift()
        const items = events === undefined ? textCompletion(["Default response"]) : events
        if (!streamGate) return Stream.fromIterable(items)
        return Stream.unwrap(
          (streamStarted ? Deferred.succeed(streamStarted, undefined) : Effect.void).pipe(
            Effect.andThen(Deferred.await(streamGate)),
            Effect.as(items),
          ),
        )
      },
      generate: (request: LLMRequest) => {
        titleRequests.push(request)
        const next = titleQueue.shift()
        return next === undefined ? Effect.succeed(LLMResponse.fromEvents(textCompletion(["Auto"]))!) : next
      },
    }),
  )

  const permission = Layer.succeed(
    PermissionV2.Service,
    PermissionV2.Service.of({
      assert: () => Effect.die("unused"),
      ask: () => Effect.die("unused"),
      reply: () => Effect.die("unused"),
      get: () => Effect.die("unused"),
      forSession: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
    }),
  )

  const models = SessionRunnerModel.layerWith(() => Effect.succeed(currentSessionModel))

  const systemContext = Layer.mock(SystemContextRegistry.Service, {
    register: () => Effect.void,
    load: () => Effect.succeed(SystemContext.empty),
  })
  const skillGuidance = Layer.mock(SkillGuidance.Service, {
    load: () => Effect.succeed(SystemContext.empty),
  })
  const referenceGuidance = Layer.mock(ReferenceGuidance.Service, {
    load: () => Effect.succeed(SystemContext.empty),
  })

  const config = Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () => Effect.succeed(configEntries),
    }),
  )

  const catalog = Layer.succeed(
    Catalog.Service,
    Catalog.Service.of({
      transform: () => Effect.void,
      reload: () => Effect.void,
      provider: {
        get: () => Effect.succeed(undefined),
        all: () => Effect.succeed([]),
        available: () => Effect.succeed([]),
      },
      model: {
        get: (providerID, id) => Effect.succeed(catalogModels.get(`${providerID}/${id}`)),
        all: () => Effect.succeed([...catalogModels.values()]),
        available: () => Effect.succeed([...catalogModels.values()]),
        default: () => Effect.succeed(undefined),
        small: (providerID) => Effect.succeed(catalogSmall.get(providerID)),
      },
    }),
  )

  const integration = Layer.succeed(
    Integration.Service,
    Integration.Service.of({
      transform: () => Effect.void,
      reload: () => Effect.void,
      get: () => Effect.succeed(undefined),
      list: () => Effect.succeed([]),
      connection: {
        active: () => Effect.succeed(undefined),
        resolve: () => Effect.succeed(undefined),
        key: () => Effect.void,
        oauth: () => Effect.die("unused"),
        update: () => Effect.void,
        select: () => Effect.void,
        remove: () => Effect.void,
      },
      attempt: {
        status: () => Effect.die("unused"),
        complete: () => Effect.die("unused"),
        cancel: () => Effect.void,
      },
    }),
  )

  const sharedReplacements = [
    [LayerNodePlatform.llmClient, client],
    [SessionRunnerModel.node, models],
    [SystemContextRegistry.node, systemContext],
    [SkillGuidance.node, skillGuidance],
    [ReferenceGuidance.node, referenceGuidance],
    [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
    [PermissionV2.node, permission],
    [Config.node, config],
    [Catalog.node, catalog],
    [Integration.node, integration],
  ] satisfies LayerNode.Replacements

  const titleLayer = AppNodeBuilder.build(SessionTitle.node, sharedReplacements)
  const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
    [Snapshot.node, Snapshot.noopLayer],
    ...sharedReplacements,
    [SessionTitle.node, titleLayer],
  ])
  const execution = Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const sessionRunner = yield* SessionRunner.Service
      const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError>({
        drain: (sessionID, force) => sessionRunner.run({ sessionID, force }),
      })
      return SessionExecution.Service.of({
        active: coordinator.active,
        resume: coordinator.run,
        wake: coordinator.wake,
        interrupt: coordinator.interrupt,
      })
    }),
  ).pipe(Layer.provide(runnerLayer))

  const layer = AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      QuestionV2.node,
      SessionProjector.node,
      SessionStore.node,
      ApplicationTools.node,
      AgentV2.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      SessionRunnerModel.node,
      SystemContextRegistry.node,
      SkillGuidance.node,
      ReferenceGuidance.node,
      Config.node,
      Snapshot.node,
      Catalog.node,
      Integration.node,
      SessionRunnerLLM.node,
      SessionExecution.node,
      SessionTitle.node,
      SessionV2.node,
    ]),
    [
      [Snapshot.node, Snapshot.noopLayer],
      ...sharedReplacements,
      [SessionExecution.node, execution],
      [SessionTitle.node, titleLayer],
    ],
  )

  return {
    it: testEffect(layer),
    requests,
    titleRequests,
    enqueueCompletion: (events) => completions.push(events),
    enqueueTitle: (events) => titleQueue.push(Effect.succeed(LLMResponse.fromEvents(events)!)),
    failNextTitle: (error) => titleQueue.push(Effect.fail(error)),
    setConfig: (patch) => {
      for (const entry of configEntries) {
        if (entry.type !== "document") continue
        for (const [key, value] of Object.entries(patch)) {
          ;(entry.info as Record<string, string | undefined>)[key] = value
        }
      }
    },
    addCatalogModel: (model) => catalogModels.set(`${model.providerID}/${model.id}`, model),
    setCatalogSmall: (providerID, model) => catalogSmall.set(providerID, model),
    setSessionModel: (model) => {
      currentSessionModel = model
    },
    setStreamGate: (gate) => {
      streamGate = gate
    },
    setStreamStarted: (started) => {
      streamStarted = started
    },
    reset: () => {
      requests.length = 0
      titleRequests.length = 0
      completions.length = 0
      titleQueue = []
      streamGate = undefined
      streamStarted = undefined
      currentSessionModel = sessionModel
      catalogModels.clear()
      catalogSmall.clear()
      for (const entry of configEntries) {
        if (entry.type !== "document") continue
        delete entry.info.small_model
        delete entry.info.title_prompt
      }
    },
  }
}

export const insertSession = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: `New session - ${new Date(0).toISOString()}`,
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

export const setTitle = (id: SessionV2.ID, title: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(SessionTable)
      .set({ title })
      .where(eq(SessionTable.id, id))
      .run()
      .pipe(Effect.orDie)
  })
