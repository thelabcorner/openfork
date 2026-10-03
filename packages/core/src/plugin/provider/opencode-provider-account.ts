export * as OpencodeProviderAccount from "./opencode-provider-account"

import { ProviderAccount } from "@opencode-ai/schema/provider-account"
import { Provider } from "@opencode-ai/schema/provider"
import { Credential } from "../../credential"
import { Hash } from "../../util/hash"
import { DEFAULT_SERVER } from "./opencode-console"
import { integrationID } from "./opencode-auth"

const IDENTITY_NAMESPACE = "openfork-provider-account/opencode/v1"

function metadataString(value: unknown) {
  if (typeof value !== "string") return undefined
  const result = value.trim()
  return result.length > 0 ? result : undefined
}

/**
 * Canonicalize the upstream Console authority used in account identity.
 *
 * Query/fragment/userinfo are invalid for a service realm. URL canonicalization
 * normalizes protocol/host/default ports; a trailing path slash is insignificant.
 */
export function canonicalServer(value: unknown): string | undefined {
  const source = metadataString(value) ?? DEFAULT_SERVER
  try {
    const url = new URL(source)
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined
    if (url.username || url.password || url.search || url.hash) return undefined

    const pathname =
      url.pathname === "/"
        ? ""
        : url.pathname.replace(/\/+$/, "")
    return `${url.origin}${pathname}`
  } catch {
    return undefined
  }
}

export interface IdentityInput {
  readonly server: string
  readonly remoteUserID: string
  readonly orgID?: string
}

/**
 * Collision-resistant, secret-free stable identity.
 *
 * The full SHA-256 digest keeps this suitable as durable routing/accounting
 * authority rather than a cosmetic fingerprint. The tuple is JSON-framed so
 * no delimiter ambiguity can collapse distinct upstream identities.
 */
export function deriveAccountID(input: IdentityInput): ProviderAccount.ID {
  const digest = Hash.sha256(
    JSON.stringify([
      IDENTITY_NAMESPACE,
      input.server,
      input.remoteUserID,
      input.orgID ?? null,
    ]),
  )
  return ProviderAccount.ID.make(`opencode-account:${digest}`)
}

/**
 * Project one canonical Core Credential into a secret-free ProviderAccount.
 *
 * Missing stable upstream user identity fails closed. In particular, this does
 * not fall back to Credential.ID, label, email, or a secret fingerprint.
 */
export function projectCredential(
  credential: Credential.Info,
): ProviderAccount.Info | undefined {
  if (credential.integrationID !== integrationID) return undefined
  // OAuth metadata is produced by the trusted Console enrollment flow. Generic
  // Key metadata has no verified-identity provenance today, so it cannot mint a
  // durable ProviderAccount identity yet.
  if (credential.value.type !== "oauth") return undefined

  const metadata = credential.value.metadata
  const remoteUserID = metadataString(metadata?.accountID)
  if (!remoteUserID) return undefined

  const server = canonicalServer(metadata?.server)
  if (!server) return undefined
  const orgID = metadataString(metadata?.orgID)
  const email = metadataString(metadata?.email)
  const orgName = metadataString(metadata?.orgName)

  return {
    providerID: Provider.ID.opencode,
    credentialID: credential.id,
    accountID: deriveAccountID({ server, remoteUserID, ...(orgID ? { orgID } : {}) }),
    label: credential.label,
    active: credential.active === true,
    authType: "oauth",
    source: "credential",
    metadata: {
      remoteUserID,
      server,
      ...(email ? { email } : {}),
      ...(orgID ? { orgID } : {}),
      ...(orgName ? { orgName } : {}),
    },
  }
}
