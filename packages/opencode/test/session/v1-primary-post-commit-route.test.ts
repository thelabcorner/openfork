import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { eq } from "drizzle-orm"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Database } from "@opencode-ai/core/database/database"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderRoute } from "@opencode-ai/core/provider-route"
import { OpencodeProviderRoute } from "@opencode-ai/core/plugin/provider/opencode-provider-route"
import { SessionMetadataOwnership } from "@opencode-ai/core/session/metadata-ownership"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import { UsageRecordTable } from "@opencode-ai/core/usage/sql"
import { Provider } from "@/provider/provider"
import { Plugin } from "@/plugin"
import { MCP } from "@/mcp"
import { LSP } from "@/lsp/lsp"
import { Env } from "@/env"
import { Agent as AgentSvc } from "@/agent/agent"
import { Command } from "@/command"
import { Permission } from "@/permission"
import { Config } from "@/config/config"
import { Question } from "@/question"
import { Todo } from "@/session/todo"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionProcessor } from "@/session/processor"
import { SessionPrompt } from "@/session/prompt"
import { SessionCompaction } from "@/session/compaction"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Instruction } from "@/session/instruction"
import { SystemPrompt } from "@/session/system"
import { LLM } from "@/session/llm"
import { Image } from "@/image/image"
import { Snapshot } from "@/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { ToolInterrupt } from "@/tool/interrupt"
import { Truncate } from "@/tool/truncate"
import { Skill } from "@/skill"
import { Git } from "@/git"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "@/format"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Goal } from "@opencode-ai/core/goal"
import { GoalContext } from "@opencode-ai/core/goal/context"
import { GoalAutomation } from "@opencode-ai/core/goal/automation"
import { resetZenPoolForTest, setTestZenFetch, setTestZenVaultCredentials } from "@/plugin/zen"
import { stableZenIdentity } from "@/plugin/zen-accounts"
import { testEffect } from "../lib/effect"

/**
 * V1 PRIMARY post-commit route immutability — the one D4 leg no existing test covers.
 *
 * WHY THIS FILE EXISTS
 * `test/provider/post-commit-route-immutability.test.ts` documents its own limit at
 * :38-49: it is "NOT V1 primary orchestration" and does "NOT enter
 * `session/prompt.ts` -> `SessionProcessor` -> `LLM.Service`", and it asserts route
 * PERSISTENCE (`ProviderRoute`) rather than V1 usage settlement. A9 independently
 * recorded (ledger 4827) that no D4 test file existed. So "an explicit hard-pinned
 * non-default account survives the REAL V1 primary dispatch to the exact wire byte,
 * with a real route-attributed `usage_record` settlement, and cannot be moved by
 * post-commit ambient mutation" was unproven.
 *
 * WHAT IS PRODUCTION HERE (nothing is faked below the catalog)
 * - `promptRoot` is cloned read-only from `test/session/prompt.test.ts:259-301`, which
 *   already contains the REAL `Provider.Service`, REAL `SessionProcessor`, and REAL
 *   `LLM.Service`. Nothing is replaced except four inert collaborators
 *   (summary / lsp / mcp / runtimeFlags), exactly as `prompt.test.ts` does.
 * - Route intent is injected through the PUBLIC delegated-metadata seam already
 *   proven at `prompt.test.ts:751-804`, which production reads at
 *   `prompt.ts:3207-3208` (workerDelegation.model.routeIntent).
 * - The physical path is entirely production:
 *   `prompt.ts:3214` commit -> `prompt.ts:3397-3399` processor.create(routeAttribution,
 *   routeLease) -> `processor.ts:1095-1098` llm.stream(route) -> `llm.ts:118` auth
 *   suppression -> `request.ts:203-243` hosted identity -> `provider.ts:3545`
 *   committedZenProviderFetch -> `zen.ts:578` `testFetch ?? fetch`.
 * - Only two things are stubbed, both sanctioned by A3/A8: the `models.opencode.ai`
 *   catalog HTTP call, and the byte exit itself via `setTestZenFetch`.
 *
 * POST-COMMIT BARRIER (no production hook required)
 * There is no public pause between commit (`prompt.ts:3214`) and dispatch. The byte-exit
 * stub IS the barrier: `committedZenProviderFetch` has already snapshotted the committed
 * bearer and is calling `testFetch`, so mutating ambient authority inside the first
 * physical (non-`/models`) handler provably occurs AFTER route commitment and BEFORE any
 * byte leaves. Ordering is safe for BOTH dispatches because the title fork at
 * `prompt.ts:3254-3263` runs after the primary commit at `:3214`.
 *
 * THIS IS NOT A SUBSTITUTE FOR
 * - A3 `test/provider/console-account-execution.test.ts:856` (static env, direct provider)
 * - A3 `test/provider/post-commit-route-immutability.test.ts` (direct provider, ProviderRoute)
 * - A4 `test/system-one/system-one-real-resolver.test.ts` (System One)
 * - A9 `test/session/llm-route-auth-suppression.test.ts` (rejected as D4 evidence: it
 *   injects `route` onto `streamInput` and uses `ProviderTest.fake`, so no real resolver)
 */

