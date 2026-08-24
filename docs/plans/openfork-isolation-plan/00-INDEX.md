# 00 — Index & Decision Log

> **STATUS: COMPLETE** — 2026-08-22. Facts verified against this working tree on branch `openfork` @ `a747d51764`, `gh` identity `thelabcorner`, and OpenChamber's public repo.

## One-sentence brief

Push this already-patched OpenCode tree to `thelabcorner/openfork`, delete unused SaaS/infra from `main`, keep history mergeable, and give every future agent a prune-after-merge doctrine so tag syncs do not bring the clutter back.

## Current facts

| Fact | Value |
|---|---|
| Local branch | `openfork` @ `a747d51764` (`chore: merge upstream v1.18.21 into openfork`) |
| Only remote | `origin` → `https://github.com/anomalyco/opencode.git` |
| Tracking | none |
| GitHub user | `thelabcorner` (no orgs) |
| `thelabcorner/openfork` | **does not exist** |
| Official fork of anomalyco/opencode | **does not exist** |
| Last sync style | merge **release tags** (`v1.18.18`, `v1.18.21`), not floating `dev` |
| Uncommitted fork work | large — quota module is **untracked**; app/desktop/search dirty |
| License | MIT (Copyright 2025 opencode) |

## Decision log (accept or reject before execution)

Recommended answers. Change them here; every other file assumes these.

| ID | Decision | Recommendation | Why |
|---|---|---|---|
| D1 | Product shape | **Branch-fork of OpenCode Desktop**, not an OpenChamber-style rewrite | Fork features live *inside* `../../../packages/app`, `../../../packages/opencode`, `../../../packages/desktop`. Rewriting the UI would throw away the product. |
| D2 | GitHub shape | **New empty repo** `thelabcorner/openfork`. Do **not** press GitHub's Fork button. | Different name, no accidental PRs to anomalyco, we already have the history locally. Keep `anomalyco/opencode` as `upstream`. |
| D3 | Default branch | `main` = today's `openfork` line | Personal repo convention. Document that `upstream/dev` and tags are sync sources, not the default branch. |
| D4 | History | **Keep full history.** No `git filter-repo`. No orphan branch. | Filter-repo makes every future upstream merge a rewrite. That is how independent forks are born by accident. |
| D5 | How clutter dies | **Delete unused trees from `main`.** Keep history (no filter-repo). After every tag merge, run `../../../script/fork-prune.ts` and resolve DROP-path conflicts as delete. | You do not want console/web/sst in the repo. Scorched-earth history rewrite would kill merges. Prune-after-merge is the only way to have both. |
| D6 | TUI | **Do not maintain TUI.** Inline the 3 sidecar util re-exports into `../../../packages/opencode`, then `git rm packages/tui`. Leave `../../../packages/opencode/src/cli/tui` in place (same package as the sidecar — stripping it is scorched earth). | Desktop never runs the terminal UI. Only three tiny util files are on the sidecar graph. |
| D7 | Sync cadence | Keep **tag merges** (`v1.18.x`) as the default. Cherry-pick individual PRs only when a fix is needed before the next tag. | This is already how the last two syncs worked. Floating `origin/dev` is stale and noisy. |
| D8 | Conflict doctrine | **Union, not ours/theirs.** Path ownership map in `drafts/FORK.md`. | The v1.18.21 merge already did this (websearch engines ∪ opencode-go check). Blind `-X ours` would drop upstream security/provider fixes. |
| D9 | Branding / updater | Distinct product name `OpenFork`. Disable or retarget `electron-updater`. Distinct channel DB (already `opencode-openfork.db`). | Shipping with anomalyco's updater installs official OpenCode over the fork. |
| D10 | Agent docs | Replace root `../../handoff/AGENTS.md` with the fork guide. Add `../../../.opencode/skills/upstream-sync`. Keep upstream style/API rules. | Agents currently have no sync doctrine. The two merge commits are the only source. |
| D11 | First push contents | Commit all wanted fork work first. Do **not** push swarm DBs, CDP logs, vendor tgz, sample DBs, or `_archivetest`. | Isolation from a dirty tree silently drops quota and publishes junk. |

## What OpenChamber taught us (and what it did not)

Steal:

- Slim *concern*: do not maintain Stripe/SST/console/stats/marketing.
- `../../handoff/AGENTS.md` as routing + always-on rules; skills as workflows.
- Explicit runtime boundaries (main / sidecar / renderer).

Do not steal:

- Separate git tree that never merges OpenCode.
- Rewritten React UI over `@opencode-ai/sdk`.
- Their Electron/server architecture.

See `01-strategy.md`.

## Do this first (human, before any agent writes code)

1. Accept or edit the decision log above.
2. Decide what of the **uncommitted** tree is product (quota, dirty UX, search probes) vs trash.
3. Checkpoint-commit the product. Leave trash untracked or gitignore it.
4. Then run Phase 0–2 in `08-roadmap.md` / `07-orchestration.md`.

## Definition of done for the *isolation* (not the whole product)

- `thelabcorner/openfork` exists, default `main`, full history, `upstream` remote works.
- `packages/console`, `stats`, `web`, `enterprise`, `function`, `slack`, `infra/`, `sst.config.ts` are **gone from `main`** (still in history).
- `bun install` no longer installs those packages.
- `bun run dev` from `../../../packages/desktop` still launches the Electron app against current source.
- Root `../../handoff/AGENTS.md` + `../../../FORK.md` + `upstream-sync` skill exist and describe tag-merge + union conflicts.
- Anomalyco publish/deploy workflows are gone or disabled.
- Auto-update cannot overwrite the fork with official OpenCode.
- A dry-run of the sync skill against the *next* tag (or a replay of v1.18.21) has a written checklist an agent can follow.

## Out of scope

- Implementing remaining dirty features.
- Publishing installers.
- Relicensing.
- Contributing PRs back to anomalyco (possible later; not the point).
- Dropping TUI source in phase 1.
