import { Hash } from "../../util/hash"
import type { Snapshot } from "./opencode-account-config"

const SENSITIVE_OPTION_KEYS = new Set([
  "apikey",
  "token",
  "accesstoken",
  "refreshtoken",
  "secret",
  "password",
  "authorization",
  "proxyauthorization",
  "xapikey",
  "credential",
  "credentials",
])

const SENSITIVE_HEADER_KEYS = new Set(["authorization", "proxy-authorization", "x-api-key", "api-key"])

function sanitize(value: unknown, key?: string): unknown {
  const normalized = key?.replaceAll(/[-_]/g, "").toLowerCase()
  if (normalized && SENSITIVE_OPTION_KEYS.has(normalized)) return undefined
  if (Array.isArray(value)) return value.map((item) => sanitize(item))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).flatMap(([childKey, child]) => {
      const next = sanitize(child, childKey)
      return next === undefined ? [] : [[childKey, next]]
    }),
  )
}

function sanitizeHeaders(headers: Readonly<Record<string, string>> | undefined) {
  if (!headers) return undefined
  const result = Object.fromEntries(
    Object.entries(headers).filter(([key]) => !SENSITIVE_HEADER_KEYS.has(key.toLowerCase())),
  )
  return Object.keys(result).length > 0 ? result : undefined
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonical(child)]),
  )
}

export interface AccountModelCapability {
  /** Account-neutral V1 selection key from the provider's models record. */
  readonly id: string
  /** Provider-wire model id; may differ from the selection key. */
  readonly apiID: string
  readonly providerID: string
  readonly config: Readonly<Record<string, unknown>>
}

export interface AccountProviderCapability {
  /** Account-neutral V1 provider selection key from the config record. */
  readonly id: string
  readonly name?: string
  readonly configuredID?: string
  readonly api?: string
  readonly npm?: string
  readonly options: Readonly<Record<string, unknown>>
  readonly headers?: Readonly<Record<string, string>>
  readonly models: Readonly<Record<string, AccountModelCapability>>
  /** Stable, secret-free identity of this account-specific transport definition. */
  readonly configIdentity: string
}

export interface AccountCapabilitySnapshot {
  readonly scope: string
  readonly credentialID: Snapshot["credentialID"]
  readonly credentialRevision: number
  readonly configVersion: number
  readonly providers: Readonly<Record<string, AccountProviderCapability>>
  readonly servesModel: (providerID: string, modelID: string) => boolean
}

/**
 * Compile a secret-free routing/execution capability index from one account's
 * decoded Console config. This is not the user-facing merged discovery catalog:
 * it remains account-specific and is safe to attach to a router Candidate.
 */
export function projectAccountCapabilities(snapshot: Snapshot): AccountCapabilitySnapshot {
  const providers: Record<string, AccountProviderCapability> = {}

  for (const [providerKey, rawProvider] of Object.entries(snapshot.config?.provider ?? {})) {
    const providerID = providerKey
    const configuredID = rawProvider.id?.trim()
    const options = (sanitize(rawProvider.options ?? {}) ?? {}) as Record<string, unknown>
    const providerHeaders = sanitizeHeaders(
      rawProvider.options && typeof rawProvider.options === "object"
        ? ((rawProvider.options as Record<string, unknown>).headers as Record<string, string> | undefined)
        : undefined,
    )

    const models: Record<string, AccountModelCapability> = {}
    for (const [modelKey, rawModel] of Object.entries(rawProvider.models ?? {})) {
      const apiID = rawModel.id?.trim() || modelKey
      const modelConfig = sanitize({
        ...rawModel,
        ...(rawModel.id ? { id: apiID } : {}),
        headers: sanitizeHeaders(rawModel.headers),
      }) as Record<string, unknown>
      models[modelKey] = { id: modelKey, apiID, providerID, config: modelConfig }
    }

    const transport = {
      providerID,
      configuredID,
      api: rawProvider.api,
      npm: rawProvider.npm,
      options,
      headers: providerHeaders,
      models: Object.fromEntries(
        Object.entries(models).map(([id, model]) => [id, model.config]),
      ),
    }
    providers[providerID] = {
      id: providerID,
      ...(rawProvider.name ? { name: rawProvider.name } : {}),
      ...(configuredID ? { configuredID } : {}),
      ...(rawProvider.api ? { api: rawProvider.api } : {}),
      ...(rawProvider.npm ? { npm: rawProvider.npm } : {}),
      options,
      ...(providerHeaders ? { headers: providerHeaders } : {}),
      models,
      configIdentity: Hash.fast(JSON.stringify(canonical(transport))),
    }
  }

  return {
    scope: snapshot.scope,
    credentialID: snapshot.credentialID,
    credentialRevision: snapshot.credentialRevision,
    configVersion: snapshot.version,
    providers,
    servesModel: (providerID, modelID) => providers[providerID]?.models[modelID] !== undefined,
  }
}
