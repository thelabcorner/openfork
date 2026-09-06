---
name: upstream-sync
description: Merge anomalyco/opencode release tags or cherry-pick upstream PRs into this OpenFork branch-fork. Use when syncing, merging v*.*.* tags, fetching upstream, resolving conflicts with official OpenCode, or bringing the fork up to speed.
---

# Upstream sync

This repo is a **branch-fork**. Stay mergeable. Load `FORK.md` before touching git.

## Forbidden

- `git filter-repo`, orphan branches, history rewrite
- `git merge -X ours` / `-X theirs` / `--squash` of a release tag
- `git rebase main onto upstream/dev`
- `git push` to `upstream`
- Keeping a re-added DROP path (`packages/console`, `web`, `infra`, …). Always prune.
- Hand-merging generated SDK/client files
- Using a local `dev` ref as the baseline

## Default: merge a release tag (use the pipeline, not ad-hoc git)

```powershell
bun run fork:sync preflight vX.Y.Z
git merge vX.Y.Z
bun run fork:sync resolve
# handle each MANUAL item it prints per FORK.md, then re-run resolve until clean
# delete untracked DROP leftovers it reports (merge resurrects pruned trees on disk)
bun install
# commit with a message body listing unions and deliberate stubs (see a747d51764)
bun run fork:sync verify --tag vX.Y.Z
```

Replace `vX.Y.Z` with the tag. Do not merge `upstream/dev` unless the user explicitly asked for a mid-cycle sync.

`preflight` refuses a dirty tree and snapshots every fork-only package.json
key (deps, scripts, exports, top-level) so `resolve`/`verify` can prove
nothing fork-only was lost. `resolve` auto-handles prune/lock/pkg-union/
generated/fork-owned/meta classes and exits 2 while MANUAL items remain —
never force those through with `-X ours/theirs`. `verify` enforces the
semantic checklist below as failing checks plus workspaces-installability
(no globs, no DROP entries, all exist — v1.18.29 broke `bun install` via
upstream `packages/*` globs referencing pruned trees).

## Cherry-pick a single PR

Only when the user needs one KEEP-path fix before the next tag.

```powershell
git fetch upstream pull/NNNNN/head:pr-NNNNN
git log --oneline main..pr-NNNNN
git cherry-pick -x <sha>
```

If the PR is a stack, wait for the tag. Skip console/stats/web-only PRs.

## Conflicts

`bun run fork:sync resolve` already applied the mechanical classes below
(prune / lock / pkg-union / generated / fork-ours / meta-ours per FORK.md).
What remains is MANUAL and needs a human:

1. List conflicted files. Classify each with `FORK.md` (fork-owned / union / case-by-case / generated / SaaS / meta).
2. **Generated:** pick either side, then regenerate (`bun run generate` in `packages/client`; `./packages/sdk/js/script/build.ts` if V1 SDK moved).
3. **package.json:** handled by the canonical merger (upstream versions;
   union deps with upstream winning overlaps; union scripts minus
   dev:console/dev:stats/dev:storybook/sso with fork winning `dev`; union
   exports/imports with fork winning overlaps; curated explicit
   workspaces). If resolve reports `fork-wins` notes, review them: upstream
   changed the same key. Then `bun install` to rebuild `bun.lock`. Never hand-edit the lock.
4. **Fork-owned:** keep fork behavior. Apply upstream hunks only when they are unrelated bugfixes.
5. **Union:** combine. Template: `git show a747d51764` (websearch engines ∪ opencode-go check; e2e stub kept; versions from upstream).
6. **Pruned SaaS / nix:** delete. `git rm` the path. Then `bun run fork:prune`. Also delete the untracked on-disk leftovers the merge resurrects.
7. **Meta** (`../../../docs/handoff/AGENTS.md`, `FORK.md`, workflows, updater, README): keep ours. Port a new always-on KEEP-code rule if upstream added one.
8. If ownership is unclear, **stop** and ask. Do not guess.
9. Never hand-roll an ad-hoc package.json union script: the v1.18.29 sync
   lost `@opencode-ai/core`'s `./memory` export that way (only deps+scripts
   were unioned). Extend `mergePackageJson` in `script/fork-sync.ts` and add
   a regression test in `script/fork-sync.test.ts` instead.

## After the merge commit

Write a merge message body that lists unions and deliberate stubs (see `a747d51764`).

```powershell
bun install
bun run fork:sync verify --tag vX.Y.Z
bun --cwd packages/opencode typecheck
bun --cwd packages/app typecheck
bun --cwd packages/desktop typecheck
```

`verify` enforces the semantic checklist below as code (quota routes, fork
tools, pause/regenerate-title, session groups, updater pin, core memory
export, websearch union, workspaces installability). Run focused tests for
touched KEEP packages. Then tell the user to run `bun run --cwd packages/desktop dev` and look at the window. Do not claim desktop works from typecheck alone.

## Semantic checklist (all must be considered)

- Fork credentials / Go usage cache
- Pause / resume / regenerate-title
- Session groups
- Quota routes still registered in `api.ts` + `server.ts`
- Extra tools still in `tool/registry.ts` and new upstream tools present
- Websearch union
- Plugin/provider unions
- Fork UI tests not replaced by `#review-panel` assumptions
- Channel DB name still fork-specific
- Updater still disabled or still `thelabcorner/openfork`

If a box fails, the sync is not done. Do not push `main`.

## Prune (mandatory, last step)

`main` does not carry SaaS/infra. After the merge is resolved:

```powershell
bun run fork:prune
git status
```

`git ls-files packages/console packages/web infra sst.config.ts` must be empty. If the prune created extra diffs after the merge commit, commit `chore: prune SaaS trees after vX.Y.Z`.

## Update FORK.md

If this sync created a new fork-owned path or a new union file, add it to `FORK.md` in the same change.
