export * as ProviderAccount from "./provider-account"

import { Schema } from "effect"
import { Credential } from "./credential"
import { Provider } from "./provider"
import { optional } from "./schema"

export const ID = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
).annotate({ identifier: "ProviderAccount.ID" })
export type ID = typeof ID.Type

export const AuthType = Schema.Literals(["key", "oauth"]).annotate({
  identifier: "ProviderAccount.AuthType",
})
export type AuthType = typeof AuthType.Type

export const Source = Schema.Literals([
  "credential",
  "fork-vault",
  "env",
  "legacy",
]).annotate({ identifier: "ProviderAccount.Source" })
export type Source = typeof Source.Type

export const Metadata = Schema.Struct({
  email: Schema.String.pipe(optional),
  remoteUserID: Schema.String.pipe(optional),
  orgID: Schema.String.pipe(optional),
  orgName: Schema.String.pipe(optional),
  server: Schema.String.pipe(optional),
}).annotate({ identifier: "ProviderAccount.Metadata" })
export type Metadata = typeof Metadata.Type

/**
 * Secret-free account identity shared by routing, accounting, inspection and UI.
 *
 * credentialID is the local storage handle. accountID is the stable provider
 * identity. Mutable labels and safe metadata are never routing authority.
 */
export const Info = Schema.Struct({
  providerID: Provider.ID,
  credentialID: Credential.ID,
  accountID: ID,
  label: Schema.String,
  active: Schema.Boolean,
  authType: AuthType,
  source: Source,
  metadata: Metadata.pipe(optional),
}).annotate({ identifier: "ProviderAccount" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
