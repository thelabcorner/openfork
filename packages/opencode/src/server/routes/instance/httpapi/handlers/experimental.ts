import { Account } from "@/account/account"
import { Agent } from "@/agent/agent"
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
  OpenRouterTelemetryQuery,
  SessionListQuery,
  ToolListQuery,
  WorktreeApiError,
} from "../groups/experimental"

function mapWorktreeError<A, R>(self: Effect.Effect<A, Worktree.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => new WorktreeApiError({ name: error._tag, data: { message: error.message } })),
  )
}

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
      query: typeof import("../groups/experimental").OpenRouterTelemetryQuery.Type
    }) {
      // Best-effort proxy for the undocumented frontend telemetry endpoints.
      const modelId = ctx.query.model
      const timeRange = ctx.query.timeRange ?? "1w"
      // Resolve permaslug via author-models proxy
      const author = modelId.slice(0, modelId.indexOf("/"))
      const permaslugRes = yield* HttpClient.filterStatusOk(http).execute(
        HttpClientRequest.get(
          `https://openrouter.ai/api/frontend/v1/author-models?authorSlug=${encodeURIComponent(author)}`,
        ).pipe(HttpClientRequest.accept("application/json")),
      ).pipe(Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.fail(new HttpApiError.InternalServerError({})) }), Effect.mapError(() => new HttpApiError.InternalServerError({})))
      const permaslugBody = yield* permaslugRes.json.pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      const permaslug = (permaslugBody as { data?: { models?: Array<{ slug?: string; permaslug?: string; endpoint?: { variant?: string } }> } })?.data?.models?.find((m) => m.slug === modelId && m.endpoint?.variant === "standard")?.permaslug ?? (permaslugBody as { data?: { models?: Array<{ slug?: string; permaslug?: string }> } })?.data?.models?.find((m) => m.slug === modelId)?.permaslug
      if (!permaslug) return []

      // Effective pricing for identity + cache ratio
      const pricingRes = yield* HttpClient.filterStatusOk(http).execute(
        HttpClientRequest.get(
          `https://openrouter.ai/api/frontend/v1/stats/effective-pricing?permaslug=${encodeURIComponent(permaslug)}&shape=v7&variant=standard`,
        ).pipe(HttpClientRequest.accept("application/json")),
      ).pipe(Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.fail(new HttpApiError.InternalServerError({})) }), Effect.mapError(() => new HttpApiError.InternalServerError({})))
      const pricingBody = yield* pricingRes.json.pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      const summaries = (pricingBody as { data?: { providerSummaries?: Array<{ endpointId?: string; providerName?: string; providerSlug?: string; cacheHitRate?: number }> } })?.data?.providerSummaries ?? []
      const allowedIds = new Set(summaries.map((s) => s.endpointId).filter((id): id is string => !!id))

      // Throughput series
      let throughputLatest = new Map<string, number>()
      try {
        const throughputRes = yield* HttpClient.filterStatusOk(http).execute(
          HttpClientRequest.get(
            `https://openrouter.ai/api/frontend/v1/stats/throughput-comparison?permaslug=${encodeURIComponent(permaslug)}&timeRange=${encodeURIComponent(timeRange)}&variant=standard`,
          ).pipe(HttpClientRequest.accept("application/json")),
        ).pipe(Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.fail(new HttpApiError.InternalServerError({})) }), Effect.mapError(() => new HttpApiError.InternalServerError({})))
        const throughputBody = yield* throughputRes.json.pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
        const todayStr = new Date().toISOString().slice(0, 10)
        for (const point of ((throughputBody as { data?: Array<{ x?: string; y?: Record<string, number> }> })?.data ?? [])) {
          const bucket = point.x?.slice(0, 10)
          if (bucket && bucket >= todayStr) continue
          for (const [rawKey, value] of Object.entries(point.y ?? {})) {
            const endpointId = rawKey.split("::", 1)[0]
            if (allowedIds.has(endpointId) && typeof value === "number") {
              throughputLatest.set(endpointId, value)
            }
          }
        }
      } catch {
        // Best-effort: throughput failure shouldn't kill telemetry.
      }

      return summaries.map((summary) => {
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
    })

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
      .handle("openrouterTelemetry", openrouterTelemetry)
      .handle("openrouterEndpoints", openrouterEndpoints)
  }),
)
