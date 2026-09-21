# OpenFork Isolation Plan

Investigation date: 2026-08-22. Planning only — no repo created, no remotes changed, no history rewritten.

> **Current-policy note:** this historical isolation plan predates OpenFork's
> explicit independent-product compatibility doctrine. "Branch-fork" below refers
> to Git ancestry and tag-sync mechanics only. It does **not** mean OpenFork is an
> OpenCode-compatible distribution. See
> `../../architecture/compatibility-boundary.md`.

**Goal:** move the local `openfork` branch into
`https://github.com/thelabcorner/openfork`, leave only desktop + sidecar on
`main`, and preserve a **branch-fork** relationship with `anomalyco/opencode`
for source acquisition (tag merge + prune).

**Product distinction:** OpenChamber is a compatibility-oriented wrapper around
OpenCode. OpenFork is a source-level fork that owns and changes its local runtime,
APIs, plugins, UI, and features. The two products may borrow ideas from each other,
but OpenFork is not required to remain locally compatible with OpenCode.

## Reading order

| # | Document | Lane |
|---|---|---|
| 1 | `00-INDEX.md` — decisions, constraints, what to do first | coordinator |
| 2 | `01-strategy.md` — OpenChamber vs branch-fork, why we do not delete history | strategist |
| 3 | `02-keep-drop.md` — package inventory, workspace allowlist | scout |
| 4 | `03-repo-git.md` — remotes, first push, hygiene, license | git-ops |
| 5 | `04-slim.md` — how clutter actually goes away without breaking merges | slimmer |
| 6 | `05-upstream-sync.md` — merge doctrine (source for the skill) | sync-owner |
| 7 | `06-agents-and-skill.md` — fork `../../handoff/AGENTS.md` + `../../../.opencode/skills/upstream-sync` | docs-owner |
| 8 | `07-orchestration.md` — agent lanes, gates, taskfiles | coordinator |
| 9 | `08-roadmap.md` — phases, risks, acceptance | coordinator |

Ready-to-copy artifacts:

- `drafts/AGENTS.md`
- `drafts/FORK.md`
- `drafts/skills/upstream-sync/SKILL.md`
- `drafts/keep-manifest.json`
- `tasks/*.md`

## Status

COMPLETE — decision-grade plan. Execution starts only after the human accepts the decision log in `00-INDEX.md`.
