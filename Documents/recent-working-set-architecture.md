# Recent / Working-Set Architecture

## Goal

Give an OpenCode agent a cheap, trustworthy answer to: **what has been happening in this repository recently?**

The feature should provide a useful head start without reading source bodies, scanning the full repository on every call, or confusing filesystem timestamp churn with meaningful development activity.

## Current State

OpenCode already has `project(action: "recent")` in `packages/opencode/src/tool/project.ts`.

The current implementation:

1. Builds a gitignore-aware project file list with ripgrep.
2. Calls `stat()` for every listed file to collect `mtime`.
3. Sorts all files by `mtime`.
4. Takes the newest `N` files.
5. Groups the output by directory.

This is useful as a proof of concept, but it is not yet a true activity model. It cannot distinguish meaningful edits from timestamp churn, cannot represent deleted files, and does not use Git history or live watcher information.

## Architectural Decision

Do **not** replace the `project` tool with a recent-files tool.

The responsibilities are different:

| Capability | Question answered |
| --- | --- |
| `project` | What is this repository? |
| `recent` | What has been happening in this repository? |
| `read` | What does this specific file contain? |
| `symbols` | Where is this code conceptually? |
| `git` | What is the repository's VCS state/history? |

Instead, create a reusable **WorkspaceActivity** service beneath both `project` and the eventual `recent` tool.

```text
                         WorkspaceActivity
                               service
                                  |
             +--------------------+--------------------+
             |                    |                    |
       watcher events        Git evidence       FileIndex / mtime
       live activity         cold-start state   fallback/history
             |                    |                    |
             +--------------------+--------------------+
                                  |
                           fused working set
                                  |
                    +-------------+-------------+
                    |                           |
                recent tool              project digest
                full view                tiny top-N view
```

## Core Concept: Working Set, Not Raw Mtime

The agent does not primarily care which file has the newest timestamp. It cares which files are most likely to be relevant to the work that was happening recently.

The service should normalize activity into a structure similar to:

```ts
interface WorkspaceActivityFile {
  path: string
  previousPath?: string
  lastActivityAt: number

  state?:
    | "modified"
    | "staged"
    | "untracked"
    | "added"
    | "deleted"
    | "renamed"
    | "conflict"
    | "clean"

  sources: Array<
    | "watcher"
    | "git-status"
    | "git-log"
    | "session"
    | "filesystem"
  >

  lastCommit?: {
    sha: string
    at: number
  }

  exists: boolean
}
```

The exact persisted representation may be smaller, but the conceptual model should preserve source provenance and explainability.

## Source 1: Live Filesystem Activity

OpenCode already has a native cross-platform watcher in `packages/core/src/filesystem/watcher.ts`, built on `@parcel/watcher`.

It already provides:

- Windows native watcher support.
- macOS FSEvents.
- Linux inotify.
- Gitignore/protected-path filtering.
- Add/change/unlink classification.
- Duplicate-event suppression.
- Bounded pending-event state.
- Project scoping.

`packages/core/src/filesystem/index-watcher.ts` also demonstrates the desired consumer pattern: subscribe to watcher events, debounce bursts, coalesce repeated paths, and update derived state incrementally.

Create a comparable activity consumer that stores only bounded metadata.

Recommended state:

```text
root-relative path -> latest activity record
```

Use a bounded map, approximately 512 to 1,024 unique paths per worktree. Updating an already-known path should replace/coalesce the existing entry instead of appending an event forever.

This makes the warm path extremely cheap:

```text
read bounded activity state
        +
merge current Git state
        +
sort a few hundred records
        ->
return top N
```

## Source 2: Git Cold-Start Reconstruction

The watcher answers what happened while OpenCode was alive. Git reconstructs meaningful activity that occurred before the current process/session started.

Use machine-oriented Git output rather than human-formatted output.

### Current working tree

Preferred command semantics:

```bash
git status --porcelain=v2 -z --untracked-files=all
```

Important properties:

- NUL-delimited paths.
- Stable machine-oriented format.
- Proper handling of spaces/newlines in filenames.
- Rename/copy information.
- Staged and unstaged state.
- Untracked files.

The implementation should use the existing typed Git layer rather than shelling out directly if that layer can expose equivalent structured data.

### Recent committed activity

Use one bounded history scan, not one Git command per file.

Conceptually:

```bash
git log -n <bounded commits> --name-status -z ...
```

From that stream derive records such as:

