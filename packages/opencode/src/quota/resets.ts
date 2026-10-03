import type { ForkUsageSnapshot } from "@/fork/usage"
import type {
  ProviderResult,
  ResetAgendaResult,
  ResetFailure,
  ResetOccurrence,
  ResetSource,
  ResetWindow,
  UsageWindow,
  WorkBuddyModelLimit,
} from "./schema"

type Scope = ResetOccurrence["scope"]
type MutableOccurrence = Omit<ResetOccurrence, "windows"> & { windows: ResetWindow[] }

type OccurrenceInput = {
  readonly providerId: string
  readonly providerName: string
  readonly resetAt: number
  readonly observedAt: number
  readonly scope: Scope
  readonly accountId?: string
  readonly accountLabel?: string
  readonly model?: string
  readonly window: ResetWindow
}

function finiteReset(value: number | null | undefined, from: number, to: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= from && value <= to
}

function windowSource(providerId: string): ResetSource {
  if (providerId === "opencode-zen") return "inferred"
  if (providerId === "nvidia") return "local"
  return "provider"
}

function modelResetSource(model: WorkBuddyModelLimit): ResetSource {
  if (model.resetSource === "inferred") return "inferred"
  if (model.resetSource === "server-6004") return "observed"
  return "observed"
}

function resetWindow(key: string, window: UsageWindow, source: ResetSource): ResetWindow {
  return {
    key,
    usedPercent: window.usedPercent,
    remainingPercent: window.remainingPercent,
    valueLabel: window.valueLabel,
    source,
  }
}

function accountWindowKey(key: string) {
  if (!key.startsWith("account:")) return
  const rest = key.slice("account:".length)
  const split = rest.lastIndexOf(":")
  if (split <= 0) return
  return { label: rest.slice(0, split), key: rest.slice(split + 1) }
}

function modelWindowKey(key: string) {
  const split = key.indexOf(":")
  if (split <= 0) return
  const prefix = key.slice(0, split)
  if (prefix !== "weekly" && prefix !== "model") return
  return { model: key.slice(split + 1), key: prefix }
}

function stableID(input: {
  providerId: string
  scope: Scope
  resetAt: number
  accountId?: string
  accountLabel?: string
  model?: string
}) {
  return [
    input.providerId,
    input.scope,
    input.accountId ?? input.accountLabel ?? "",
    input.model ?? "",
    String(input.resetAt),
  ]
    .map((part) => encodeURIComponent(part))
    .join(":")
}

function addOccurrence(map: Map<string, MutableOccurrence>, input: OccurrenceInput) {
  const id = stableID(input)
  const existing = map.get(id)
  if (existing) {
    if (!existing.windows.some((window) => window.key === input.window.key && window.source === input.window.source)) {
      existing.windows.push(input.window)
    }
    return
  }
  map.set(id, {
    id,
    providerId: input.providerId,
    providerName: input.providerName,
    resetAt: input.resetAt,
    observedAt: input.observedAt,
    scope: input.scope,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.accountLabel ? { accountLabel: input.accountLabel } : {}),
    ...(input.model ? { model: input.model } : {}),
    windows: [input.window],
  })
}

function addProviderResult(
  map: Map<string, MutableOccurrence>,
  result: ProviderResult,
  from: number,
  to: number,
) {
  const usage = result.usage
  if (!usage) return
  const source = windowSource(result.providerId)
  const accountIdByLabel = new Map<string, string>()
  for (const [accountId, label] of Object.entries(usage.accountLabels ?? {})) accountIdByLabel.set(label, accountId)

  for (const [key, window] of Object.entries(usage.windows)) {
    if (!finiteReset(window.resetAt, from, to)) continue

    const account = accountWindowKey(key)
    if (account) {
      addOccurrence(map, {
        providerId: result.providerId,
        providerName: result.providerName,
        resetAt: window.resetAt,
        observedAt: result.fetchedAt,
        scope: "account",
        accountId: accountIdByLabel.get(account.label),
        accountLabel: account.label,
        window: resetWindow(account.key, window, source),
      })
      continue
    }

    const model = modelWindowKey(key)
    if (model) {
      addOccurrence(map, {
        providerId: result.providerId,
        providerName: result.providerName,
        resetAt: window.resetAt,
        observedAt: result.fetchedAt,
        scope: "model",
        model: model.model,
        window: resetWindow(model.key, window, source),
      })
      continue
    }

    addOccurrence(map, {
      providerId: result.providerId,
      providerName: result.providerName,
      resetAt: window.resetAt,
      observedAt: result.fetchedAt,
      scope: "provider",
      window: resetWindow(key, window, source),
    })
  }

  for (const [model, modelUsage] of Object.entries(usage.models ?? {})) {
    for (const [key, window] of Object.entries(modelUsage.windows)) {
      if (!finiteReset(window.resetAt, from, to)) continue
      addOccurrence(map, {
        providerId: result.providerId,
        providerName: result.providerName,
        resetAt: window.resetAt,
        observedAt: result.fetchedAt,
        scope: "model",
        model,
        window: resetWindow(key, window, source),
      })
    }
  }

  for (const account of usage.workbuddyAccounts ?? []) {
    for (const model of account.models) {
      if (!finiteReset(model.resetAt, from, to)) continue
      addOccurrence(map, {
        providerId: result.providerId,
        providerName: result.providerName,
        resetAt: model.resetAt,
        observedAt: model.lastObservationAt ?? result.fetchedAt,
        scope: "account-model",
        accountId: account.accountId,
        accountLabel: account.label,
        model: model.canonical ?? model.model,
        window: {
          key: model.windowType,
          usedPercent:
            model.remainingPercent === null ? null : Math.max(0, Math.min(100, 100 - model.remainingPercent)),
          remainingPercent: model.remainingPercent,
          valueLabel: null,
          source: modelResetSource(model),
        },
      })
    }
  }

  for (const account of usage.zenAccounts ?? []) {
    if (!finiteReset(account.resetAt, from, to)) continue
    addOccurrence(map, {
      providerId: result.providerId,
      providerName: result.providerName,
      resetAt: account.resetAt,
      observedAt: result.fetchedAt,
      scope: "account",
      accountId: account.keyId,
      accountLabel: account.label,
      window: {
        key: account.state === "cooling" ? "cooldown" : "quota",
        usedPercent:
          account.remainingPercent === null ? null : Math.max(0, Math.min(100, 100 - account.remainingPercent)),
        remainingPercent: account.remainingPercent,
        valueLabel: null,
        source: "observed",
      },
    })
  }
}

