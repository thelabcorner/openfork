import { SessionMetadataOwnership } from "@opencode-ai/core/session/metadata-ownership"

/**
 * Fork-local supervision metadata helpers.
 *
 * Supervisor Mode persists a durable, caller-replaceable delegation envelope on
 * the child Session. It is intentionally NOT registered as producer-owned
 * identity: supervision must be adoptive and relinquishable, so the caller may
 * replace or clear it. `SessionMetadataOwnership` reserves `workerDelegation`
 * for immutable producer identity; `taskDelegation` is a distinct, mutable key.
 *
 * This module is self-contained on purpose so the Supervisor Mode feature can
 * ship without editing `packages/core`. The canonical key name is duplicated
 * here as a plain string constant because core does not (yet) export a
 * `taskDelegation` key.
 */
export const TASK_DELEGATION_KEY = "taskDelegation"

/** The core registry key this envelope deliberately avoids (immutable identity). */
export const WORKER_DELEGATION_KEY = SessionMetadataOwnership.Keys.workerDelegation

export type SupervisionMode = "supervisor"

export interface TaskDelegation {
  readonly mode: SupervisionMode
  readonly supervisorSessionID: string
  readonly supervisionGroupID: string
  readonly description: string
  readonly createdFromMessageID: string
}

type Metadata = Readonly<Record<string, unknown>>

function stringField(value: Record<string, unknown>, key: string) {
  const field = value[key]
  return typeof field === "string" && field.length > 0 ? field : undefined
}

/**
 * Parse the durable supervision envelope without trusting arbitrary metadata.
 * Malformed/partial envelopes return undefined so callers fail closed rather
 * than fabricating an ownership relationship.
 */
export function taskDelegation(value: Metadata | undefined): TaskDelegation | undefined {
  const raw = value?.[TASK_DELEGATION_KEY]
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return
  const row = raw as Record<string, unknown>
  if (row.mode !== "supervisor") return
  const supervisorSessionID = stringField(row, "supervisorSessionID")
  const supervisionGroupID = stringField(row, "supervisionGroupID")
  const description = stringField(row, "description")
  const createdFromMessageID = stringField(row, "createdFromMessageID")
  if (!supervisorSessionID || !supervisionGroupID || !description || !createdFromMessageID) return
  return {
    mode: "supervisor",
    supervisorSessionID,
    supervisionGroupID,
    description,
    createdFromMessageID,
  }
}

/**
 * Presence is meaningful even for malformed rows (restart reconstruction should
 * notice a supervision relationship exists). Unlike producer identity this is
 * not fail-closed protection, only a cheap existence check.
 */
export function hasTaskDelegationOrigin(value: Metadata | undefined) {
  return value !== undefined && Object.prototype.hasOwnProperty.call(value, TASK_DELEGATION_KEY)
}

/**
 * Compose a new metadata bag with the supervision envelope set. `metadata` may
 * be passed to preserve unrelated caller-owned keys. The envelope is written as
 * a plain JSON-serializable object.
 */
export function withTaskDelegation(
  delegation: TaskDelegation,
  metadata?: Metadata,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    [TASK_DELEGATION_KEY]: {
      mode: delegation.mode,
      supervisorSessionID: delegation.supervisorSessionID,
      supervisionGroupID: delegation.supervisionGroupID,
      description: delegation.description,
      createdFromMessageID: delegation.createdFromMessageID,
    },
  }
}

/**
 * Remove the supervision envelope while preserving every other metadata key.
 * Used when relinquishing supervision (supervisor -> background/foreground).
 */
export function withoutTaskDelegation(metadata: Metadata | undefined): Record<string, unknown> {
  const next = { ...(metadata ?? {}) }
  delete next[TASK_DELEGATION_KEY]
  return next
}

export * as SubagentSupervisionMetadata from "./subagent-supervision-metadata"
