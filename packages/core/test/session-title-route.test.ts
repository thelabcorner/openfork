import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Model } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTitle } from "@opencode-ai/core/session/title"
import { Database } from "@opencode-ai/core/database/database"
import { MaintenanceUsageTable } from "@opencode-ai/core/usage/sql"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { providerRequestHeaders } from "@opencode-ai/core/session/runner/provider-request-headers"
import { OpenCodeHostedUserAgent } from "@opencode-ai/core/installation/version"
import { catalogModel, generatedTitleCompletion, insertSession, insertUserMessage, makeHarness } from "./lib/session-harness"

/**
 * Core Title route/wire/settlement proof.
 *
 * One committed route decision must reach the physical LLM client boundary and
 * the maintenance Usage settlement unchanged, with no credential handle,
 * revision, or token anywhere in ordinary attribution. These tests fail if
 * Title re-selects provider auth outside the route authority, if hosted request
 * identity is missing or malformed, or if settlement drifts from the selected
 * route.
 */

type Attribution = { readonly routeKind: "public" } | { readonly routeKind: "account"; readonly accountID: string }

/** An OpenCode-hosted model, so the hosted wire branch is the one exercised. */
const hostedModel = Model.make({ id: "space-bunny-free", provider: "opencode", route: OpenAIChat.route })

/** An explicit cross-provider candidate ref, optionally hard-pinned to an account. */
const otherRef = (accountID?: string) =>
  ModelV2.Ref.make({
    providerID: ProviderV2.ID.make("other"),
    id: ModelV2.ID.make("other-v1"),
    ...(accountID ? { accountID } : {}),
  })

/** Records every ref Title asks the route authority to resolve. */
const asked: string[] = []

/** Records the ref the route authority actually received, pins included. */
const askedRefs: (ModelV2.Ref | undefined)[] = []

/**
 * A route-authority seam that commits exactly one attribution. Title must route
 * every cascade candidate through `resolveWithInfo`; a direct `resolveRef` is a
 * defect, so it dies rather than silently serving an unrouted model.
 *
 * An account route deliberately carries a lease with credential material, so
 * the settlement assertions can prove it never leaks.
 */
const committed = (route?: Attribution, model = hostedModel) =>
  Layer.succeed(
    SessionRunnerModel.Service,
    SessionRunnerModel.Service.of({
      resolve: () => Effect.succeed(model),
      resolveRef: () => Effect.die("SessionTitle must not resolve an unrouted ref"),
      resolveWithInfo: (session) =>
        Effect.sync(() => {
          asked.push(session.model ? `${session.model.providerID}/${session.model.id}` : "<none>")
          askedRefs.push(session.model)
          return {
            model,
            name: String(model.id),
            ...(route ? { route } : {}),
            ...(route?.routeKind === "account"
              ? {
                  lease: {
                    route: {
                      kind: "account",
                      accountID: route.accountID,
                      credentialHandle: "cred_secret_handle",
                      credentialRevision: 7,
                    },
                  },
                }
              : {}),
          } as unknown as SessionRunnerModel.ResolvedInfo
        }),
    }),
  )

const maintenance = Effect.gen(function* () {
  const { readDb } = yield* Database.Service
  return yield* readDb
    .select()
    .from(MaintenanceUsageTable)
    .where(eq(MaintenanceUsageTable.agent, "session_title"))
    .all()
    .pipe(Effect.orDie)
})

const headers = (request: { readonly http?: { readonly headers?: Record<string, string> } } | undefined) =>
  request?.http?.headers ?? {}

const generate = (
  h: ReturnType<typeof makeHarness>,
  sessionID: SessionV2.ID,
  title: string,
  options?: {
    readonly model?: ModelV2.Ref
    /** Runs after `h.reset()`, so registered catalog state survives. */
    readonly prepare?: (h: ReturnType<typeof makeHarness>) => void
  },
) =>
  Effect.gen(function* () {
    h.reset()
    asked.length = 0
    askedRefs.length = 0
    options?.prepare?.(h)
    yield* insertSession(sessionID)
    yield* insertUserMessage(sessionID, "first message")
    h.enqueueTitle(generatedTitleCompletion(title))
    const service = yield* SessionTitle.Service
    const session = yield* SessionV2.Service
    yield* service.regenerate({
      session: yield* session.get(sessionID),
      ...(options?.model ? { model: options.model } : {}),
    })
    return { rows: yield* maintenance, request: h.titleRequests.at(-1) }
  })

describe("Core Title committed route reaches wire and settlement", () => {
  const h = makeHarness({
    sessionRunnerModel: committed({ routeKind: "account", accountID: "acct_stable_alpha" }),
  })
  const it = h.it.live
  const sessionID = SessionV2.ID.make("ses_title_route_account")

  it("settles the exact stable account, sends exact hosted identity, and leaks no credential material", () =>
    Effect.gen(function* () {
      const { rows, request } = yield* generate(h, sessionID, "Routed")

      // Settlement: exactly one maintenance row, attributed to the committed route.
      expect(rows.length).toBe(1)
      expect(rows[0]!.agent).toBe("session_title")
      expect(rows[0]!.route_kind).toBe("account")
      expect(rows[0]!.account_id).toBe("acct_stable_alpha")

      // Physical hosted request identity, proven at the LLM client boundary.
      const sent = headers(request)
      expect(sent["User-Agent"]).toBe(OpenCodeHostedUserAgent())
      expect(sent["x-opencode-project"]).toBe(rows[0]!.project_id!)
      expect(sent["x-opencode-session"]).toBe(sessionID)
      expect(sent["x-opencode-client"]).toBeDefined()
      expect(sent["x-opencode-request"]).toBeDefined()

      // The settled session is the session the request identified itself as.
      expect(sent["x-opencode-session"]).toBe(rows[0]!.session_id!)

      // A committed lease carries credential material; none of it may reach
      // ordinary attribution.
      const serialized = JSON.stringify(rows)
      expect(serialized).not.toContain("cred_secret_handle")
      expect(serialized).not.toContain("credentialHandle")
      expect(serialized).not.toContain("credentialRevision")
      expect(serialized).not.toContain("Bearer")
    }),
  )
})

