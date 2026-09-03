import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { splitAccountModelID } from "@opencode-ai/schema/model-account-identity"
import { ZenRegistry, ZenRouter, type ZenAccount } from "./zen-accounts"

/**
 * OpenCode Zen multi-key routing plugin.
 *
 * Zen is a plain OpenAI-compatible API, so no loopback proxy is needed. The
 * router holds the single routing/auth authority through `zenProviderFetch`,
 * an options.fetch wrapper injected by the opencode provider loader
 * (resolveSDK passes provider options.fetch through to the SDK). The wrapper
 * parses the request body's model field, splits the `@zen-...` account
 * suffix, binds or affinity-selects the account, rewrites the wire model id
 * to the base id (upstream never sees the suffix), sets the Authorization
 * header, and observes non-ok responses directly into the key's governor.
 *
 * Per-account model variants are emitted from the provider.models hook as
 * `${baseModelID}@${account.id}` with `${baseName} (${label})` display names;
 * the bare catalog models remain the automatic (router-managed) entries.
 *
 * Failures and completions are still observed through the "event" hook as a
 * secondary path: an APIError on a persisted assistant message is attributed
 * to the session's bound key, and a completed message with no error is
 * evidence the key is healthy again — this also catches in-band errors
 * inside 200 SSE streams the fetch wrapper cannot see.
 *
 * Fork precedence: while a fork_credential is active, the wrapper never sets
 * Authorization (mirroring the provider fork override at provider.ts), so
 * fork usage attribution and existing fork behavior stay intact; the wire
 * model id is still de-qualified so requests succeed on the fork key. A
 * one-time notice says so, so ignored OPENCODE_API_KEYS are never a silent
 * mystery.
 */

const PROVIDER_ID = "opencode"
const FORK_ACTIVE_TTL_MS = 60_000
const ZEN_ACCOUNT_SPLIT = [{ id: "opencode", accountPrefix: "zen-", aliasMarkers: [] }]

let zenRegistry = new ZenRegistry()
let zenRouter = new ZenRouter({ registry: zenRegistry })

let forkClient: ReturnType<typeof createOpencodeClient> | undefined
let forkActiveCache: { value: boolean; at: number } | undefined
let forkNoticeLogged = false
let zenServerUrl: URL | undefined
let testFetch: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | undefined

/** Test-only: isolate the registry/router state from the user's real store. */
export function setTestZenAccountStore(root: string | undefined) {
  if (!root) return
  zenRegistry = new ZenRegistry({ persistenceDir: `${root}/state` })
  zenRouter = new ZenRouter({ registry: zenRegistry })
}

/** Test-only: pin the fork-active lookup to a fixed value. */
export function setTestZenForkActive(value: boolean | undefined) {
  forkActiveCache = value === undefined ? undefined : { value, at: Date.now() }
}

/** Test-only: clear the one-time fork notice latch. */
export function resetZenForkNotice() {
  forkNoticeLogged = false
}

/** Test-only: replace the base fetch used by the provider wrapper. */
export function setTestZenFetch(value: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | undefined) {
  testFetch = value
}

async function forkCredentialActive(): Promise<boolean> {
  if (forkActiveCache && Date.now() - forkActiveCache.at < FORK_ACTIVE_TTL_MS) return forkActiveCache.value
  try {
    forkClient ??= createOpencodeClient({ baseUrl: (zenServerUrl ?? new URL("http://127.0.0.1:4096")).toString() })
    const response = await forkClient.fork.credential.list()
    const credentials = response.data ?? []
    const active = credentials.some((credential) => credential.active)
    forkActiveCache = { value: active, at: Date.now() }
    return active
  } catch {
    // The fork store is unreachable (e.g. embedded server without the route):
    // assume no active credential so env multi-key routing still engages.
    forkActiveCache = { value: false, at: Date.now() }
    return false
  }
}

function logForkNotice() {
  if (forkNoticeLogged) return
  forkNoticeLogged = true
  console.warn(
    "[zen] multi-key routing disabled: a fork credential is active, so OPENCODE_API_KEY(S) are ignored and requests use the fork key",
  )
}

function parseBodyModel(init: RequestInit | undefined): { body: any; model?: string } {
  if (typeof init?.body !== "string" || !init.body) return { body: undefined }
  try {
    const parsed = JSON.parse(init.body)
    return { body: parsed, model: typeof parsed?.model === "string" ? parsed.model : undefined }
  } catch {
    return { body: undefined }
  }
}

/**
 * Single routing/auth authority for every opencode-provider request. See the
 * module doc: splits `@zen-...` account suffixes, picks the key, de-qualifies
 * the wire model id, sets Authorization, and observes non-ok responses.
 */