```text
src/foo.ts       committed 6m ago
src/bar.ts       committed 6m ago
src/parser.ts    committed 1h ago
src/service.ts   renamed from src/old-service.ts 3h ago
```

Deleted files and renames should remain visible even when no current filesystem object exists.

## Source 3: FileIndex / Filesystem Fallback

The persisted `FileIndex` already tracks metadata such as size and `mtime` and is incrementally invalidated by the watcher.

Eventually expose an efficient top-K operation such as:

```ts
recent(prefix, limit)
```

This can scan already-indexed metadata in memory using a bounded top-K algorithm instead of issuing filesystem syscalls for every project file.

For a repository with `N` files and result size `K`, target approximately:

```text
O(N log K)
```

with zero per-file filesystem syscalls on a warm index.

For non-Git directories, FileIndex/filesystem recency becomes more important. For Git repositories it is a fallback signal, not the primary authority.

## Signal Precedence

Avoid opaque weighted-ranking formulas unless later evidence shows they are necessary.

Prefer deterministic, explainable precedence.

High-confidence evidence:

1. OpenCode/session-originated write/edit/patch activity.
2. Live watcher activity.
3. Current Git status combined with targeted metadata.
4. Recent Git commit timestamps.

Lower-confidence evidence:

5. Clean-file filesystem `mtime`.

In Git repositories, clean-file mtime should be treated cautiously because branch switches, restores, checkouts, archive extraction, generated code, and tooling can update timestamps without representing meaningful human activity.

## Ranking

Each record should expose the best-known meaningful `lastActivityAt` plus provenance.

Primary sort:

```text
credible lastActivityAt descending
```

Secondary ordering may favor stronger evidence when timestamps tie, but avoid large source-specific score boosts that make behavior difficult to reason about.

Git state is primarily annotation. A dirty file from three days ago should not automatically outrank a file actively edited thirty seconds ago.

## `recent` Tool

The eventual provider-facing tool should be small.

Potential arguments:

```ts
{
  path?: string
  limit?: number
  mode?: "working-set" | "modified" | "history" | "filesystem"
}
```

Default:

```text
mode = "working-set"
limit = 15 or 20
```

Suggested semantics:

- `working-set`: fused activity view optimized for agent orientation.
- `modified`: factual recent modifications plus current dirty state.
- `history`: Git-oriented committed/rename/delete history.
- `filesystem`: diagnostic fallback based primarily on indexed mtimes.

The output should remain globally chronological. Do **not** regroup results by directory after ranking because that destroys the temporal ordering that gives the capability its value.

Example:

```xml
<recent scope="." coverage="live+git" count="12">
  <file path="packages/opencode/src/session/prompt.ts"
        age="2m"
        state="modified"
        sources="watcher,git-status" />
  <file path="packages/opencode/src/tool/task.ts"
        age="8m"
        state="modified"
        sources="watcher,git-status" />
  <file path="packages/core/src/background-job.ts"
        age="31m"
        state="clean"
        commit="a81c7e2"
        sources="git-log" />
  <file path="packages/opencode/src/service.ts"
        previousPath="packages/opencode/src/old-service.ts"
        age="1h"
        state="renamed"
        sources="git-log" />
</recent>
```

## Integration with `project`

`project` should remain the structural orientation capability.

Its summary tier may consume a tiny WorkspaceActivity digest, for example the top 3 to 5 files:

```xml
<activity>
  <file path="src/foo.ts" age="2m" state="modified" />
  <file path="src/bar.ts" age="8m" state="modified" />
</activity>
```

Do not make `project` responsible for activity collection itself.

During migration, `project(action: "recent")` should delegate to the same WorkspaceActivity service so there is only one implementation. It can be deprecated later if the standalone `recent` capability proves sufficient.

## Session-Originated Activity

OpenCode already knows when its own tools mutate files. This signal is unusually strong and should eventually feed WorkspaceActivity directly.

Useful events include:

- `edit`
- `write`
- `patch`
- apply-patch style mutations
- other future structured file mutation tools

Do not treat a file merely being read as an edit.

Later, maintain a separate weak **focus** signal for recently read/opened files if desired. That can improve `working-set` ranking without corrupting the factual `modified` view.

## Working Set vs Recently Modified

These should remain distinct concepts.

`modified` answers:

> Which files actually changed recently?

`working-set` answers:

> Which files are probably relevant to the work happening right now?

The future working-set view may combine:

```text
actual modifications
+ current dirty files
+ current-session writes
+ current/recent editor files if available
+ files repeatedly referenced in recent tool calls
```

