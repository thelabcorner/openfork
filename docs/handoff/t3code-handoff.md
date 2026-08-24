# T3 Code Git Checkpoints → OpenCode
## Comprehensive Research Dossier, Feature-Ideation Handoff, and Implementation Execution Blueprint

**Research date:** 2026-08-12  
**Audience:** feature ideation agent, architecture agent, and implementation/execution agent  
**Target:** `anomalyco/opencode`, with emphasis on the desktop application and the backend/session runtime it consumes  
**Reference implementation studied:** `pingdotgg/t3code`

---

## 0. Executive Directive

The goal is **not** to copy T3 Code's checkpoint implementation literally.

The goal is to reproduce the *product capability* that makes T3's turn timeline useful:

1. a stable filesystem state immediately before a turn;
2. a stable filesystem state after the turn has actually quiesced;
3. a durable mapping between that state and the corresponding user/assistant turn;
4. exact per-turn and cumulative diffs;
5. a UI that can review those diffs by turn;
6. a rollback operation that restores both filesystem state and conversation state;
7. enough lifecycle discipline that later changes cannot be accidentally attributed to the wrong turn.

### Central conclusion

**OpenCode already owns most of the hard Git machinery.**

Current OpenCode has a dedicated `Snapshot` subsystem using a **shadow Git repository** per project/worktree. It already:

- tracks filesystem snapshots as Git trees;
- keeps snapshot Git metadata outside the user's real repository;
- reuses the source repository's object database through Git alternates;
- copies/seeds the source index for first-snapshot performance;
- serializes snapshot operations with a semaphore;
- respects the source repo's ignore rules;
- explicitly drops newly ignored paths from the snapshot index;
- excludes newly added files larger than 2 MiB;
- supports patches, restore, revert, raw diff, and structured full diffs;
- is integrated with OpenCode's message/session revert feature;
- pre-captures a snapshot **before the LLM stream begins** specifically because tool execution may otherwise beat lifecycle events.

Therefore, the recommended OpenCode architecture is:

> **Keep OpenCode's existing `Snapshot` storage engine. Add a first-class, durable per-turn `Checkpoint` model and checkpoint lifecycle on top of it. Borrow T3's turn/checkpoint semantics, diff timeline UX, and coordinated rollback behavior—not its same-repository hidden-ref storage implementation.**

This is both less invasive and safer than introducing a second checkpoint Git system into OpenCode.

---

# 1. Research Baseline and Source Pinning

Repository code evolves quickly. Implementation work should begin by checking whether these paths still match the target checkout.

## 1.1 T3 Code source baseline

Repository:

- https://github.com/pingdotgg/t3code

Research was pinned against commit:

```text
1e59b4c4004ce3c724d09ca0b140ed4523758d1e
```

Core checkpoint sources:

- `apps/server/src/checkpointing/Utils.ts`
- `apps/server/src/checkpointing/CheckpointStore.ts`
- `apps/server/src/checkpointing/CheckpointDiffQuery.ts`
- `apps/server/src/checkpointing/Diffs.ts`
- `apps/server/src/checkpointing/Errors.ts`
- `apps/server/src/vcs/VcsDriver.ts`
- `apps/server/src/vcs/GitVcsDriver.ts`
- `apps/server/src/orchestration/Layers/CheckpointReactor.ts`
- `packages/contracts/src/orchestration.ts`

Useful tests:

- `apps/server/src/checkpointing/CheckpointStore.test.ts`
- `apps/server/src/checkpointing/CheckpointDiffQuery.test.ts`
- `apps/server/src/checkpointing/Diffs.test.ts`
- `apps/server/src/checkpointing/Utils.test.ts`
- checkpoint/reactor coverage elsewhere in `apps/server`

Relevant issue evidence:

- https://github.com/pingdotgg/t3code/issues/1434
- https://github.com/pingdotgg/t3code/issues/1472
- https://github.com/pingdotgg/t3code/issues/1590

## 1.2 OpenCode source baseline

Repository:

- https://github.com/anomalyco/opencode

Research was pinned against current `dev` commit:

```text
14b37df39168eaf6a6faf862ec4a7bbe9c825bbd
```

The desktop package reports version `1.18.17` at this commit.

Primary OpenCode sources:

- `../../packages/opencode/src/snapshot/index.ts`
- `../../packages/opencode/src/session/processor.ts`
- `../../packages/opencode/src/session/prompt.ts`
- `../../packages/opencode/src/session/revert.ts`
- `../../packages/opencode/src/session/summary.ts`
- `../../packages/opencode/src/session/session.ts`
- `../../packages/opencode/src/session/message-v2.ts`
- `../../packages/opencode/src/server/routes/instance/httpapi/groups/session.ts`
- `packages/app/...`
- `packages/session-ui/...`
- `packages/desktop/...`

Snapshot tests:

- `../../packages/opencode/test/snapshot/snapshot.test.ts`
- `../../packages/opencode/test/session/revert-compact.test.ts`
- `../../packages/opencode/test/session/prompt.test.ts`

---

# 2. Evidence Discipline

Every implementation agent should distinguish three categories.

| Label | Meaning |
|---|---|
| **VERIFIED** | Directly confirmed in the pinned repository source or current issue state. |
| **INFERRED** | Strongly implied by neighboring code, but not relied on as an implementation fact. |
| **PROPOSED** | Architecture recommended for OpenCode; not a claim about current behavior. |

Do not silently promote an inference into a repository fact.

---

# 3. Critical Corrections to Earlier Research

Several prior notes were directionally useful but materially inaccurate. These corrections matter because an implementation agent copying the wrong assumption could damage Git state.

## 3.1 T3 restore is not `git reset --hard <checkpoint>`

**VERIFIED**

Current T3's Git VCS driver restores a checkpoint approximately as follows:

```bash
git restore --source <checkpoint-commit> --worktree --staged -- .
git clean -fd -- .
git reset --quiet -- .       # when HEAD exists
```

Consequences:

- branch `HEAD` is **not moved** to the checkpoint commit;
- tracked working-tree contents are restored from the checkpoint;
- untracked, non-ignored files are removed;
- ignored files remain because `git clean -fd` does not include `-x`;
- the real index is temporarily restored and then reset toward `HEAD`;
- pre-existing user staging state is not preserved.

That last point is a significant semantic/safety consideration.

## 3.2 T3 checkpoint commits are not a parented checkpoint branch

**VERIFIED**

T3 creates each checkpoint commit with:

```bash
git commit-tree <tree> -m "t3 checkpoint ref=<ref>"
```

No `-p <parent>` is supplied.

Therefore:

- the commit object is a detached/root commit;
- checkpoint sequence is represented by application metadata and ref numbering;
- checkpoint N is not Git-parented to checkpoint N-1;
- diffs explicitly resolve and compare two checkpoint commits.

Do **not** design OpenCode around a synthetic checkpoint commit chain unless there is a separate reason to do so.

## 3.3 Current T3 checkpoint files are not centered in `git/Services/*`

**VERIFIED**

The current bounded checkpoint subsystem is split across:

```text
apps/server/src/checkpointing/*
apps/server/src/vcs/*
apps/server/src/orchestration/Layers/CheckpointReactor.ts
packages/contracts/src/orchestration.ts
```

Older descriptions that place the implementation primarily in `apps/server/src/git/Services/*` should not be used as the current source map.

## 3.4 There is no current standalone `CheckpointRevert.ts` in the checkpointing directory

**VERIFIED**

Revert orchestration currently lives inside `CheckpointReactor.ts`; the low-level restore primitive lives in the Git VCS checkpoint capability.

## 3.5 OpenCode Desktop is currently Electron, not Tauri

**VERIFIED**

At the researched OpenCode commit:

```json
{
  "name": "@opencode-ai/desktop",
  "version": "1.18.17",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build"
  }
}
```

The desktop feature should therefore be treated as:

```text
OpenCode backend/server + shared app UI + Electron shell
```

Do not design a Rust/Tauri backend integration for this feature unless the target branch is materially different.

## 3.6 OpenCode already has an advanced Git snapshot implementation

**VERIFIED**

This is the biggest architectural correction.

Do not begin by creating:

```text
CheckpointStore.ts
GitCheckpointService.ts
refs/opencode/checkpoints/...
```

until evaluating whether the requirement actually cannot be satisfied by extending `Snapshot`.

---

# 4. T3 Checkpoint Mental Model

T3's checkpoint system can be understood as four layers:

```text
┌────────────────────────────────────────────────────────────┐
│                 Orchestration / turn model                 │
│   turn start, turn completed, revert request, read model  │
└────────────────────────────┬───────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────┐
│                    CheckpointReactor                       │
│ baseline capture / final capture / placeholder handling   │
│ diff summary / rollback / receipts / activity reporting   │
└────────────────────────────┬───────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────┐
│                    CheckpointStore                         │
│ thin service: detect / capture / has / diff / restore     │
└────────────────────────────┬───────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────┐
│                  VcsCheckpointOps                          │
│                  GitVcsDriver                              │
│ temporary index → tree → detached commit → hidden ref     │
└────────────────────────────────────────────────────────────┘
```

The product feature is the **entire vertical slice**, not merely the Git commands.

---

# 5. T3 Checkpoint Ref Model

## 5.1 Exact namespace

**VERIFIED**

```ts
CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints"
```

A checkpoint ref is generated as:

```text
refs/t3/checkpoints/<base64url(threadId)>/turn/<turnCount>
```

For example:

```text
refs/t3/checkpoints/dGhyZWFkLTEyMw/turn/0
refs/t3/checkpoints/dGhyZWFkLTEyMw/turn/1
refs/t3/checkpoints/dGhyZWFkLTEyMw/turn/2
```

Properties:

- refs are in the actual repository's Git common directory;
- they do not appear as normal branches;
- worktrees sharing a common repository also share the ref store;
- encoding thread IDs prevents unsafe/raw thread strings from becoming ref path fragments;
- `turn/0` is the baseline slot.

## 5.2 Why custom refs are useful

A custom ref gives Git reachability to detached commit objects.

Without a ref, a tree/commit created only by plumbing commands can eventually be garbage-collected.

The hidden ref therefore provides:

- durability;
- named lookup;
- explicit deletion;
- no normal branch pollution;
- no need to move `HEAD`.

---

# 6. T3 Low-Level Capture Algorithm

## 6.1 Temporary index isolation

**VERIFIED**

T3 resolves the repository's **Git common directory**, then creates a random temporary index path:

```text
<toplevel git common dir>/t3-checkpoint-index-<uuid>
```

It runs checkpoint staging with:

```text
GIT_INDEX_FILE=<temporary path>
```

This is one of the strongest parts of the T3 implementation.

It means capture does not need to mutate the user's real Git index.

## 6.2 Commit identity

The environment sets a fixed identity:

