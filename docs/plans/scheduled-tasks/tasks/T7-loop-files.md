# T7 — Markdown loop files (OPTIONAL, phase 2)

**Depends on:** T3  
**Blocks:** nothing  
**Read first:** `04-surface-and-ux.md` § 6

## Scope

Discover schedule definitions from markdown files with YAML frontmatter
in a conventional project directory, following OpenChamber's \"loop file\"
idea. The value is that schedules become committable and reviewable
artifacts rather than hidden local state.

## Why this is optional and sequenced last

`AGENTS.md` treats filesystem watchers as expensive observers requiring
a single shared owner. This feature needs file change notification.

**Do not add a second watcher.** Subscribe to the existing one and
filter. If that turns out not to be possible, **defer the feature** and
say so — do not \"just add a small watcher for now\". That is exactly
the kind of accretion the contract is written to prevent.

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
- Edit/remove/restore a loop file and confirm the tombstone semantics.
- Re-reading an unchanged file produces **zero** writes.
