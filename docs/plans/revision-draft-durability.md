# Durable Revisor Artifacts

## Problem

Prompt revision is currently durable only after the renderer receives the
generation and mutates its local editor state. Goal and Scheduled Task revision
have an even narrower lifetime: the generated text exists only in component
memory until the user explicitly saves the enclosing domain object.

That leaves a destructive gap:

```text
provider accepts revised_prompt
  -> Core returns revision
  -> HTTP response / renderer / component
  -> editor draft
```

If the connection, renderer, dialog, or desktop process disappears after the
provider has produced the accepted revision but before the editor owns it, the
artifact is lost even though the expensive generation succeeded.

The failure is architectural rather than component-specific. The UI is not the
correct owner of a model-produced artifact that must survive UI failure.

## Ownership

### Current producer inventory

The production app currently has exactly three call sites for
`api.promptRevisor.revise`:

- Prompt Input V2 — ordinary prompt revision and revise-before-send;
- Goal Composer — existing and pre-creation Goal objective revision;
- Scheduled Task Editor — scheduled prompt revision.

All three use the same Core `PromptRevisor` terminal contract and the same
`RevisionDraft` mailbox. New revision surfaces must join this contract rather
than introducing component-local persistence.

The raw Prompt Revisor API retains a target-less stateless mode for SDK/API
compatibility. Such a caller has deliberately supplied no recoverable editor
identity, so Core cannot expose crash recovery for that invocation. This is
distinct from the product reviser surfaces above: every product reviser supplies
a target and therefore crosses the durable mailbox commit boundary before
success is observable.

### User-visible fact

"The latest accepted revision for this exact editable target is recoverable
until the editor has incorporated or explicitly dismissed it."

### Authoritative producer

`PromptRevisor`, at the point where the terminal `revised_prompt` tool call
has passed host validation. This is the earliest layer that knows the artifact
is valid and complete.

### Durable owner

A Core `RevisionDraft` service backed by SQLite. The table is a small pending
mailbox, not revision history. The special-agent Session transcript remains the
audit/history surface.

### Ownership tier

Generation remains Tier 3 because it needs model/runtime services. Recovery and
acknowledgement are bootstrap-free durable metadata operations keyed by a stable
editor identity: SQLite only, zero Instance/Location bootstrap.

## Data model

One pending row exists per globally stable editor identity:

```text
(target_kind, target_key)
```

The row stores:

- an opaque artifact id;
- semantic purpose / target kind;
- target key;
- execution directory (metadata, not mailbox identity);
- a client-supplied source fingerprint used only as an optimistic edit fence;
- the validated revised text;
- validated rich prompt references;
- creation time.

There is intentionally no consumed-history table. A successful acknowledgement
deletes the pending row. A later generation atomically replaces the pending row
for the same target.

This gives bounded storage proportional to editable targets rather than revision
attempts and makes recovery a unique-index lookup.

## Concurrency semantics

Acknowledgement is compare-by-artifact-id, never "clear target".

Example:

1. revision A writes artifact A;
2. revision B for the same target replaces the slot with artifact B;
3. an old renderer acknowledges A;
4. the DELETE predicates on id A and therefore cannot delete B.

The target slot is latest-request-wins, not merely
last-successful-generation-wins. Before expensive model work starts, Core writes
a tiny per-target generation claim. Completion may commit under an immediate
SQLite transaction only while that exact claim is still current. Therefore an
older provider call finishing after a newer request cannot replace the newer
request's mailbox state. Acknowledgement remains generation-safe.

The claim is bound to the exact target kind, target key, and source-fingerprint
snapshot that created it. A claim id cannot be replayed with mutated source
state, even for the same editor target.

## Crash semantics

The accepted terminal artifact is persisted before `PromptRevisor` is allowed
to return it to HTTP. Persistence is an uninterruptible commit step. Therefore a
renderer disconnect that occurs after host acceptance cannot create a successful
but unretained revision.