```text
GIT_AUTHOR_NAME=T3 Code
GIT_AUTHOR_EMAIL=t3code@users.noreply.github.com
GIT_COMMITTER_NAME=T3 Code
GIT_COMMITTER_EMAIL=t3code@users.noreply.github.com
```

Because `commit-tree` creates an actual commit object, Git still requires commit metadata.

## 6.3 Initial index seed

If `HEAD` exists:

```bash
git read-tree HEAD
```

is performed against the temporary index.

This seeds tracked state from the current committed repository tree.

If the repository has no `HEAD`, capture still proceeds without this seed.

## 6.4 Stage workspace state

T3 then stages:

```bash
git add -A -- .
```

against the temporary index.

This captures:

- tracked modifications;
- tracked deletions;
- new non-ignored files;
- renames as represented by tree state.

Ignored files are not added by normal `git add -A`.

## 6.5 Write tree

```bash
git write-tree
```

produces the Git tree OID for the entire snapshot.

## 6.6 Create detached commit

```bash
git commit-tree <treeOID> -m "t3 checkpoint ref=<checkpointRef>"
```

No parent is supplied.

## 6.7 Publish checkpoint ref

```bash
git update-ref <checkpointRef> <commitOID>
```

The temporary index is cleaned up in an `ensuring`/finally-style path.

## 6.8 Important capture invariant

Capture should not mutate:

- current branch;
- `HEAD`;
- the normal working tree;
- user's real index.

That is the low-level invariant T3 is trying to guarantee.

---

# 7. T3 Diff Algorithm

## 7.1 Direct commit-to-commit diff

**VERIFIED**

The Git driver computes:

```bash
git diff \
  --patch \
  --no-color \
  --no-ext-diff \
  --no-textconv \
  [--ignore-all-space] \
  <from>^{commit} \
  <to>^{commit}
```

The driver has a checkpoint diff maximum output setting of approximately:

```text
10,000,000 bytes
```

An implementation agent must inspect the process runner's exact truncation behavior before assuming that every diff above this size is usable.

## 7.2 Whitespace behavior

`CheckpointDiffQuery` defaults `ignoreWhitespace` to `true`.

Checkpoint capture's immediate file-summary derivation uses:

```text
ignoreWhitespace: false
```

Therefore there are two distinct consumers:

- summary accounting should reflect actual line churn;
- human diff querying often suppresses whitespace-only churn by default.

## 7.3 Turn diff

T3 conceptually computes:

```text
turn N diff =
checkpoint(turn N - 1)
        →
checkpoint(turn N)
```

## 7.4 Full-thread diff

T3 also exposes a cumulative diff:

```text
checkpoint(turn 0 baseline)
        →
checkpoint(turn N)
```

This is important: a T3-style UI should expose both.

## 7.5 Server validation before diff

`CheckpointDiffQuery` validates:

- thread exists;
- requested turn count is available;
- workspace path is available;
- `from` checkpoint ref is known;
- `to` checkpoint ref is known;
- result conforms to the response schema.

The query derives workspace CWD as:

```text
thread.worktreePath ?? project.workspaceRoot
```

## 7.6 File summary parser

T3 parses unified diffs using `@pierre/diffs`' patch parser, then derives:

```ts
{
  path,
  additions,
  deletions
}
```

The summary is sorted by path.

Notably, the current capture path emits:

```ts
kind: "modified"
```

for its file summaries even though Git may represent adds/deletes. An OpenCode implementation should use its richer `Snapshot.FileDiff` status model rather than reproducing that information loss.

---

# 8. T3 Baseline Semantics

## 8.1 Turn zero is a real snapshot

The checkpoint at count `0` is the pre-turn baseline.

The reactor checks the current maximum checkpoint count and creates a baseline ref at that count if the ref does not yet exist.

This enables:

```text
baseline 0 → turn 1
turn 1    → turn 2
turn 2    → turn 3
```

## 8.2 Baseline creation signals

**VERIFIED**

T3 attempts baseline creation from multiple lifecycle signals:

### Runtime path

```text
turn.started
```

### Domain paths

```text
thread.turn-start-requested
thread.message-sent
```

For `thread.message-sent`, baseline capture is gated so it applies to an appropriate non-streaming user message that has not already been associated with a turn.

## 8.3 Why multiple signals exist

The code is defending against provider/runtime heterogeneity.

This is a useful T3 lesson, but OpenCode has a more direct runner and should not automatically reproduce every redundant signal.

---

# 9. T3 Final Capture Lifecycle

## 9.1 Ideal path

The intended final checkpoint path is:

```text
provider turn.completed
    ↓
resolve active thread/workspace
    ↓
determine next checkpointTurnCount
    ↓
capture filesystem
    ↓
diff previous checkpoint → new checkpoint
    ↓
derive file summary
    ↓
dispatch thread.turn.diff.complete
    ↓
publish checkpoint.diff.finalized
    ↓
publish turn.processing.quiesced
```

## 9.2 Primary-turn guard

If a thread has an active primary turn, the completion checkpoint is only accepted when the event's turn ID matches that active turn.

This protects against stray/concurrent runtime events becoming checkpoints for the wrong logical turn.

## 9.3 Status mapping

Runtime state maps roughly into:

```text
failed        → error
cancelled     → missing
interrupted   → missing
completed     → ready
default       → ready
```

An OpenCode implementation should model aborted/cancelled/failed turns explicitly and decide whether a filesystem checkpoint is still valuable even if model completion failed.

**Recommendation:** yes—if side effects occurred, preserve the actual final filesystem snapshot but mark the logical turn outcome separately.

---

# 10. The T3 Placeholder Path and Its Known Race

This is the single most important implementation lesson from T3.

## 10.1 Current behavior

Codex can emit streaming:

```text
turn.diff.updated
```

Provider runtime ingestion can turn that into a domain checkpoint placeholder with:

```text
status = "missing"
```

The current `CheckpointReactor` reacts to that placeholder and immediately performs a **real filesystem checkpoint**.

Later, `turn.completed` sees that a real non-placeholder checkpoint may already exist and can skip recapturing.

## 10.2 Why this is dangerous

The first streaming diff update is not the same thing as:

```text
all tool side effects for this turn are finished
```

Therefore the checkpoint can be taken in the middle of the turn.

## 10.3 Issue #1434

T3 issue #1434 documents exactly this symptom:

- a long turn creates many files;
- turn 1 diff contains only early files;
- remaining files are present on disk;
- a later no-op prompt causes the omitted files to appear in turn 2's checkpoint diff.

A later issue comment identifies the likely mechanism:

> placeholder checkpoint is created from the first `turn.diff.updated`, then replaced by a real Git snapshot too early; later edits spill over the checkpoint boundary.

The suggested minimal fix was to let `turn.completed` own final capture.

As of the researched commit, the placeholder-to-real capture path is still present in `CheckpointReactor.ts`.

## 10.4 Root architectural cause

The source comments explain that the reactor does not consider its provider runtime stream sufficiently reliable for final completion delivery because of shared subscription behavior.

That transport problem pushed the checkpoint system toward using a less semantically reliable signal.

## 10.5 OpenCode must not copy this

OpenCode already pre-captures `Snapshot.track()` inside `SessionProcessor.create()` **before the LLM stream starts**, with an explicit comment explaining why:

> the AI SDK may execute tools internally before emitting start-step events.

This is exactly the kind of lifecycle discipline a checkpoint system needs.

For OpenCode final capture, use a similarly authoritative completion barrier:

```text
processor cleanup / end-of-user-turn lifecycle
AFTER all outstanding tool calls have settled
AFTER final file-producing hooks have completed
BEFORE the session is declared idle/turn finalized
```

Do not finalize a checkpoint on:

- first patch event;
- first file edit;
- first `step-finish`;
- streaming text completion;
- provider diff hint;
- debounce timer.

---

# 11. T3 Revert Workflow

## 11.1 Validation

T3 validates:

- thread exists;
- active provider session is bound;
- provider session has a workspace CWD;
- CWD is a Git workspace;
- requested turn is not beyond current turn;
- target checkpoint ref can be resolved.

Turn 0 may fall back to `HEAD` if the baseline ref is unavailable.

## 11.2 Filesystem restore

As described above:

```bash
git restore --source <checkpoint> --worktree --staged -- .
git clean -fd -- .
git reset --quiet -- .       # if HEAD exists
```

## 11.3 Workspace index refresh

After restore, T3 refreshes its workspace file-entry index so file pickers and `@` mentions reflect the reverted filesystem.

## 11.4 Conversation rollback

This is essential.

T3 calculates:

```text
rolledBackTurns = currentTurnCount - targetTurnCount
```

and calls provider conversation rollback for that many turns.

Therefore T3 rollback is **not only filesystem rollback**.

The filesystem and provider conversation are moved together.

## 11.5 Delete future checkpoints

Checkpoint refs with a turn count greater than the target are deleted:

```bash
git update-ref -d <staleCheckpointRef>
```

This intentionally collapses the future timeline rather than preserving a branch of alternate history.

## 11.6 Domain/read-model completion

The reactor dispatches:

```text
thread.revert.complete
```

after filesystem and provider rollback.

The read model can then truncate/recompute the logical thread state.

---

# 12. T3 Restore Safety Semantics

An implementation agent must understand what a T3-style revert actually destroys.

## 12.1 Untracked files

```bash
git clean -fd -- .
```

removes untracked files/directories.

It does not include `-x`, so ignored files should remain.

## 12.2 Staging area

T3's restore path touches `--staged`, then resets the index toward `HEAD`.

Therefore a user who had manually staged changes can lose that staging selection.

The content may still be present in the working tree if it matches checkpoint state, but the staging metadata is not preserved.

## 12.3 Branch

The branch ref and `HEAD` are not moved.

This is safer than a literal `reset --hard <detached checkpoint commit>` because a hidden checkpoint root commit is not normal branch ancestry.

## 12.4 OpenCode opportunity

OpenCode's shadow snapshot repository means it can restore files without needing to alter the real repo's index at all.

That is a strong reason **not** to replace OpenCode Snapshot with T3's same-repo hidden-ref approach.

---

# 13. T3 Worktrees and Checkpoints

T3 resolves checkpoint CWD from:

```text
thread.worktreePath
```

when available, otherwise project workspace root.

After a turn, it also refreshes Git status and contains branch-drift handling for dedicated worktrees.

The branch drift code intentionally avoids adopting:

- detached HEAD;
- temporary worktree placeholder branches;
- a branch change in a CWD shared by multiple threads.

This illustrates an important general rule:

> Checkpoint identity must include *which workspace/worktree instance the turn ran in*, not merely repository identity.

OpenCode's `Snapshot` state already includes both:

```text
ctx.worktree
project.id
Hash.fast(ctx.worktree)
```

which makes it naturally worktree-scoped.

---

# 14. T3 Checkpoint Metadata / Read Model