This provides a lightweight repository attention model without requiring embeddings, vector storage, or model inference.

## Windows USN Journal

NTFS exposes the USN Change Journal, which could provide extremely efficient persisted historical filesystem activity on Windows.

Do not make this a V1 dependency.

Reasons:

- Platform-specific implementation complexity.
- Volume-level semantics require root filtering.
- Journal access/management can require elevated privileges depending on operation/environment.
- Existing Parcel watcher + Git + FileIndex already provide a strong cross-platform design.

Design WorkspaceActivity with pluggable evidence sources so a future optional `ntfs-usn` adapter can be added without changing the tool contract.

## Proposed File Ownership

Suggested organization:

```text
packages/opencode/src/project/activity.ts
```

or, if activity becomes a core filesystem primitive:

```text
packages/core/src/filesystem/activity.ts
```

Prefer `project/activity.ts` initially because the fused model includes Git/session semantics in addition to filesystem events. Promote it to core only if multiple packages require the service.

Potential modules:

```text
project/activity.ts              fused service / public API
project/activity-watcher.ts      live watcher source
project/activity-git.ts          status + bounded history source
project/activity-filesystem.ts   FileIndex fallback
```

Avoid over-fragmenting until implementation size justifies it.

## Performance Requirements

Warm-path requirements:

- No full repository filesystem `stat()` sweep.
- No per-file Git subprocess calls.
- Bounded memory independent of total repository history.
- Bounded Git history depth.
- Respect ignore/protected paths.
- Reuse FileIndex metadata when available.
- Coalesce watcher bursts.
- Use project/worktree identity as the state key.

Target shape:

```text
watcher update: O(1) average
recent warm call: O(A log A) or O(A log K), A <= bounded activity capacity
Git bootstrap: bounded by configured commit/history window
filesystem fallback: O(N log K) over in-memory index metadata
```

## Correctness / Edge Cases

Tests should cover:

- Modified tracked file.
- Staged file.
- Staged + unstaged changes on the same file.
- Untracked file.
- Added file.
- Deleted file.
- Rename, including old/new path representation.
- Copy detection if supported by the selected Git API.
- Conflict/unmerged state.
- Filename containing spaces.
- Filename containing tabs/newlines.
- Gitignored files.
- Protected/OpenCode internal files.
- Non-Git repositories.
- Git repository with no commits.
- Branch checkout causing mtime churn.
- Atomic editor save event bursts.
- File modified repeatedly in a short interval.
- File modified while OpenCode is offline, then process cold-starts.
- Worktrees.
- Scoped subdirectory query.
- Deleted file that no longer exists on disk.
- Abort during bootstrap.
- Very large repository.

## Implementation Sequence

### Phase 1

Create `WorkspaceActivity` with:

- Bounded in-memory activity records.
- Parcel watcher consumer.
- Git status bootstrap.
- Bounded Git recent-file history.
- Unit tests for normalization and fusion.

### Phase 2

Create the standalone `recent` tool as a thin presentation layer over WorkspaceActivity.

Keep its provider-facing schema small.

### Phase 3

Replace the existing mtime implementation behind `project(action: "recent")` with WorkspaceActivity delegation.

Add a tiny recent-activity digest to project summary if measurements show it improves first-turn orientation enough to justify its token cost.

### Phase 4

Feed OpenCode-originated file mutations into WorkspaceActivity as high-confidence session activity.

### Phase 5

Optimize FileIndex fallback with a top-K metadata path rather than per-file stats.

### Phase 6

Experiment with optional attention/focus signals for `working-set` mode, while preserving a factual `modified` mode.

### Optional Future Phase

Evaluate an NTFS USN adapter on Windows only if benchmarks show meaningful cold-start value beyond Git + FileIndex.

## Non-Goals

- Do not read file contents to determine recency.
- Do not add embeddings or vector search for V1.
- Do not continuously retain an unbounded edit event log.
- Do not make platform-specific Windows APIs mandatory.
- Do not conflate file reads with file modifications.
- Do not expose opaque relevance scores without provenance.
- Do not turn `project` into a monolithic catch-all tool.

## Success Criteria

The feature is successful when a newly started agent can cheaply infer the repository's current working area from one compact call, including files changed before the agent started, while avoiding false confidence from raw filesystem timestamps.

The implementation should be substantially cheaper than the current full-file `stat()` sweep and should preserve clear, explainable provenance for every returned file.
