import { Effect, Exit, Schema } from "effect"
import { Quota } from "@/quota/quota"
import type { ProviderResult, UsageWindow } from "@/quota/schema"
import * as Tool from "./tool"
import DESCRIPTION from "./quota.txt"

const MAX_PROVIDER_IDS = 16
const SUMMARY_WINDOWS = 8
const DETAIL_WINDOWS = 40
const MAX_MODEL_ROWS = 30
const MAX_ACCOUNTS = 12
const MAX_ACCOUNT_MODELS = 16
const MAX_RESET_OCCURRENCES = 100
const DAY_MS = 24 * 60 * 60 * 1000

const normalizeProviderID = (id: string) => id.trim().toLowerCase().replace(/[\s_]+/g, "-")

export const Parameters = Schema.Struct({
  action: Schema.optional(Schema.Literals(["providers", "get", "overview", "resets"])).annotate({
    description: "Operation (default providers). Use get for one provider; overview only for an explicit cross-provider snapshot.",
  }),
  providerID: Schema.optional(Schema.String).annotate({
    description: "get/resets: provider id or registered alias.",
  }),
  providerIDs: Schema.optional(
    Schema.Array(Schema.String).check(Schema.isMaxLength(MAX_PROVIDER_IDS)),
  ).annotate({
    description: "overview: optional provider ids/aliases. Omit to inspect every configured provider.",
  }),
  detail: Schema.optional(Schema.Literals(["summary", "windows", "accounts", "models", "full"])).annotate({
    description: "get: projection detail (default summary). accounts/full may include configured account display labels.",
  }),
  days: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 }))).annotate({
    description: "resets: forward calendar window in days (default 7, max 32). Mutually exclusive with from/to.",
  }),
  from: Schema.optional(Schema.Finite).annotate({
    description: "resets: absolute start epoch milliseconds. Supply together with to; mutually exclusive with days.",
  }),
  to: Schema.optional(Schema.Finite).annotate({
    description: "resets: absolute end epoch milliseconds. Supply together with from; range must be <=32 days.",
  }),
})

type WindowView = {
  key: string
  usedPercent: number | null
  remainingPercent: number | null
  windowSeconds: number | null
  resetAt: number | null
  valueLabel: string | null
  resource?: UsageWindow["resource"]
}

type ProviderView = {
  kind: "provider"
  providerID: string
  providerName: string
  ok: boolean
  configured: boolean
  planLabel?: string | null
  error?: string
  fetchedAt: number
  nextRefreshAt?: number
  windows: WindowView[]
  totalWindows: number
  omittedWindows: number
  models?: Array<{
    model: string
    rate?: number
    rateFree?: boolean
    rateLabel?: string | null
    promotionLabel?: string | null
    windows: WindowView[]
    totalWindows: number
  }>
  omittedModels?: number
  accounts?: Array<
    | {
        kind: "workbuddy"
        accountID: string
        label: string
        models: Array<{
          model: string
          canonical: string | null
          status: string
          remainingPercent: number | null
          resetAt: number | null
          confidence: string
          accuracy: string
          exhaustedObserved: boolean
          willLikelyExhaustBeforeReset: boolean | null
        }>
        omittedModels: number
      }
    | {
        kind: "zen"
        accountID: string
        label: string
        state: string
        isDefault: boolean
        exhausted: boolean
        remainingPercent: number | null
        resetAt: number | null
        estimateSource: string | null
      }
  >
  omittedAccounts?: number
}

export type Metadata = {
  action: "providers" | "get" | "overview" | "resets"
  view:
    | {
        kind: "providers"
        providers: Array<{ providerID: string; providerName: string; configured: boolean }>
      }
    | ProviderView
    | {
        kind: "overview"
        providers: ProviderView[]
        failures: Array<{ providerID: string; error: string }>
      }
    | {
        kind: "resets"
        from: number
        to: number
        generatedAt: number
        occurrences: Array<{
          providerID: string
          providerName: string
          resetAt: number
          scope: string
          accountLabel?: string
          model?: string
          windows: Array<{ key: string; remainingPercent: number | null; valueLabel: string | null; source: string }>
        }>
        totalOccurrences: number
        omittedOccurrences: number
        failures: Array<{ providerID: string; providerName: string; error: string }>
      }
}

