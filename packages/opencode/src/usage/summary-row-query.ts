import { sql, type SQL } from "drizzle-orm"

/** Same maintenance projection in the host and experimental worker fold. */
export function usageSummaryMaintenanceRowsQuery(
  request: { since: number; until: number },
  projectID: string | null,
): SQL {
  return sql`
    SELECT agent, provider_id, model_id, variant, session_id, project_id,
      requests, cost_usd, cost_estimated, input_tokens, cache_read_tokens,
      cache_write_tokens, output_tokens, reasoning_tokens, total_tokens,
      time_started AS started_ms, time_completed AS completed_ms
    FROM maintenance_usage
    WHERE time_completed >= ${request.since}
      AND time_completed < ${request.until}
      AND ${projectID === null ? sql`1 = 1` : sql`project_id = ${projectID}`}
    ORDER BY time_completed ASC
  `
}

/**
 * Session dimensions are durable and constant for all settlements in one
 * SQLite snapshot. Project/name/title/directory joins per generation waste
 * the majority of global query CPU and heap on large histories.
 *
 * Query only identities actually represented in the requested history, then
 * enrich slim usage_record scalars via an O(1) lookup while aggregating.
 * Both statements MUST run in the same deferred read transaction.
 */
export function usageSummaryDimensionsQuery(request: { since: number; until: number }): SQL {
  return sql`
    WITH active AS MATERIALIZED (
      SELECT DISTINCT r.session_id
      FROM usage_record r
      WHERE r.completed_at >= ${request.since}
        AND r.completed_at < ${request.until}
    )
    SELECT
      a.session_id,
      COALESCE(s.project_id, us.project_id, '__historical__') AS project_id,
      COALESCE(s.directory, us.directory, 'Historical usage') AS directory,
      COALESCE(s.title, us.title, 'Deleted session') AS session_title,
      COALESCE(p.name, us.project_name) AS project_name
    FROM active a
    LEFT JOIN session s ON s.id = a.session_id
    LEFT JOIN project p ON p.id = s.project_id
    LEFT JOIN usage_session us ON us.session_id = a.session_id
  `
}

/** Slim chronological settlement reader. See usageSummaryDimensionsQuery. */
export function usageSummaryRawRowsQuery(
  request: { since: number; until: number },
  page?: { limit: number; after: { completedAt: number; rowID: number } | null },
  includeMessageID = true,
): SQL {
  const selectPage = page ? sql`, r.rowid AS cursor_id` : sql``
  // Analytics never dereferences message_id. Omitting it from the unbounded
  // global read avoids materializing and transferring thousands of strings.
  // Keep it by default for diagnostics, legacy callers and parity tests.
  const selectID = includeMessageID ? sql`r.message_id AS id,` : sql``
  const seek = !page?.after ? sql`` : sql`
    AND (r.completed_at, r.rowid) > (${page.after.completedAt}, ${page.after.rowID})
  `
  const order = page ? sql`ORDER BY r.completed_at ASC, r.rowid ASC LIMIT ${page.limit}` : sql`ORDER BY r.completed_at ASC, r.rowid ASC`
  return sql`
    SELECT
      ${selectID} r.session_id, r.provider_id, r.model_id, r.variant,
      r.created_at AS created_ms, r.completed_at AS completed_ms,
      r.request_sent_at AS request_sent_ms, r.first_token_at AS first_token_ms,
      r.streamed_at AS streamed_ms, r.cost_usd,
      r.input_tokens, r.cache_read_tokens, r.cache_write_tokens,
      r.output_tokens, r.reasoning_tokens, r.agent, r.mode
      ${selectPage}
    FROM usage_record r
    WHERE r.completed_at >= ${request.since}
      AND r.completed_at < ${request.until}
      ${seek}
    ${order}
  `
}

/**
 * Index-friendly membership filter for grouped Inspection queries. SQLite
 * computes the small Session ID set using project indexes, then seeks its
 * (session_id, completed_at) usage index. No attribution joins are needed for
 * a scoped totals/model/provider/variant/timeline query.
 */
export function usageScopedProjectFilter(projectID: string): SQL {
  return sql`r.session_id IN (
    SELECT live.id FROM session live WHERE live.project_id = ${projectID}
    UNION ALL
    SELECT snap.session_id FROM usage_session snap
    WHERE snap.project_id = ${projectID}
      AND NOT EXISTS (SELECT 1 FROM session live WHERE live.id = snap.session_id)
  )`
}

/**
 * Rich Usage.summary read-side SQL. Project-scoped requests use the existing
 * session/project and usage_session/project indexes to find relevant Session
 * identities, then seek usage_record(session_id, completed_at). This avoids
 * scanning every project's historical messages before filtering.
 *
 * The live Session's project always takes precedence over its durable
 * usage_session tombstone; a deleted Session uses the tombstone. An orphan
 * with neither identity is classified as __historical__, which deliberately
 * retains the full range-scan fallback.
 *
 * Neither variant changes the row contract or the accounting JS aggregator.
 */
export function usageSummaryRowsQuery(
  request: { since: number; until: number },
  projectID: string | null,
  indexedProject: boolean,
): SQL {
  const projection = sql`
    r.message_id AS id,
    r.session_id,
    r.provider_id,
    r.model_id,
    r.variant,
    r.created_at AS created_ms,
    r.completed_at AS completed_ms,
    r.request_sent_at AS request_sent_ms,
    r.first_token_at AS first_token_ms,
    r.streamed_at AS streamed_ms,
    r.cost_usd,
    r.input_tokens,
    r.cache_read_tokens,
    r.cache_write_tokens,
    r.output_tokens,
    r.reasoning_tokens,
    COALESCE(s.project_id, us.project_id, '__historical__') AS project_id,
    COALESCE(s.directory, us.directory, 'Historical usage') AS directory,
    COALESCE(s.title, us.title, 'Deleted session') AS session_title,
    COALESCE(p.name, us.project_name) AS project_name,
    r.agent,
    r.mode
  `
  const joins = sql`
    LEFT JOIN session s ON s.id = r.session_id
    LEFT JOIN project p ON p.id = s.project_id
    LEFT JOIN usage_session us ON us.session_id = r.session_id
  `
  if (!indexedProject || projectID === null || projectID === "__historical__") {
    // Global scans and true orphan lookups cannot be driven by project IDs.
    return sql`
      SELECT ${projection}
      FROM usage_record r
      ${joins}
      WHERE r.completed_at >= ${request.since}
        AND r.completed_at < ${request.until}
        AND (${projectID} IS NULL OR COALESCE(s.project_id, us.project_id, '__historical__') = ${projectID})
      ORDER BY r.completed_at ASC, r.rowid ASC
    `
  }
  return sql`
    WITH target_session AS MATERIALIZED (
      SELECT s.id AS session_id
      FROM session s
      WHERE s.project_id = ${projectID}
      UNION ALL
      SELECT us.session_id
      FROM usage_session us
      WHERE us.project_id = ${projectID}
        AND NOT EXISTS (SELECT 1 FROM session live WHERE live.id = us.session_id)
    )
    SELECT ${projection}
    FROM target_session target
    JOIN usage_record r ON r.session_id = target.session_id
    ${joins}
    WHERE r.completed_at >= ${request.since}
      AND r.completed_at < ${request.until}
    ORDER BY r.completed_at ASC, r.rowid ASC
  `
}