The contracts define a checkpoint summary containing:

```ts
{
  turnId,
  checkpointTurnCount,
  checkpointRef,
  status,
  files,
  assistantMessageId,
  completedAt
}
```

with statuses:

```text
ready
missing
error
```

Each file summary contains approximately:

```ts
{
  path,
  kind,
  additions,
  deletions
}
```

This application metadata is intentionally **not** owned by `CheckpointStore`.

`CheckpointStore` is a storage/VCS adapter.

The orchestration system owns:

- which turn a checkpoint belongs to;
- status;
- assistant message association;
- file summaries;
- completion timestamps;
- sequence;
- rollback semantics.

This separation is worth retaining in OpenCode.

---

# 15. T3 CheckpointStore Responsibility Boundary

`CheckpointStore` is a thin Effect service around whichever VCS driver is active.

Conceptually:

```ts
interface CheckpointStore {
  isGitRepository(cwd): boolean
  captureCheckpoint({ cwd, checkpointRef }): void | unsupported
  hasCheckpointRef({ cwd, checkpointRef }): boolean
  restoreCheckpoint({ cwd, checkpointRef, fallbackToHead? }): boolean | unsupported
  diffCheckpoints({...}): string
  deleteCheckpointRefs({...}): void
}
```

`VcsDriver` exposes checkpoint operations as an **optional capability**.

This is a good abstraction lesson even though OpenCode probably should not copy the exact service.

---

# 16. T3 Serialized Reactor

Checkpoint inputs from domain events and provider runtime events are fed into a drainable worker.

This gives a single, queue-backed side-effect path rather than letting every event handler mutate Git concurrently.

For OpenCode:

- `Snapshot` already uses a semaphore keyed by its snapshot Git directory;
- a new checkpoint metadata writer should also ensure session-level ordering.

Recommended ordering key:

```text
sessionID + worktree identity
```

---

# 17. T3 User-Facing Diff Semantics

The T3 product model historically centers the diff panel around checkpoint transitions.

Per issue #1590, the existing product behavior was:

```text
checkpoint[N-1] → checkpoint[N]
```

with per-turn selection.

The issue requested a second mode for a live Git diff because checkpoint-based views have limitations:

- manual changes outside the agent do not get a new turn boundary automatically;
- cumulative checkpoint diff is not identical to branch-vs-base review;
- checkpoint capture bugs need a live-disk fallback;
- huge turn diffs can be expensive.

Issue #1590 was later closed as completed, so the implementation agent should inspect current UI behavior before recreating a now-obsolete limitation.

### OpenCode design implication

Do not make the new checkpoint view replace OpenCode's existing broader diff capabilities.

Expose distinct concepts:

```text
Turn
  exact changes attributed to one AI turn

Session
  baseline → selected/latest checkpoint

Working tree
  current live Git/source state

Branch
  base...HEAD / PR-style review
```

They answer different questions.

---

# 18. Manual Checkpoint Feature Request

T3 issue #1472 requested manual snapshots for changes made by the user between agent turns.

It was closed as `not_planned`, but the use case remains valuable.

For OpenCode, manual checkpoints are much cheaper to support once a first-class checkpoint entity exists.

Recommended phase-two checkpoint kinds:

```ts
type CheckpointKind =
  | "baseline"
  | "turn"
  | "manual"
  | "pre-revert"
```

A manual checkpoint should not masquerade as an AI turn.

---

# 19. OpenCode's Existing Snapshot System

This is the most important OpenCode section.

## 19.1 Storage model

OpenCode uses a separate Git directory:

```text
<Global.Path.data>/snapshot/<project.id>/<Hash.fast(worktree)>
```

with:

```text
--git-dir <snapshot gitdir>
--work-tree <actual worktree>
```

This is a **shadow Git repository**.

The user's real `.git` refs and branches do not become the checkpoint database.

## 19.2 Why this is architecturally strong

Compared with T3 hidden refs in the real repo, OpenCode's design provides stronger isolation from the user's Git metadata:

- no hidden refs inside user's repository;
- no custom refs to push accidentally under unusual refspecs;
- no collision with real repo GC/ref tooling;
- snapshot index is separate;
- snapshot restore need not rewrite the real Git index;
- snapshot lifecycle can be pruned independently.

## 19.3 Existing `Snapshot` interface

Current interface:

```ts
interface Snapshot {
  init(): void
  cleanup(): void
  track(): string | undefined
  patch(hash: string): Patch
  restore(snapshot: string): void
  revert(patches: Patch[]): void
  diff(hash: string): string
  diffFull(from: string, to: string): FileDiff[]
}
```

Where a `Patch` includes:

```ts
{
  hash: string,
  files: string[]
}
```

The snapshot ID returned by `track()` is a **Git tree hash**.

This is critical:

> OpenCode already has the natural identifier needed for a per-turn checkpoint.

---

# 20. OpenCode Snapshot Initialization and Performance Work

OpenCode's implementation is significantly more performance-conscious than a naive shadow repo.

## 20.1 Source object alternates

On initial seed it resolves the source repository's Git common directory and writes alternates so the shadow repository can reuse the source object's database.

This avoids re-hashing/re-copying every pre-existing blob.

## 20.2 Index seeding

If the source index exists, it attempts to copy the source index into the snapshot repo.

The source comments explicitly explain that this is important for huge repositories such as Chromium, where rebuilding all hashes can take minutes.

## 20.3 Large-repo Git tuning

The snapshot Git repository config includes performance-related options such as:

```text
feature.manyFiles=true
index.version=4
index.threads=true
core.untrackedCache=true
core.fsmonitor=false
```

plus explicit long-path/symlink/autocrlf behavior.

## 20.4 Serialized access

A semaphore is keyed by snapshot `gitdir`.

Mutating/read-modify-write operations go through that lock.

This makes the snapshot service a better foundation than layering unrelated Git commands beside it.

---

# 21. OpenCode Snapshot Ignore Semantics

OpenCode does extra work to keep the snapshot repository aligned with source-repo ignore behavior.

It:

1. reads the source repository's `info/exclude`;
2. writes corresponding ignore/exclude state into the snapshot repo;
3. enumerates changed/untracked candidates;
4. invokes source Git ignore classification;
5. removes newly ignored files from the snapshot index;
6. stages only allowed paths.

This is more nuanced than a blanket `git add -A`.

---

# 22. OpenCode Snapshot Large-File Rule

OpenCode has a per-file threshold:

```text
2 * 1024 * 1024 bytes
```

New untracked files larger than the threshold are excluded from snapshot tracking.

Tests verify a newly added file larger than the limit:

- does not appear in patch;
- does not appear in diff;
- does not change the snapshot tree hash.

### Feature-design implication

A first-class checkpoint UI must surface this limitation.

Otherwise a user can believe:

> "checkpoint captured everything"

when an oversized new file is intentionally not represented.

Recommended checkpoint metadata:

```ts
{
  excluded: [
    {
      path,
      reason: "new-file-too-large",
      size
    }
  ]
}
```

If exposing excluded paths is too invasive for v1, at minimum expose:

```text
checkpoint completeness = partial
```

when exclusions are known.

---

# 23. OpenCode Snapshot Track Flow

The current `track()` path effectively:

```text
ensure shadow Git dir exists
    ↓
initialize + seed if first use
    ↓
detect changed/untracked files
    ↓
apply source ignore policy
    ↓
stage allowed changed paths in shadow repo
    ↓
git write-tree
    ↓
return tree hash
```

Unlike T3, OpenCode does **not** need a commit object just to identify the snapshot.

Tree OIDs are sufficient for:

- diff;
- restore;
- patch;
- equality/deduplication.

This is very efficient.

---

# 24. OpenCode Snapshot Revert / Restore Behavior

OpenCode has two related concepts.

## 24.1 `restore(snapshot)`

The shadow Git repo reads the target tree and checks its index contents into the real worktree.

Conceptually:

```bash
git --git-dir <shadow> --work-tree <worktree> read-tree <snapshot>
git --git-dir <shadow> --work-tree <worktree> checkout-index -a -f
```

## 24.2 `revert(patches)`

This is a targeted inverse operation based on patch metadata/files.

Tests verify:

- newly added files are removed;
- deleted files are restored;
- modified files are restored;
- nested files work;
- binary additions are removed;
- special-character paths work;
- Unicode paths are largely covered;
- symlinks are tracked;
- empty patches are safe.

### Crucial OpenCode advantage

All this can occur without intentionally rewriting the real repository's branch or staging index.

---

# 25. OpenCode Existing Conversation Revert

`../../packages/opencode/src/session/revert.ts` already coordinates filesystem snapshot operations with conversation state.

Current high-level flow:

```text
assert session is not busy
    ↓
load messages and locate requested revert point
    ↓
collect patch parts after target
    ↓
capture current snapshot for unrevert
    ↓
restore previous revert snapshot if one is active
    ↓
revert accumulated patches
    ↓
compute diff from saved unrevert snapshot
    ↓
recompute session file diff summary
    ↓
persist session revert metadata
```

It also supports:

```text
unrevert
```

by restoring the snapshot captured before the revert.

This is a major capability T3's destructive timeline truncation does not obviously provide in the same way.

### Recommendation

A per-turn checkpoint feature should integrate with or refactor this service rather than creating an independent rollback command.

---

# 26. OpenCode Processor Already Captures a Pre-Stream Snapshot

In `SessionProcessor.create()`:

```text
initialSnapshot = snapshot.track()
```

happens before the LLM stream starts.

The source comment is highly relevant:

> AI SDK may execute tools internally before emitting start-step events, so capturing inside the event handler can be too late.

This is essentially the pre-turn checkpoint race solved correctly.

It should become the foundation of the new feature's baseline association.

---

# 27. OpenCode Already Emits Patch Parts During Processing

The session processor:

- holds `ctx.snapshot`;
- obtains a patch against that snapshot;
- writes patch parts onto the assistant message when files changed;
- repeats patch generation during cleanup paths.

Those patch parts are exactly what the existing `SessionRevert` later consumes.

Therefore OpenCode already has an implicit causal link:

```text
assistant execution
    ↔
snapshot hash
    ↔
changed file set
```

The missing T3-like feature is largely:

> **turn-level durability, indexing, timeline querying, cumulative diffing, and a richer review/revert UI.**

---

# 28. OpenCode Existing HTTP Surface

Current session HTTP API already includes:

```text
GET  /session/:sessionID/diff
POST /session/:sessionID/revert
POST /session/:sessionID/unrevert
POST /session/:sessionID/message
POST /session/:sessionID/prompt_async
POST /session/:sessionID/abort
```

`session.diff` returns structured `Snapshot.FileDiff[]`.

That means a checkpoint feature should extend the existing session API family rather than inventing a separate server.

---

# 29. T3 → OpenCode Capability Mapping