function remaining(window: UsageWindow) {
  if (window.remainingPercent !== null && Number.isFinite(window.remainingPercent)) return window.remainingPercent
  if (window.usedPercent !== null && Number.isFinite(window.usedPercent)) return Math.max(0, Math.min(100, 100 - window.usedPercent))
  return null
}

function projectWindow(key: string, window: UsageWindow): WindowView {
  return {
    key,
    usedPercent: window.usedPercent,
    remainingPercent: remaining(window),
    windowSeconds: window.windowSeconds,
    resetAt: window.resetAt,
    valueLabel: window.valueLabel,
    ...(window.resource ? { resource: window.resource } : {}),
  }
}

function sortedWindows(windows: Record<string, UsageWindow>) {
  return Object.entries(windows)
    .sort((left, right) => {
      const a = left[1].windowSeconds
      const b = right[1].windowSeconds
      if (a !== null && b !== null && a !== b) return a - b
      if (a !== null && b === null) return -1
      if (a === null && b !== null) return 1
      return left[0].localeCompare(right[0])
    })
    .map(([key, window]) => projectWindow(key, window))
}

function projectProvider(result: ProviderResult, detail: "summary" | "windows" | "accounts" | "models" | "full"): ProviderView {
  const usage = result.usage
  const allWindows = usage ? sortedWindows(usage.windows) : []
  const windowLimit = detail === "summary" ? SUMMARY_WINDOWS : DETAIL_WINDOWS
  const view: ProviderView = {
    kind: "provider",
    providerID: result.providerId,
    providerName: result.providerName,
    ok: result.ok,
    configured: result.configured,
    ...(result.planLabel !== undefined ? { planLabel: result.planLabel } : {}),
    ...(result.error ? { error: result.error } : {}),
    fetchedAt: result.fetchedAt,
    ...(result.nextRefreshAt !== undefined ? { nextRefreshAt: result.nextRefreshAt } : {}),
    windows: allWindows.slice(0, windowLimit),
    totalWindows: allWindows.length,
    omittedWindows: Math.max(0, allWindows.length - windowLimit),
  }

  if (usage && (detail === "models" || detail === "full")) {
    const entries = Object.entries(usage.models ?? {}).sort(([a], [b]) => a.localeCompare(b))
    view.models = entries.slice(0, MAX_MODEL_ROWS).map(([model, value]) => {
      const windows = sortedWindows(value.windows)
      return {
        model,
        ...(value.rate !== undefined ? { rate: value.rate } : {}),
        ...(value.rateFree !== undefined ? { rateFree: value.rateFree } : {}),
        ...(value.rateLabel !== undefined ? { rateLabel: value.rateLabel } : {}),
        ...(value.promotionLabel !== undefined ? { promotionLabel: value.promotionLabel } : {}),
        windows: windows.slice(0, SUMMARY_WINDOWS),
        totalWindows: windows.length,
      }
    })
    view.omittedModels = Math.max(0, entries.length - MAX_MODEL_ROWS)
  }

  if (usage && (detail === "accounts" || detail === "full")) {
    const workbuddy = (usage.workbuddyAccounts ?? []).map((account) => ({
      kind: "workbuddy" as const,
      accountID: account.accountId,
      label: account.label,
      models: account.models.slice(0, MAX_ACCOUNT_MODELS).map((model) => ({
        model: model.model,
        canonical: model.canonical,
        status: model.status,
        remainingPercent: model.remainingPercent,
        resetAt: model.resetAt,
        confidence: model.confidence,
        accuracy: model.accuracy,
        exhaustedObserved: model.exhaustedObserved,
        willLikelyExhaustBeforeReset: model.willLikelyExhaustBeforeReset,
      })),
      omittedModels: Math.max(0, account.models.length - MAX_ACCOUNT_MODELS),
    }))
    const zen = (usage.zenAccounts ?? []).map((account) => ({
      kind: "zen" as const,
      accountID: account.keyId,
      label: account.label,
      state: account.state,
      isDefault: account.isDefault,
      exhausted: account.exhausted,
      remainingPercent: account.remainingPercent,
      resetAt: account.resetAt,
      estimateSource: account.estimateSource,
    }))
    const accounts = [...workbuddy, ...zen]
    view.accounts = accounts.slice(0, MAX_ACCOUNTS)
    view.omittedAccounts = Math.max(0, accounts.length - MAX_ACCOUNTS)
  }

  return view
}

