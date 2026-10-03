export * as OpencodeAccountModel from "./opencode-account-model"

import { ConfigProviderOptionsV1 } from "../../v1/config/provider-options"
import { ModelV2 } from "../../model"
import type { AccountProviderCapability } from "./opencode-account-capability"

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {}

const string = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined

const sensitiveHeaders = new Set(["authorization", "proxy-authorization", "x-api-key", "api-key"])

const headers = (value: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(record(value)).flatMap(([key, child]) =>
      typeof child === "string" && !sensitiveHeaders.has(key.toLowerCase()) ? [[key, child]] : [],
    ),
  )

const sensitiveOptions = new Set([
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
  "headers",
])

const withoutTransportCredentials = (value: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(
    Object.entries(value).filter(([key]) => {
      const normalized = key.replaceAll(/[-_]/g, "").toLowerCase()
      return !sensitiveOptions.has(normalized)
    }),
  )

/**
 * Compile the exact account-scoped transport for one committed lease.
 *
 * The base model may have passed through location catalog transforms, so none
 * of its request/auth transport is inherited. It is used only for descriptive
 * model metadata and non-secret limits/capabilities. Endpoint/package/model-id,
 * request headers/body, and variants come exclusively from the sanitized
 * account capability produced from this exact account's /api/config snapshot.
 */
export function compile(
  base: ModelV2.Info,
  provider: AccountProviderCapability,
  modelID: string,
): ModelV2.Info | undefined {
  const capability = provider.models[modelID]
  if (!capability) return undefined

  const raw = record(capability.config)
  const rawProvider = record(raw.provider)
  const packageName =
    string(rawProvider.npm) ??
    provider.npm ??
    (base.api.type === "aisdk" ? base.api.package : undefined)
  const apiURL =
    string(rawProvider.api) ??
    provider.api ??
    string(provider.options.baseURL) ??
    base.api.url

  const api: ModelV2.Info["api"] = packageName
    ? {
        id: ModelV2.ID.make(capability.apiID),
        type: "aisdk",
        package: packageName,
        ...(apiURL ? { url: apiURL } : {}),
      }
    : {
        id: ModelV2.ID.make(capability.apiID),
        type: "native",
        ...(apiURL ? { url: apiURL } : {}),
        settings: {},
      }

  const lowerer = ConfigProviderOptionsV1.get(packageName)
  const providerOptions = withoutTransportCredentials(provider.options)
  const modelOptions = withoutTransportCredentials(record(raw.options))
  const requestHeaders = {
    ...(provider.headers ?? {}),
    ...headers(raw.headers),
  }
  const requestBody = {
    ...lowerer.request(providerOptions),
    ...lowerer.request(modelOptions),
  }

  const configuredVariants = record(raw.variants)
  const variants =
    Object.keys(configuredVariants).length === 0
      ? []
      : Object.entries(configuredVariants).flatMap(([id, value]) => {
          const item = record(value)
          if (item.disabled === true) return []
          return [{
            id: ModelV2.VariantID.make(id),
            headers: headers(item.headers),
            body: lowerer.request(withoutTransportCredentials(record(item.options))),
          }]
        })

  return ModelV2.Info.make({
    ...base,
    id: ModelV2.ID.make(modelID),
    api,
    request: {
      headers: requestHeaders,
      body: requestBody,
      ...(base.request.variant === undefined ? {} : { variant: base.request.variant }),
    },
    variants,
  })
}