| T3 concept | Current T3 mechanism | OpenCode equivalent / target |
|---|---|---|
| Snapshot storage | detached commit + custom ref | **existing Snapshot tree hash** |
| Hidden snapshot namespace | `refs/t3/checkpoints/...` | shadow Git dir under global data |
| Capture isolation | temporary Git index | shadow repo index |
| Baseline | ref turn 0 | snapshot tree hash before user turn |
| Final checkpoint | ref turn N | snapshot tree hash after turn quiesces |
| Turn metadata | orchestration projection | **new checkpoint persistence model** |
| Per-turn diff | ref N-1 → N | `Snapshot.diffFull(from,to)` |
| Raw unified diff | `git diff` commits | existing `Snapshot.diff(...)` or new two-tree raw helper |
| Cumulative diff | baseline → selected | `Snapshot.diffFull(baseline,selected)` |
| Rollback filesystem | Git restore/clean/reset-index | existing Snapshot revert/restore |
| Rollback conversation | provider rollback | existing SessionRevert / cleanup semantics |
| Delete future checkpoints | delete refs | delete/truncate checkpoint rows/metadata |
| Diff UI | turn chips + viewer | app/session UI checkpoint timeline |
| Error status | ready/missing/error | new checkpoint status |
| Manual checkpoint | requested, not planned | easy phase-two addition |

---

# 30. Architectural Decision: Storage Strategy

There are three viable strategies.

## Option A — Literal T3 hidden refs in user's repository

```text
refs/opencode/checkpoints/<session>/<turn>
```

### Pros

- direct parity with T3;
- standard Git object reachability;
- inspectable with Git plumbing;
- no external metadata needed to keep objects reachable.

### Cons

- duplicates existing OpenCode snapshot machinery;
- mutates user's repository ref store;
- checkpoint lifecycle tied to source repo GC/ref semantics;
- worktree/common-dir semantics become more complex;
- same-repo restore tends to interact with real index;
- adds another Git concurrency domain;
- carries T3's semantics into a codebase that already solved isolation differently.

### Recommendation

**Do not choose this for v1.**

---

## Option B — Extend OpenCode `Snapshot` with first-class checkpoint metadata

### Pros

- reuses mature code;
- no source-ref pollution;
- no real-index mutation;
- tests already cover many filesystem cases;
- fast on large repos because of alternates/index seeding;
- naturally worktree-scoped;
- existing SessionRevert integration;
- smaller implementation surface.

### Cons

- checkpoint durability depends on shadow repo lifecycle;
- GC policy must guarantee checkpoint trees remain reachable;
- raw tree IDs alone are not refs;
- current `Snapshot.cleanup()` prunes unreachable objects after a configured period;
- first-class checkpoint metadata must create a reachability mechanism if a checkpoint must live longer than ordinary loose-object grace.

### Recommendation

**Choose this, but explicitly solve reachability/durability.**

---

## Option C — Hybrid: use shadow repo + private refs there

This is the recommended refinement of Option B.

Keep OpenCode's isolated shadow Git repository, but give durable checkpoints refs **inside the shadow repository**, not the user's real repository.

Example:

```text
refs/opencode/checkpoints/<session-b64>/turn/<ordinal>
```

pointing to either:

- commits that contain the snapshot tree, or
- lightweight ref targets supported by chosen object type/ref semantics.

Safer conventional implementation:

```text
tree hash
    ↓
commit-tree in shadow Git repo
    ↓
update-ref in shadow Git repo
```

### Why hybrid is attractive

It combines:

- OpenCode's source-repo isolation;
- T3's explicit reachability/durability;
- named checkpoint cleanup;
- stable IDs through GC.

### But do not overbuild v1

If OpenCode's storage/database already retains enough information and snapshot GC guarantees are acceptable, first ship durable metadata with the existing tree hashes and add shadow refs only if necessary.

The implementation agent must verify object reachability under `Snapshot.cleanup()` before finalizing this decision.

---

# 31. Recommended OpenCode Domain Model

## 31.1 `SessionCheckpoint`

**PROPOSED**

```ts
type SessionCheckpointStatus =
  | "capturing"
  | "ready"
  | "partial"
  | "error"

type SessionCheckpointKind =
  | "baseline"
  | "turn"
  | "manual"
  | "pre-revert"

type SessionCheckpoint = {
  id: string

  sessionID: string

  // User message that initiated the logical turn.
  userMessageID: string | null

  // Final assistant message associated with the turn.
  assistantMessageID: string | null

  // Monotonic within session.
  ordinal: number

  kind: SessionCheckpointKind
  status: SessionCheckpointStatus

  // OpenCode Snapshot tree hash.
  snapshot: string

  // Previous checkpoint's snapshot.
  parentSnapshot: string | null

  // Optional stable shadow-ref if hybrid durability is implemented.
  ref?: string

  createdAt: number
  completedAt: number | null

  summary: {
    files: number
    additions: number
    deletions: number
  }

  excluded?: Array<{
    path: string
    reason: string
    size?: number
  }>

  error?: {
    code: string
    message: string
  }
}
```

## 31.2 Why ordinal is separate from message ID

A checkpoint timeline must tolerate:

- retry/regeneration;
- multiple assistant steps;
- tool-only turns;
- aborted turns;
- compaction;
- future manual checkpoints;
- forked sessions.

Do not use array index as checkpoint identity.

---

# 32. Recommended Persistence

OpenCode is already using database-backed session structures plus storage/event layers.

Preferred:

```text
session_checkpoint table
```

rather than embedding all checkpoint history in a single JSON column.

Suggested columns:

```sql
id                TEXT PRIMARY KEY
session_id        TEXT NOT NULL
ordinal           INTEGER NOT NULL
kind              TEXT NOT NULL
status            TEXT NOT NULL
snapshot          TEXT NOT NULL
parent_snapshot   TEXT
user_message_id   TEXT
assistant_message_id TEXT
created_at        INTEGER NOT NULL
completed_at      INTEGER
files             INTEGER NOT NULL DEFAULT 0
additions         INTEGER NOT NULL DEFAULT 0
deletions         INTEGER NOT NULL DEFAULT 0
metadata          TEXT
error             TEXT

UNIQUE(session_id, ordinal)
INDEX(session_id, ordinal)
INDEX(session_id, user_message_id)
INDEX(session_id, assistant_message_id)
```

If schema migration cost is undesirable for a prototype, use the existing storage abstraction first, but the execution agent should keep the API shaped so migration to SQL is straightforward.

---

# 33. Define a Logical OpenCode "Turn" Before Coding

T3 has an explicit turn model.

OpenCode's runtime has:

- user messages;
- assistant messages;
- potentially multiple LLM steps;
- tool calls;
- retries;
- subagents;
- compaction;
- cleanup.

The implementation must define:

> **Checkpoint turn = one top-level user message through terminal completion of the primary assistant run caused by that message.**

Do not create a final checkpoint for every LLM step.

Subagent behavior needs a deliberate rule.

Recommended v1:

- child/subagent filesystem effects are attributed to the parent top-level turn when they share the same worktree;
- child session checkpoint timelines may exist independently if they run in separate sessions/workspaces;
- do not allow two checkpoint writers to race on the same worktree.

---

# 34. Capture Lifecycle — Recommended OpenCode Design

## 34.1 Pre-turn

At the earliest authoritative point before tool execution:

```text
user message accepted
    ↓
session lock/run state acquired
    ↓
snapshot.track()
    ↓
associate as baseline snapshot for this logical turn
    ↓
start LLM/tool processing
```

OpenCode already captures in `SessionProcessor.create()` before the LLM stream.

Use that existing snapshot rather than immediately calling `track()` a second time.

### Important implementation preference

Refactor processor creation so the snapshot can be exposed/associated with the logical user turn cleanly.

Avoid hidden duplicate captures.

## 34.2 During turn

Do not finalize.

Existing patch parts may continue to be emitted for:

- UI streaming;
- revert internals;
- incremental summaries.

But they are not final checkpoint boundaries.

## 34.3 Quiescence barrier

Before final capture, prove:

- no live tool call Deferreds remain;
- processor cleanup has completed;
- file-mutating plugin hooks are done;
- child tasks that are part of this top-level turn have settled according to chosen semantics;
- session is still on the same logical run generation;
- abort/cancel cleanup is complete.

## 34.4 Final capture

```text
finalSnapshot = snapshot.track()
```

If:

```text
finalSnapshot === baselineSnapshot
```

the turn still gets a checkpoint row if the UX wants one checkpoint per logical turn.

This supports empty/no-file-change turns without special gaps.

## 34.5 Diff derivation

```text
Snapshot.diffFull(baselineSnapshot, finalSnapshot)
```

Compute:

```text
file count
additions
deletions
structured file list
```

Persist summary.

Do not persist giant full patch text unless there is a strong reason; regenerate it from snapshot objects on demand.

---

# 35. Exactly-Once Finalization

The feature needs idempotency.

A turn completion signal can be duplicated by:

- retry paths;
- cleanup paths;
- abort handling;
- connection/restart recovery.

Use a uniqueness invariant:

```text
UNIQUE(sessionID, logicalTurnID)
```

or:

```text
UNIQUE(sessionID, ordinal)
```

with an idempotency key tied to the top-level user message/run generation.

Recommended state machine:

```text
pending
  ↓
capturing
  ↓
ready | partial | error
```

Finalization should be a compare-and-set transition.

---

# 36. Crash Recovery

A mature checkpoint system should survive process death between:

```text
baseline captured
```

and:

```text
final checkpoint metadata committed
```

On startup/session resume:

1. query checkpoints/statuses left `capturing`;
2. inspect session run state;
3. if the turn is definitely finished, capture current snapshot and mark recovered;
4. if causal ownership is ambiguous, mark checkpoint `error`/`partial` rather than guessing;
5. never silently attribute current unrelated disk state to an old turn.

---

# 37. Diff API Proposal

Extend the existing session HTTP group.

## 37.1 List checkpoints

```http
GET /session/:sessionID/checkpoint
```

Response:

```ts
SessionCheckpoint[]
```

Use pagination only if sessions can be extremely long.

## 37.2 Get a checkpoint

```http
GET /session/:sessionID/checkpoint/:checkpointID
```

## 37.3 Per-turn diff

```http
GET /session/:sessionID/checkpoint/:checkpointID/diff
```

or:

```http
GET /session/:sessionID/checkpoint/diff?from=<id>&to=<id>
```

Recommended structured response:

```ts
{
  from,
  to,
  files: Snapshot.FileDiff[]
}
```

## 37.4 Raw patch

Only if UI renderer needs it:

```http
GET /session/:sessionID/checkpoint/diff/raw?from=...&to=...
```

Use response-size controls.

## 37.5 Cumulative session diff

```http
GET /session/:sessionID/checkpoint/diff?from=baseline&to=<selected>
```

## 37.6 Revert

