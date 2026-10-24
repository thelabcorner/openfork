# OXP native Session visibility parity — 2026-10-21

## Incident and reproduced counterexample

A user-visible OpenFork freeze-dryer firmware research Session,
`ses_ea48f5469ffeIsALV669AIYaza`, existed in the currently running host's
native `openfork-dev-fresh.db` Session table, with directory
`W:/Dev/freezedryer-firmwares`. OXP's existing `sessionSupervision =
"approved-roots"` grant was enabled, but the current approved-root catalog did
not include that directory. Therefore native OpenFork displayed the Session
while `openfork_session get/search/list` could not address it.

The root cause was **authority conflation**: Session control was authorized
through `SessionRow.directory` as an approved filesystem path. The frontend's
automatic project-root synchronization cannot recover an unselected, global,
detached, or otherwise historical Session directory.

This is distinct from earlier OXP session incidents:

- Project-root synchronization and path-namespace mismatches (especially
  local Windows vs WSL/SSH/remote paths) made discoverability depend on a
  renderer-owned project list.
- Separate session-control/host-owned delegated-worker ownership used the
  wrong continuation/control surface; an actual worker has to be continued
  through its owning worker contract, not a synthetic native Session turn.
- Runtime generation and stale sidecar/transport schemas produced situations
  where current source code was correct but the connected host still served an
  older capability contract.
- An external parent tool epoch or tunnel outage can prevent tool delivery even
  when a native Session is healthy; this is a transport/liveness issue, not
  evidence the Session is absent.

None of these permits fabrication of Session IDs, implicit ChatGPT-native
Session ownership, borrowed provider credentials, or expanding arbitrary
filesystem access.

## Implemented authority contract

`Grant.sessionSupervision` now accepts:

| Mode | Native Session access | Filesystem tool access |
| --- | --- | --- |
| `none` | No Session supervision | Unchanged independent grants |
| `approved-roots` | Existing Sessions whose native directory resolves inside approved OXP roots | Unchanged approved-root requirements |
| `all-native` | Every existing Session in the **same native runtime's authoritative Session database**, including global/detached/outside-project-root Sessions | **Still** requires independently granted root-scoped read/write/process/git/etc. |

`all-native` is explicitly selected in OpenFork Settings → OXP → Agent
Support → Session access, after enabling Session supervision. Existing
`approved-roots` settings remain unchanged; enabling supervision from off
starts in the restricted scope. The `all-native` grant is not inferred from
`read`, `code`, `process`, project-list visibility, an OXP connection, or
the presence of a Session ID.

- `OxpSupervision.authorizeRow` resolves the *real durable Session row*.
  For `all-native` with no explicit root filter, admission is Session-class,
  without invented `rootID`, approved filesystem path, or workspace.
- Explicit `rootID` filters continue to enforce root containment, even in
  all-native mode.
- `OxpSession` list/get/messages/children/search use the same native durable
  reader and real Session identifiers. Search drops the directory-prefix
  predicate **only** for explicitly granted all-native scope; a root-scoped
  search still applies authorization **before** candidate ranking.
- Broad Session location metadata is labeled
  `{scope:"native-session",path:<native-directory>}` rather than claiming a
  phantom approved root. The path is authorized *Session metadata only*;
  consumers must not reinterpret it as authority to invoke file/process tools.
- Supervision, mutation, egress, and native runtime commit guards keep
  independent authorization/revalidation. Reducing the grant back to
  approved-roots or none revokes broad admission.
- Request supervision remains a separately enabled authority; it does not
  become enabled merely through Session visibility.
- `list` now exposes `cursor` and `nextCursor` for deterministic
  native Session-record pagination. Cursor represents the last **consumed**
  Session row (updatedAt + id), not a fetched page tail, so skipped results or
  a partially consumed 100-row page cannot silently lose later candidates.
  The cursor is an ordering token, **not** an authorization token; each
  continued page reauthorizes every returned Session.

## Verification gates

- Native Session regression: outside-root get/search/list/send, explicit root
  denial, downgrade revocation, native Session path projection.
- Large-inventory pagination fixture: 133 distinct Sessions across 80-result
  pages, with no skipped/duplicated IDs; invalid cursor rejected.
- Authority regression: a rootless Session grant is **not** a filesystem
  `read` grant and is revoked by a supervision-scope downgrade.
- Desktop sidecar validator, Electron-main trusted IPC, app control typings,
  and generated MCP manifest carry `all-native` without widening existing
  `approved-roots` configs.
- Repository parity verifier and all affected TypeScript package typechecks.

These gates prove the **modified source and local fixture behavior**, not that
an already-running OXP sidecar was reloaded. Verify the new generated MCP schema
fingerprint against the restarted host before claiming a live ChatGPT-to-Session
success.

## Remaining universal-access frontier

The exact supported scope is **the native Session database of the host serving
this OXP connection**. A user may also have Sessions in a *different* OpenFork
process/database, a remote OpenFork/OFXP host, WSL, SSH, or another logged-in
device. `all-native` must not claim those Sessions until there is an explicit,
identity-preserving multi-runtime federation.

To reach true user-visible parity across connected runtimes, build:

1. An authoritative native Session-source registry: stable runtime/host
   identity, database generation, SessionID, durable owner and actual
   capabilities; no directory heuristics or synthetic Session rows.
2. A source selection/routing layer for direct ID lookups, search, and
   pagination, with an unambiguous tuple `(runtimeID, sessionID)`. Discovery
   must distinguish *unknown ID*, *authorized-but-source-offline*,
   *authorization denied*, and *wrong native owner* without leaking
   unauthorized Session existence.
3. Each source's separately configured OXP/OFXP/remote grants, source-local
   native-session authorization, liveness/heartbeat, and audit receipts.
   Controlling a Session routes to its owner; no cross-instance SQLite
   mutation and no cross-host principal inheritance.
4. A live acceptance test comparing a bounded authoritative native UI inventory
   with the OXP enumerator under the same source/scope, including archives,
   global Sessions, project switches, sidecar restarts, stale transport schemas,
   revocation, blocked workers, and transport disconnect/reconnect.

Do not claim this future multi-runtime federation is implemented by the
current local-host `all-native` change.

## Release/activation

1. Build/restart the owning OpenFork desktop and sidecar so the generated MCP
   manifest and runtime code agree. OXP's currently running connector can
   retain stale schema until host replacement.
2. Enable Session supervision and select **All native sessions** in the OXP
   settings. Leave filesystem read/write/process root grants independent.
3. Reconnect OXP and verify the target via `openfork_session get` and
   `search` using the original Session ID/title.
4. Execute an explicitly requested `steer` or `send`, verify the real
   target Session's resulting message/provenance, and inspect the native
   pending-job/blocked-request state rather than inferring from timestamps.
