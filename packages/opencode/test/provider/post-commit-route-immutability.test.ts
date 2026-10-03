import { expect } from "bun:test"
import { generateText } from "ai"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ProviderRoute } from "@opencode-ai/core/provider-route"
import { ProviderRouteHealth } from "@opencode-ai/core/provider-route-health"
import { OpencodeProviderRoute } from "@opencode-ai/core/plugin/provider/opencode-provider-route"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ProviderRouteIntent } from "@opencode-ai/schema/model-select/provider-route-intent"
import { Provider } from "@/provider/provider"
import {
  resetZenPoolForTest,
  setTestZenFetch,
  setTestZenVaultCredentials,
} from "@/plugin/zen"
import { stableZenIdentity } from "@/plugin/zen-accounts"
import { testEffect } from "../lib/effect"

/**
 * WHAT THIS PROVES (and precisely what it does not).
 *
 * PROVEN: after a route is COMMITTED, mutating ambient authority - re-priming the Zen
 * pool so a NEW key becomes the default, and setting a live `OPENCODE_API_KEY` - cannot
 * change the credential that reaches the physical wire. A hard pin to a NON-DEFAULT
 * account keeps its exact bearer, the new pool default never appears, the post-commit
 * env secret never appears, a later re-resolution still returns the pinned account, and
 * the durable `ProviderRoute` row is unchanged after dispatch.
 *
 * NOT PROVEN - do not read this file as any of the following:
 *  - NOT V1 primary orchestration. This enters `Provider.Service.resolveRoutedModel`
 *    directly and then `provider.getLanguage(...)` + the real AI-SDK `generateText`.
 *    It does NOT enter `session/prompt.ts` -> `SessionProcessor` -> `LLM.Service`.
 *  - NOT `usage_record` / maintenance settlement. The durable assertion here is the
 *    `ProviderRoute` row, which is route PERSISTENCE. V1 settlement attribution is
 *    written by `SessionProcessor` through `UsageRecord.Service`
 *    (`src/session/processor.ts:156-173`) and is not reached by this file.
 *  - NOT a substitute for A3's `console-account-execution.test.ts:856` (static
 *    environment, non-default hard pin at the physical wire) or A4's
 *    `system-one-real-resolver.test.ts` (System One real-resolver transient transport).
 *    This file is the post-commit-mutation delta those two do not cover.
 *
 * Only catalog data (hosted `/models` advertisement) and the last byte-exit boundary are
 * stubbed. Authorization is entirely production: real `Provider.Service`, real
 * `OpencodeProviderRoute` resolution, real Zen/Go compat inventory and
 * `resolveZenCompatExecution` materialization, and the real `setTestZenFetch`
 * (`testFetch ?? fetch`) seam inside `committedZenProviderFetch`. Assertions are on the
 * physical request and durable state - never on a pre-SDK request object.
 */

const COMPAT_KEY_A = "postcommit-key-a-original-default"
const COMPAT_KEY_B = "postcommit-key-b-hard-pinned"
const COMPAT_KEY_C = "postcommit-key-c-new-default"
const POST_COMMIT_ENV_SECRET = "post-commit-env-secret-must-never-reach-wire"

const ZEN_ENV_KEYS = [
  "OPENCODE_API_KEY",
  "OPENCODE_API_KEYS",
  ...Array.from({ length: 9 }, (_, index) => `OPENCODE_API_KEY_${index + 2}`),
]

const hostedProviderID = ProviderV2.ID.make("opencode")
const hostedModelID = ModelV2.ID.make("big-pickle")

