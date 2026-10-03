import { defaultSdkLoader, resolveCliPath } from "./availability"
import { buildChildEnv, type ChildEnv } from "./env"
import {
  CLAUDE_SUBSCRIPTION_MODEL_REFRESH_MS,
  claudeSubscriptionCatalogNeedsRefresh,
  recordClaudeSubscriptionModels,
  type ClaudeSdkModelRow,
} from "./models"

let lastRefreshAttemptAt = 0
let refreshInFlight: Promise<boolean> | undefined

/**
 * Minimal SDK query shape used for model discovery. Keeping it here avoids
 * eagerly importing the optional Agent SDK into provider/model listing.
 */
interface SupportedModelsQuery {
  supportedModels?: () => Promise<unknown[]>
  close?: () => void
  return?: () => unknown
}

export interface SupportedModelsHandle {
  supportedModels?: () => Promise<unknown[]>
}

function rows(value: unknown): ClaudeSdkModelRow[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is ClaudeSdkModelRow => {
    if (!item || typeof item !== "object") return false
    const row = item as Record<string, unknown>
    return typeof row.value === "string"
  })
}

function closeQuery(query: SupportedModelsQuery) {
  try {
    if (typeof query.close === "function") query.close()
    else if (typeof query.return === "function") void Promise.resolve(query.return()).catch(() => {})
  } catch {
    // Discovery cleanup is best-effort.
  }
}

async function refreshOnce(
  force: boolean,
  discover: () => Promise<ClaudeSdkModelRow[] | undefined>,
): Promise<boolean> {
  const now = Date.now()
  if (refreshInFlight) return refreshInFlight
  if (!force) {
    if (!claudeSubscriptionCatalogNeedsRefresh(now)) return false
    if (now - lastRefreshAttemptAt < CLAUDE_SUBSCRIPTION_MODEL_REFRESH_MS) return false
  }

  lastRefreshAttemptAt = now
  const active = (async () => {
    const discovered = await discover()
    if (!discovered?.length) return false
    return recordClaudeSubscriptionModels(discovered)
  })().finally(() => {
    if (refreshInFlight === active) refreshInFlight = undefined
  })
  refreshInFlight = active
  return active
}

/**
 * Ask the official Claude Agent SDK/CLI which models the signed-in account can
 * use. This is an explicit active operation; passive provider listing must
 * never call it.
 */
export async function listClaudeSupportedModels(input?: {
  readonly env?: ChildEnv
  readonly timeoutMs?: number
}): Promise<ClaudeSdkModelRow[] | undefined> {
  const sdk = await defaultSdkLoader()
  if (typeof sdk.query !== "function") return undefined

  let release: () => void = () => {}
  const idle = (async function* () {
    await new Promise<void>((resolve) => {
      release = resolve
    })
  })()

  const env = buildChildEnv(input?.env ?? process.env)
  const executable = resolveCliPath(env)
  const query = (sdk.query as (request: unknown) => unknown)({
    prompt: idle,
    options: {
      env,
      persistSession: false,
      settingSources: [],
      strictMcpConfig: true,
      settings: { disableClaudeAiConnectors: true },
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
    },
  }) as SupportedModelsQuery

  const timeoutMs = input?.timeoutMs ?? 20_000
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    if (typeof query.supportedModels !== "function") return undefined
    const result = await Promise.race([
      query.supportedModels(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs)
        timer.unref?.()
      }),
    ])
    const parsed = rows(result)
    return parsed.length ? parsed : undefined
  } finally {
    if (timer) clearTimeout(timer)
    release()
    closeQuery(query)
  }
}

/**
 * Refresh the durable account-visible catalog. A 10-minute freshness gate
 * mirrors opencode-claude's cadence; force=true is used after explicit login.
 */
export async function refreshClaudeSubscriptionModels(input?: {
  readonly force?: boolean
  readonly env?: ChildEnv
  readonly timeoutMs?: number
}): Promise<boolean> {
  const force = Boolean(input?.force)
  if (!force) {
    return refreshOnce(false, () =>
      listClaudeSupportedModels({ env: input?.env, timeoutMs: input?.timeoutMs }),
    )
  }
  return refreshOnce(true, async () => {
    const discovered = await listClaudeSupportedModels({ env: input?.env, timeoutMs: input?.timeoutMs })
    if (!discovered?.length) {
      throw new Error("Claude Agent SDK supportedModels() returned no models")
    }
    return discovered
  })
}

/**
 * Piggyback discovery on the authenticated query OpenFork already owns. This
 * avoids a second Claude process on normal turns while keeping provider
 * listing side-effect-free.
 */
export async function refreshClaudeSubscriptionModelsFromHandle(
  handle: SupportedModelsHandle,
): Promise<boolean> {
  if (typeof handle.supportedModels !== "function") return false
  return refreshOnce(false, async () => {
    try {
      const discovered = rows(await handle.supportedModels!())
      return discovered.length ? discovered : undefined
    } catch {
      return undefined
    }
  })
}

export function resetClaudeModelDiscoveryForTest() {
  lastRefreshAttemptAt = 0
  refreshInFlight = undefined
}

export * as ClaudeModelDiscovery from "./model-discovery"