```http
POST /session/:sessionID/checkpoint/:checkpointID/revert
```

Payload should include an explicit policy if manual working-tree changes exist.

Example:

```ts
{
  mode: "discard-current" | "preserve-current"
}
```

For v1, if only discard is supported, make that explicit in UX.

## 37.7 Manual checkpoint — phase two

```http
POST /session/:sessionID/checkpoint
```

```ts
{
  kind: "manual",
  label?: string
}
```

---

# 38. Event Model Proposal

Use OpenCode's existing event bridge.

Suggested events:

```text
session.checkpoint.created
session.checkpoint.updated
session.checkpoint.removed
session.checkpoint.reverted
session.checkpoint.error
```

Payloads should be additive and small.

Do not broadcast full diffs in ordinary events.

The UI can fetch a diff when the user selects a checkpoint.

---

# 39. UI / UX Blueprint

OpenCode should take T3's concept but integrate it into the existing app visual language.

## 39.1 Timeline

For each top-level user turn, render a checkpoint affordance associated with that turn.

Potential compact representation:

```text
Turn 1   +4 -2   3 files
Turn 2   +88 -15 12 files
Turn 3   No file changes
```

Statuses:

```text
ready     normal
partial   warning
error     destructive/retry affordance
capturing subtle spinner only while genuinely pending
```

## 39.2 Selection modes

Recommended header modes:

```text
TURN | SESSION | WORKTREE
```

### TURN

Selected turn's baseline → final checkpoint.

### SESSION

Initial baseline → selected/latest checkpoint.

### WORKTREE

Live current state; use existing source-control/diff facilities.

This avoids T3 issue #1590's conceptual collision.

## 39.3 Diff renderer

Reuse OpenCode's existing structured diff rendering wherever possible.

Do not introduce a second syntax diff library unless required.

Capabilities:

- file list;
- added/deleted counts;
- collapse/expand files;
- split/unified if supported;
- whitespace toggle if renderer/API supports it;
- binary-file state;
- deleted/new-file states.

## 39.4 Revert action

Checkpoint menu:

```text
View turn diff
View changes through here
Restore workspace to here…
```

Confirmation should state precisely:

- which later turns will be removed/hidden;
- whether uncommitted manual changes will be overwritten;
- whether an unrevert point will be saved;
- whether ignored files are untouched;
- what happens to newly added large files excluded from snapshots.

---

# 40. Revert Architecture — Recommended OpenCode Path

Do not call `Snapshot.restore(target)` blindly and then separately delete messages.

Use a coordinated service.

Proposed:

```text
SessionCheckpointRevert
```

or refactor existing:

```text
SessionRevert
```

to accept a checkpoint target.

## 40.1 Preconditions

- session not busy;
- checkpoint belongs to session;
- checkpoint snapshot object is resolvable;
- worktree identity matches;
- no concurrent run generation changed since request.

## 40.2 Safety capture

Before destructive restore:

```text
preRevertSnapshot = snapshot.track()
```

Store it as an unrevert point.

This preserves OpenCode's existing nice `unrevert` property.

## 40.3 Restore filesystem

Preferred:

- use existing Snapshot restore/revert primitives;
- avoid touching source repo `HEAD`;
- avoid modifying real Git index.

## 40.4 Truncate logical future

Remove or mark superseded:

- messages after target causal point;
- patch parts after target;
- checkpoint metadata after target;
- derived `session_diff`;
- summaries/todos if they are causal products of removed messages.

## 40.5 Recompute derived state

Recompute:

- diff summary;
- session summary metadata;
- UI aggregates.

## 40.6 Publish events

Publish a single coherent completion after the state is internally consistent.

---

# 41. Alternate-History Question

T3 deletes stale future checkpoint refs after rollback.

OpenCode currently has `unrevert`, which argues for a slightly richer model.

Two choices:

## Destructive linear timeline

After restore:

```text
checkpoints > target → deleted
```

Pros:

- T3 parity;
- simple.

## Soft-superseded timeline

Mark future checkpoints:

```text
superseded_by_revert_id
```

and hide them by default.

Pros:

- can support redo/branching history;
- better forensic recovery.

Cons:

- more data-model complexity.

### Recommendation

For v1:

- retain **one pre-revert snapshot** for unrevert;
- logically truncate later checkpoints from active timeline;
- actual background deletion can happen after unrevert expires or next committed turn.

---

# 42. Manual Edits Between Turns

This is where checkpoint semantics become subtle.

Suppose:

```text
turn 1 checkpoint
↓
user manually edits file A
↓
turn 2 starts
```

If turn 2's baseline is captured immediately before model execution, the manual edit belongs to:

```text
baseline for turn 2
```

and should **not** appear as AI change in turn 2's diff.

That is good attribution.

Therefore per-turn diff should be:

```text
preTurnSnapshot → postTurnSnapshot
```

not necessarily:

```text
previousTurnPostSnapshot → currentTurnPostSnapshot
```

This is an important improvement over a simplistic T3 sequential model.

### Proposed model therefore stores both

```ts
baselineSnapshot
finalSnapshot
```

per logical turn, even if baseline frequently equals prior final.

This cleanly excludes manual inter-turn changes from AI attribution.

It also allows a separate:

```text
between-turn/manual diff
```

if desired later.

---

# 43. This Is a Key Place to Improve on T3

T3 uses:

```text
checkpoint[N-1] → checkpoint[N]
```

as its turn diff.

That assumes the state between those checkpoint boundaries belongs to the next logical agent turn.

Issue #1590 highlights that manual changes are not independently represented.

OpenCode can define a more precise causal model:

```text
TurnCheckpoint {
  before
  after
}
```

Then:

```text
AI turn diff = before → after
```

while:

```text
inter-turn drift =
previous.after → current.before
```

This provides exact attribution.

### Strong recommendation

Implement **two snapshot hashes per turn record** or model baseline checkpoint objects separately.

Do not derive current turn baseline exclusively from prior turn final snapshot.

---

# 44. Proposed Refined Data Model

```ts
type TurnCheckpoint = {
  id: string
  sessionID: string
  turnID: string
  ordinal: number

  userMessageID: string
  assistantMessageID: string | null

  beforeSnapshot: string
  afterSnapshot: string

  status:
    | "capturing"
    | "ready"
    | "partial"
    | "error"
    | "aborted"

  startedAt: number
  completedAt: number | null

  summary: {
    files: number
    additions: number
    deletions: number
  }

  completeness: {
    largeFilesExcluded: number
    ignoredFilesExcluded: boolean
  }
}
```

Then session/cumulative review can use:

```text
first.beforeSnapshot → selected.afterSnapshot
```

Inter-turn manual drift:

```text
previous.afterSnapshot → current.beforeSnapshot
```

---

# 45. Snapshot Object Durability

This must be resolved before implementation is considered complete.

OpenCode `Snapshot.cleanup()` runs Git GC with a prune horizon expressed as:

```text
7.days
```

A raw tree OID stored in SQL is not automatically a Git reachability root.

If the tree is only reachable as an unreferenced loose object and enough time/GC passes, the checkpoint may disappear.

The execution agent must experimentally verify:

1. what objects `write-tree` creates/reuses;
2. which objects remain reachable in the shadow repo;
3. what `git gc --prune=7.days` can delete;
4. whether current snapshot workflow creates any refs/commits elsewhere;
5. whether a persisted checkpoint tree survives cleanup.

### If not guaranteed

Create durable refs **inside the shadow repo**.

Recommended:

```text
refs/opencode/checkpoints/<sessionBase64>/turn/<ordinal>/before
refs/opencode/checkpoints/<sessionBase64>/turn/<ordinal>/after
```

Simpler alternative:

- make a commit object for `after`;
- optionally tag/store `before` separately.

But two refs to tree-ish objects may need conventional commit objects depending on command/tooling assumptions.

### Important

Do not add those refs to the user's real repository.

---

# 46. Concurrency Model

## 46.1 Existing snapshot lock

OpenCode has a semaphore keyed by snapshot Git directory.

Keep using it.

## 46.2 Add session checkpoint lock

Metadata ordering also needs protection.

Potential invariant:

```text
for any session:
  at most one active top-level checkpoint capture
```

## 46.3 Shared worktree

If two sessions can operate on the same worktree concurrently, exact filesystem attribution is impossible without additional isolation.

Choices:

1. disallow concurrent checkpointed turns on one worktree;
2. automatically create worktrees;
3. mark checkpoints `partial/contended`;
4. maintain file-write provenance at tool layer.

For v1, the safest policy is:

> checkpoint accuracy is guaranteed only when a worktree has one active mutating top-level run.

Detect and warn rather than silently lying.

---

# 47. Abort / Failure Semantics

A failed turn may still have changed files.

Do not map:

```text
turn failure ⇒ no checkpoint
```

Instead:

```text
turn aborted
  + filesystem changed
  ⇒ capture after state
  ⇒ status=aborted
  ⇒ diff remains reviewable/revertible
```

A checkpoint is a record of reality, not an assertion that the model succeeded.

---

# 48. Empty Turns

If:

```text
beforeSnapshot === afterSnapshot
```

store the turn checkpoint anyway if timeline alignment is important.

Summary:

```text
0 files
+0
-0
```

This preserves:

```text
user turn ↔ checkpoint ordinal
```

and avoids off-by-one mapping when later turns are selected.

---

# 49. Large Diff Strategy

T3 has a fixed checkpoint diff output ceiling.

OpenCode's `diffFull` already works in structured batches.

Recommended:

- list file summaries first;
- fetch/render file details lazily;
- avoid serializing multi-megabyte unified patches into every realtime event;
- allow cancellation when user switches selected turn;
- cache structured diff summaries keyed by:

```text
beforeSnapshot + ":" + afterSnapshot
```

---

# 50. Diff Cache

Snapshot hashes are content-addressed.

Therefore diff results can be cached safely:

```text
key = hash(before + NUL + after + NUL + options)
```

Options include:

```text
whitespace mode
context lines
rename detection policy
```

A checkpoint diff is immutable once both tree hashes exist.

This is an excellent cache boundary.

---

# 51. Performance Benchmarks Required

Do not ship on qualitative claims.

Benchmark at minimum:

## Repository sizes

- 1k files;
- 10k files;
- 100k files;
- monorepo / Chromium-class synthetic or real fixture.

## Change sets

- zero changes;
- 1 modified file;
- 100 modified files;
- 1,000 generated files;
- tracked deletion burst;
- untracked file burst;
- rename-heavy change;
- large ignored directory present;
- many >2 MiB new files.

## Metrics

```text
pre-turn snapshot latency
post-turn snapshot latency
p50 / p95 / p99
diff summary latency
full structured diff latency
peak RSS
Git subprocess count
bytes written to snapshot object store
database checkpoint row overhead
revert latency
unrevert latency
```

## Regression targets