// The hosted catalog witness is the only network-shaped input Public eligibility
// depends on. It advertises the model as hosted so the compat account path and the
// hosted `/models` boundary are both deterministic.
const client = HttpClient.make((request) =>
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

const layer = LayerNode.compile(
  LayerNode.group([
    Provider.node,
    ProviderRoute.node,
    ProviderRouteHealth.node,
    Database.node,
  ]),
  [[httpClient, Layer.succeed(HttpClient.HttpClient, client)]],
)
const it = testEffect(layer)

const projectID = ProjectV2.ID.global
const projectDirectory = AbsolutePath.make("/openfork-post-commit-route-test")
const sessionDirectory = AbsolutePath.make("/openfork-post-commit-route-test/workspace")

const seedRouteSession = (sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: projectID, worktree: projectDirectory, sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: projectID,
        slug: sessionID,
        directory: sessionDirectory,
        title: "Post-commit route immutability test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

type Wire = { authorization: string | null; body: Record<string, unknown> }

const installWireAndPool = (requests: Wire[]) =>
  Effect.gen(function* () {
    const savedEnv = ZEN_ENV_KEYS.map((name) => [name, process.env[name]] as const)
    for (const name of ZEN_ENV_KEYS) delete process.env[name]
    resetZenPoolForTest()
    setTestZenVaultCredentials([
      { apiKey: COMPAT_KEY_A, label: "Original default", isDefault: true },
      { apiKey: COMPAT_KEY_B, label: "Hard pinned", isDefault: false },
    ])
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
      const request = new Request(input, init)
      const body = (await request.json()) as Record<string, unknown>
      requests.push({ authorization: request.headers.get("authorization"), body })
      return new Response(
        JSON.stringify({
          id: "chatcmpl-post-commit",
          object: "chat.completion",
          created: 0,
          model: "big-pickle",
          choices: [
            { index: 0, message: { role: "assistant", content: "ROUTE_OK" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
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

/**
 * Negative-invariant guard: if the physical assertion below were vacuous, replacing
 * the expected bearer with the ORIGINAL pool default must turn this file red. The
 * mutation is intentionally NOT applied in the shipped file; it was executed once to
 * confirm the assertion discriminates, then reverted.
 */
it.instance(
  "a committed non-default hard pin keeps its exact wire credential after the pool default and env are mutated post-commit",
  Effect.gen(function* () {
    const requests: Wire[] = []
    yield* installWireAndPool(requests)

    const provider = yield* Provider.Service
    const accountB = stableZenIdentity(COMPAT_KEY_B)
    const sessionID = SessionSchema.ID.make("ses_post_commit_route_immutability")
    yield* seedRouteSession(sessionID)

    // --- Commit the route BEFORE any ambient mutation. ---
    const routed = yield* provider.resolveRoutedModel({
      sessionID,
      providerID: hostedProviderID,
      modelID: hostedModelID,
      routeIntent: ProviderRouteIntent.Info.make({
        kind: "account",
        accountID: accountB,
        pin: "hard",
      }),
    })
    if (!routed) throw new Error("expected a committed compat account route")

    const lease = routed.route.lease.route
    expect(lease.kind).toBe("account")
    expect(lease.kind === "account" && lease.accountID).toBe(accountB)
    expect(lease.kind === "account" && lease.credentialHandle).toBe(`zen-compat:${accountB}`)
    expect(routed.route.attribution.routeKind).toBe("account")
    expect(routed.route.attribution.accountID).toBe(accountB)

    // --- MUTATE AMBIENT AUTHORITY AFTER COMMITMENT, BEFORE DISPATCH. ---
    // A new key C becomes the pool default and B is no longer default, and a live
    // OPENCODE_API_KEY env secret appears. None of these may reach the wire.
    setTestZenVaultCredentials([
      { apiKey: COMPAT_KEY_A, label: "Original default", isDefault: false },
      { apiKey: COMPAT_KEY_B, label: "Hard pinned", isDefault: false },
      { apiKey: COMPAT_KEY_C, label: "NEW default after commit", isDefault: true },
    ])
    process.env.OPENCODE_API_KEY = POST_COMMIT_ENV_SECRET

    // --- Physical dispatch through the real provider + real AI-SDK call. ---
    const language = yield* provider.getLanguage(routed.model)
    const result = yield* Effect.promise(() =>
      generateText({ model: language, prompt: "Reply with exactly ROUTE_OK", maxRetries: 0 }),
    )
    expect(result.text).toBe("ROUTE_OK")

    // --- Assertions at the PHYSICAL boundary. ---
    expect(requests).toHaveLength(1)
    expect(requests[0]!.authorization).toBe(`Bearer ${COMPAT_KEY_B}`)
    expect(requests[0]!.authorization).not.toBe(`Bearer ${COMPAT_KEY_A}`)
    expect(requests[0]!.authorization).not.toBe(`Bearer ${COMPAT_KEY_C}`)
    expect(requests[0]!.authorization).not.toContain(POST_COMMIT_ENV_SECRET)
    expect(requests[0]!.body.model).toBe("big-pickle")
    const serializedWire = JSON.stringify(requests)
    expect(serializedWire).not.toContain(COMPAT_KEY_A)
    expect(serializedWire).not.toContain(COMPAT_KEY_C)
    expect(serializedWire).not.toContain(POST_COMMIT_ENV_SECRET)

    // --- Assertion at DURABLE SETTLEMENT: the committed row is unchanged. ---
    const persisted = yield* (yield* ProviderRoute.Service).get(
      sessionID,
      OpencodeProviderRoute.affinityDomain(hostedProviderID),
    )
    expect(persisted?.routeKind).toBe("account")
    expect(persisted?.routeKind === "account" ? persisted.accountID : undefined).toBe(accountB)
  }),
  { timeout: 30_000 },
)

/**
 * The durable binding - not ambient re-selection - is what a later V1 primary
 * dispatch observes. After the same post-commit mutation, a fresh resolution for the
 * same Session must still return the hard-pinned account B and must not adopt the new
 * pool default C.
 */
it.instance(
  "a post-commit re-resolution still returns the hard-pinned account and never adopts the new pool default",
  Effect.gen(function* () {
    const requests: Wire[] = []
    yield* installWireAndPool(requests)

    const provider = yield* Provider.Service
    const accountB = stableZenIdentity(COMPAT_KEY_B)
    const accountC = stableZenIdentity(COMPAT_KEY_C)
    const sessionID = SessionSchema.ID.make("ses_post_commit_rebind_immutability")
    yield* seedRouteSession(sessionID)

    const first = yield* provider.resolveRoutedModel({
      sessionID,
      providerID: hostedProviderID,
      modelID: hostedModelID,
      routeIntent: ProviderRouteIntent.Info.make({
        kind: "account",
        accountID: accountB,
        pin: "hard",
      }),
    })
    if (!first) throw new Error("expected a committed compat account route")
    expect(first.route.lease.route.kind === "account" && first.route.lease.route.accountID).toBe(accountB)

    // Mutate ambient authority: C becomes the new pool default.
    setTestZenVaultCredentials([
      { apiKey: COMPAT_KEY_A, label: "Original default", isDefault: false },
      { apiKey: COMPAT_KEY_B, label: "Hard pinned", isDefault: false },
      { apiKey: COMPAT_KEY_C, label: "NEW default after commit", isDefault: true },
    ])

    // A later dispatch for the same Session re-resolves. It must observe the durable
    // binding, not the mutated pool default.
    const second = yield* provider.resolveRoutedModel({
      sessionID,
      providerID: hostedProviderID,
      modelID: hostedModelID,
    })
    if (!second) throw new Error("expected the durable account binding to re-resolve")
    const secondLease = second.route.lease.route
    expect(secondLease.kind).toBe("account")
    expect(secondLease.kind === "account" && secondLease.accountID).toBe(accountB)
    expect(secondLease.kind === "account" && secondLease.accountID).not.toBe(accountC)

    // And the physical dispatch for that re-resolved route is still account B.
    const language = yield* provider.getLanguage(second.model)
    yield* Effect.promise(() =>
      generateText({ model: language, prompt: "Reply with exactly ROUTE_OK", maxRetries: 0 }),
    )
    expect(requests).toHaveLength(1)
    expect(requests[0]!.authorization).toBe(`Bearer ${COMPAT_KEY_B}`)
    expect(requests[0]!.authorization).not.toBe(`Bearer ${COMPAT_KEY_C}`)
  }),
  { timeout: 30_000 },
)
