# T3 — Install fork agent docs

**Lane:** docs-owner  
**After:** T2  
**Parallel with:** T4 T5 T6

## Do

1. Copy `drafts/AGENTS.md` → repo root `../../../handoff/AGENTS.md` (replace).
2. Copy `drafts/FORK.md` → repo root `../../../../FORK.md`.
3. Copy `drafts/skills/upstream-sync/SKILL.md` → `../../../../.opencode/skills/upstream-sync/SKILL.md`.
4. Keep `../../../../.opencode/skills/effect` and `rtl-aware-development`.
5. Keep `../../../../packages/desktop/AGENTS.md` and `../../../../packages/app/AGENTS.md`.
6. Write a short root `../../../../README.md` for OpenFork: what it is, `bun run --cwd packages/desktop dev`, link `../../../../FORK.md`, MIT + upstream attribution. Do not delete `LICENSE`.
7. Commit: `docs: add OpenFork AGENTS, ownership map, and upstream-sync skill`

## Do not

Invent new style rules. Drop the V1/V2 API sections. Edit runtime code.

## Done when

An agent that only reads `../../../handoff/AGENTS.md` + `../../../../FORK.md` + the skill knows remotes, tag-merge, union conflicts, and what not to maintain.
