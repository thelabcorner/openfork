import { Account } from "@/account/account"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { Project } from "@/project/project"
import { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Worktree } from "@/worktree"
import { Effect, Option } from "effect"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  ConsoleSwitchPayload,
  OpenRouterEndpointsQuery,
  OpenRouterFreeUsageQuery,
  OpenRouterTelemetryQuery,
  SessionListQuery,
  ToolListQuery,
  WorktreeApiError,
} from "../groups/experimental"
import { Credential } from "@opencode-ai/core/credential"
import { Integration } from "@opencode-ai/schema/integration"
import { OpenRouterFreeUsageTracker } from "@/openrouter/free-usage/tracker"
import type { FreeUsageReport } from "@/openrouter/free-usage/types"

function mapWorktreeError<A, R>(self: Effect.Effect<A, Worktree.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => new WorktreeApiError({ name: error._tag, data: { message: error.message } })),
  )
}

// Process-global Free Usage trackers keyed by management key (hashed prefix) so
// multiple accounts don't share samples/caches. The tracker itself owns 15s
// snapshot, 6h tier/pricing, 24h schema TTLs and single-flight coalescing.
const openRouterFreeUsageTrackers = new Map<string, OpenRouterFreeUsageTracker>()

// Mirrors the renderer's parser in packages/app/src/utils/openrouter-endpoints.ts:
// OpenRouter's `/api/v1/models/{id}/endpoints` returns `{ data: { endpoints: [] } }`
// where each row carries `provider_name`, `tag` (e.g. "novita/fp8"), string
// `pricing.{prompt,completion,input_cache_read}` and `uptime_last_30m`. Defensive:
// unknown/malformed rows are skipped, pricing strings are coerced to numbers.
function parseOpenRouterEndpoints(payload: unknown) {
  const rows = (payload as { data?: { endpoints?: unknown } } | null)?.data?.endpoints
  if (!Array.isArray(rows)) return []
  const num = (value: unknown) => {
    if (typeof value === "number") return value
    if (typeof value === "string") {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
    return undefined
  }
  const result: Array<{
    providerName: string
    tag: string
    provider: string
    pricing: { prompt: number; completion: number; cacheRead: number }
    uptime?: number
  }> = []
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    const item = row as {
      provider_name?: unknown
      tag?: unknown
      pricing?: { prompt?: unknown; completion?: unknown; input_cache_read?: unknown }
      uptime_last_30m?: unknown
    }
    const tag = typeof item.tag === "string" ? item.tag : undefined
    if (!tag) continue
    const uptime = num(item.uptime_last_30m)
    const perMillion = (value: unknown) => (num(value) ?? 0) * 1_000_000
    result.push({
      providerName: typeof item.provider_name === "string" ? item.provider_name : tag,
      tag,
      provider: tag.split("/")[0],
      pricing: {
        prompt: perMillion(item.pricing?.prompt),
        completion: perMillion(item.pricing?.completion),
        cacheRead: perMillion(item.pricing?.input_cache_read),
      },
      ...(uptime === undefined ? {} : { uptime }),
    })
  }
  return result
}

function degradedFreeUsageReport(note: string): FreeUsageReport {
  const fetchedAt = new Date()
  const resetsAt = new Date(fetchedAt.getTime() + 86_400_000)
  return {
    free: {
      remaining: 0,
      limit: 50,
      remainingPercent: 0,
      used: 0,
      usedPercent: 0,
      status: "depleted",
      tier: { source: "override", totalCreditsPurchased: null },
      tokens: { prompt: 0, completion: 0, reasoning: 0, total: 0 },
      value: {
        equivalentPaidValueUsd: 0,
        valuedRequests: 0,
        unvaluedRequests: 0,
        methodology: "current-paid-sibling-list-price",
        cacheAware: false,
        note,
      },
      window: {
        type: "calendar-day",
        timezone: "UTC",
        startedAt: fetchedAt.toISOString(),
        resetsAt: resetsAt.toISOString(),
        secondsUntilReset: 86_400,
      },
      reset: {
        policy: "midnight-utc",
        confidence: "high",
        basis: "No usable analytics data available.",
      },
      rate: { limitPerMinute: 20, observedRequestsPerMinute: 0, source: "insufficient-data" },
      projection: {
        requestsPerHour: 0,
        rateSource: "insufficient-data",
        sustainableRequestsPerHour: 0,
        projectedRemainingAtReset: 0,
        willExhaustBeforeReset: false,
        estimatedExhaustionAt: null,
      },
      models: [],
    },
    source: {
      mode: "openrouter-analytics",
      scope: "account",
      analyticsAsOf: fetchedAt.toISOString(),
      fetchedAt: fetchedAt.toISOString(),
      stale: true,
      analyticsRows: 0,
      analyticsTruncated: false,
      upstreamCalls: 0,
    },
  }
}

