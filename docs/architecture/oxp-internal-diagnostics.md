# OXP internal error diagnostics

OXP failures that escape normal domain error handling must not become an
undifferentiated MCP `-32603` with no repair path. The OXP server records an
opaque incident ID at execution, result-validation, result-projection, and HTTP
transport boundaries. Tool-call failures return `OXP_INTERNAL` with that ID;
transport failures return a valid JSON-RPC internal-error envelope containing
the incident ID when the request ID is available, and keep the ID queryable
through `openfork_diagnostics`.

The producer is the exception boundary that still has the phase and tool/action
identity. The `packages/opencode/src/oxp/diagnostics.ts` service stores a bounded
64-entry process-local ring. It does not use SQLite or the activity recorder, so
diagnostic retrieval remains available during database contention. The
read-only `openfork_diagnostics` OXP tool reads that ring independently of
`openfork_info`. Possession of the endpoint's unguessable local URL is its
authorization boundary; it does not load OXP configuration, workspace roots,
activity storage, or SQLite. Incident retrieval therefore remains available
when one of those dependencies caused the original failure. `openfork_info
action=status` also includes the five most recent incidents (including an empty
list) as a fallback for connectors that have not refreshed their tool list. The only activity-write exception is the initial status handshake: when
`action=status` carries a valid `sessionTitle`, OXP registers the logical
session title on the canonical parent-activity row. Everything else remains
read-only diagnostics/catalog surfaces.

Records contain an opaque ID, timestamp, phase, tool/action labels, active OXP
surface fingerprint, a sanitized error class/code, and stack frames reduced to source
basename and line. Free-form error messages, arguments, results, prompts,
credentials, and absolute paths are not retained. Query a single incident with
`incidentID`, or request the most recent entries with `limit` (maximum 20).

The ring survives OXP module refresh within the same process, but not a process
restart and not more than 64 incidents. An incident ID can therefore expire;
operators should query it promptly. This is an operational diagnostic channel,
not a durable audit log.
