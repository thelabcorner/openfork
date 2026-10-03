export * as SessionMetadataOwnership from "./metadata-ownership"

import { Schema } from "effect"
import { ProviderRouteIntent } from "@opencode-ai/schema/model-select/provider-route-intent"

/**
 * Root Session metadata is a V1 compatibility bag. Most keys are caller-owned,
 * but a small set encode producer-owned Session identity and must not be
 * forgeable, erasable, or inherited by a newly derived Session aggregate.
 *
 * Keep this registry narrow. Mutable runtime policy (for example localMcp) does
 * not belong here merely because it is internal.
 */
export const Keys = {
  specialAgent: "specialAgent",
  specialAgentOwnerKind: "specialAgentOwnerKind",
  specialAgentOwnerID: "specialAgentOwnerID",
  scheduledTaskID: "scheduledTaskID",
  scheduledTaskRunID: "scheduledTaskRunID",
  workerDelegation: "workerDelegation",
} as const

export interface WorkerDelegationModel {
  readonly providerID: string
  readonly modelID: string
  readonly accountID?: string
  readonly variant?: string
  /** Secret-free canonical routing intent; never a credential binding. */
  readonly routeIntent?: ProviderRouteIntent.Info
}

export interface WorkerDelegationOrigin {
  /** First-party producer namespace. OXP currently uses "oxp". */
  readonly producer: string
  /** Stable external principal identity, not Session/user identity. */
  readonly principalRef: string
  /** Durable correlation for the delegation operation that created the worker. */
  readonly invocationRef: string
  /** Stable external/root authority identity. */
  readonly rootRef: string
  readonly agent: string
  readonly model: WorkerDelegationModel
  readonly nestedDelegation: boolean
  /** Present on descendants created by the delegated worker runtime. */
  readonly parentWorkerID?: string
}

type Metadata = Readonly<Record<string, unknown>>

const immutableOriginKeys = [
  Keys.specialAgent,
  Keys.specialAgentOwnerKind,
  Keys.specialAgentOwnerID,
  Keys.scheduledTaskID,
  Keys.scheduledTaskRunID,
  Keys.workerDelegation,
] as const

// Current special-agent producers attach these relation details alongside the
// immutable classifier. They are producer-owned only when the Session actually
// is a special-agent transcript; ordinary Sessions may still use the same
// generic metadata names for compatibility.
const specialAgentDetailKeys = ["goalID", "parentSessionID"] as const

const hasOwn = (value: Metadata | undefined, key: string) =>
  value !== undefined && Object.prototype.hasOwnProperty.call(value, key)

function clone(value: Metadata | undefined) {
  return value ? { ...value } : {}
}

function stripImmutableOrigin(value: Record<string, unknown>) {
  for (const key of immutableOriginKeys) delete value[key]
}

/**
 * Canonical aggregate classifier for protected special-agent Sessions.
 * Unknown string values are intentionally treated as protected/fail-closed;
 * callers that need a known Kind may decode it separately.
 */
export function specialAgentKind(value: Metadata | undefined) {
  const kind = value?.[Keys.specialAgent]
  return typeof kind === "string" ? kind : undefined
}

export function specialAgentOwnerKind(value: Metadata | undefined) {
  if (!specialAgentKind(value)) return undefined
  const kind = value?.[Keys.specialAgentOwnerKind]
  return typeof kind === "string" ? kind : undefined
}

export function specialAgentOwnerID(value: Metadata | undefined) {
  if (!specialAgentKind(value)) return undefined
  const id = value?.[Keys.specialAgentOwnerID]
  return typeof id === "string" ? id : undefined
}

export function isSpecialAgent(value: Metadata | undefined) {
  return specialAgentKind(value) !== undefined
}

/**
 * Scheduled-task aggregate ownership is fail-closed on either protected key.
 * A partially-written/legacy row is still producer-owned; malformed origin
 * metadata must not accidentally downgrade it into an interactive Session.
 */
export function hasScheduledTaskOrigin(value: Metadata | undefined) {
  return hasOwn(value, Keys.scheduledTaskID) || hasOwn(value, Keys.scheduledTaskRunID)
}