The checkpoint metadata layer should add almost no extra Git work beyond snapshot operations OpenCode already performs.

---

# 52. T3 Bug Regression Test to Port Immediately

Create an automated reproduction inspired by T3 #1434:

```text
1. clean worktree
2. start one top-level turn
3. execute 18 distinct sequential file writes
4. ensure each tool write fully resolves
5. finish turn
6. inspect turn checkpoint
7. assert all 18 files are in diff
8. start a no-op second turn
9. assert second turn has zero file changes
```

This should be one of the first new tests.

---

# 53. Additional Correctness Tests

## Baseline attribution

```text
manual edit before turn
turn modifies different file
turn diff must exclude prior manual edit
```

## Manual edit during active turn

If possible through external process:

```text
external edit races agent
```

Expected behavior must be defined. At minimum mark attribution uncertainty if detectable.

## Gitignored file

- ignored file changed;
- should not be included;
- revert should not destroy it.

## Large new file

- >2 MiB file created by turn;
- checkpoint should report partial/excluded state or explicitly documented exclusion.

## Existing large tracked file

Verify behavior independently from new-untracked limit.

## Binary file

- add/modify/delete.

## Symlink

- create/change/delete.

## Unicode paths

- CJK;
- emoji;
- Cyrillic;
- composed/decomposed Unicode where platform supports.

## Windows

- long path;
- colon invalidity awareness;
- path separators;
- file locks;
- antivirus contention.

## Worktree

- same project, distinct worktrees;
- same repo, concurrent sessions.

## Abort

- edit files;
- abort turn;
- ensure checkpoint remains usable.

## Crash

- kill after baseline;
- kill after final snapshot but before metadata commit;
- restart and recover safely.

## Revert

- restore selected turn;
- validate filesystem;
- validate message timeline;
- validate diff summary;
- validate later checkpoints gone/inactive.

## Unrevert

- restore pre-revert state exactly.

---

# 54. Real Git Index Preservation Test

This is especially important because T3 does not preserve staging selection.

OpenCode should.

Test:

```text
1. create staged change S
2. create unstaged change U
3. run agent turn modifying A
4. checkpoint
5. revert turn
6. inspect user's real Git index
```

Expected OpenCode behavior:

```text
staging state S is unchanged
```

unless product explicitly documents otherwise.

This should be a hard acceptance criterion.

---

# 55. Source Repository Invariants

Checkpoint operations should not change:

```text
HEAD
current branch
upstream config
real repo refs
real Git index
real stash
remotes
hooks
Git config
```

unless a separate user-requested Git action occurs.

These can be tested before/after via Git plumbing.

---

# 56. Security and Path Safety

## Path escape

All snapshot/restoration paths must remain under the worktree.

Special care:

- symlinks;
- junctions on Windows;
- path traversal;
- literal pathspecs beginning with `:`;
- NUL-separated Git path input.

OpenCode already uses literal/top-level pathspec encoding in snapshot staging, which should be retained.

## Git hooks

Snapshot operations should avoid unexpectedly executing user hooks.

`write-tree`, `read-tree`, `checkout-index`, etc. are preferable to user-facing commit workflows that could invoke hooks.

## Malicious repository config

Continue hardening Git invocation where practical:

- no ext diff;
- no textconv for server-generated raw diff unless intentionally enabled;
- controlled environment;
- bounded output;
- explicit paths.

---

# 57. Observability

Add structured spans/log fields:

```text
session_id
checkpoint_id
ordinal
before_snapshot
after_snapshot
worktree_hash
capture_phase
file_count
additions
deletions
duration_ms
status
excluded_count
```

Do not log file contents.

Useful counters:

```text
checkpoint.capture.success
checkpoint.capture.failure
checkpoint.capture.partial
checkpoint.diff.failure
checkpoint.revert.success
checkpoint.revert.failure
checkpoint.recovery
```

---

# 58. Failure Handling

A failure to derive the file summary should not necessarily invalidate an already captured snapshot.

T3 already separates:

```text
checkpoint captured
```

from:

```text
turn diff summary unavailable
```

OpenCode should do the same.

Proposed internal statuses:

```text
snapshot_ready
summary_error
```

which can render as a recoverable checkpoint with a retry button.

---

# 59. Recompute Instead of Overpersist

Persist:

- snapshot IDs;
- causal message IDs;
- status;
- lightweight summary.

Do not persist:

- every full unified patch;
- full before/after file bodies.

Git snapshot objects already represent the underlying state.

Derived diffs can be recomputed and cached.

---

# 60. Integration File Map — OpenCode

The implementation agent should start here.

## Backend core

### `../../packages/opencode/src/snapshot/index.ts`

Primary reuse target.

Likely changes:

- expose snapshot completeness/exclusion metadata if desired;
- add durable checkpoint object pinning if needed;
- potentially add `diffRaw(from,to)` instead of only diff against current shadow index;
- potentially add `pin/unpin` APIs.

### `../../packages/opencode/src/session/processor.ts`

Critical lifecycle seam.

Existing important behavior:

- pre-stream `snapshot.track()`;
- patch generation;
- cleanup.

Likely changes:

- propagate top-level pre-turn snapshot into checkpoint finalizer;
- invoke checkpoint finalizer only after tool-call settling/cleanup;
- keep step-level patch behavior separate.

### `../../packages/opencode/src/session/prompt.ts`

Owns higher-level session loop.

Use it to resolve:

- top-level user-message/turn identity;
- retry boundaries;
- subtask semantics;
- compaction interaction.

### `../../packages/opencode/src/session/revert.ts`

Do not duplicate it.

Refactor/extend to:

- accept checkpoint target;
- truncate/recompute correct logical history;
- preserve existing unrevert behavior.

### `../../packages/opencode/src/session/summary.ts`

Reuse structured diff computation where appropriate.

### `../../packages/opencode/src/session/session.ts`

Session metadata/events/model integration.

## API

### `../../packages/opencode/src/server/routes/instance/httpapi/groups/session.ts`

Add checkpoint endpoints in the existing session group.

## Shared schema / generated SDK

Follow OpenCode's existing API-generation flow rather than editing generated SDK output manually.

## App UI

Search current `../../packages/app` for:

- session diff data;
- session message actions;
- revert/unrevert;
- source-control panels;
- global sync event reducer.

Likely integration points will be under `packages/app/src/...`.

## Shared session UI

Inspect:

```text
packages/session-ui/src/components/message-part.tsx
```

and neighboring message/session components before inventing a new standalone diff implementation.

## Desktop

`../../packages/desktop` is Electron shell plumbing and consumes `@opencode-ai/app`.

Most checkpoint UI should live in shared app code unless it is truly desktop-only.

---

# 61. Do Not Put Business Logic in Electron Main

The checkpoint subsystem belongs in the OpenCode backend/session domain.

Electron should not directly run:

```bash
git ...
```

for checkpoint semantics.

Why:

- CLI/web/TUI can share capability;
- one source of truth;
- lifecycle is in backend session processor;
- filesystem path/worktree context is already owned there;
- easier tests.

---

# 62. Implementation Phases

## Phase 0 — Verify current source and semantics

- pin target commit;
- run existing snapshot tests;
- read complete Snapshot service;
- identify Snapshot GC reachability;
- trace processor cleanup/abort flow;
- trace existing session diff/revert UI.

Deliverable:

```text
implementation notes with final file list
```

## Phase 1 — Domain + persistence only

Implement first-class turn checkpoint records.

No new UI beyond debug endpoint.

Acceptance:

- before/after snapshots recorded for every top-level turn;
- no extra attribution race;
- empty turns represented;
- statuses correct.

## Phase 2 — Diff API

Implement:

```text
list checkpoints
turn diff
cumulative diff
```

Reuse structured `Snapshot.diffFull`.

Acceptance:

- T3 #1434 regression passes;
- manual pre-turn edit excluded from AI turn diff.

## Phase 3 — Timeline UI

Add:

- per-turn file counts;
- checkpoint selection;
- turn/session diff modes.

## Phase 4 — Checkpoint revert

Integrate with existing `SessionRevert`.

Acceptance:

- filesystem + conversation move together;
- real index unchanged;
- unrevert works.

## Phase 5 — Durability hardening

Add shadow refs/pins if object-GC testing proves necessary.

## Phase 6 — Manual checkpoints / inter-turn drift

Optional after core semantics stabilize.

---

# 63. Suggested Backend Service Shape

Avoid an over-abstracted T3 clone. A compact OpenCode-specific service is enough.

```ts
interface SessionCheckpointService {
  beginTurn(input: {
    sessionID: string
    userMessageID: string
    beforeSnapshot: string
  }): Effect<CheckpointDraft>

  finalizeTurn(input: {
    checkpointID: string
    assistantMessageID?: string
    outcome: "completed" | "aborted" | "failed"
  }): Effect<SessionCheckpoint>

  list(input: {
    sessionID: string
  }): Effect<SessionCheckpoint[]>

  diff(input: {
    sessionID: string
    checkpointID: string
    mode: "turn" | "session"
  }): Effect<Snapshot.FileDiff[]>

  revert(input: {
    sessionID: string
    checkpointID: string
  }): Effect<Session.Info>
}
```

Storage mechanics remain delegated to `Snapshot`.

---

# 64. Suggested Finalization Pseudocode

```ts
const begin = yield* checkpoints.beginTurn({
  sessionID,
  userMessageID,
  beforeSnapshot: preStreamSnapshot,
})

const result = yield* runPrimaryTurn(...)

yield* awaitAllToolCallsSettled()
yield* runCleanupThatMayMutateFiles()

const checkpoint = yield* checkpoints.finalizeTurn({
  checkpointID: begin.id,
  assistantMessageID: result.assistantMessageID,
  outcome: result.outcome,
})
```

Inside finalize:

```ts
const after = yield* snapshot.track()

const files =
  before === after
    ? []
    : yield* snapshot.diffFull(before, after)

yield* repository.finalize({
  afterSnapshot: after,
  summary: summarize(files),
  status: deriveStatus(...)
})
```

---

# 65. Why Pre- and Post-Snapshot Must Be Explicit

Do not reconstruct a turn's `before` state later from:

```text
previous checkpoint after
```

because between-turn manual edits break causal attribution.

Do not reconstruct `after` from current working tree later because subsequent activity breaks temporal accuracy.

Both hashes must be captured at their actual boundary.

---

# 66. Forked Sessions

OpenCode supports session forking.

Define checkpoint behavior.

Recommended:

- child session begins with a fresh baseline captured from the child worktree/current worktree state;
- do not blindly copy parent checkpoint rows;
- optionally retain provenance:

```ts
forkedFromCheckpointID
```

if useful.

This keeps each session timeline internally coherent.

---

# 67. Compaction

Conversation compaction should not delete checkpoint metadata.

Checkpoint causal identity should remain tied to stable message IDs/turn IDs even if the model-facing context is compacted.