function addGoSnapshot(
  map: Map<string, MutableOccurrence>,
  snapshot: ForkUsageSnapshot,
  from: number,
  to: number,
  observedAt: number,
) {
  const providerId = "opencode-go"
  const providerName = "OpenCode Go"

  for (const window of snapshot.result.aggregate) {
    if (!finiteReset(window.resetsAt, from, to)) continue
    const representedByAccount =
      window.source === "api" &&
      snapshot.result.byCredential.some((account) =>
        account.windows.some(
          (accountWindow) =>
            accountWindow.label === window.label && finiteReset(accountWindow.resetsAt, from, to),
        ),
      )
    if (representedByAccount) continue
    addOccurrence(map, {
      providerId,
      providerName,
      resetAt: window.resetsAt,
      observedAt,
      scope: "provider",
      window: {
        key: window.label,
        usedPercent: window.limitUSD > 0 ? Math.max(0, Math.min(100, (window.spentUSD / window.limitUSD) * 100)) : null,
        remainingPercent:
          window.limitUSD > 0 ? Math.max(0, Math.min(100, 100 - (window.spentUSD / window.limitUSD) * 100)) : null,
        valueLabel: null,
        source: window.source === "api" ? "provider" : "local",
      },
    })
  }

  for (const account of snapshot.result.byCredential) {
    const accountId = account.accountID ?? account.credentialID
    const accountLabel = snapshot.accountLabels.get(accountId) ?? snapshot.accountLabels.get(account.credentialID) ?? accountId
    for (const window of account.windows) {
      if (!finiteReset(window.resetsAt, from, to)) continue
      addOccurrence(map, {
        providerId,
        providerName,
        resetAt: window.resetsAt,
        observedAt: account.official?.fetchedAt || observedAt,
        scope: "account",
        accountId,
        accountLabel,
        window: {
          key: window.label,
          usedPercent:
            window.limitUSD > 0 ? Math.max(0, Math.min(100, (window.spentUSD / window.limitUSD) * 100)) : null,
          remainingPercent:
            window.limitUSD > 0 ? Math.max(0, Math.min(100, 100 - (window.spentUSD / window.limitUSD) * 100)) : null,
          valueLabel: null,
          source:
            window.source === "api"
              ? account.official?.status === "stale"
                ? "observed"
                : "provider"
              : "local",
        },
      })
    }
  }
}

export function buildResetAgenda(input: {
  readonly from: number
  readonly to: number
  readonly generatedAt?: number
  readonly providerResults: readonly ProviderResult[]
  readonly goSnapshot?: ForkUsageSnapshot
}): ResetAgendaResult {
  const generatedAt = input.generatedAt ?? Date.now()
  const occurrences = new Map<string, MutableOccurrence>()
  const failures: ResetFailure[] = []

  for (const result of input.providerResults) {
    if (result.providerId === "opencode-go") continue
    if (!result.ok) {
      failures.push({
        providerId: result.providerId,
        providerName: result.providerName,
        error: result.error ?? "Usage data unavailable",
      })
      continue
    }
    addProviderResult(occurrences, result, input.from, input.to)
  }

  if (input.goSnapshot) addGoSnapshot(occurrences, input.goSnapshot, input.from, input.to, generatedAt)

  const rows = [...occurrences.values()]
  for (const row of rows) row.windows.sort((a, b) => a.key.localeCompare(b.key))
  rows.sort((a, b) => {
    if (a.resetAt !== b.resetAt) return a.resetAt - b.resetAt
    const provider = a.providerName.localeCompare(b.providerName)
    if (provider !== 0) return provider
    const account = (a.accountLabel ?? "").localeCompare(b.accountLabel ?? "")
    if (account !== 0) return account
    return (a.model ?? "").localeCompare(b.model ?? "")
  })

  failures.sort((a, b) => a.providerName.localeCompare(b.providerName))

  return {
    from: input.from,
    to: input.to,
    generatedAt,
    occurrences: rows,
    failures,
  }
}