The editor acknowledges only after a durable owner has incorporated the
artifact. For Prompt Input this means the canonical prompt draft has been
explicitly flushed. Goal and Scheduled Task component/form state is not durable
ownership: acknowledgement waits for successful Goal/Task Save/Create. If
acknowledgement fails, the row remains recoverable.

## Target identities

Target keys are stable editor identities, not component instance ids.

- Prompt composer
  - existing Session: `session:<sessionID>`
  - persisted new-session draft: `draft:<draftID>`
  - desktop no-draft fallback: `new:window:<stableWindowID>`
  - directory draft fallback: `workspace:<editor-directory>`
- Goal Revisor
  - existing Goal: `goal:<goalID>`
  - pre-creation Goal editor: `new:<goalArmKey>`
- Scheduled Task Revisor
  - existing task: `task:<taskID>`
  - desktop new-task editor: `new:window:<stableWindowID>`
  - web/PWA fallback: `new:workspace:<editor-workspace-directory>`

The execution directory is intentionally not required for recovery. A new
Scheduled Task may target another directory, and requiring the crashed renderer
to reconstruct that unsaved selection would defeat the durability contract.
Fallback keys carry a durable editor owner when they do not already have a
globally unique domain id. Electron supplies a stable window ID that survives
renderer reload and restored application windows, so independent desktop windows
can revise separate new Scheduled Tasks without racing one mailbox slot.
Web/PWA currently has no equally durable per-tab identity, so it deliberately
falls back to one recoverable new-task slot per workspace rather than inventing
component-instance randomness that cannot be rediscovered after a crash.

Prompt draft identity follows the same rule: a persisted draft's UUID, not its
mutable directory, owns the mailbox slot. The workspace directory is included in
the Prompt source fingerprint instead. Moving a draft therefore keeps the prior
artifact discoverable, but the directory change breaks the automatic-apply
fence and requires an explicit Apply/Dismiss decision.

## Source fence and recovery policy

Every revision request carries the fingerprint of the complete editable source
that produced it. For Prompt and Goal revision, that fence also incorporates the
workspace directory used for reconnaissance/context. Stable editor identity is
therefore independent of mutable execution context: moving an editor does not
orphan its mailbox artifact, but it does prevent silent cross-workspace apply.

On recovery:

1. if the current editor source fingerprint equals the stored source fingerprint,
   apply the revision automatically;
2. if the current durable owner already equals the complete revised result, only
   acknowledge it. Prompt uses full structured-part equality after rebuilding
   the artifact's rich references; visible text equality alone is insufficient.
   Goal/Scheduled equality is field equality because those revisers mutate only
   their plain domain prompt/objective field. Ephemeral form equality never
   counts as ownership;
3. a pre-creation Goal/Scheduled Task editor with no durable draft identity must
   never auto-apply a retained artifact merely because its reconstructed source
   matches. That editor identity can survive a crash, but its unsaved form state
   cannot prove whether a prior Save/Create already succeeded and only mailbox
   acknowledgement failed. Surface an explicit Apply / Dismiss recovery choice;
4. otherwise do not overwrite newer user input. Keep the artifact pending and
   expose an explicit Apply / Dismiss choice.

The server does not interpret fingerprints. They are optimistic concurrency
tokens owned by the editor contract.

Target identity is an independent fence from source equality. Normal responses,
delayed recovery actions, and Prompt reveal/restore actions must still match the
captured target key at the instant they mutate UI state. Two editors with
identical content in the same workspace are never interchangeable.

## Prompt draft integration

Prompt Input already has a persisted draft/session prompt store. Recovered
revisions must enter through the canonical controller mutation path so the final
revision becomes the normal persisted prompt. The server mailbox is the
cross-process handoff; it does not become a second prompt store.

The existing reveal animation may transiently write partial editor state. The
server artifact remains pending until the final state is committed and
acknowledged, so a renderer crash during reveal still leaves the complete result
recoverable.

Prompt recovery starts mailbox lookup and canonical persisted-draft hydration in
parallel, but evaluates the source fence only after hydration completes. This
prevents a retained revision from being compared against the temporary empty
state that exists before an asynchronous draft has loaded.