/** Presence itself is protected/fail-closed even when a row is malformed. */
export function hasWorkerDelegationOrigin(value: Metadata | undefined) {
  return hasOwn(value, Keys.workerDelegation)
}

function stringField(value: Record<string, unknown>, key: string) {
  const field = value[key]
  return typeof field === "string" && field.length > 0 ? field : undefined
}

function sameRouteIntent(left: ProviderRouteIntent.Info, right: ProviderRouteIntent.Info) {
  return (
    left.kind === right.kind &&
    (left.kind !== "account" ||
      (right.kind === "account" &&
        left.accountID === right.accountID &&
        (left.pin ?? "hard") === (right.pin ?? "hard")))
  )
}

/**
 * Canonicalize the protected delegated-worker model migration window.
 *
 * Legacy accountID is a hard account pin; missing route data is Auto. Explicit
 * route intent is authoritative but may coexist with legacy accountID only when
 * both name the exact same account. Account intent without the compatibility
 * field is projected back into accountID so old Session/model surfaces retain
 * the same stable account identity.
 */
export function normalizeWorkerDelegationModel(value: unknown): WorkerDelegationModel | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const model = value as Record<string, unknown>
  const providerID = stringField(model, "providerID")
  const modelID = stringField(model, "modelID")
  if (!providerID || !modelID) return

  let accountID = stringField(model, "accountID")
  const variant = stringField(model, "variant")
  const rawRouteIntent = model.routeIntent
  let routeIntent: ProviderRouteIntent.Info

  if (rawRouteIntent === undefined) {
    routeIntent = accountID
      ? { kind: "account", accountID, pin: "hard" }
      : { kind: "auto" }
  } else {
    if (!Schema.is(ProviderRouteIntent.Info)(rawRouteIntent)) return
    routeIntent = rawRouteIntent
    if (accountID !== undefined) {
      if (routeIntent.kind !== "account" || routeIntent.accountID !== accountID) return
    } else if (routeIntent.kind === "account") {
      accountID = routeIntent.accountID
    }
  }

  return {
    providerID,
    modelID,
    ...(accountID ? { accountID } : {}),
    ...(variant ? { variant } : {}),
    routeIntent,
  }
}

export function sameWorkerDelegationModel(left: WorkerDelegationModel, right: WorkerDelegationModel) {
  const canonicalLeft = normalizeWorkerDelegationModel(left)
  const canonicalRight = normalizeWorkerDelegationModel(right)
  if (!canonicalLeft || !canonicalRight) return false
  return (
    canonicalLeft.providerID === canonicalRight.providerID &&
    canonicalLeft.modelID === canonicalRight.modelID &&
    canonicalLeft.accountID === canonicalRight.accountID &&
    (canonicalLeft.variant && canonicalLeft.variant !== "default" ? canonicalLeft.variant : undefined) ===
      (canonicalRight.variant && canonicalRight.variant !== "default" ? canonicalRight.variant : undefined) &&
    sameRouteIntent(canonicalLeft.routeIntent!, canonicalRight.routeIntent!)
  )
}

/**
 * Parse the protected delegation policy without trusting arbitrary metadata.
 * Invalid legacy/corrupt envelopes remain producer-owned via
 * hasWorkerDelegationOrigin(), but return undefined here so execution fails
 * closed instead of fabricating policy.
 */
export function workerDelegation(value: Metadata | undefined): WorkerDelegationOrigin | undefined {
  const raw = value?.[Keys.workerDelegation]
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return
  const row = raw as Record<string, unknown>
  const model = normalizeWorkerDelegationModel(row.model)
  if (!model) return
  const producer = stringField(row, "producer")
  const principalRef = stringField(row, "principalRef")
  const invocationRef = stringField(row, "invocationRef")
  const rootRef = stringField(row, "rootRef")
  const agent = stringField(row, "agent")
  if (
    !producer ||
    !principalRef ||
    !invocationRef ||
    !rootRef ||
    !agent ||
    typeof row.nestedDelegation !== "boolean"
  ) return
  const parentWorkerID = stringField(row, "parentWorkerID")
  return {
    producer,
    principalRef,
    invocationRef,
    rootRef,
    agent,
    model,
    nestedDelegation: row.nestedDelegation,
    ...(parentWorkerID ? { parentWorkerID } : {}),
  }
}