const KEY_A = "v1primary-key-a-original-default"
const KEY_B = "v1primary-key-b-hard-pinned"
const KEY_C = "v1primary-key-c-post-commit-default"
const POST_COMMIT_ENV_SECRET = "v1primary-post-commit-env-secret-must-never-reach-wire"

const ZEN_ENV_KEYS = [
  "OPENCODE_API_KEY",
  "OPENCODE_API_KEYS",
  ...Array.from({ length: 9 }, (_, index) => `OPENCODE_API_KEY_${index + 2}`),
]

const hostedProviderID = ProviderV2.ID.make("opencode")
const hostedModelID = ModelV2.ID.make("big-pickle")

// Inert collaborators, cloned from prompt.test.ts so the production graph resolves.
const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    exactTools: () => Effect.succeed([]),
    invokeTool: () => Effect.die("unexpected MCP tool invocation"),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })

// prompt.test.ts:259-301, cloned read-only. REAL Provider / SessionProcessor / LLM.
const promptRoot = LayerNode.group([
  SessionPrompt.node,
  Goal.node,
  GoalContext.node,
  GoalAutomation.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  Provider.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  ToolInterrupt.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  ProviderRoute.node,
])

// Catalog-only stub, identical in shape to post-commit-route-immutability.test.ts:76-95.
const catalogClient = HttpClient.make((request) =>
  Effect.sync(() => {
    if (request.url.startsWith("https://models.opencode.ai/models.json")) {
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ models: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    }
    return HttpClientResponse.fromWeb(
      request,
      new Response(JSON.stringify({ error: "not stubbed" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    )
  }),
)

const layer = LayerNode.compile(promptRoot, [
  [httpClient, Layer.succeed(HttpClient.HttpClient, catalogClient)],
  [SessionSummary.node, summary],
  [LSP.node, lsp],
  [MCP.node, mcp],
  [RuntimeFlags.node, runtimeFlags],
])

const it = testEffect(layer)

type Wire = {
  authorization: string | null
  body: Record<string, unknown>
  model: string | undefined
  isTitle: boolean
  isSpad: boolean
}

/**
 * Title (`prompt.ts:3254-3263`) and SPAD Auditor (`prompt.ts:3529-3543`) are forked
 * same-Session maintenance dispatches that ALSO cross `llm.stream` on the SAME
 * committed route. They are additional physical POSTs, so this file never asserts a
 * total request count; it partitions by tool surface instead.
 */
const toolNamesOf = (body: Record<string, unknown>) => {
  const tools = body.tools
  if (!Array.isArray(tools)) return [] as string[]
  return tools.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return []
    const item = entry as { name?: unknown; function?: { name?: unknown } }
    const name = typeof item.name === "string" ? item.name : item.function?.name
    return typeof name === "string" ? [name] : []
  })
}

/**
 * The real V1 path enters `LLM.Service.stream` -> AI-SDK `streamText`, so the hosted
 * OpenAI-compatible inference boundary must answer with SSE, not a one-shot
 * `chat.completion` JSON. Shape copied from the proven
 * `test/session/llm-route-auth-suppression.test.ts:27-36`.
 */
const sse = (content: string) =>
  [
    `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 0, model: "big-pickle", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}`,
    "",
    `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 0, model: "big-pickle", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n")

/**
 * Install the hosted compat pool and the byte-exit barrier.
 *
 * `mutateAmbient` runs inside the FIRST physical (non-`/models`) handler invocation,
 * i.e. after `prompt.ts:3214` committed the route and after
 * `committedZenProviderFetch` snapshotted the bearer, but before any byte leaves.
 */
const installPoolAndBarrier = (
  requests: Wire[],
  mutateAmbient: () => void,
  options: { readonly mutateOnFirstCallOnly?: boolean } = {},
) =>
  Effect.gen(function* () {
    const savedEnv = ZEN_ENV_KEYS.map((name) => [name, process.env[name]] as const)
    for (const name of ZEN_ENV_KEYS) delete process.env[name]
    resetZenPoolForTest()
    setTestZenVaultCredentials([
      { apiKey: KEY_A, label: "Original default", isDefault: true },
      { apiKey: KEY_B, label: "Hard pinned", isDefault: false },
    ])
    let mutated = false
    setTestZenFetch(async (input, init) => {
      const url = String(input)
      if (url.endsWith("/models")) {
        return new Response(
          JSON.stringify({
            object: "list",
            data: [{ id: "big-pickle", object: "model", owned_by: "opencode" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (!mutated) {
        mutated = true
        mutateAmbient()
      } else if (options.mutateOnFirstCallOnly === false) {
        mutateAmbient()
      }
      const request = new Request(input, init)
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const names = toolNamesOf(body)
      requests.push({
        authorization: request.headers.get("authorization"),
        body,
        model: typeof body.model === "string" ? body.model : undefined,
        isTitle: names.includes("generated_title"),
        isSpad: names.includes("spad_verdict"),
      })
      return new Response(sse("PRIMARY_OK"), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        setTestZenFetch(undefined)
        setTestZenVaultCredentials(undefined)
        resetZenPoolForTest()
        for (const [name, value] of savedEnv) {
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        }
      }),
    )
  })

/** Replace/reorder the pool so a NEW key C is default and B is not; add a live env secret. */
const mutateAmbientAuthority = () => {
  setTestZenVaultCredentials([
    { apiKey: KEY_B, label: "Hard pinned", isDefault: false },
    { apiKey: KEY_C, label: "NEW default after commit", isDefault: true },
    { apiKey: KEY_A, label: "Original default", isDefault: false },
  ])
  process.env.OPENCODE_API_KEY = POST_COMMIT_ENV_SECRET
}

const hardPinnedOrigin = (accountID: string) =>
  ({
    producer: "oxp",
    principalRef: "oxp:v1-primary-route-proof",
    invocationRef: "oxp-inv:v1-primary-route-proof",
    rootRef: "root-v1-primary-route-proof",
    agent: "build",
    model: {
      providerID: String(hostedProviderID),
      modelID: String(hostedModelID),
      routeIntent: { kind: "account" as const, accountID, pin: "hard" as const },
    },
    nestedDelegation: false,
  }) as const

const accountA = stableZenIdentity(KEY_A)
const accountB = stableZenIdentity(KEY_B)
const accountC = stableZenIdentity(KEY_C)

it.instance(
  "V1 primary dispatch sends the hard-pinned non-default account B to the physical wire and settles usage_record to B",
  () =>
    Effect.gen(function* () {
      const requests: Wire[] = []
      yield* installPoolAndBarrier(requests, mutateAmbientAuthority)

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const origin = hardPinnedOrigin(accountB)
      const chat = yield* sessions.create({
        title: "V1 primary route proof",
        metadata: SessionMetadataOwnership.delegatedWorker(origin),
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.hostPrompt(
        {
          sessionID: chat.id,
          noReply: true,
          agent: "build",
          model: { providerID: hostedProviderID, modelID: hostedModelID },
          parts: [{ type: "text", text: "Reply with exactly PRIMARY_OK" }],
        },
        {
          source: SessionTurnProvenance.Source.OxpDelegation,
          ref: origin.invocationRef,
          principalRef: origin.principalRef,
        },
      )

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      // The assistant turn the primary settlement must be keyed to.
      const primaryMessageID = result.info.id

      // ---- PHYSICAL WIRE ASSERTIONS (the last outbound boundary) ----
      // Title/SPAD are additional same-route maintenance POSTs, so partition rather
      // than assert a total count; identity is proven for EVERY dispatch.
      expect(requests.length).toBeGreaterThan(0)
      for (const request of requests) {
        expect(request.authorization).toBe(`Bearer ${KEY_B}`)
      }
      const serialized = JSON.stringify(requests)
      expect(serialized).not.toContain(KEY_A)
      expect(serialized).not.toContain(KEY_C)
      expect(serialized).not.toContain(POST_COMMIT_ENV_SECRET)
      expect(serialized).not.toContain(accountA)
      expect(serialized).not.toContain(accountC)

      // The PRIMARY turn is the non-title, non-SPAD dispatch and must be present.
      const primary = requests.filter((request) => !request.isTitle && !request.isSpad)
      expect(primary.length).toBeGreaterThan(0)
      expect(primary[0]!.authorization).toBe(`Bearer ${KEY_B}`)
      expect(primary[0]!.model).toBe("big-pickle")

      // ---- REAL PRIMARY SETTLEMENT ASSERTION (UsageRecordTable) ----
      // Correlate on the assistant turn this loop actually produced, so the assertion
      // is about the PRIMARY settlement rather than every row the session may hold.
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const assistantIDs = new Set(
        messages.filter((message) => message.info.role === "assistant").map((message) => message.info.id),
      )
      expect(assistantIDs.size).toBeGreaterThan(0)
      expect([...assistantIDs]).toContain(primaryMessageID)

      // Read through the WRITER connection: `readDb` is a separate `query_only`
      // reader (database.ts:96-105) and is not guaranteed to observe the row this
      // same effect just committed.
      const { db } = yield* Database.Service
      const rows = yield* db
        .select({
          messageID: UsageRecordTable.message_id,
          sessionID: UsageRecordTable.session_id,
          routeKind: UsageRecordTable.route_kind,
          accountID: UsageRecordTable.account_id,
          providerID: UsageRecordTable.provider_id,
          modelID: UsageRecordTable.model_id,
        })
        .from(UsageRecordTable)
        .where(eq(UsageRecordTable.session_id, chat.id))
        .all()
        .pipe(Effect.orDie)

      const settled = rows.filter((row) => assistantIDs.has(row.messageID as never))
      expect(settled.length).toBeGreaterThan(0)
      const primaryRow = settled[0]!
      expect({
        routeKind: primaryRow.routeKind,
        accountID: primaryRow.accountID,
        providerID: primaryRow.providerID,
        modelID: primaryRow.modelID,
      }).toEqual({
        routeKind: "account",
        accountID: accountB,
        providerID: "opencode",
        modelID: "big-pickle",
      })
      // Secret-free settlement: no credential handle, revision, or key material.
      expect(JSON.stringify(primaryRow)).not.toContain("credentialHandle")
      expect(JSON.stringify(primaryRow)).not.toContain("credentialRevision")
      expect(JSON.stringify(primaryRow)).not.toContain(KEY_A)
      expect(JSON.stringify(primaryRow)).not.toContain(KEY_B)
      expect(JSON.stringify(primaryRow)).not.toContain(KEY_C)
      expect(JSON.stringify(primaryRow)).not.toContain("zen-compat:")

      // ---- SECONDARY: durable route persistence is unchanged by the mutation ----
      const persisted = yield* (yield* ProviderRoute.Service).get(
        SessionSchema.ID.make(chat.id),
        OpencodeProviderRoute.affinityDomain(hostedProviderID),
      )
      expect(persisted?.routeKind).toBe("account")
      expect(persisted?.routeKind === "account" ? persisted.accountID : undefined).toBe(accountB)
    }),
  { timeout: 60_000 },
)

it.instance(
  "V1 primary dispatch re-resolves the same durable B binding after post-commit pool and env mutation",
  () =>
    Effect.gen(function* () {
      const requests: Wire[] = []
      yield* installPoolAndBarrier(requests, mutateAmbientAuthority, { mutateOnFirstCallOnly: false })

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const provider = yield* Provider.Service
      const origin = hardPinnedOrigin(accountB)
      const chat = yield* sessions.create({
        title: "V1 primary route rebind proof",
        metadata: SessionMetadataOwnership.delegatedWorker(origin),
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.hostPrompt(
        {
          sessionID: chat.id,
          noReply: true,
          agent: "build",
          model: { providerID: hostedProviderID, modelID: hostedModelID },
          parts: [{ type: "text", text: "Reply with exactly PRIMARY_OK" }],
        },
        {
          source: SessionTurnProvenance.Source.OxpDelegation,
          ref: origin.invocationRef,
          principalRef: origin.principalRef,
        },
      )
      yield* prompt.loop({ sessionID: chat.id })

      // Ambient authority is now fully mutated: C is the pool default and a live
      // OPENCODE_API_KEY exists. A fresh V1-shaped resolution for the same Session must
      // still observe the DURABLE binding, never the mutated default.
      const reResolved = yield* provider.resolveRoutedModel({
        sessionID: SessionSchema.ID.make(chat.id),
        providerID: hostedProviderID,
        modelID: hostedModelID,
      })
      expect(reResolved).toBeDefined()
      if (!reResolved) return
      expect(reResolved.route.attribution.routeKind).toBe("account")
      expect(reResolved.route.attribution.accountID).toBe(accountB)
      expect(reResolved.route.attribution.accountID).not.toBe(accountC)
      expect(reResolved.route.lease.route.kind).toBe("account")
      if (reResolved.route.lease.route.kind === "account") {
        expect(reResolved.route.lease.route.accountID).toBe(accountB)
      }
      expect(JSON.stringify(reResolved.route.attribution)).not.toContain("credentialHandle")
      expect(JSON.stringify(reResolved.route.attribution)).not.toContain("credentialRevision")
      expect(JSON.stringify(reResolved.route.attribution)).not.toContain(KEY_B)

      // Every physical dispatch in the whole run stayed on B.
      expect(requests.length).toBeGreaterThan(0)
      for (const request of requests) expect(request.authorization).toBe(`Bearer ${KEY_B}`)
      expect(JSON.stringify(requests)).not.toContain(KEY_C)
      expect(JSON.stringify(requests)).not.toContain(POST_COMMIT_ENV_SECRET)
    }),
  { timeout: 60_000 },
)
