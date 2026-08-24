# 05 — Upstream Sync Doctrine

> **STATUS: COMPLETE** — this is the prose source for `drafts/skills/upstream-sync/SKILL.md`. If they drift, the skill wins for agents; this file wins for humans editing policy.

## Default sync

Merge **release tags**, not `upstream/dev`.

Proven on this line:

| Tag | Merge | Notes |
|---|---|---|
| `v1.18.18` | `108709d816` | conflicts almost all package.json + lock |
| `v1.18.21` | `a747d51764` | documented unions (websearch, tests, deps) |

`origin/dev` on this machine has been stale. Do not use a local `dev` ref as the baseline.

## When to cherry-pick a PR instead

Use cherry-pick when:

- a single provider/session crash fix lands on `dev` and you need it before the next tag
- the PR touches only KEEP paths and does not depend on a stack of later commits

Do not cherry-pick:

- `chore: generate` alone (take it with the protocol change, then regenerate yourself)
- console/stats/web-only PRs
- release-train version bumps without the rest of the tag

Cherry-pick with `-x` so the skill can see the source.

## Pre-merge ritual (non-negotiable)

1. `git status` clean. If not: checkpoint commit, same as `5374a0963b`.
2. `git fetch upstream --tags --prune`
3. Confirm the tag exists and note `git log --oneline main..vX.Y.Z` size.
4. Read the tag's KEEP-path diff, not the whole SaaS dump:

   ```powershell
   git log --oneline main..v1.18.22 -- packages/app packages/desktop packages/opencode packages/core packages/schema packages/protocol packages/server packages/sdk packages/session-ui packages/ui
   git diff --stat main...v1.18.22 -- packages/app packages/desktop packages/opencode packages/core
   ```

5. Only then `git merge vX.Y.Z`.

No `-X ours`. No `-X theirs`. No `--squash` of a tag (destroys future merge-base).

## Path ownership

Canonical table lives in `drafts/FORK.md`. Summary:

| Class | On conflict |
|---|---|
| **Fork-owned** (quota, spad, session-group, project-explorer, titlebar-tab-*, fork-usage, hosted browser, core/search matcher extras, extra tools) | Keep fork behavior. Replay upstream hunks only when they are bugfixes in the same file. |
| **Union** (tool/registry, plugin/index, session/prompt, provider, package.json, bun.lock) | Combine. The v1.18.21 websearch merge is the template: fork engines **plus** upstream opencode-go check. |
| **Generated** (`packages/client/src/generated*`, `packages/sdk/js/src/**/gen`, `../../../packages/sdk/js/src/v2/gen`) | Do not hand-merge. Take either side, then regenerate. |
| **Pruned SaaS** (console, stats, web, infra, sst, cli, sdk-next, …) | **Always delete.** `deleted by us, modified by them` → `git rm`. Then `bun run fork:prune`. Never keep a re-added DROP path. |
| **Fork-owned meta** (`../../handoff/AGENTS.md`, `../../../FORK.md`, `.github/workflows`, README, updater) | Keep ours. Port a new always-on upstream rule if it is about KEEP code. |
| **Tests that assume deleted fork UI** | Keep the fork stub. Example: e2e targeting `#review-panel` after project-explorer removed it. |

## Union rules (the ones people get wrong)

1. **package.json versions** — take **upstream** version numbers (`1.18.22`). Union *dependencies* if the fork added packages. Then `bun install` to regenerate `../../../bun.lock`. Never hand-edit the lock.
2. **HttpApi / schema / protocol** — additive fork routes stay. If upstream renamed a group you also patched, re-attach the fork group in the new file. Then `bun run generate` from `../../../packages/client` and `./packages/sdk/js/script/build.ts` if V1 SDK moved.
3. **nix/hashes.json** — take upstream. You are not maintaining Nix in phase 1.
4. **i18n locale dumps** — keep English source keys the fork added; re-run translate later. Do not let a merge drop `en.ts` keys.
5. **Provider / retry / security fixes** — take upstream unless they delete a fork API. These are why you stay in-line.

## Semantic checklist after a green merge (from v1.18.21's message)

Run this as a real checklist, not a vibe:

- [ ] Fork credentials / Go usage cache still wired
- [ ] Pause / resume / regenerate-title still on V1 HttpApi
- [ ] Session groups still listed
- [ ] Quota routes still registered (`api.ts` + `server.ts`)
- [ ] Extra tools still in `tool/registry.ts` **and** any new upstream tool is also present
- [ ] Websearch: fork engines ∪ whatever upstream added
- [ ] Plugin Cerebras / provider unions still present
- [ ] Archive / project-explorer e2e still match the fork UI
- [ ] Desktop `bun run dev` still boots; sidecar healthy
- [ ] Channel DB name still fork-specific
- [ ] Updater still disabled or still pointing at this repo

If a box fails, the merge is not done. Do not push `main` green.

## Conflict workflow for agents

1. List conflicted files. Classify each against `../../../FORK.md`.
2. Resolve generated files by choosing any side + regenerate.
3. Resolve package.json with the version/dep rule above; then lockfile.
4. Resolve fork-owned files by reading **both** sides. Prefer fork behavior. Cherry-pick upstream hunks that are clearly unrelated bugfixes.
5. Resolve union files by reading the v1.18.21 merge as a worked example (`git show a747d51764`).
6. DROP-path conflicts: delete. Then `bun run fork:prune` so nothing leaked back.
7. Commit the merge with a body that lists unions, like `a747d51764`. Future you is the audience.

## After the merge commit

```powershell
bun install
bun --cwd packages/opencode typecheck
bun --cwd packages/app typecheck
bun --cwd packages/desktop typecheck
bun --cwd packages/opencode test   # or a focused subset if the suite is huge
bun --cwd packages/app test:unit
```

Then `bun run --cwd packages/desktop dev` and actually look at it. AGENTS.md already forbids guessing desktop from source.

## Individual upstream PRs

```powershell
git fetch upstream pull/43892/head:pr-43892
git log --oneline main..pr-43892
# if single-commit and KEEP-path: git cherry-pick -x <sha>
# if a stack: wait for the tag
```

If cherry-pick conflicts in a fork-owned file, stop and apply the same union rules. Do not abort and leave the tree half-applied without saying so.

## What "bring the fork up to speed" is not

It is not rebasing `main` onto `upstream/dev`. Rebases of a published `main` rewrite merge commits you will need next tag. Merge tags. Live with a slightly noisier first-parent. That is the branch-fork bargain.