export const experimentalHandlers = HttpApiBuilder.group(InstanceHttpApi, "experimental", (handlers) =>
  Effect.gen(function* () {
    const account = yield* Account.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const project = yield* Project.Service
    const registry = yield* ToolRegistry.Service
    const worktreeSvc = yield* Worktree.Service
    const sessions = yield* Session.Service
    const background = yield* BackgroundJob.Service
    const flags = yield* RuntimeFlags.Service
    const http = yield* HttpClient.HttpClient
    const credential = yield* Credential.Service
    const auth = yield* Auth.Service

    const capabilities = Effect.fn("ExperimentalHttpApi.capabilities")(function* () {
      return { backgroundSubagents: flags.experimentalBackgroundSubagents }
    })

    const getConsole = Effect.fn("ExperimentalHttpApi.console")(function* () {
      const [state, groups] = yield* Effect.all(
        [
          config.getConsoleState(),
          account.orgsByAccount().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
        ],
        {
          concurrency: "unbounded",
        },
      )
      return {
        consoleManagedProviders: state.consoleManagedProviders,
        ...(state.activeOrgName ? { activeOrgName: state.activeOrgName } : {}),
        switchableOrgCount: groups.reduce((count, group) => count + group.orgs.length, 0),
      }
    })

    const listConsoleOrgs = Effect.fn("ExperimentalHttpApi.consoleOrgs")(function* () {
      const [groups, active] = yield* Effect.all(
        [
          account.orgsByAccount().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
          account.active().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
        ],
        {
          concurrency: "unbounded",
        },
      )
      const info = Option.getOrUndefined(active)
      return {
        orgs: groups.flatMap((group) =>
          group.orgs.map((org) => ({
            accountID: group.account.id,
            accountEmail: group.account.email,
            accountUrl: group.account.url,
            orgID: org.id,
            orgName: org.name,
            active: !!info && info.id === group.account.id && info.active_org_id === org.id,
          })),
        ),
      }
    })

    const switchConsole = Effect.fn("ExperimentalHttpApi.consoleSwitch")(function* (ctx: {
      payload: typeof ConsoleSwitchPayload.Type
    }) {
      yield* account
        .use(ctx.payload.accountID, Option.some(ctx.payload.orgID))
        .pipe(Effect.catch(() => Effect.fail(new HttpApiError.BadRequest({}))))
      return true
    })

    const tool = Effect.fn("ExperimentalHttpApi.tool")(function* (ctx: { query: typeof ToolListQuery.Type }) {
      const list = yield* registry.tools({
        providerID: ctx.query.provider,
        modelID: ctx.query.model,
        agent: yield* agents.defaultInfo(),
      })
      return list.map((item) => ({
        id: item.id,
        description: item.description,
        parameters: ToolJsonSchema.fromTool(item),
      }))
    })

    const toolIDs = Effect.fn("ExperimentalHttpApi.toolIDs")(function* () {
      return yield* registry.ids()
    })

    const worktree = Effect.fn("ExperimentalHttpApi.worktree")(function* () {
      const ctx = yield* InstanceState.context
      return yield* project.sandboxes(ctx.project.id)
    })

    const worktreeCreate = Effect.fn("ExperimentalHttpApi.worktreeCreate")(function* (ctx: {
      payload: typeof Worktree.CreateInput.Type | void
    }) {
      return yield* mapWorktreeError(worktreeSvc.create(ctx.payload ?? undefined))
    })

    const worktreeRemove = Effect.fn("ExperimentalHttpApi.worktreeRemove")(function* (input: {
      payload: Worktree.RemoveInput
    }) {
      const ctx = yield* InstanceState.context
      yield* mapWorktreeError(worktreeSvc.remove(input.payload))
      yield* project.removeSandbox(ctx.project.id, input.payload.directory)
      return true
    })

    const worktreeReset = Effect.fn("ExperimentalHttpApi.worktreeReset")(function* (ctx: {
      payload: Worktree.ResetInput
    }) {
      yield* mapWorktreeError(worktreeSvc.reset(ctx.payload))
      return true
    })

    const session = Effect.fn("ExperimentalHttpApi.session")(function* (ctx: { query: typeof SessionListQuery.Type }) {
      const limit = ctx.query.limit ?? 100
      const directory = ctx.query.directory ? yield* InstanceState.directory : undefined
      const all = yield* sessions.listGlobal({
        directory,
        roots: ctx.query.roots,
        start: ctx.query.start,
        cursor: ctx.query.cursor,
        search: ctx.query.search,
        limit: limit + 1,
        archived: ctx.query.archived,
      })
      const list = all.length > limit ? all.slice(0, limit) : all
      return HttpServerResponse.jsonUnsafe(list, {
        headers:
          all.length > limit && list.length > 0
            ? { "x-next-cursor": String(list[list.length - 1].time.updated) }
            : undefined,
      })
    })

    const sessionBackground = Effect.fn("ExperimentalHttpApi.sessionBackground")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      if (!flags.experimentalBackgroundSubagents) return false
      const jobs = (yield* background.list()).filter(
        (job) =>
          job.type === "task" &&
          job.status === "running" &&
          job.metadata?.parentSessionId === ctx.params.sessionID &&
          job.metadata.background !== true,
      )
      const promoted = yield* Effect.forEach(jobs, (job) => background.promote(job.id), { concurrency: "unbounded" })
      return promoted.some((job) => job !== undefined)
    })

    const resource = Effect.fn("ExperimentalHttpApi.resource")(function* () {
      return yield* mcp.resources()
    })

    const openrouterTelemetry = Effect.fn("ExperimentalHttpApi.openrouterTelemetry")(function* (ctx: {
      query: typeof OpenRouterTelemetryQuery.Type
    }) {
      // Best-effort proxy — must NEVER 500. Models like "~deepseek/..." or unpublished
      // variants have no frontend telemetry; return [] so the UI degrades to uptime.
      const rawModelId = ctx.query.model
      const timeRange = ctx.query.timeRange ?? "1w"
      const modelId = rawModelId.replace(/^~+/, "")
      const slash = modelId.indexOf("/")
      if (slash <= 0) return []
      const author = modelId.slice(0, slash)

      const fetchJson = (url: string) =>
        HttpClient.filterStatusOk(http)
          .execute(HttpClientRequest.get(url).pipe(HttpClientRequest.accept("application/json")))
          .pipe(
            Effect.timeout("10 seconds"),
            Effect.catch(() => Effect.succeed(null as any)),
            Effect.flatMap((res: any) => {
              if (!res) return Effect.succeed(null)
              return res.json.pipe(Effect.catch(() => Effect.succeed(null)))
            }),
          )

      const permaslugBody = (yield* fetchJson(
        `https://openrouter.ai/api/frontend/v1/author-models?authorSlug=${encodeURIComponent(author)}`,
      )) as { data?: { models?: Array<{ slug?: string; permaslug?: string; endpoint?: { variant?: string } }> } } | null
      if (!permaslugBody) return []
      const models = permaslugBody.data?.models ?? []
      const permaslug =
        models.find((m) => (m.slug === modelId || m.slug === rawModelId) && m.endpoint?.variant === "standard")?.permaslug ??
        models.find((m) => m.slug === modelId || m.slug === rawModelId)?.permaslug
      if (!permaslug) return []

      const pricingBody = (yield* fetchJson(
        `https://openrouter.ai/api/frontend/v1/stats/effective-pricing?permaslug=${encodeURIComponent(permaslug)}&shape=v7&variant=standard`,
      )) as { data?: { providerSummaries?: Array<{ endpointId?: string; providerName?: string; providerSlug?: string; cacheHitRate?: number }> } } | null
      if (!pricingBody) return []
      const summaries = pricingBody.data?.providerSummaries ?? []
      const allowedIds = new Set(summaries.map((s) => s.endpointId).filter((id): id is string => !!id))

      let throughputLatest = new Map<string, number>()
      const throughputBody = (yield* fetchJson(
        `https://openrouter.ai/api/frontend/v1/stats/throughput-comparison?permaslug=${encodeURIComponent(permaslug)}&timeRange=${encodeURIComponent(timeRange)}&variant=standard`,
      )) as { data?: Array<{ x?: string; y?: Record<string, number> }> } | null
      if (throughputBody?.data) {
        const todayStr = new Date().toISOString().slice(0, 10)
        for (const point of throughputBody.data ?? []) {
          const bucket = point.x?.slice(0, 10)
          if (bucket && bucket >= todayStr) continue
          for (const [rawKey, value] of Object.entries(point.y ?? {})) {
            const endpointId = rawKey.split("::", 1)[0]
            if (allowedIds.has(endpointId) && typeof value === "number") throughputLatest.set(endpointId, value)
          }
        }
      }

      const result = summaries.map((summary) => {
        const endpointId = summary.endpointId!
        const providerName = summary.providerName ?? endpointId
        const providerSlug = summary.providerSlug ?? endpointId
        return {
          endpointId,
          providerName,
          providerSlug,
          cacheHitPercent: Math.round((summary.cacheHitRate ?? 0) * 10000) / 100,
          throughputTps: throughputLatest.has(endpointId) ? Math.round(throughputLatest.get(endpointId)! * 100) / 100 : undefined,
        }
      })
      return result
    } as any)

    const openrouterEndpoints = Effect.fn("ExperimentalHttpApi.openrouterEndpoints")(function* (ctx: {
      query: typeof OpenRouterEndpointsQuery.Type
    }) {
      const request = HttpClientRequest.get(
        `https://openrouter.ai/api/v1/models/${encodeURI(ctx.query.model)}/endpoints`,
      ).pipe(HttpClientRequest.accept("application/json"))
      const response = yield* HttpClient.filterStatusOk(http)
        .execute(request)
        .pipe(
          Effect.timeoutOrElse({
            duration: "15 seconds",
            orElse: () => Effect.fail(new HttpApiError.InternalServerError({})),
          }),
          // Non-2xx or a transport failure surfaces as an internal error so the
          // renderer can distinguish "couldn't load" from a model with no providers.
          Effect.mapError(() => new HttpApiError.InternalServerError({})),
        )
      const body = yield* response.json.pipe(
        Effect.mapError(() => new HttpApiError.InternalServerError({})),
      )
      return parseOpenRouterEndpoints(body)
    })

    const openrouterFreeUsage = Effect.fn("ExperimentalHttpApi.openrouterFreeUsage")(function* (ctx: {
      query: typeof OpenRouterFreeUsageQuery.Type
    }) {
      const envKey = process.env.OPENROUTER_MANAGEMENT_KEY?.trim()
      let managementKey: string | undefined = envKey && envKey.length > 0 ? envKey : undefined
      if (!managementKey) {
        const stored = yield* auth.get("openrouter-management").pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (stored?.type === "api") managementKey = stored.key.trim() || undefined
        if (stored?.type === "oauth") managementKey = stored.access.trim() || undefined
        if (stored?.type === "wellknown") managementKey = stored.token.trim() || undefined
      }
      if (!managementKey) {
        const integrationID = Integration.ID.make("openrouter")
        const list = (yield* credential
          .list(integrationID)
          .pipe(Effect.catch(() => Effect.succeed([] as Credential.Info[])))) as Credential.Info[]
        const active = list.find((entry) => entry.active) ?? list[0]
        if (active) {
          if (active.value.type === "key" && typeof active.value.key === "string" && active.value.key.length > 0) {
            managementKey = active.value.key
          } else if (
            active.value.type === "oauth" &&
            typeof (active.value as unknown as { access: string }).access === "string"
          ) {
            managementKey = (active.value as unknown as { access: string }).access
          }
        }
      }
      if (!managementKey) {
        const stored = yield* auth.get("openrouter").pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (stored?.type === "api") managementKey = stored.key.trim() || undefined
        if (stored?.type === "oauth") managementKey = stored.access.trim() || undefined
        if (stored?.type === "wellknown") managementKey = stored.token.trim() || undefined
      }
      if (!managementKey) {
        const fallback = process.env.OPENROUTER_API_KEY?.trim()
        if (fallback && fallback.length > 0) managementKey = fallback
      }
      if (!managementKey) return degradedFreeUsageReport("No OpenRouter key configured; usage unavailable.")

      const namespace = `openrouter-free-usage:${managementKey.slice(0, 12)}`
      let tracker = openRouterFreeUsageTrackers.get(managementKey)
      if (!tracker) {
        tracker = new OpenRouterFreeUsageTracker({
          managementKey,
          cacheNamespace: namespace,
        })
        openRouterFreeUsageTrackers.set(managementKey, tracker)
      }
      const includeValue = ctx.query.includeValue ?? true
      const forceRefresh = ctx.query.forceRefresh ?? false
      return yield* Effect.tryPromise({
        try: () => tracker!.getUsage({ includeValue, forceRefresh }),
        catch: (cause) => cause,
      }).pipe(Effect.catch(() => Effect.succeed(degradedFreeUsageReport("OpenRouter usage unavailable; a Management key is required for analytics."))))
    })

    return handlers
      .handle("capabilities", capabilities)
      .handle("console", getConsole)
      .handle("consoleOrgs", listConsoleOrgs)
      .handle("consoleSwitch", switchConsole)
      .handle("tool", tool)
      .handle("toolIDs", toolIDs)
      .handle("worktree", worktree)
      .handle("worktreeCreate", worktreeCreate)
      .handle("worktreeRemove", worktreeRemove)
      .handle("worktreeReset", worktreeReset)
      .handle("session", session)
      .handle("sessionBackground", sessionBackground)
      .handle("resource", resource)
      .handle("openrouterTelemetry", openrouterTelemetry as any)
      .handle("openrouterEndpoints", openrouterEndpoints)
      .handle("openrouterFreeUsage", openrouterFreeUsage as any)
  }),
)