function percent(value: number | null) {
  return value === null || !Number.isFinite(value) ? "—" : `${Math.max(0, Math.min(100, value)).toFixed(value % 1 === 0 ? 0 : 1)}%`
}

function providerOutput(view: ProviderView) {
  const lines = [
    `${view.providerName} (${view.providerID}) — ${view.ok ? "ok" : "unavailable"}`,
    view.planLabel ? `Plan: ${view.planLabel}` : undefined,
    view.error ? `Error: ${view.error}` : undefined,
  ].filter((line): line is string => !!line)
  for (const window of view.windows) {
    const reset = window.resetAt ? ` · reset ${new Date(window.resetAt).toISOString()}` : ""
    const label = window.valueLabel ? ` · ${window.valueLabel}` : ""
    lines.push(`${window.key}: ${percent(window.remainingPercent)} remaining${reset}${label}`)
  }
  if (view.omittedWindows > 0) lines.push(`… ${view.omittedWindows} more windows omitted; request detail="windows" or "full".`)
  if (view.models) lines.push(`Models: ${view.models.length}${view.omittedModels ? ` (+${view.omittedModels} omitted)` : ""}`)
  if (view.accounts) lines.push(`Accounts: ${view.accounts.length}${view.omittedAccounts ? ` (+${view.omittedAccounts} omitted)` : ""}`)
  return lines.join("\n")
}

function invalid(detail: string) {
  return new Tool.InvalidArgumentsError({ tool: "quota", detail })
}

