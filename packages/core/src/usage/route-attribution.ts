export * as UsageRouteAttribution from "./route-attribution"

/**
 * Durable Usage settlement route attribution.
 *
 * Usage records which committed provider route paid for a settled generation.
 * The committed route is the authority. Transport-observed account metadata is
 * validation only, and an account-qualified model id is legacy compatibility
 * data -- neither may silently become the settled account.
 *
 * Two facts are deliberately kept apart and must never be collapsed:
 *
 * - `public`  - an account-free hosted route. It has no account at all.
 * - `unknown` - no committed route attribution was available: pre-route-ledger
 *               history, a legacy settlement path, or a rejected attribution.
 *
 * `public` and `unknown` are both account-free, so both project to a NULL
 * `usage_record.account_id`. Durable `route_kind` preserves their distinction:
 * new settlements write `public|account|unknown`, while pre-migration rows may
 * retain SQL NULL as historical unknown. Never invent `accountID = "public"`
 * to fake the distinction: an invented account is a real,
 * billable, wrong identity that later per-account quota/capacity aggregation will
 * happily charge against a route that never had one.
 *
 * This module is pure and secret-free. It performs no I/O and never sees a
 * credential value; a `credentialHandle` or `credentialRevision` reaching a
 * settlement ledger is a leak, so committed input carrying them fails closed
 * instead of being quietly trimmed.
 */

/** Durable settlement route vocabulary. `unknown` is the legacy/absent case. */
export type Kind = "public" | "account" | "unknown"

/** Secret-free settled route attribution. `accountID` exists only for `account`. */
export interface Attribution {
  readonly kind: Kind
  readonly accountID?: string
}

/**
 * The only committed-route shape Usage accepts.
 *
 * Structurally compatible with the P5A `RouteAttribution` projection, so the
 * committed lease can be forwarded as-is. It is intentionally narrower than a
 * lease: no credential handle, no credential revision, no secret.
 */
export interface Committed {
  readonly routeKind: "public" | "account"
  readonly accountID?: string
}

/** Why a committed attribution was refused. Each value is a fail-closed reason. */
export type Rejection =
  | "not-an-object"
  | "unknown-route-kind"
  | "public-with-account"
  | "account-without-account"
  | "secret-material"

/**
 * Keys that must never reach a durable settlement ledger.
 *
 * A committed account route resolves its credential through an opaque handle;
 * the handle and its trusted revision are execution/client-cache inputs, not
 * accounting identity. Their presence at settlement is a leak, not extra detail.
 */
export const FORBIDDEN_KEYS = [
  "credentialHandle",
  "credentialRevision",
  "secret",
  "token",
  "accessToken",
  "refreshToken",
  "apiKey",
  "authorization",
  "headers",
] as const

export type Normalized =
  | { readonly ok: true; readonly attribution: Attribution }
  | { readonly ok: false; readonly rejection: Rejection; readonly attribution: Attribution }

const UNKNOWN: Attribution = { kind: "unknown" }

/**
 * Project an optional committed route into a secret-free settlement attribution.
 *
 * Absence is not a failure: a settlement with no committed route settles as
 * `unknown`. A present-but-unusable attribution fails closed to `unknown` rather
 * than falling back to transport data, because falling back is how a public
 * route ends up billed to an account.
 */
export function normalize(input: unknown): Normalized {
  if (input === undefined || input === null) return { ok: true, attribution: UNKNOWN }
  if (typeof input !== "object" || Array.isArray(input))
    return { ok: false, rejection: "not-an-object", attribution: UNKNOWN }

  const record = input as Record<string, unknown>
  for (const key of FORBIDDEN_KEYS) {
    if (record[key] !== undefined) return { ok: false, rejection: "secret-material", attribution: UNKNOWN }
  }

  if (record.routeKind === "public") {
    if (record.accountID !== undefined) return { ok: false, rejection: "public-with-account", attribution: UNKNOWN }
    return { ok: true, attribution: { kind: "public" } }
  }

  if (record.routeKind === "account") {
    const accountID = record.accountID
    if (typeof accountID !== "string" || accountID.length === 0)
      return { ok: false, rejection: "account-without-account", attribution: UNKNOWN }
    return { ok: true, attribution: { kind: "account", accountID } }
  }

  return { ok: false, rejection: "unknown-route-kind", attribution: UNKNOWN }
}

/**
 * The `account_id` value for a settled attribution.
 *
 * `public` and `unknown` are both account-free, so both settle to `undefined`
 * (SQL NULL). Only an `account` route contributes an account identity.
 */
export function accountColumn(attribution: Attribution): string | undefined {
  return attribution.kind === "account" ? attribution.accountID : undefined
}

export interface SettleInput {
  /**
   * Committed route attribution for the generation, or `undefined` when no
   * durable route binding existed (legacy/pre-ledger settlement).
   */
  readonly route?: unknown
  /**
   * Account observed from transport response metadata. Validation only; it can
   * never outrank a committed account route.
   */
  readonly observedAccountID?: string
  /** Legacy account suffix parsed out of the account-qualified model id. */
  readonly modelAccountID?: string
}

export interface Settled {
  readonly attribution: Attribution
  /** Value written to `usage_record.account_id`; `undefined` means NULL. */
  readonly accountID: string | undefined
  /** Set only when a present committed attribution was refused. */
  readonly rejection?: Rejection
}

/**
 * Resolve one settlement's account identity from committed route authority.
 *
 * Three cases, in strict order:
 *
 * 1. No committed route: preserve the exact legacy derivation
 *    (`observedAccountID ?? modelAccountID`) so pre-ledger history and uncut
 *    execution paths keep their current attribution.
 * 2. Committed route accepted: it is authoritative. A `public` route settles
 *    account-free even when the model id still carries a legacy account suffix,
 *    and an `account` route settles its own stable `accountID` even when
 *    transport metadata or the suffix disagrees with it.
 * 3. Committed route refused: settle `unknown`/NULL. Never reuse transport or
 *    suffix data for an attribution that was explicitly presented and rejected.
 */
export function settle(input: SettleInput): Settled {
  if (input.route === undefined) {
    const accountID = input.observedAccountID ?? input.modelAccountID
    return {
      attribution: accountID ? { kind: "account", accountID } : UNKNOWN,
      accountID,
    }
  }

  const normalized = normalize(input.route)
  if (!normalized.ok) {
    return { attribution: normalized.attribution, accountID: undefined, rejection: normalized.rejection }
  }
  return { attribution: normalized.attribution, accountID: accountColumn(normalized.attribution) }
}
