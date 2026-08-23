# OpenFork Isolation Plan

Investigation date: 2026-08-22. Planning only — no repo created, no remotes changed, no history rewritten.

**Goal:** move the local `openfork` branch into `https://github.com/thelabcorner/openfork`, leave only desktop + sidecar on `main`, and stay a **branch-fork** of `anomalyco/opencode` (tag merge + prune, not an independent product).

**Non-goal:** become OpenChamber. OpenChamber is a separate UI that consumes OpenCode as a black box. This fork *is* OpenCode Desktop with patches. That difference decides every git decision in this folder.

## Reading order

| # | Document | Lane |
|---|---|---|
| 1 | `00-INDEX.md` — decisions, constraints, what to do first | coordinator |
| 2 | `01-strategy.md` — OpenChamber vs branch-fork, why we do not delete history | strategist |
| 3 | `02-keep-drop.md` — package inventory, workspace allowlist | scout |
| 4 | `03-repo-git.md` — remotes, first push, hygiene, license | git-ops |
| 5 | `04-slim.md` — how clutter actually goes away without breaking merges | slimmer |
| 6 | `05-upstream-sync.md` — merge doctrine (source for the skill) | sync-owner |
| 7 | `06-agents-and-skill.md` — fork `AGENTS.md` + `.opencode/skills/upstream-sync` | docs-owner |
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
