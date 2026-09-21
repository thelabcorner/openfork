# T7 — Markdown loop files (OPTIONAL, phase 2)

**Depends on:** T3  
**Blocks:** nothing  
**Read first:** `04-surface-and-ux.md` § 6

## Scope

Discover schedule definitions from markdown files with YAML frontmatter
in a conventional project directory, following OpenChamber's \"loop file\"
idea. The value is that schedules become committable and reviewable
artifacts rather than hidden local state.

## Why this remains deferred

`AGENTS.md` treats filesystem watchers as expensive observers requiring
a single shared owner. This feature needs file change notification.

The feasibility gate has now been resolved:

- the canonical `Watcher.node` is **location-scoped**;
- its native subscription is finalized with the location graph;
- inactive projects can therefore change while no watcher exists;
- keeping every location graph alive for schedules would pull Tier-2/3
  workspace services into a Tier-0 scheduler concern;
- adding a second process-global watcher is explicitly disallowed.

So the current answer is **defer**. Do not implement loop files until a
process-global/project-catalog-owned invalidation primitive exists that can
observe inactive projects without materializing their location graphs.

## Reconciliation rules (non-negotiable)

- File-sourced tasks are **read-only in the UI** except enable toggle
and
  manual run.
- A removed file **disables and tombstones** the task; it does not
delete
  it. Switching git branches must not destroy run history.
- `revision` is the frontmatter content hash, so re-sync is idempotent
and
  a no-op re-read does not perturb `next_run_at`.
- Invalid frontmatter surfaces as a visible validation error on the task,
  not silent omission.

## Verification

- No new watcher instance (assert the count).
- File-authoritative correctness must hold while the target project has no active
  location graph.
- Edit/remove/restore a loop file and confirm the tombstone semantics.
- Re-reading an unchanged file produces **zero** writes.