describe("Core Title Public route stays account-free", () => {
  const h = makeHarness({ sessionRunnerModel: committed({ routeKind: "public" }) })
  const it = h.it.live
  const sessionID = SessionV2.ID.make("ses_title_route_public")

  it("settles public with no account while still sending hosted identity", () =>
    Effect.gen(function* () {
      const { rows, request } = yield* generate(h, sessionID, "Public")
      expect(rows.length).toBe(1)
      expect(rows[0]!.route_kind).toBe("public")
      expect(rows[0]!.account_id ?? null).toBeNull()
      expect(headers(request)["User-Agent"]).toBe(OpenCodeHostedUserAgent())
      expect(headers(request)["x-opencode-session"]).toBe(sessionID)
    }),
  )
})

describe("Core Title candidate policy routes every candidate through the authority", () => {
  const h = makeHarness({ sessionRunnerModel: committed({ routeKind: "public" }) })
  const it = h.it.live

  it("resolves an explicit cross-provider request model as its own provider-domain route", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_title_route_cross")
      // The explicit configured candidate must be a real catalog model, and it
      // belongs to a different provider domain than the hosted Session model.
      const { rows, request } = yield* generate(h, sessionID, "Cross", {
        model: otherRef(),
        prepare: (harness) => harness.addCatalogModel(catalogModel("other", "other-v1")),
      })
      // The explicit configured candidate was handed to the route authority
      // rather than being skipped or silently replaced by the Session model.
      expect(asked).toEqual(["other/other-v1"])
      expect(rows.length).toBe(1)
      expect(rows[0]!.route_kind).toBe("public")
      expect(headers(request)["x-opencode-session"]).toBe(sessionID)
    }),
  )

  it("falls back to the Session binding when no candidate is configured", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_title_route_fallback")
      const { rows } = yield* generate(h, sessionID, "Fallback")
      // No request model, no title-agent model, no small_model, no catalog small:
      // the final fallback inherits the Session's own provider-domain route.
      expect(asked).toEqual(["<none>"])
      expect(rows.length).toBe(1)
      expect(rows[0]!.route_kind).toBe("public")
    }),
  )
})

/**
 * Commits exactly the account the caller hard-pinned, and a visibly different
 * account when no pin was supplied. Reconstruction that drops `accountID`
 * therefore settles the wrong account instead of silently passing.
 */
const pinnedAccount = (model = hostedModel) =>
  Layer.succeed(
    SessionRunnerModel.Service,
    SessionRunnerModel.Service.of({
      resolve: () => Effect.succeed(model),
      resolveRef: () => Effect.die("SessionTitle must not resolve an unrouted ref"),
      resolveWithInfo: (session) =>
        Effect.sync(() => {
          const ref = session.model
          askedRefs.push(ref)
          const accountID = ref?.accountID ?? "acct_auto_selected"
          return {
            model,
            name: String(model.id),
            route: { routeKind: "account", accountID },
            lease: {
              route: {
                kind: "account",
                accountID,
                credentialHandle: "cred_secret_handle",
                credentialRevision: 7,
              },
            },
          } as unknown as SessionRunnerModel.ResolvedInfo
        }),
    }),
  )

describe("Core Title preserves an explicit accountID hard pin", () => {
  const h = makeHarness({ sessionRunnerModel: pinnedAccount() })
  const it = h.it.live
  const sessionID = SessionV2.ID.make("ses_title_route_pinned")

  it("keeps the pinned account through the authority, the wire, and settlement", () =>
    Effect.gen(function* () {
      const { rows, request } = yield* generate(h, sessionID, "Pinned", {
        model: otherRef("acct_hard_pinned"),
        prepare: (harness) => harness.addCatalogModel(catalogModel("other", "other-v1")),
      })

      // The hard pin reached the route authority instead of degrading to Auto.
      expect(askedRefs.length).toBe(1)
      expect(askedRefs[0]?.providerID).toBe(otherRef().providerID)
      expect(askedRefs[0]?.id).toBe(otherRef().id)
      expect(askedRefs[0]?.accountID).toBe("acct_hard_pinned")
      // ...and settlement committed that same pinned account.
      expect(rows.length).toBe(1)
      expect(rows[0]!.route_kind).toBe("account")
      expect(rows[0]!.account_id).toBe("acct_hard_pinned")

      // The physical request still identified the settled session.
      expect(headers(request)["x-opencode-session"]).toBe(sessionID)
      expect(JSON.stringify(rows)).not.toContain("cred_secret_handle")
    }),
  )
})

describe("third-party providers keep generic affinity identity", () => {
  test("does not claim OpenCode hosted identity", () => {
    const sent = providerRequestHeaders({
      providerID: "anthropic",
      projectID: "prj",
      sessionID: "ses",
      requestID: "req",
    })
    expect(sent["User-Agent"]).toBeUndefined()
    expect(sent["x-opencode-session"]).toBeUndefined()
    expect(sent["x-session-affinity"]).toBe("ses")
  })
})