export const QuotaTool = Tool.define<typeof Parameters, Metadata, Quota.Service>(
  "quota",
  Effect.gen(function* () {
    const quota = yield* Quota.Service
    return {
      exposure: "lazy" as const,
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params) =>
        Effect.gen(function* () {
          const action = params.action ?? "providers"
          if (action === "providers") {
            if (params.providerID || params.providerIDs || params.detail || params.days || params.from !== undefined || params.to !== undefined) {
              return yield* Effect.fail(invalid("providers accepts no provider, detail, or range arguments"))
            }
            const result = yield* quota.providers()
            const view: Metadata["view"] = {
              kind: "providers",
              providers: result.providers.map((provider) => ({
                providerID: provider.providerId,
                providerName: provider.providerName,
                configured: provider.configured,
              })),
            }
            return {
              title: "Quota providers",
              metadata: { action, view },
              output: view.providers
                .map((provider) => `${provider.providerID}: ${provider.configured ? "configured" : "not configured"}`)
                .join("\n"),
              data: view,
            }
          }

          if (action === "get") {
            if (!params.providerID) return yield* Effect.fail(invalid("get requires providerID"))
            if (params.providerIDs || params.days || params.from !== undefined || params.to !== undefined) {
              return yield* Effect.fail(invalid("get accepts providerID and optional detail only"))
            }
            const detail = params.detail ?? "summary"
            const result = yield* quota.get({ providerID: params.providerID })
            const view = projectProvider(result, detail)
            return {
              title: `Quota · ${result.providerName}`,
              metadata: { action, view },
              output: providerOutput(view),
              data: view,
            }
          }

          if (action === "overview") {
            if (params.providerID || params.detail || params.days || params.from !== undefined || params.to !== undefined) {
              return yield* Effect.fail(invalid("overview accepts optional providerIDs only"))
            }
            const registry = yield* quota.providers()
            const canonicalByLookup = new Map<string, string>()
            for (const provider of registry.providers) {
              canonicalByLookup.set(normalizeProviderID(provider.providerId), provider.providerId)
              for (const alias of provider.aliases) canonicalByLookup.set(normalizeProviderID(alias), provider.providerId)
            }
            const requested = params.providerIDs?.length
              ? [
                  ...new Set(
                    params.providerIDs.map((providerID) =>
                      canonicalByLookup.get(normalizeProviderID(providerID)) ?? providerID.trim(),
                    ),
                  ),
                ]
              : registry.providers.filter((provider) => provider.configured).map((provider) => provider.providerId)
            if (requested.length > MAX_PROVIDER_IDS) {
              return yield* Effect.fail(invalid(`overview supports at most ${MAX_PROVIDER_IDS} providers`))
            }
            const settled = yield* Effect.forEach(
              requested,
              (providerID) => Effect.map(Effect.exit(quota.get({ providerID })), (exit) => ({ providerID, exit })),
              { concurrency: 4 },
            )
            const providers: ProviderView[] = []
            const failures: Array<{ providerID: string; error: string }> = []
            for (const item of settled) {
              if (Exit.isSuccess(item.exit)) providers.push(projectProvider(item.exit.value, "summary"))
              else failures.push({ providerID: item.providerID, error: "Quota provider unavailable or unsupported" })
            }
            const view = { kind: "overview" as const, providers, failures }
            return {
              title: "Quota overview",
              metadata: { action, view },
              output: [
                ...providers.flatMap((provider) => [
                  `${provider.providerName} (${provider.providerID}): ${provider.ok ? "ok" : provider.error ?? "unavailable"}`,
                  ...provider.windows.slice(0, 3).map((window) => `  ${window.key}: ${percent(window.remainingPercent)} remaining`),
                ]),
                ...failures.map((failure) => `${failure.providerID}: ${failure.error}`),
              ].join("\n"),
              data: view,
            }
          }

          if (params.providerIDs || params.detail) {
            return yield* Effect.fail(invalid("resets accepts optional providerID plus days or from/to only"))
          }
          const hasAbsolute = params.from !== undefined || params.to !== undefined
          if (hasAbsolute && (params.from === undefined || params.to === undefined)) {
            return yield* Effect.fail(invalid("resets requires both from and to when either absolute bound is supplied"))
          }
          if (hasAbsolute && params.days !== undefined) {
            return yield* Effect.fail(invalid("resets accepts either days or from/to, not both"))
          }
          const from = hasAbsolute ? params.from! : Date.now()
          const to = hasAbsolute ? params.to! : from + (params.days ?? 7) * DAY_MS
          if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 32 * DAY_MS) {
            return yield* Effect.fail(invalid("resets range must be finite, increasing, and no longer than 32 days"))
          }
          const result = params.providerID
            ? yield* quota.resetsForProvider({ providerID: params.providerID, from, to })
            : yield* quota.resets({ from, to })
          const occurrences = result.occurrences.slice(0, MAX_RESET_OCCURRENCES).map((occurrence) => ({
            providerID: occurrence.providerId,
            providerName: occurrence.providerName,
            resetAt: occurrence.resetAt,
            scope: occurrence.scope,
            // Account display labels can contain user-identifying values such as
            // email addresses. Keep reset projections on the same privacy
            // contract as summary/overview: only the explicit accounts/full
            // detail path exposes labels. The stable opaque account id is enough
            // to correlate account-scoped reset rows here.
            ...(occurrence.accountId ? { accountID: occurrence.accountId } : {}),
            ...(occurrence.model ? { model: occurrence.model } : {}),
            windows: occurrence.windows.map((window) => ({
              key: window.key,
              remainingPercent: window.remainingPercent,
              valueLabel: window.valueLabel,
              source: window.source,
            })),
          }))
          const view = {
            kind: "resets" as const,
            from: result.from,
            to: result.to,
            generatedAt: result.generatedAt,
            occurrences,
            totalOccurrences: result.occurrences.length,
            omittedOccurrences: Math.max(0, result.occurrences.length - occurrences.length),
            failures: result.failures.map((failure) => ({
              providerID: failure.providerId,
              providerName: failure.providerName,
              error: failure.error,
            })),
          }
          return {
            title: "Quota resets",
            metadata: { action, view },
            output: [
              ...occurrences.map((occurrence) =>
                `${new Date(occurrence.resetAt).toISOString()} · ${occurrence.providerName} · ${occurrence.scope}${occurrence.model ? ` · ${occurrence.model}` : ""}`,
              ),
              ...(view.omittedOccurrences ? [`… ${view.omittedOccurrences} more reset occurrences omitted.`] : []),
              ...view.failures.map((failure) => `${failure.providerName}: ${failure.error}`),
            ].join("\n") || "No known quota resets in this range.",
            data: view,
          }
        }),
    }
  }),
)