Existing cleanup code must be inspected so compaction-specific message deletion does not accidentally invalidate checkpoint relations.

---

# 68. Subagents / Task Tool

OpenCode can run subtasks/agents.

Decide whether their file changes belong to:

```text
parent turn
```

or:

```text
child session checkpoint
```

based on where they execute.

Recommended causality:

- if a subagent mutates the same worktree synchronously as a tool call of the parent turn, those changes are included in parent's before→after diff;
- if a child session/worktree is distinct, it owns its own checkpoints.

Do not attempt file-level provenance in v1.

---

# 69. Shell Commands

A user may invoke session shell behavior separately from a normal AI turn.

Choose whether that creates:

- no turn checkpoint;
- a manual/system checkpoint.

Recommended:

- preserve existing shell semantics initially;
- only top-level user→AI execution creates turn checkpoints;
- later add `kind="manual"` for shell-only workflows if product requires it.

---

# 70. Non-Git Projects

OpenCode Snapshot currently depends on Git semantics and is enabled when project VCS is Git and snapshot config is not disabled.

For non-Git projects:

- checkpoint API should return capability state;
- UI should hide/disable checkpoint controls;
- do not represent missing Git as a checkpoint error on every turn.

Proposed capability:

```ts
{
  supported: false,
  reason: "project-not-git"
}
```

---

# 71. Snapshot Disabled by Config

OpenCode allows snapshot behavior to be disabled.

The new checkpoint feature must respect that setting.

Options:

1. checkpoint feature disabled when snapshot disabled;
2. checkpoint setting supersedes snapshot setting.

Recommended v1:

```text
snapshot=false ⇒ checkpoint feature unavailable
```

and show a clear capability reason.

---

# 72. Large New Files: Product Decision

Existing snapshot tests intentionally skip newly added files >2 MiB.

For a rollback product, silent omission is potentially surprising.

Choose one:

## A. Keep current limit and report partial checkpoint

Recommended initial choice.

## B. Raise limit

Requires performance/storage benchmarking.

## C. Store large files in alternate object store

Too much scope for v1.

---

# 73. Ignored Files

Ignored files should normally remain outside checkpoint semantics.

Examples:

- `.env`;
- `node_modules`;
- build cache;
- credentials;
- databases.

That is safer and aligns with existing Snapshot behavior.

The UI should not promise "entire folder backup."

Use wording like:

> Project changes tracked by OpenCode snapshots

rather than:

> Complete filesystem restore point

unless that claim becomes technically true.

---

# 74. Database Files / OpenCode Self-Modification

Do not snapshot OpenCode's own global state/database simply because it happens to live under a project path.

Confirm exclusion boundaries so `opencode.db`, caches, socket state, and checkpoint Git storage cannot recursively enter the snapshot.

---

# 75. Cross-Platform Concerns

OpenCode's snapshot test suite already demonstrates awareness of:

- Windows-invalid filename characters;
- slash normalization;
- long paths;
- symlinks;
- Unicode.

Checkpoint-specific tests should run on:

```text
Windows
macOS
Linux
```

Do not accept a Linux-only Git behavior assumption.

---

# 76. Git Worktrees

Because source repository worktrees share objects but have separate working directories/indexes, OpenCode's snapshot identity correctly includes a hash of worktree path.

Test:

```text
same project.id
worktree A
worktree B
```

must map to distinct snapshot state.

Checkpoint metadata should also store a stable worktree identity.

A session that changes worktree mid-history must either:

- start a new checkpoint epoch; or
- mark old checkpoints as belonging to prior workspace.

Do not silently diff tree hashes from unrelated worktrees.

---

# 77. Checkpoint Epochs

A useful concept for robustness:

```ts
epoch = hash(projectID + worktree identity + snapshot store identity)
```

A checkpoint carries an epoch.

Diff/revert operations reject cross-epoch targets.

This prevents subtle corruption after:

- worktree deletion/recreation;
- path reuse;
- repository replacement.

---

# 78. Source-Control Changes During Turn

If the model runs:

```bash
git checkout ...
git reset ...
git clean ...
```

the filesystem can still be snapshotted, but semantic meaning changes.

OpenCode should capture actual before/after filesystem state, not try to infer tool intent.

However, if repository/worktree identity changes incompatibly during turn, mark the checkpoint partial/error.

---

# 79. Comparison: T3 Hidden Refs vs OpenCode Shadow Repo

| Dimension | T3 | OpenCode |
|---|---|---|
| Object database | user's repo | shadow repo + source alternates |
| Snapshot ID | commit ref | tree OID |
| User refs mutated | hidden custom refs | no |
| Real index touched on capture | no | no |
| Real index touched on restore | yes, then reset | should not need to |
| GC durability | custom ref | must verify/pin |
| Ignore behavior | normal Git add | explicit source-ignore sync |
| New large-file cap | not observed in checkpoint path | 2 MiB |
| Locking | reactor queue / Git behavior | snapshot semaphore |
| Existing conversation revert | provider rollback | first-class SessionRevert |
| Unrevert | not central in examined path | yes |

---

# 80. Golden Patterns to Preserve

## T3 golden patterns

- explicit baseline;
- exact turn association;
- hidden/non-branch storage;
- temp-index capture isolation;
- VCS capability abstraction;
- checkpoint diff query validation;
- coordinated filesystem + conversation rollback;
- stale future checkpoint cleanup;
- queue-backed side-effect processing;
- structured checkpoint failure state.

## OpenCode golden patterns

- shadow Git storage;
- pre-stream snapshot capture;
- source object alternates;
- index seeding;
- literal NUL pathspec handling;
- ignore-rule synchronization;
- snapshot semaphore;
- structured full diffs;
- existing revert/unrevert integration;
- extensive snapshot tests;
- cross-platform path care.

The desired feature should combine these strengths.

---

# 81. Anti-Patterns to Avoid

Do not:

- checkpoint on first streaming diff event;
- checkpoint on a timer;
- use `git reset --hard` against a detached checkpoint commit;
- mutate user's real Git refs unless explicitly choosing that design;
- mutate user's staging area;
- create a second snapshot engine beside `Snapshot`;
- persist giant patch blobs as primary state;
- assume previous checkpoint final = next turn baseline;
- conflate agent turn diff with live worktree diff;
- hide large-file exclusions;
- let two sessions checkpoint the same mutable worktree concurrently without policy;
- delete conversation state before filesystem restore succeeds;
- finalize checkpoint metadata before all mutating tool calls settle;
- make Electron main process the checkpoint authority;
- edit generated SDK files manually instead of regenerating them.

---

# 82. MVP Acceptance Criteria

A v1 is complete only if all are true.

1. Every top-level AI turn gets a stable before snapshot.
2. Every terminal turn outcome gets a stable after snapshot.
3. Checkpoint finalization occurs after file-mutating work is quiescent.
4. Turn diff is exact for the T3 #1434 regression.
5. Manual changes made **before** a turn are not falsely attributed to the AI.
6. Empty turns remain aligned with conversation turns.
7. Checkpoint history survives app restart.
8. Checkpoint snapshot objects survive configured cleanup for as long as metadata claims they exist.
9. User's current branch is unchanged by checkpoint capture/revert.
10. User's real Git staging state is unchanged.
11. Ignored files are not deleted by revert.
12. Existing OpenCode session revert behavior still works.
13. Checkpoint revert updates filesystem and logical conversation consistently.
14. An unrevert path remains available or the UI explicitly documents destructive semantics.
15. Windows/macOS/Linux snapshot tests pass.

---

# 83. Enhanced Acceptance Criteria

For production quality:

- file summaries render without fetching giant raw diff;
- diff cache is content-addressed;
- worktree epoch mismatch is rejected;
- crash recovery never falsely attributes later filesystem state to an earlier turn;
- aborted turns remain inspectable;
- large-file exclusions are visible;
- manual checkpoint API can be added without schema redesign;
- branch/worktree live diff remains a separate UI mode.

---

# 84. Suggested Agent Execution Order

An implementation execution agent should follow this order.

```text
1. Read current Snapshot implementation in full.
2. Run snapshot/revert tests before modifying anything.
3. Trace SessionProcessor create/process/cleanup with a concrete prompt.
4. Identify one authoritative top-level turn ID.
5. Prototype persistence of before/after tree hashes.
6. Write T3 #1434 regression first.
7. Add finalization only at quiescence.
8. Add diff query over the two tree hashes.
9. Verify object durability / GC.
10. Add shadow refs only if required.
11. Extend SessionRevert.
12. Add API.
13. Regenerate SDK.
14. Add UI.
15. Benchmark.
16. Failure-inject.
17. Cross-platform test.
```

---

# 85. First Prototype Scope

The fastest valid prototype does **not** need a full T3 UI.

Implement:

```text
checkpoint record
  beforeSnapshot
  afterSnapshot
  userMessageID
  assistantMessageID
  status
```

Then a debug endpoint/command:

```text
opencode debug checkpoints <session>
```

printing:

```text
ordinal
before
after
files
+additions
-deletions
```

and:

```text
opencode debug checkpoint-diff <session> <ordinal>
```

Only after semantics prove correct should the main app UI be built.

---

# 86. Recommended Feature Names

Internal:

```text
SessionCheckpoint
TurnCheckpoint
CheckpointTimeline
```

Avoid naming it `GitCheckpoint` in the user/domain layer because the storage implementation is intentionally abstracted behind Snapshot.

UI:

```text
Checkpoints
Turn changes
Restore point
```

---

# 87. Potential Future Capabilities Enabled by This Work

Once explicit checkpoints exist, OpenCode can later add:

- manual restore points;
- side-by-side turn comparisons;
- "what changed between turns 4 and 9";
- fork a session from a checkpoint;
- redo/alternate history;
- automated change summaries;
- per-file blame to AI turn;
- checkpoint-aware code review;
- checkpoint export/import;
- remote checkpoint sync;
- checkpoint compaction;
- semantic diff summaries;
- safety auto-checkpoint before high-risk shell commands.

Do not pull these into v1.

---

# 88. Direct Source Links — T3

Pinned source links:

- https://github.com/pingdotgg/t3code/blob/1e59b4c4004ce3c724d09ca0b140ed4523758d1e/apps/server/src/checkpointing/Utils.ts
- https://github.com/pingdotgg/t3code/blob/1e59b4c4004ce3c724d09ca0b140ed4523758d1e/apps/server/src/checkpointing/CheckpointStore.ts
- https://github.com/pingdotgg/t3code/blob/1e59b4c4004ce3c724d09ca0b140ed4523758d1e/apps/server/src/checkpointing/CheckpointDiffQuery.ts
- https://github.com/pingdotgg/t3code/blob/1e59b4c4004ce3c724d09ca0b140ed4523758d1e/apps/server/src/checkpointing/Diffs.ts
- https://github.com/pingdotgg/t3code/blob/1e59b4c4004ce3c724d09ca0b140ed4523758d1e/apps/server/src/vcs/VcsDriver.ts
- https://github.com/pingdotgg/t3code/blob/1e59b4c4004ce3c724d09ca0b140ed4523758d1e/apps/server/src/vcs/GitVcsDriver.ts
- https://github.com/pingdotgg/t3code/blob/1e59b4c4004ce3c724d09ca0b140ed4523758d1e/apps/server/src/orchestration/Layers/CheckpointReactor.ts
- https://github.com/pingdotgg/t3code/blob/1e59b4c4004ce3c724d09ca0b140ed4523758d1e/packages/contracts/src/orchestration.ts

