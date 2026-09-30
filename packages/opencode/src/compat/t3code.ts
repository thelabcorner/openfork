import { Buffer } from "node:buffer"
import { splitModelIDForProvider } from "@opencode-ai/schema/model-select/account-identity"

/**
 * Explicit local-client compatibility profile for pingdotgg/t3code.
 *
 * T3 Code currently consumes OpenCode through @opencode-ai/sdk 1.15.13 and
 * rejects reported OpenCode versions >= 2.0.0. OpenFork is an independent
 * product, so this profile is opt-in and only changes the compatibility facade
 * observed by a T3-launched process; it never changes canonical OpenFork
 * product/version identity.
 */
export const T3_CODE_COMPAT_PROFILE = "t3code-opencode-v1" as const
export const T3_CODE_COMPAT_EXECUTABLE = "openfork-t3code" as const
export const T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION = "1.15.13" as const
export const OPENFORK_COMPAT_PROFILE_ENV = "OPENFORK_COMPAT_PROFILE" as const
export const T3_CODE_ACCOUNT_MODEL_MARKER = "@ofacct:" as const
const T3_CODE_ACCOUNT_TOKEN_NAMESPACE = "openfork-t3code-account-v1:"

type Environment = Readonly<Record<string, string | undefined>>

export function isT3CodeCompatibilityProfile(
  environment: Environment = process.env,
): boolean {
  return environment[OPENFORK_COMPAT_PROFILE_ENV] === T3_CODE_COMPAT_PROFILE
}

/**
 * Version projected to OpenCode-compatible local clients.
 *
 * Keep the real OpenFork version everywhere except the explicit T3 facade.
 * The facade version is the audited SDK contract version, not the OpenFork
 * product release number.
 */
export function localClientReportedVersion(
  nativeVersion: string,
  environment: Environment = process.env,
): string {
  return isT3CodeCompatibilityProfile(environment)
    ? T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION
    : nativeVersion
}

/**
 * T3 historically matched the literal OpenCode startup prefix. Current T3 is
 * more permissive, but the explicit facade keeps the old spelling so both
 * generations remain compatible without changing normal OpenFork branding.
 */
export function localServerListeningProduct(
  environment: Environment = process.env,
): "opencode" | "OpenFork" {
  return isT3CodeCompatibilityProfile(environment) ? "opencode" : "OpenFork"
}

export interface T3CodeModelRef {
  readonly providerID: string
  readonly modelID: string
  readonly accountID?: string
}

/**
 * Compatibility-only account-qualified model identity used for first-class
 * ProviderAccount routes that have no legacy provider-specific model suffix.
 *
 * The account id is reversible rather than hashed so the adapter never owns a
 * second identity map. base64url keeps arbitrary stable provider account ids
 * opaque to T3 while staying safe inside an OpenCode model-id string.
 */
export function t3CodeAccountModelID(baseModelID: string, accountID: string): string {
  const payload = `${T3_CODE_ACCOUNT_TOKEN_NAMESPACE}${accountID}`
  return `${baseModelID}${T3_CODE_ACCOUNT_MODEL_MARKER}${Buffer.from(payload, "utf8").toString("base64url")}`
}

function splitT3CodeAccountModelID(modelID: string): { readonly baseModelID: string; readonly accountID: string } | undefined {
  const separator = modelID.lastIndexOf(T3_CODE_ACCOUNT_MODEL_MARKER)
  if (separator <= 0) return undefined
  const token = modelID.slice(separator + T3_CODE_ACCOUNT_MODEL_MARKER.length)
  if (!token || !/^[A-Za-z0-9_-]+$/.test(token)) return undefined
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8")
    if (Buffer.from(decoded, "utf8").toString("base64url") !== token) return undefined
    // New aliases carry an explicit namespace sentinel so an unrelated model
    // ending in @ofacct:<valid-base64url> cannot be mistaken for our wire ABI.
    // Accept the short-lived pre-namespace form only for the stable Console
    // account ids this adapter actually emitted while the feature was landing.
    const accountID = decoded.startsWith(T3_CODE_ACCOUNT_TOKEN_NAMESPACE)
      ? decoded.slice(T3_CODE_ACCOUNT_TOKEN_NAMESPACE.length)
      : decoded.startsWith("opencode-account:")
        ? decoded
        : undefined
    if (!accountID || accountID.length > 256 || /[\x00-\x1f\x7f]/.test(accountID)) return undefined
    return { baseModelID: modelID.slice(0, separator), accountID }
  } catch {
    return undefined
  }
}

/**
 * Lower the model-string ABI consumed by T3 back into OpenFork's canonical
 * provider + account-neutral model + first-class account identity.
 *
 * Outside the explicit T3 profile this is a strict identity function. Known
 * legacy @wb-/@zen- forms use the provider-declared parser; generic Console
 * accounts use only the reserved @ofacct: marker emitted by this adapter.
 */
export function canonicalT3CodeModelRef<T extends T3CodeModelRef>(
  ref: T,
  environment: Environment = process.env,
): T & T3CodeModelRef {
  if (!isT3CodeCompatibilityProfile(environment) || ref.accountID) return ref
  const projected = splitT3CodeAccountModelID(ref.modelID)
  if (projected) {
    return {
      ...ref,
      modelID: projected.baseModelID,
      accountID: projected.accountID,
    }
  }
  const legacy = splitModelIDForProvider(ref.modelID, ref.providerID)
  if (!legacy.accountID) return ref
  return {
    ...ref,
    modelID: legacy.baseModelID,
    accountID: legacy.accountID,
  }
}

export function canonicalT3CodeModelSlug(
  slug: string,
  environment: Environment = process.env,
): { readonly slug: string; readonly accountID?: string } {
  if (!isT3CodeCompatibilityProfile(environment)) return { slug }
  const separator = slug.indexOf("/")
  if (separator <= 0 || separator === slug.length - 1) return { slug }
  const providerID = slug.slice(0, separator)
  const modelID = slug.slice(separator + 1)
  const canonical = canonicalT3CodeModelRef({ providerID, modelID }, environment)
  return {
    slug: `${canonical.providerID}/${canonical.modelID}`,
    ...(canonical.accountID ? { accountID: canonical.accountID } : {}),
  }
}
