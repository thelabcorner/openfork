# 06 — AGENTS.md, FORK.md, and the Sync Skill

> **STATUS: COMPLETE** — copy these drafts into the repo during `tasks/T3-agent-docs.md`. Do not edit them here and in the repo as two sources of truth after isolation; the repo copies win.

## What goes where

| File | Job |
|---|---|
| `../../handoff/AGENTS.md` | Always-on rules. Short. Routing table to skills. |
| `../../../FORK.md` | Path ownership, remotes, keep/drop, semantic checklist. |
| `../../../.opencode/skills/upstream-sync/SKILL.md` | The merge/cherry-pick workflow. Agents must load it before any git sync. |
| Existing `../../../.opencode/skills/effect` | Keep. |
| Existing `../../../.opencode/skills/rtl-aware-development` | Keep. |
| Package `../../handoff/AGENTS.md` files | Keep upstream + existing desktop/app notes. |

OpenChamber's lesson: `../../handoff/AGENTS.md` is routing, not a novel. Workflows live in skills.

## Instruction order after isolation

1. Root `../../handoff/AGENTS.md`
2. `../../../FORK.md` if the task touches repo shape, remotes, or KEEP/DROP
3. Matching skills (`upstream-sync`, `effect`, `rtl-aware-development`)
4. Nearest package `../../handoff/AGENTS.md`
5. Local code precedent

## Trigger table to add

| Trigger | Skill |
|---|---|
| Merge/cherry-pick/rebase involving `upstream`, a `v*.*.*` tag, or an anomalyco PR | `upstream-sync` |
| Effect v4 / effect-smol | `effect` |
| RTL/LTR, desktop chrome, mixed-direction text | `rtl-aware-development` |

## Drafts

Full text:

- `drafts/AGENTS.md`
- `drafts/FORK.md`
- `drafts/skills/upstream-sync/SKILL.md`

When copying:

- Root `../../handoff/AGENTS.md` **replaces** the current file, but **keeps** the style guide, testing, typecheck, API Architecture, and V2 Session Core sections verbatim (they are still correct for KEEP packages).
- Do not delete `../../../packages/desktop/AGENTS.md` or `../../../packages/app/AGENTS.md`.
- Default branch wording today says `dev`. The draft changes that to `main` for this repo and names `upstream/dev` as a fetch source only.

## Writing rules for the skill

- Frontmatter `name` + `description` so the skill loader can match it.
- Description must mention merge, upstream, tag, cherry-pick, conflict — that is how it gets auto-selected.
- No "ask the user for the GitHub token" fluff. No history rewrites.
- Include the exact commands that already worked.
- Include the semantic checklist.
- Tell the agent to stop if ownership is unclear rather than pick `-X ours`.
