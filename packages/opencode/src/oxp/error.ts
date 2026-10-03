import { Schema } from "effect"

export const MAX_DETAIL_LENGTH = 1024

const Detail = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024))
const MetadataKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))
const MetadataValue = Schema.Union([
  Schema.String.check(Schema.isMaxLength(256)),
  Schema.Number,
  Schema.Boolean,
])

export const Metadata = Schema.Record(MetadataKey, MetadataValue)
export type Metadata = Schema.Schema.Type<typeof Metadata>

/**
 * Normalize diagnostics crossing into the OXP error contract.
 *
 * Downstream runtimes may return arbitrarily large messages (patch context,
 * compiler output, provider diagnostics, etc). OXP intentionally bounds error
 * detail, so adapters must truncate before constructing a tagged error instead
 * of throwing a second schema error while reporting the first failure.
 */
export function boundDetail(
  value: unknown,
  fallback = "OXP operation failed",
): string {
  const raw =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : value == null
          ? ""
          : String(value)
  const text = raw.length > 0 ? raw : fallback
  if (text.length <= MAX_DETAIL_LENGTH) return text
  return text.slice(0, MAX_DETAIL_LENGTH - 3) + "..."
}

const fields = {
  detail: Detail,
  metadata: Schema.optional(Metadata),
}

export class InvalidArgument extends Schema.TaggedErrorClass<InvalidArgument>()("OXP_INVALID_ARGUMENT", fields) {
  override get message() {
    return this.detail
  }
}

export class AuthDenied extends Schema.TaggedErrorClass<AuthDenied>()("OXP_AUTH_DENIED", fields) {
  override get message() {
    return this.detail
  }
}

export class AuthRevoked extends Schema.TaggedErrorClass<AuthRevoked>()("OXP_AUTH_REVOKED", fields) {
  override get message() {
    return this.detail
  }
}

export class RootRequired extends Schema.TaggedErrorClass<RootRequired>()("OXP_ROOT_REQUIRED", fields) {
  override get message() {
    return this.detail
  }
}

export class RootNotFound extends Schema.TaggedErrorClass<RootNotFound>()("OXP_ROOT_NOT_FOUND", fields) {
  override get message() {
    return this.detail
  }
}

export class RootChanged extends Schema.TaggedErrorClass<RootChanged>()("OXP_ROOT_CHANGED", fields) {
  override get message() {
    return this.detail
  }
}

export class PathEscape extends Schema.TaggedErrorClass<PathEscape>()("OXP_PATH_ESCAPE", fields) {
  override get message() {
    return this.detail
  }
}

export class Conflict extends Schema.TaggedErrorClass<Conflict>()("OXP_CONFLICT", fields) {
  override get message() {
    return this.detail
  }
}

export class NotFound extends Schema.TaggedErrorClass<NotFound>()("OXP_NOT_FOUND", fields) {
  override get message() {
    return this.detail
  }
}

export class HandleStale extends Schema.TaggedErrorClass<HandleStale>()("OXP_HANDLE_STALE", fields) {
  override get message() {
    return this.detail
  }
}

export class Busy extends Schema.TaggedErrorClass<Busy>()("OXP_BUSY", fields) {
  override get message() {
    return this.detail
  }
}

export class Timeout extends Schema.TaggedErrorClass<Timeout>()("OXP_TIMEOUT", fields) {
  override get message() {
    return this.detail
  }
}

export class Cancelled extends Schema.TaggedErrorClass<Cancelled>()("OXP_CANCELLED", fields) {
  override get message() {
    return this.detail
  }
}

export class DependencyUnavailable extends Schema.TaggedErrorClass<DependencyUnavailable>()(
  "OXP_DEPENDENCY_UNAVAILABLE",
  fields,
) {
  override get message() {
    return this.detail
  }
}

export class ProviderAccountUnavailable extends Schema.TaggedErrorClass<ProviderAccountUnavailable>()(
  "OXP_PROVIDER_ACCOUNT_UNAVAILABLE",
  fields,
) {
  override get message() {
    return this.detail
  }
}

/**
 * An explicit route choice this host cannot bind yet. Deliberately distinct
 * from ProviderAccountUnavailable: Public is a route class rather than a
 * provider account, so this error never carries an account identity for it.
 */
export class RouteBindingUnavailable extends Schema.TaggedErrorClass<RouteBindingUnavailable>()(
  "OXP_ROUTE_BINDING_UNAVAILABLE",
  fields,
) {
  override get message() {
    return this.detail
  }
}

export class IntegrationOffline extends Schema.TaggedErrorClass<IntegrationOffline>()("OXP_INTEGRATION_OFFLINE", fields) {
  override get message() {
    return this.detail
  }
}

export class AmbiguousExternalResult extends Schema.TaggedErrorClass<AmbiguousExternalResult>()(
  "OXP_AMBIGUOUS_EXTERNAL_RESULT",
  fields,
) {
  override get message() {
    return this.detail
  }
}

export type Error =
  | InvalidArgument
  | AuthDenied
  | AuthRevoked
  | RootRequired
  | RootNotFound
  | RootChanged
  | PathEscape
  | Conflict
  | NotFound
  | HandleStale
  | Busy
  | Timeout
  | Cancelled
  | DependencyUnavailable
  | ProviderAccountUnavailable
  | RouteBindingUnavailable
  | IntegrationOffline
  | AmbiguousExternalResult

const tags = new Set([
  "OXP_INVALID_ARGUMENT",
  "OXP_AUTH_DENIED",
  "OXP_AUTH_REVOKED",
  "OXP_ROOT_REQUIRED",
  "OXP_ROOT_NOT_FOUND",
  "OXP_ROOT_CHANGED",
  "OXP_PATH_ESCAPE",
  "OXP_CONFLICT",
  "OXP_NOT_FOUND",
  "OXP_HANDLE_STALE",
  "OXP_BUSY",
  "OXP_TIMEOUT",
  "OXP_CANCELLED",
  "OXP_DEPENDENCY_UNAVAILABLE",
  "OXP_PROVIDER_ACCOUNT_UNAVAILABLE",
  "OXP_ROUTE_BINDING_UNAVAILABLE",
  "OXP_INTEGRATION_OFFLINE",
  "OXP_AMBIGUOUS_EXTERNAL_RESULT",
])

export function isError(value: unknown): value is Error {
  return typeof value === "object" && value !== null && "_tag" in value && tags.has(String(value._tag))
}

export * as OxpError from "./error"