/** Any Session whose aggregate lifecycle belongs to a first-party producer. */
export function isProducerOwned(value: Metadata | undefined) {
  return isSpecialAgent(value) || hasScheduledTaskOrigin(value) || hasWorkerDelegationOrigin(value)
}

/**
 * Public/general Session creation may carry arbitrary compatibility metadata,
 * but it cannot mint producer-owned origin identity.
 */
export function forPublicCreate(value: Metadata | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined
  const next = clone(value)
  const attemptedSpecialAgent = isSpecialAgent(value)
  stripImmutableOrigin(next)
  if (attemptedSpecialAgent) {
    for (const key of specialAgentDetailKeys) delete next[key]
  }
  return next
}

/**
 * Preserve V1 replacement semantics for caller-owned metadata while retaining
 * producer-owned origin fields from the current Session. Incoming origin fields
 * cannot introduce or overwrite producer identity.
 */
export function replaceCallerOwned(
  current: Metadata | undefined,
  replacement: Metadata,
): Record<string, unknown> {
  const next = clone(replacement)

  for (const key of immutableOriginKeys) {
    if (hasOwn(current, key)) next[key] = current![key]
    else delete next[key]
  }

  if (isSpecialAgent(current)) {
    for (const key of specialAgentDetailKeys) {
      if (hasOwn(current, key)) next[key] = current![key]
      else delete next[key]
    }
  }

  return next
}

/**
 * A fork/derived Session is a new aggregate with a new producer identity.
 * Caller-owned metadata may carry forward, but origin metadata must not.
 */
export function forDerivedSession(value: Metadata | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined
  // Preserve the pre-existing fork contract: nested caller metadata belongs to
  // the new aggregate by value, not by a shared in-memory object reference.
  const next = structuredClone(value) as Record<string, unknown>
  const specialAgent = isSpecialAgent(value)
  stripImmutableOrigin(next)
  if (specialAgent) {
    for (const key of specialAgentDetailKeys) delete next[key]
  }
  return Object.keys(next).length > 0 ? next : undefined
}

/**
 * Compose a special-agent metadata envelope. Producer identity wins over
 * caller-provided extras by construction.
 */
export function specialAgent(input: {
  readonly agent: string
  readonly ownerKind: string
  readonly ownerID: string
  readonly metadata?: Metadata
}): Record<string, unknown> {
  return {
    ...input.metadata,
    [Keys.specialAgent]: input.agent,
    [Keys.specialAgentOwnerKind]: input.ownerKind,
    [Keys.specialAgentOwnerID]: input.ownerID,
  }
}

/**
 * Compose one protected worker-delegation aggregate identity. Producer-owned
 * identity wins over caller metadata by construction.
 */
export function delegatedWorker(input: WorkerDelegationOrigin & { readonly metadata?: Metadata }): Record<string, unknown> {
  const { metadata, ...origin } = input
  return {
    ...metadata,
    [Keys.workerDelegation]: structuredClone(origin),
  }
}

/**
 * Trusted producer-only mutation for a delegated worker's model selection.
 *
 * Generic metadata replacement deliberately cannot rewrite workerDelegation.
 * The delegation owner may, however, rebind the worker to another validated
 * model/account/variant while preserving every other immutable origin field.
 * Malformed producer metadata stays fail-closed.
 */
export function rebindDelegatedWorkerModel(
  value: Metadata | undefined,
  model: WorkerDelegationModel,
): Record<string, unknown> | undefined {
  const origin = workerDelegation(value)
  const canonical = normalizeWorkerDelegationModel(model)
  if (!origin || !canonical) return
  return delegatedWorker({
    ...origin,
    model: canonical,
    metadata: value,
  })
}
