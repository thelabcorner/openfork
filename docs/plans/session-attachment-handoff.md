# Session Attachment Handoff Plan

## Purpose

Allow an orchestrating OpenFork session to deliberately include user-uploaded
attachments in work delegated to a Task subagent, a Native Swarm member, or a
future first-party worker. The child must receive the selected bytes in its
initial model request when the selected model can accept them, and the durable
record must explain which user turn authorized the handoff, which task received
the attachment, and whether the attachment was actually included in a provider
request.

This plan targets production V1 session execution and the local API path, with
the newer UI as its primary presentation. Native Swarm is a first-party product
domain with its own authoritative services; integrate through those owners
without treating Swarm's runtime generation as a reason to migrate ordinary V1
session execution. Neither UI generation owns attachment discovery, access, or
copying.

## Verified current state

The primary composer encodes image blobs as data URLs before sending the prompt
([`submit.ts`](../../packages/app/src/components/prompt-input/submit.ts#L129),
[`build-request-parts.ts`](../../packages/app/src/components/prompt-input/build-request-parts.ts#L198)).
The request carries V1 `file` parts with MIME, filename, URL, and optional source
([`session.ts`](../../packages/schema/src/v1/session.ts#L516)). The V1 prompt
runtime resolves file inputs, normalizes image parts, and persists them as
message parts. Provider-history projection turns durable user file parts back
into multimodal input ([`message-v2.ts`](../../packages/opencode/src/session/message-v2.ts#L566),
[`message-v2.ts`](../../packages/opencode/src/session/message-v2.ts#L972)).
There is no distinct durable attachment/blob entity in this path today: uploaded
bytes are embedded in the persisted part URL.

Task delegation already identifies the assistant tool call's exact parent user
turn and has message history available
([`subagent-delegation.ts`](../../packages/opencode/src/session/subagent-delegation.ts#L193),
[`subagent-delegation.ts`](../../packages/opencode/src/session/subagent-delegation.ts#L400)).
However, a new child prompt is built from `resolvePromptParts(prompt)` and does
not carry any parent attachments
([`subagent-delegation.ts`](../../packages/opencode/src/session/subagent-delegation.ts#L779)).
The existing `Result.attachments` field describes files returned by a tool to
its parent, not input attachments sent to a child
([`subagent-delegation.ts`](../../packages/opencode/src/session/subagent-delegation.ts#L201)).

The existing supervisor-steer path already admits a host-authored text-plus-file
projection through `SessionInput.admitSynthetic`
([`prompt.ts`](../../packages/opencode/src/session/prompt.ts#L4888)). That is a
useful mechanism, but attachment forwarding needs its own durable task-scoped
grant and idempotency identity rather than an ad hoc second copy operation.

Compaction currently summarizes user files as MIME/name markers and replay
replaces media parts with text markers
([`compaction.ts`](../../packages/opencode/src/session/compaction.ts#L96),
[`compaction.ts`](../../packages/opencode/src/session/compaction.ts#L817)).
Therefore, workers must resolve selected attachments from their durable handoff
manifest, not reconstruct bytes from compacted transcript text.

Native Swarm has separate text-only assignment and peer admission paths. Task
assignment calls `SwarmSessionAdmission.assignment` and admits rendered text
([`session-admission.ts`](../../packages/opencode/src/swarm/session-admission.ts#L132));
peer messages likewise render and admit text. Swarm task-run identity and
`sessionInputID` already make assignment admission idempotent, which can anchor
handoff delivery too. Swarm must share the attachment owner/resolver while
maintaining narrower per-task/per-member grants.

## Architectural path and ownership

### Producer-to-display path

```text
composer upload
  -> V1 prompt request (`file` part)
  -> V1 prompt admission and durable parent user message
  -> attachment registry/blob owner (new canonical identity and access grants)
  -> Task/Swarm selection validated against exact user-owned sources or active grants
  -> task-scoped durable handoff manifest
  -> child admission or request-time resolver
  -> child V1 history projection / provider compiler
  -> provider request with file bytes, if supported
  -> child status projection (available / included / unsupported / revoked)
  -> task/session UI
```

The current V1 `FilePart` is the source fact today. The target attachment owner
should own immutable bytes, logical upload identity, MIME/name metadata,
retention, and access grants. The parent message remains the durable causal
record showing which upload the user supplied. Content hashes deduplicate bytes
only; possession of or knowledge about a hash must never grant access.

For references such as “use the image I sent earlier,” maintain a bounded
session attachment index updated at admission time. It should offer paginated
explicit lookup over compact metadata and opaque refs; it must not scan or
hydrate transcript history. The orchestration context should show a bounded
current-turn manifest and active task grants, while older eligible items are
discoverable only through explicit lookup. This keeps ordinary prompt and dense
UI paths O(1) while supporting intentional retrieval. Index reads are O(k) for
the requested page and independent of transcript length.

The attachment registry must be callable from the existing V1 admission and
execution path without bootstrapping a workspace `Instance` for metadata-only
lookup. Resolving a selected attachment for a provider request occurs inside
the already-running child execution path. Any future browse/list or revocation
API must use the narrowest durable/session ownership boundary; it must not add
history hydration or a new N-per-row UI request.

| Flow | Owner and tier | Transport / client rule |
| --- | --- | --- |
| Upload and parent prompt admission | Existing V1 Session Prompt execution (Tier 3); semantic upload origin is stamped at this trusted boundary. | Reuse the existing prompt contract; do not add an upload-only runtime or a second raw-content stream. |
| Attachment index/list | Durable attachment/session metadata owner (Tier 1), keyed by explicit session and paginated. | No `InstanceStore`, config, plugin, tool, or history bootstrap. Expose a compact browser-safe contract; list is O(k) for returned page, independent of transcript length. |
| Grant validation and scheduling | V1 Task owner or authoritative Swarm task/run owner. | Snapshot exact symbolic selections and immutable grant manifest before async scheduling. |
| Attachment byte resolution | Attachment owner, invoked from authorized Tier 3 child execution. | Resolve only selected and live grants; no arbitrary path or URL fetch. |
| Provider inclusion/status | Child prompt compiler and execution lifecycle. | Record recipient provider/account/route and actual `included_in_provider_request`; status projection is compact and batched. |
| Presentation | `packages/app` new-layout session/task/Swarm surfaces. | Consume server-owned compact projections; never hydrate message history or make one request per row. |

Keep browser-safe references and projection schemas in `packages/schema`. Do not
introduce app-to-Core/Server implementation dependencies. If a new endpoint is
needed, classify it before choosing middleware. A new OpenFork endpoint under
`packages/opencode/src/server/routes/**` requires unified SDK generation from
`packages/sdk/js`; do not add a Protocol/current API migration merely to expose
this feature.

### Reverse demand path

The user needs a particular upload available to a delegated task. The composer
admits it once and records its semantic origin. The orchestrator sees a bounded
manifest of eligible references from its exact triggering turn when user-owned,
plus active task-scoped received grants. It can explicitly page the session
index for older uploads. When it invokes Task or creates a Swarm task, it
explicitly chooses zero or more references. The delegation owner validates them against
the exact triggering turn, an explicit index result, or a live grant already
held by this worker, then snapshots the grant before queueing.
When the child begins (or resumes), the runtime rechecks the grant and resolves
the bytes; the model compiler checks exact model/route/MIME capability and puts
selected bytes in that invocation's provider request. The UI reports
availability and provider inclusion separately.

No layer should scan prior messages, read paths from unrelated workspaces, or
fetch arbitrary URLs to satisfy that demand.

## Product and contract decisions

These are the recommended defaults for implementation, not unresolved product
questions:

1. **Selection is explicit and empty by default.** A delegation with no selected
   attachment references transfers no uploads. The orchestrator may select
   model-visible symbolic refs surfaced for its exact triggering turn when
   user-owned, active task grants, or an explicit paginated session-index
   lookup. It may not discover older turns by scanning or hydrating transcript
   history.
2. **Selection and access are separate.** A grant authorizes a child/task to
   resolve an attachment; inclusion records that bytes were actually serialized
   into a particular provider request. UI and logs must not treat a grant as
   proof the model received or understood an image.
3. **Access is task-scoped.** A Task grant belongs to that delegation
   invocation and child session. A Swarm grant belongs to an exact task run and
   member session. A peer message cannot widen a grant. Nested workers may pass
   only attachments explicitly granted to their current worker/task, never
   search ancestors for more. Instruction authority remains separate: an
   attachment grant does not promote file bytes to privileged/System content.
4. **Only semantic user uploads are eligible.** V1 `file` currently conflates
   data-URL uploads with `file://` workspace references, MCP resources, and
   tool output. Add a durable, server-validated attachment origin/category to
   distinguish user uploads. Never accept arbitrary `file://`, HTTP(S), or
   model-supplied URLs as attachment references. Existing history is not
   automatically backfilled into eligible grants. A selected legacy part can
   be adopted only when trusted admission data proves its upload origin;
   otherwise require the user to re-upload it through the classified path.
5. **Preserve provenance and authority.** Child delivery is host-authored
   Synthetic conversational content, with lineage to the parent user message
   and delegation/task identity. It does not become a new human-owned turn or
   privileged System instruction. Use the centralized V1 turn provenance
   taxonomy, not `role === "user"`, `part.synthetic`, filename, or content
   shape, to establish ownership.
6. **Bytes must reach the selected child model input.** For a new worker,
   selected bytes are in its initial model request. For a resumed worker,
   selected delta bytes are in that invocation's request. Merely making an
   attachment available through a tool or metadata lookup does not satisfy
   handoff. If the chosen model/route cannot accept the MIME type, fail or mark
   the handoff unavailable with a clear reason; do not claim successful visual
   inspection. Never silently drop unsupported content.
7. **No automatic inheritance from transcript history.** Resume and retry reuse
   the immutable selected manifest. Adding or widening a selection is a new
   explicit grant update. Compaction preserves bounded manifest metadata, never
   auto-rehydrates all bytes. A later request can explicitly read an active
   grant through the bounded attachment-read operation, which places the chosen
   bytes in that request's provider input; the manifest alone never restores
   image content.
8. **The destination is part of the handoff.** Resolve the actual child model,
   provider route, and account before reading bytes. Record and expose the
   recipient when it differs from the parent route. An explicit attachment
   selection for the delegated task authorizes that task's selected model under
   existing provider/privacy policy; do not add a blanket same-provider rule.
   If an existing policy requires user approval for a new external recipient,
   preserve that gate. Never silently bypass it.
9. **Source deletion and child access are distinct.** Removing a parent session
   link does not silently revoke a live child grant. Explicit asset deletion or
   revocation cascades to every descendant grant and blocks future reads. A
   scoped grant revoke blocks that child and its descendants. Preserve a
   tombstone when revocation prevents a resumed worker from resolving bytes.

## Target data contract

Introduce a browser-safe attachment reference based on logical upload identity,
not raw URL or content hash. A reference should minimally resolve to a source
session/message/part and an opaque attachment ID. The ID is not a bearer token;
every use is checked against durable source ownership and an active grant.
Expose stable model-visible symbolic handles in a compact manifest so the
orchestrator can select a subset without inventing hidden IDs. Include
current-turn uploads and active task-scoped grants; provide a paginated index
lookup for older session uploads after compaction. Opaque storage IDs remain
server-internal. A convenience “all current uploads” selector may be added,
but it must not replace granular refs.

Represent an immutable grant edge with:

- source user-owned message and file-part IDs;
- attachment logical ID, filename, MIME, byte length, and optional content hash;
- delegation invocation ID and target child session, or Swarm task-run ID and
  exact member session;
- original upload's user-turn provenance and causal lineage, distinct from the
  host-authored child handoff turn;
- created/revoked/expired state and a bounded reason/status;
- idempotency key tied to a unique delegation invocation or task-run/admission
  identity. For Task, include source session, assistant message, tool call ID
  and durable tool part ID plus child key; assistant message ID alone is not
  unique when several Task calls run in parallel. For Swarm, bind retries to
  the immutable TaskRun and `sessionInputID`.

Keep asset content identity separate from logical upload identity. Two uploads
with equal bytes may share immutable blob storage while retaining distinct
ownership, filenames, grants, and revocation. Hash equality never merges access
rights.

Use three distinct operations: unlinking a source session removes its listing
relationship but leaves bytes available to live grants; revoking one grant
blocks that child and descendant grants; deleting/revoking an asset tombstones
it and cascades to every grant. Blob reclamation follows the tombstone and
remaining retention references, not parent-session reachability alone.

Persist the selected manifest before asynchronous scheduling. Retries reuse the
same grants and do not duplicate bytes or handoff turns. Explicit source
revocation cascades through descendant grants and is checked at every
dispatch/read; it prevents future inclusion but cannot recall bytes already
transmitted to a provider. Deleting/unlinking the parent session is not itself
source revocation. A revoked asset must produce a durable “attachment
unavailable” state for a resumable child, not silent omission.

Storage direction:

- **First implementation:** use existing inline data URLs only as a bounded
  compatibility backing for selected user uploads. Enforce count, per-item and
  aggregate byte limits before creating child input; measure write/prompt
  amplification. Do not copy unselected bytes.
- **Target implementation:** move binary bytes behind a canonical local blob
  owner and store small immutable attachment references in FileParts/manifests.
  Use explicit references/refcounts and tombstones for retention. Avoid
  permanent full-byte copies in every child message/session.
- **Migration:** adopt legacy inline payloads lazily only when selected and
  trusted admission data proves their upload origin; validate and assign
  immutable IDs. Otherwise require re-upload. Do not scan/rewrite all history
  during startup or migration. Historical tasks remain attachment-free unless
  a new explicit grant is made.

## Task and worker behavior

Extend the V1 Task contract with optional symbolic attachment references. The
orchestrator receives a bounded, provider-visible manifest with stable handles
for eligible uploads on its exact triggering turn when user-owned, plus active
task grants, so it can choose a precise subset. A bounded paginated session index supports
intentional selection of older uploads after compaction. The model-facing ref is
not the storage ID or a bearer token. The server validates against the current
turn, index ownership, or active worker grant, and rejects foreign, stale,
revoked, unsupported-origin, or arbitrary-path references. Empty/omitted
references mean no attachments.

For example, Task input may carry `attachments: ["upload-7", "upload-9"]`,
where those symbolic handles were shown in the current compact manifest or
returned by an explicit index lookup. The durable grant stores the opaque
attachment IDs and source message/part identities resolved server-side.

For a new worker, snapshot the validated selected manifest before starting the
background/foreground execution. Admit the child task prompt with the selected
file parts in the initial user-lowered provider turn, along with ordinary task
text. Preserve the source message/part and invocation lineage in host Synthetic
provenance. Provider media bytes are loaded only when preparing the child model
request. A prompt-bearing resume/steer adds its explicitly selected delta to
that invocation's provider request; it does not rewrite the historical initial
turn.

For a resumed task, do not attach new parent attachments implicitly. A
prompt-bearing `task_id` continuation may add a separately selected grant only
from that invocation's exact triggering turn when user-owned, or from explicit
session-index results. Selecting an existing grant for this same child records
inclusion in the new provider request without creating another grant edge.
Forwarding that grant to a new child creates a child-scoped grant and requires
nested delegation policy. A `task_id` call without a prompt adds no refs and
records no inclusion. Existing grants remain under their own
lifetime/revocation policy.
Running Supervisor steer follows the same explicit selection contract and
safe-boundary admission; it must not bypass the grant check or turn a host
continuation into user authority. A retry with the same invocation/run identity
is idempotent.

For nested delegation, the child may forward only references in its active
task-scoped received grant, and only if nested delegation policy permits. The
handoff turn is host-owned Synthetic, so it does not become a new human-owned
root. The worker follows its explicit grant lineage and creates a new
child-scoped grant while retaining original user-upload provenance. Ancestor
session traversal is prohibited.

## Native Swarm behavior

Reuse the same attachment owner, resolver, eligibility checks, and manifest
format. Bind selected references to the durable Swarm task identity so semantic
task retries/reassignment retain the same selection. Bind each access grant to
the exact target member session and task-run ID. Assignment admission resolves
the manifest using its existing stable `sessionInputID`; delivery retries reuse
that immutable manifest and must not duplicate grants or attach a different
payload to the same run. Reassignment to a new member/session requires fresh
target-session validation and a newly bound grant; the old member grant does
not follow the task. Deliver selected bytes in the member's initial provider
request.

Peer mail remains text-only by default. It may refer to a task attachment by
symbolic reference only when the recipient is already an authorized member of
the exact task grant. Mail cannot create, broaden, or transfer a grant. Swarm-
wide visibility is not implied by coordinator ownership. A new member or task
needs its own explicit grant.

## Provider, compaction, retry, and retention rules

The exact chosen provider/model/route is authoritative for capability checks.
Check MIME capability and request budgets before dispatch. Record `selected`,
`authorized`, `resolved`, and `included_in_provider_request` as separate facts;
do not claim model comprehension. If the payload is unsupported or over budget,
fail closed with an explicit state and actionable message.

Compaction stores only attachment name/MIME/availability/ref metadata in its
bounded text projection. The resolver never scans compacted text to recover
content. After compaction, a child may explicitly select an active grant through
the bounded attachment-read operation to include it in a later provider
request; compaction alone never rehydrates bytes. On resume, recheck grant and
source retention before the next provider request. Unlinking/deleting the
parent session does not block a live child grant; explicit asset revocation
cascades to descendant grants and blocks later reads. A scoped grant revoke
blocks that child and its descendants. Cancellation and terminal child
completion release child grants according to retention policy. Preserve a
tombstone/status long enough to explain why a resumed task no longer has the
asset. Already-sent provider data cannot be recalled.

Do not log base64, signed/resolver URLs, or raw bytes. Normalize filenames,
sniff MIME on the server, cap count and bytes, and keep access checks separate
from deduplication. Remote workers or alternate workspace roots receive bytes
only through an explicit transport supported by the attachment owner; no local
path is assumed to be portable.

## Phased implementation

1. **Bounded V1 Task prototype (non-shipping).** Behind a non-shipping feature
   flag, add semantic upload origin and symbolic refs; expose compact current-
   turn and active-grant manifests plus a paginated session index; add granular
   Task selection and a bounded attachment-read operation; validate current
   turn, index ownership, and active grants; snapshot before scheduling; inject
   selected data URL parts into the initial child input; add provider
   capability/budget checks and recipient recording. This prototype may
   duplicate inline bytes and is for end-to-end behavior only. It does not meet
   the production storage-amplification invariant and must not ship.
2. **Canonical blob owner and grant lifecycle before shipping.** Move selected inline bytes to
   immutable local blob storage with logical IDs, access edges, refcounts,
   tombstones, bounded resolution, deletion/revocation, and lazy legacy
   adoption. Make ordinary FileParts reference the owner rather than persist
   repeated binary payloads. Ship handoff only after this phase meets storage,
   revocation, retention, and retry invariants.
3. **Native Swarm integration.** Add task-manifest refs and task-run/member-
   scoped grants; make delivery idempotent under `sessionInputID`; revalidate
   and rebind on reassignment; surface statuses in Swarm task projections;
   preserve text-only peer mail unless the recipient already has a grant.
4. **Presentation and operations.** Add a compact upload manifest in delegation
   controls and truthful child status for selected/available/included/unsupported/
   revoked. Use batched projections and one shared update stream where live
   status is needed. No per-row history fetches.

Each phase should have one shared domain owner and narrow V1 adapters. If a new
HTTP route is needed, classify its ownership tier first. Metadata/list access
must not hydrate history or materialize a workspace Instance; actual provider
resolution belongs to the child execution path. Regenerate only the SDK surface
that the chosen route actually changes.

## Validation and negative invariants

The implementation should prove these failures cannot occur:

- no references selected means zero child attachment bytes and no attachment
  grant;
- a selected reference resolves only if it belongs to the exact triggering
  user-owned turn, an explicit bounded session-index result, or an active grant
  already held by that worker;
- no unrelated turn, sibling session, ancestor traversal, filename match,
  content hash, or model-authored URL can disclose an attachment; the bounded
  current-turn/active-grant manifest and explicit paginated index are the only
  previous-asset discovery paths;
- workspace paths and remote URLs are never fetched or opened by handoff;
- selected bytes appear in a new child's initial provider request and in the
  corresponding later request for a selected resume/steer/read; unsupported
  MIME/model/route fails visibly and is not described as included;
- retries and duplicate Swarm assignment delivery preserve one immutable
  selection and do not multiply stored bytes or grant edges;
- explicit asset revoke/delete/expiry prevents subsequent reads and cascades to
  descendant grants; unlinking/deleting a parent session does not silently
  revoke a live child grant;
- compaction retains bounded manifest metadata without restoring binary payloads
  or scanning full history;
- stored bytes scale with unique assets, not worker count. Provider payload
  bytes necessarily scale with selected recipients, so bound per-recipient and
  aggregate in-flight resolution/concurrency and ensure unselected children
  receive zero bytes;
- the non-shipping inline prototype is expected to duplicate bytes and cannot
  pass the storage-growth closure gate;
- no attachment-only status/UI projection creates workspace Instances or
  hydrates message/part history per task row.

Validation should exercise actual provider serialization for representative
image and document MIME types, the active desktop sidecar path where practical,
parallel Task and Swarm starts, retries, suspend/resume, compaction, deletion,
revocation, reassignment, and cross-workspace failures. Report canonical stored
bytes, bytes resolved in flight, and provider payload bytes separately; a small
UI projection is not evidence that the byte path is cheap. Include representative
1/3/6+ selected-recipient concurrency and prove resolver reads/backpressure are
bounded while acknowledging unavoidable provider fanout.

## Open decisions

The following choices need product/runtime owners before phase 2; they do not
change the phase 1 safety defaults above:

- Blob backend shape and retention window: SQLite BLOB, filesystem object store,
  or an existing OpenFork artifact owner. Choose based on measured request and
  local database costs, crash recovery, and backup behavior.
- Whether child grants expire at task terminal state or remain resumable for a
  defined retention window. Default recommendation: retain grant metadata while
  the child remains resumable, release bytes only after terminal retention ends,
  and support explicit revocation at any time.
- Maximum per-file/aggregate bytes and eligible MIME allowlist. Establish from
  provider limits and desktop memory/storage measurements before enabling broad
  document support.
- Whether UI allows a human to preselect a subset before dispatch, in addition
  to model-selected refs. Preserve explicit empty-by-default server semantics
  either way.
- Whether peer mail should later support attaching a reference to an already
  authorized task/member. Phase 1 keeps mail text-only.

## Implementation status (2026-10-07)

Landed in the active worktree. The canonical blob+grant owner was built from the
start (phase-2 semantics), so task and swarm delivery share one authoritative
owner rather than duplicating inline bytes.

- **Schema** (`packages/schema/src/session-attachment.ts`): browser-safe
  contracts — branded `ID`/`BlobID`/`GrantID`/`Handle`, `Origin`, `Eligibility`,
  `GrantTarget` (task/swarm), `GrantState`, `Manifest`/`ManifestEntry`,
  `HandoffStatus`, `RecipientStatus`, `IndexPage`/`IndexEntry`, `Resolved`,
  `RejectionReason`.
- **Durable owner** (`packages/core/src/session/attachment.ts` +
  `attachment.sql.ts` + migration `20261007010326_session_attachment_handoff`):
  content-addressed blob dedup that never merges access rights, logical upload
  identities keyed by exact source part, immutable grant edges idempotent on a
  delegation/task-run identity, asset revocation that cascades to every
  descendant grant, scoped grant revoke, retention expiry, bounded paginated
  session index, four-fact status recording, and live-grant byte resolution.
  `Policy` centralizes the open decisions (MIME allowlist, byte limits, retention
  window) as bounded defaults.
- **V1 admission** (`packages/opencode/src/session/prompt.ts`): server-derived
  upload origin stamped at the trusted `resolvePart` boundary (only inline
  `data:` user uploads are eligible); a bounded orchestrator manifest is appended
  to the exact user turn.
- **Task** (`tool/task.ts`, `session/subagent-delegation.ts`): optional symbolic
  `attachments` selection, scope validation (exact triggering turn/active grant),
  grant snapshot before scheduling, injection into the child's initial provider
  request and supervisor steer. Empty/omitted selection transfers zero bytes.
- **Native Swarm** (`tool/swarm-create-schema.ts`, `swarm/command.ts`,
  `swarm/session-admission.ts`, `core/swarm/render.ts`): selected handles
  snapshotted onto the task, resolved and grant-bound to the exact task
  run/member session at admission, delivered into `content.files`, idempotent on
  the run identity.
- **API** (`server/routes/instance/httpapi/groups|handlers/session-attachment.ts`):
  Tier 1 bootstrap-free paginated index and per-recipient status; unified SDK
  regenerated.
- **Presentation** (`session-ui/src/components/message-part.tsx`, i18n): compact
  attachment count on the Task row.

Remaining follow-ups: the desktop end-to-end path and cross-workspace transport
were not exercised here; a UI preselect-before-dispatch control and a durable
attachment-read operation for post-compaction re-inclusion are not yet wired.
The negative invariants are covered by `packages/core/test/session-attachment.test.ts`
(12 tests) and the Task selection tests in `packages/opencode/test/tool/task.test.ts`.