export async function zenProviderFetch(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const baseFetch = testFetch ?? fetch
  if (zenRegistry.all().length === 0) return baseFetch(url, init)

  const headers = new Headers(init?.headers)
  const session =
    headers.get("x-opencode-session") ?? headers.get("x-session-affinity") ?? headers.get("x-session-id") ?? "default"
  const { body, model: requestedModel } = parseBodyModel(init)
  const split = requestedModel ? splitAccountModelID(requestedModel, ZEN_ACCOUNT_SPLIT) : undefined
  const qualified = split?.accountID !== undefined
  const baseModel = split?.baseModelID ?? requestedModel

  let account: ZenAccount | undefined
  if (split?.accountID) {
    const pinned = zenRegistry.get(split.accountID)
    if (pinned) {
      zenRouter.bind(session, pinned.id)
      account = pinned
    }
  }
  account ??= (baseModel ? zenRouter.select(session, baseModel) : undefined)?.account

  if (await forkCredentialActive()) {
    logForkNotice()
    const nextInit = qualified && baseModel && body ? { ...init, body: JSON.stringify({ ...body, model: baseModel }) } : init
    return baseFetch(url, nextInit)
  }

  let nextInit = init
  if (account) {
    headers.set("Authorization", `Bearer ${account.apiKey}`)
    nextInit = { ...init, headers }
  }
  if (qualified && baseModel && body) {
    nextInit = { ...nextInit, body: JSON.stringify({ ...body, model: baseModel }) }
  }

  const response = await baseFetch(url, nextInit)
  if (account && !response.ok) {
    const raw = await response.clone().text().catch(() => "")
    account.governor.observe({
      status: response.status,
      body: raw,
      headers: Object.fromEntries(response.headers.entries()),
      model: baseModel,
    })
  }
  return response
}

/** Pin a session to a specific key; the pin becomes the new sticky binding. */
export function zenPinSession(sessionID: string, accountId: string): boolean {
  return zenRouter.bind(sessionID, accountId) !== undefined
}

export function zenSessionBinding(sessionID: string): string | undefined {
  return zenRouter.binding(sessionID)
}

export function zenLimitSnapshot(now = Date.now()) {
  const accounts = zenRegistry.all()
  const order = zenRouter.failoverOrder(accounts, now)
  const positions = new Map(order.map((account, index) => [account.id, index + 1]))
  return accounts.map((account) => {
    const metrics = account.governor.metrics(now)
    return {
      accountId: account.id,
      label: account.label,
      source: account.source,
      everUsed: account.everUsed,
      state: metrics.state,
      resetAt: metrics.resetAt,
      usable: metrics.usable,
      queuePosition: positions.get(account.id) ?? null,
      hits: metrics.hits,
    }
  })
}

function observedError(info: any):
  | {
      status?: number
      body?: string
      headers?: Record<string, string>
    }
  | undefined {
  const error = info?.error
  if (!error || error.name !== "APIError") return undefined
  const data = error.data ?? error
  return {
    status: typeof data?.statusCode === "number" ? data.statusCode : undefined,
    body: typeof data?.responseBody === "string" ? data.responseBody : undefined,
    headers:
      data?.responseHeaders && typeof data.responseHeaders === "object" ? (data.responseHeaders as Record<string, string>) : undefined,
  }
}

export async function ZenPlugin(input: PluginInput): Promise<Hooks> {
  zenServerUrl = input.serverUrl
  return {
    provider: {
      id: PROVIDER_ID,
      models: async (provider) => {
        const accounts = zenRegistry.all()
        if (accounts.length === 0) return provider.models
        const merged: Record<string, (typeof provider.models)[string]> = { ...provider.models }
        for (const account of accounts) {
          for (const model of Object.values(provider.models)) {
            const exposedId = `${model.id}@${account.id}`
            merged[exposedId] = {
              ...model,
              id: exposedId,
              name: `${model.name} (${account.label})`,
              api: { ...model.api, id: exposedId },
            } as (typeof provider.models)[string]
          }
        }
        return merged
      },
    },

    event: async ({ event }) => {
      const payload = event as { type?: string; properties?: any }
      if (payload?.type !== "message.updated") return
      const properties = payload.properties
      const info = properties?.info
      if (!info || info.providerID !== PROVIDER_ID) return
      const sessionID = properties?.sessionID
      if (typeof sessionID !== "string" || !sessionID) return
      const binding = zenRouter.binding(sessionID)
      if (!binding) return
      const account = zenRegistry.get(binding)
      if (!account) return
      const error = observedError(info)
      if (error) {
        account.governor.observe({
          status: error.status,
          body: error.body,
          headers: error.headers,
          model: typeof info.modelID === "string" ? info.modelID : undefined,
        })
        return
      }
      // A completed assistant message with no error is direct evidence the
      // bound key works; only feed it when the governor currently holds the
      // key back, so ordinary updates do not spam persistence.
      const completedAt = info?.time?.completed
      if (typeof completedAt !== "number") return
      if (account.governor.metrics(completedAt).state === "READY") return
      account.governor.observe({
        status: 200,
        at: completedAt,
        model: typeof info.modelID === "string" ? info.modelID : undefined,
      })
    },
  }
}
