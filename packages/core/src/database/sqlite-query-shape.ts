/**
 * Privacy-safe structural hints for SQLite contention logs.
 * Never retain SQL, literals, bind arguments or user-provided identifiers.
 * Only table names from OpenFork's own fixed schema are allowed into logs.
 */
const INTERNAL_TABLES = new Set([
  "event", "event_value", "event_sequence", "event_compaction",
  "message", "part", "session", "session_message", "session_input",
  "session_message_tool_overlay", "session_execution_owner", "runtime_owner",
  "project", "workspace", "usage_record", "usage_session", "maintenance_usage",
  "swarm", "swarm_member", "swarm_task", "swarm_task_lease", "swarm_task_run",
  "session_limit_recovery", "directory_activity_lease", "directory_maintenance_guard",
])

export function sqliteQueryShape(query: string): string {
  const source = query.slice(0, 8192)
  const tables: string[] = []
  // Identifier keywords only; never include freeform SQL text. Dynamic table
  // names not owned by OpenFork are always rendered as "other".
  for (const match of source.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+[`"]?([a-z_][a-z0-9_]*)[`"]?/gi)) {
    const name = match[1]!.toLowerCase()
    const safe = INTERNAL_TABLES.has(name) ? name : "other"
    if (!tables.includes(safe)) tables.push(safe)
    if (tables.length >= 6) break
  }
  const joins = (source.match(/\bJOIN\b/gi) ?? []).length
  const predicates = (source.match(/\b(?:AND|OR)\b/gi) ?? []).length
  return `tables=${tables.length ? tables.join(",") : "none"} joins=${Math.min(joins, 99)} predicates=${Math.min(predicates, 99)} json=${/\bjson_(?:extract|each|tree)\s*\(/i.test(source) ? 1 : 0} order=${/\bORDER\s+BY\b/i.test(source) ? 1 : 0} group=${/\bGROUP\s+BY\b/i.test(source) ? 1 : 0}`
}