Prompt acknowledgement crosses an explicit persistence barrier. Ordinary typing
keeps the existing coalesced/debounced write path; only revision ownership
transfer forces the current prompt through both persistence debounce layers.
Revise-and-send keeps the mailbox artifact through the optimistic composer clear
and consumes it only after server admission succeeds.

The Prompt "Restore original" action is also a durable ownership transition:
the restored source is flushed first, then that exact artifact id is
acknowledged. A failed earlier acknowledgement therefore cannot cause a revision
the user explicitly restored away to reappear on restart.

## Goal and Scheduled Task semantics

Revision does **not** silently save a Goal or Scheduled Task. Revision is an edit
operation; the user's existing Save/Create action remains the domain commit.
The durable mailbox covers the otherwise ephemeral interval between model
generation and explicit save.

Applying a revision to Goal/Scheduled Task form state does not acknowledge the
mailbox. Save/Create is the ownership-transfer boundary. Explicit Dismiss or
Restore may acknowledge it because those are deliberate user decisions to
discard that revision.

For pre-creation editors that do not otherwise have persisted form state, a
pending revision also acts as the minimum recovery seed. This is intentionally
narrow: it retains the model-produced artifact, not every keystroke in the form.

## API

Generation:

```text
POST /prompt/revise?directory=...
  target: { kind, key, sourceFingerprint }
```

Recovery (bootstrap-free):

```text
POST /revision-draft/recover
  { kind, key }
```

Acknowledgement:

```text
POST /revision-draft/consume
  { id }
```

No recovery route may depend on `InstanceContextMiddleware`,
`WorkspaceRoutingMiddleware`, `Location.Service`, plugins, tools, provider
catalogs, LSP, VCS, or Session history.

Current standalone OpenFork has one process-global database/auth realm. The
planned hosted multi-tenant mode is not implemented yet; when it is, revision
recovery must resolve through the server-verified tenant database/context rather
than treating this root route as ambient process-global authority. Because the
mailbox is already owned by `Database.Service`, tenant-specific databases are
the intended isolation boundary; raw caller-provided tenant ids must never be
added as authority.

## Performance model

- request ordering: one tiny claim UPSERT before provider work;
- write: one immediate claim-check + SQLite UPSERT transaction at successful
  revision completion;
- recover: one unique-index lookup, O(log n);
- consume: one primary-key DELETE;
- storage: at most one accepted-artifact row plus one current request-claim row
  per target;
- timers/listeners: zero;
- background workers: zero;
- Session/message hydration: zero;
- Instance creation on recover/consume: zero.

The common case adds no renderer polling and no per-editor persistent listener.
Recovery is a single cold read when a revision-capable editor mounts/changes
target. A failed/aborted generation may leave one current claim row, but it does
not erase the prior accepted artifact and the next request replaces that claim;
claim storage therefore remains O(targets), not O(attempts).

## Required invariants

1. A successful revision with a target is durable before the caller can observe
   success.
2. Recover/consume never materialize an Instance.
3. Recovery never needs a directory and therefore cannot fall back to process cwd.
4. An acknowledgement for artifact A cannot remove newer artifact B.
5. A superseded generation cannot commit even if its provider call finishes last.
6. A generation claim cannot commit for a different source fingerprint than the
   snapshot it claimed.
7. Prompt acknowledgement occurs only after its persisted draft flush completes;
   revise-and-send also waits for server admission.
8. Goal/Scheduled Task acknowledgement occurs only after durable domain
   Save/Create (or explicit user discard), never merely after form mutation.
9. A changed editor or target is never overwritten automatically.
10. All three product revision surfaces use the same Core mailbox contract.
11. Rich Prompt Input references survive recovery.
12. Mailbox and generation-claim storage stay bounded to O(targets) and do not
    become revision history.
13. A newer in-flight or abandoned claim never hides or deletes the last
    accepted recoverable artifact.
14. An accepted artifact survives complete Database/RevisionDraft service
    teardown and reopen of the same SQLite file.

