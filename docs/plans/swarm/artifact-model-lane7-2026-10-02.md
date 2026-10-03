# Lane 7 — Swarm Artifact Model: implemented foundation + wiring proposal

**Status:** foundation implemented and tested; persistence/wiring awaiting coordinator decision  
**Date:** 2026-10-02  
**Scope:** OpenFork native Swarm only. **NOT OpenSwarm.**  
**Rule:** executable source/tests > this document.

---

## 1. Problem with `Deliverable.files: string[]`

`swarm_deliverable.files` stores bare path strings. A Swarm member with
`workspacePolicy.mode = "worktree"` runs in its own Git worktree
(`Worktree` directories are per managed member), so a path published by that
member **does not exist** for any other member. Publishing `["reports/audit.md"]`
from a worktree member silently promises bytes that are unreachable, and the
ledger cannot tell a producer-local path from a shared one.

Ledger invariant 22 ("Artifact references do not silently claim bytes are
durable unless they are") is therefore not enforceable today.

## 2. What Lane 7 implemented (isolated, decision-independent)

`packages/core/src/swarm/artifact.ts` (new) — `SwarmArtifact`:

- **Contract** `Artifact`: producer member, task run, optional deliverable,
  workspace-relative `path`, `backing`, derived `durability`, optional
  `mediaType` / `sizeBytes` / `digest`, workspace provenance
  (`shared_directory` | `worktree` + directory + branch), optional `git` ref,
  `createdAtMillis`.
- **`backing` is the only authority for durability**:
  - `workspace_path` → `producer_workspace_only` (explicitly _not_ durable)
  - `git_object` → `repository_durable` (worktrees of one repository share one
    object store, so a committed artifact really is cross-worktree consumable)
  - `content_store` → `content_store_durable` (requires digest + size)
- **`validateArtifact`** derives `durability` from `backing`; a publisher cannot
  assert durability independently. It rejects absolute paths, traversal, control
  characters, oversized paths, malformed object ids, `git_object` without a
  repository reference, and `content_store` without content identity.
- **`assertDurableClaim`** is the hydration guard for durable rows: a stored row
  whose `durability` disagrees with its `backing` (or that lost its digest/git
  ref) is rejected instead of being served.
- **`contentIdentityOf` / `digestOf` / `verifyContent`** give hosts a
  `sha256:<64 hex>` identity primitive (same convention as
  `Ofxp.PublicKeyFingerprint`).
- **`artifactsFromPublishedPaths`** converts the legacy `files: string[]` into
  honest `producer_workspace_only` artifacts (deduped, bounded at 64).
- **`planConsume`** resolves consumption for a consuming member workspace:
  - same shared directory → `read_in_place` (`requiresMaterialization: false`)
  - worktree → other workspace → **`unavailable` + explicit reason** (fails
    closed; the old contract silently assumed a shared path)
  - `git_object` → `restore_from_git` (`requiresMaterialization: true`)
  - `content_store` → `fetch_from_content_store` by digest
- **`describeArtifact`** renders a bounded, honest line: a path reference can
  never print the word "durable".

## 3. Not implemented on purpose (needs coordinator decision)

Where artifact **bytes** live is a product/storage decision. Options:

1. **Git-backed only** (`git_object`): no new storage; producer commits and
   publishes `commit:sha + path`. Works across worktrees immediately. Weakness:
   only for members in the same repository.
2. **Swarm content store**: new durable table keyed by `sha256` plus a byte
   store (SQLite blob table or a data directory under the global OpenFork data
   root). Storage retention/GC policy needed.
3. **Both**: `git_object` preferred when the producer can commit, otherwise
   content store.

Proposal if the coordinator approves option 3 (narrowest sound durable slice):

- Schema (`packages/schema/src/swarm.ts`, Lane 3 hotspot): promote the contract
  as `Swarm.Artifact` + `ArtifactID` (`swa_`), add
  `Deliverable.artifacts: optional(Schema.Array(ArtifactID))`, keep `files`
  during migration.
- Table (`packages/core/src/swarm/sql.ts`): `swarm_artifact`
  `(swarm_id, id, producer_member_id, task_run_id, deliverable_id, path,
backing, durability, media_type, size_bytes, digest, workspace_kind,
workspace_directory, workspace_branch, git_kind, git_object, git_path,
time_created)` with indexes `(swarm_id, time_created, id)` and
  `(deliverable_id)`. One migration via `bun script/migration.ts` from
  `packages/core`.
- Event: `swarm.artifact.updated` added to the existing
  `DeliverableUpdated`-style inventory in `packages/schema/src/swarm.ts`.
- Service (`packages/core/src/swarm/shared-state.ts` or a new
  `artifact-operations.ts` wired in `packages/core/src/swarm/index.ts`):
  `publishArtifact({ swarmID, producerMemberID, taskRunID?, deliverableID?,
workspace, input })`, reading through `assertDurableClaim`.
- Host (`packages/opencode/src/tool/swarm.ts` `deliverable.publish`, Lane 4/2
  hotspot): host resolves the caller Session directory + workspace policy and
  computes digest/size from bytes; the model never supplies its own hash.

State transition: artifact publication is an append to the deliverable's
artifact set; verdict on the deliverable does not delete artifacts (audit
history), and artifact rows are immutable once written. A retry republishes a new
row with the same content digest (content-addressed idempotence) instead of
mutating an existing one.

## 4. Cross-lane coordination required

- `packages/schema/src/swarm.ts` — currently dirty (Lane 3/4). Contract promotion
  must be merged by the coordinator.
- `packages/core/src/swarm/sql.ts` — currently clean, but a migration regenerates
  `packages/core/src/database/migration.gen.ts`, `schema.gen.ts` and
  `schema.json`, which are dirty shared generated files. Only one delegate may
  run `bun script/migration.ts` at a time.
- `packages/core/src/swarm/shared-state.ts` / `index.ts` — currently dirty
  (Lanes 1/5/6/8/9). Lane 7 intentionally did **not** edit them.
- `packages/opencode/src/tool/swarm.ts` — currently dirty (Lanes 2/4). The
  `files` parameter description must stop implying durable handoff; publish
  should gain artifact inputs once persistence exists.
- Lane 5 (`handoff.ts`) should consume `describeArtifact`/artifact refs in the
  bounded predecessor handoff instead of deliverable path strings.