Issues:

- https://github.com/pingdotgg/t3code/issues/1434
- https://github.com/pingdotgg/t3code/issues/1472
- https://github.com/pingdotgg/t3code/issues/1590

---

# 89. Direct Source Links — OpenCode

Pinned source links:

- https://github.com/anomalyco/opencode/blob/14b37df39168eaf6a6faf862ec4a7bbe9c825bbd/packages/opencode/src/snapshot/index.ts
- https://github.com/anomalyco/opencode/blob/14b37df39168eaf6a6faf862ec4a7bbe9c825bbd/packages/opencode/src/session/processor.ts
- https://github.com/anomalyco/opencode/blob/14b37df39168eaf6a6faf862ec4a7bbe9c825bbd/packages/opencode/src/session/prompt.ts
- https://github.com/anomalyco/opencode/blob/14b37df39168eaf6a6faf862ec4a7bbe9c825bbd/packages/opencode/src/session/revert.ts
- https://github.com/anomalyco/opencode/blob/14b37df39168eaf6a6faf862ec4a7bbe9c825bbd/packages/opencode/src/server/routes/instance/httpapi/groups/session.ts
- https://github.com/anomalyco/opencode/blob/14b37df39168eaf6a6faf862ec4a7bbe9c825bbd/packages/opencode/test/snapshot/snapshot.test.ts
- https://github.com/anomalyco/opencode/blob/14b37df39168eaf6a6faf862ec4a7bbe9c825bbd/packages/desktop/package.json
- https://github.com/anomalyco/opencode/tree/14b37df39168eaf6a6faf862ec4a7bbe9c825bbd/packages/app
- https://github.com/anomalyco/opencode/tree/14b37df39168eaf6a6faf862ec4a7bbe9c825bbd/packages/session-ui

---

# 90. Questions the Execution Agent Must Resolve Before Writing Production Code

These are the remaining source-dependent decisions, not reasons to block ideation.

1. Does the current Snapshot shadow repository already pin `write-tree` outputs through some ref/commit not visible in the initial scan?
2. Exactly how does `Snapshot.cleanup()` interact with persisted tree hashes older than seven days?
3. What is the single authoritative "top-level turn finished and all mutation is quiescent" seam in the current `SessionPrompt`/`SessionProcessor` lifecycle?
4. Can multiple primary sessions mutate the same worktree concurrently in the desktop product today?
5. Which existing app component is the canonical session/file diff surface after the latest app refactors?
6. How should child/subagent sessions be represented in the parent timeline?
7. Does session compaction ever remove stable message IDs required for checkpoint associations?
8. Should the first release expose excluded large files or only a partial-completeness flag?
9. How long should unrevert/future checkpoint objects be retained?
10. Is checkpoint history exported/shared with shared sessions, or kept local?

The implementation agent should answer these from the target checkout and record the answers in its PR description.

---

# 91. Feature-Ideation Directions

The architecture supports several UI concepts. An ideation agent should explore at least these three before implementation.

## Concept A — T3-like Turn Chips

```text
[All] [1] [2] [3] [4]
```

Selection changes the diff.

Pros:

- proven;
- compact;
- obvious chronology.

## Concept B — Message-Attached Checkpoint Rows

Each user/assistant exchange has:

```text
3 files  +42  -8   View changes   Restore
```

Pros:

- stronger causal connection;
- no separate mental model.

## Concept C — Review Sidebar

Dedicated right panel:

```text
Changes
  Turn 8   5 files
  Turn 7   0 files
  Turn 6   12 files
```

Header toggle:

```text
TURN / SESSION / WORKTREE
```

Pros:

- scalable;
- most similar to a code-review tool.

### Design recommendation

Use message-attached summary for quick access plus a dedicated diff/review panel for full inspection.

---

# 92. Implementation Agent Handoff Prompt

The following can be handed directly to an execution agent after this document.

> Implement a first-class per-turn checkpoint system in the current OpenCode checkout. Do not blindly port T3's hidden-ref implementation. Start by reading `../../packages/opencode/src/snapshot/index.ts`, `session/processor.ts`, `session/prompt.ts`, and `session/revert.ts` in full. Preserve and reuse the existing Snapshot shadow-Git architecture.
>
> Model each top-level AI turn with an explicit pre-turn `beforeSnapshot` and post-quiescence `afterSnapshot`. The post-turn capture must occur only after all file-mutating tool calls, hooks, subtasks included in the parent turn, and processor cleanup have settled. Do not use streaming patch/diff events as finalization signals.
>
> Write the regression test corresponding to T3 Code issue #1434 before implementing finalization: a single turn performs 18 distinct file writes, and all 18 must appear in turn 1 while a subsequent no-op turn has zero file changes.
>
> Persist checkpoint metadata durably, expose list/per-turn/cumulative diff APIs, and integrate checkpoint rollback with the existing `SessionRevert`/unrevert machinery. Checkpoint capture and rollback must not move the user's real `HEAD`, change the current branch, or modify the real Git staging selection.
>
> Investigate Snapshot object reachability under `Snapshot.cleanup()` before choosing durability storage. If raw tree hashes are not guaranteed to survive GC for the lifetime of checkpoint metadata, pin checkpoint objects using refs/commits **inside the Snapshot shadow Git repo**, never the user's source repo.
>
> Retain OpenCode's ignore policy and large-file behavior, but surface checkpoint incompleteness when newly added files are excluded by the Snapshot size limit.
>
> Keep agent-turn diff, cumulative-session diff, and live working-tree/branch diff as distinct concepts. For turn attribution, diff `beforeSnapshot → afterSnapshot`; do not assume `previousTurn.after → currentTurn.after`, because manual edits may happen between turns.
>
> Add structured tests for abort, crash recovery, empty turns, Unicode paths, binary files, ignored files, >2 MiB new files, real-index preservation, worktrees, concurrency, revert, and unrevert. Benchmark snapshot/finalization/diff/revert latency and memory on large repositories.
>
> Before modifying UI, provide a concise architecture note with: authoritative turn-boundary seam, exact persistence schema, Snapshot GC/durability result, subagent/worktree concurrency policy, and final list of files to edit.

---

# 93. Bottom Line

T3's core insight is excellent:

> **A coding-agent turn should be a reversible, reviewable filesystem transition—not merely a chat message.**

Its implementation demonstrates the essential pieces:

```text
baseline
→ turn execution
→ filesystem checkpoint
→ checkpoint diff
→ durable turn metadata
→ coordinated restore
```

But OpenCode is already unusually well positioned to implement this without copying T3's Git storage layer.

The strongest OpenCode architecture is:

```text
                OpenCode Session Turn
                       │
        ┌──────────────┴──────────────┐
        │                             │
        ▼                             ▼
before Snapshot tree            conversation IDs
        │
        │       agent/tool work
        ▼
after Snapshot tree
        │
        ├──── Snapshot.diffFull(before, after)
        │
        ▼
durable SessionCheckpoint metadata
        │
        ├──── turn diff UI
        ├──── cumulative diff UI
        └──── coordinated SessionRevert
```

The most important engineering rule is equally clear:

> **The final checkpoint boundary must represent quiescence, not merely an early provider/runtime indication that a diff exists.**

That single rule is the difference between a trustworthy turn history and a timeline that silently shifts edits into the wrong turn.

---

## Appendix A — Fast Repository Search Terms

### T3

```text
checkpointRefForThreadTurn
CHECKPOINT_REFS_PREFIX
CheckpointStore
CheckpointDiffQuery
CheckpointReactor
captureCheckpoint
restoreCheckpoint
diffCheckpoints
deleteCheckpointRefs
checkpointTurnCount
thread.turn.diff.complete
thread.turn-diff-completed
checkpoint.diff.finalized
turn.processing.quiesced
thread.checkpoint-revert-requested
thread.revert.complete
rollbackConversation
```

### OpenCode

```text
Snapshot.Service
snapshot.track
snapshot.patch
snapshot.restore
snapshot.revert
snapshot.diff
snapshot.diffFull
SessionProcessor
SessionRevert
SessionSummary
session.diff
session.revert
unrevert
type: "patch"
ctx.snapshot
snapshot cleanup
```

---

## Appendix B — Compact Architecture Comparison

```text
T3
===
actual Git repository
  └─ custom hidden refs
      └─ detached checkpoint commit
          └─ full workspace tree

metadata:
  event-sourced orchestration read model

rollback:
  checkpoint tree → worktree
  clean untracked
  provider rollback
  delete future refs


OpenCode today
==============
global OpenCode data
  └─ shadow Git repository per project/worktree
      └─ index / tree objects
          └─ full tracked snapshot state

metadata:
  messages + patch parts + session revert state

rollback:
  Snapshot restore/revert
  SessionRevert cleanup
  unrevert snapshot


Recommended OpenCode
====================
existing shadow Git repository
  └─ before/after tree snapshots
      └─ optional shadow-only refs for durability

new durable metadata:
  SessionCheckpoint / TurnCheckpoint

rollback:
  extend SessionRevert
  preserve source branch/index
  checkpoint-aware logical truncation
  retain unrevert
```

---

## Appendix C — What Not to Copy from T3

The implementation agent should explicitly avoid copying these weaknesses:

1. treating a streaming diff placeholder as a final filesystem boundary;
2. relying on a provider event stream that cannot guarantee final-completion delivery;
3. describing revert as a generic hard reset when actual semantics are subtler;
4. reducing all file summary `kind`s to `"modified"`;
5. conflating sequential checkpoint difference with exact AI-causal changes when manual edits can occur between turns;
6. mutating the user's real Git index during restore when OpenCode's shadow repo makes that unnecessary.

---

## Appendix D — What to Copy Conceptually from T3

Copy these product/architecture ideas:

1. one visible review/restore point per logical turn;
2. baseline before any AI mutation;
3. stable checkpoint identity;
4. checkpoint status in durable session state;
5. exact turn diff and cumulative diff;
6. restore filesystem **and** conversation together;
7. remove/supersede future history after rollback;
8. explicit checkpoint lifecycle receipts/events;
9. robust diff error handling distinct from snapshot-capture failure;
10. worktree-aware checkpoint identity.

---

**End of handoff.**
