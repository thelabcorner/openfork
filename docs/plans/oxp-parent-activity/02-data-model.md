# Gate P durable data model

## 1. Tables

### `oxp_parent_activity`

Materialized O(1) summary row for sidebar/list surfaces.

Proposed columns:

```text
id                     TEXT PRIMARY KEY
title                  TEXT NULL
first_seen_at          INTEGER NOT NULL
last_seen_at           INTEGER NOT NULL
call_count             INTEGER NOT NULL
failure_count          INTEGER NOT NULL
augmentation_calls     INTEGER NOT NULL
supervision_calls      INTEGER NOT NULL
delegation_calls       INTEGER NOT NULL
observed_epoch_count   INTEGER NOT NULL
last_tool              TEXT NULL
last_root_alias        TEXT NULL
time_archived          INTEGER NULL
```

No raw upstream correlation identifier is stored here.

### `oxp_correlation_ref`

Maps a pseudonymous external correlation reference to one local parent activity.

```text
scheme                 TEXT NOT NULL
digest                 TEXT NOT NULL
activity_id            TEXT NOT NULL
scope                  TEXT NOT NULL
first_seen_at          INTEGER NOT NULL
last_seen_at           INTEGER NOT NULL

PRIMARY KEY(scheme, digest)
INDEX(activity_id)
```

`scope` describes the semantics of the correlation mechanism, not confidence
in a guessed identity:

- `scheme="openai/session"` -> `scope="conversation"`, following OpenAI's
  documented anonymized ChatGPT conversation identifier;
- `scheme="mcp-session-id"` -> `scope="unknown"`, because the legacy MCP
  value is transport-session compatibility evidence rather than conversation
  identity.

### `oxp_invocation`

One durable span per OXP `tools/call` invocation.

```text
id                     TEXT PRIMARY KEY
activity_id            TEXT NOT NULL
host_run_id            TEXT NOT NULL
observed_epoch         INTEGER NULL
plane                  TEXT NOT NULL
tool                   TEXT NOT NULL
action                 TEXT NULL
root_id                TEXT NULL
root_alias             TEXT NULL
status                 TEXT NOT NULL
error_code             TEXT NULL
mutation_attempted     INTEGER NOT NULL
mutation_committed     INTEGER NOT NULL
safe_summary           TEXT(JSON) NULL
time_started           INTEGER NOT NULL
time_completed         INTEGER NULL
```

Indexes:

- `(activity_id, time_started DESC, id DESC)`
- `(activity_id, status, time_started DESC)`
- `(activity_id, host_run_id, observed_epoch)` for exact observed-segment
  accounting without scanning invocation history;
- `(status, host_run_id)` for bounded restart settlement;
- `(time_started)` for bounded maintenance/recovery.

`observed_epoch_count` on the parent summary is the number of distinct
**observation segments** `(host_run_id, observed_epoch)` actually seen for that
parent, not `MAX(observed_epoch)`. Epoch numbering is process-local and restarts
from one after a host restart, so taking the maximum would undercount history.
The writer uses the indexed tuple above and a bounded positive-only process cache
to avoid repeating the lookup for calls already proven to belong to the same
segment. Cache eviction/restart only adds an indexed SQLite read; it cannot
change durable counting semantics.

### `oxp_invocation_link`

Historical causal references to native resources.

```text
invocation_id          TEXT NOT NULL
kind                   TEXT NOT NULL
ref                    TEXT NOT NULL
label                  TEXT NULL
relation               TEXT NOT NULL

PRIMARY KEY(invocation_id, kind, ref, relation)
INDEX(kind, ref)
```

Do not use cascading foreign keys to the target resource. Historical evidence
must survive resource deletion.

## 2. IDs

Local IDs use dedicated namespaces, for example:

```text
oxpa_...   parent activity
oxpi_...   invocation
```

Upstream correlation IDs are not reused as local IDs.

## 3. Correlation pseudonymization

The OXP boundary receives a raw external correlation value transiently.

It derives:

```text
digest = HMAC-SHA256(
  local_private_correlation_key,
  scheme || NUL || raw_value
)
```

Only `scheme + digest + scope` cross into the durable Core owner. Including the
scheme in the HMAC domain-separates an identical opaque value observed through
different correlation mechanisms.

The local HMAC key must be:

- generated once;
- persisted outside renderer-visible state;
- excluded from OXP public/trusted projections;
- never logged;
- replaceable by a future secure-credential owner without changing durable
  activity IDs.

## 4. Invocation summary budget

`safe_summary` is a typed/bounded operation-specific projection, not an arbitrary
JSON dump.

Recommended maximum serialized size: 8 KiB.

Examples:

```json
{"path":"packages/opencode/src/oxp/server.ts","bytes":18342}
```

```json
{"files":4,"additions":83,"deletions":21}
```

```json
{"workerID":"ses_...","agent":"build","model":{"providerID":"openai","modelID":"gpt-5.6"}}
```

## 5. Concurrency

Ordering is by `time_started + id`, but a timeline must not infer sequential
execution from row ordering.

Two invocations overlap when:

```text
A.time_started < B.time_completed
AND
B.time_started < A.time_completed
```

The UI may group nearby starts into an activity burst while retaining each span's
exact start/completion times.

## 6. Retention

Initial Gate P should preserve activity history until explicit archive/delete.

Future pruning may be added, but:

- pruning must never delete linked native resources;
- summary counters must remain truthful for retained history or explicitly expose
  that older history was pruned;
- no retention timer should exist while the feature is disabled unless a global
  maintenance owner already legitimately runs one.
