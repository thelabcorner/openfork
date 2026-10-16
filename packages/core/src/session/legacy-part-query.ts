import { sql } from "drizzle-orm"
import { CONTEXT_PART_FACT_VERSION } from "./context-part-facts"
import { PartTable } from "./sql"

/**
 * Version-gated SQLite access to V1 Part metadata.
 *
 * PartUpdated writes these small facts atomically with the canonical payload.
 * A CASE (not an OR) prevents the query planner from evaluating JSON on the
 * current path. Older and unknown-future versions remain fail-closed against
 * their authoritative JSON until migrated by the existing context backfill.
 *
 * These facts form a compatibility boundary, not a competing source of truth.
 */
export const legacyPartKind = sql<string | null>`CASE
  WHEN ${PartTable.context_projection_version} = ${CONTEXT_PART_FACT_VERSION}
  THEN ${PartTable.context_kind}
  ELSE json_extract(${PartTable.data}, '$.type')
END`

export const legacyPartStatus = sql<string | null>`CASE
  WHEN ${PartTable.context_projection_version} = ${CONTEXT_PART_FACT_VERSION}
  THEN ${PartTable.context_status}
  ELSE json_extract(${PartTable.data}, '$.state.status')
END`

export const legacyPartSigned = sql<number>`CASE
  WHEN ${PartTable.context_projection_version} = ${CONTEXT_PART_FACT_VERSION}
  THEN CASE WHEN ${PartTable.context_kind} = 'reasoning' AND ${PartTable.context_signed} = 1 THEN 1 ELSE 0 END
  ELSE CASE WHEN json_extract(${PartTable.data}, '$.type') = 'reasoning'
    AND json_type(${PartTable.data}, '$.metadata.anthropic.signature') IS NOT NULL
    AND json_type(${PartTable.data}, '$.metadata.anthropic.signature') <> 'null'
    THEN 1 ELSE 0 END
END`

export const legacyPartOpaque = sql<number>`CASE
  WHEN ${PartTable.context_opaque} = 1 THEN 1
  WHEN ${PartTable.context_projection_version} = ${CONTEXT_PART_FACT_VERSION} THEN 0
  ELSE CASE WHEN json_type(${PartTable.data}, '$."$cdbRef"') IS NOT NULL THEN 1 ELSE 0 END
END`

export const unsettledLegacyToolPredicate = sql`CASE
  WHEN ${PartTable.context_projection_version} = ${CONTEXT_PART_FACT_VERSION}
  THEN ${PartTable.context_kind} = 'tool'
    AND ${PartTable.context_status} IN ('pending', 'running')
  ELSE json_extract(${PartTable.data}, '$.type') = 'tool'
    AND json_extract(${PartTable.data}, '$.state.status') IN ('pending', 'running')
END`