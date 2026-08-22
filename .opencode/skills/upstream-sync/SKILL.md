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

## Default: merge a release tag

```powershell
git status
# if dirty: checkpoint commit first, then continue
git fetch upstream --tags --prune
git log --oneline main..vX.Y.Z -- packages/app packages/desktop packages/opencode packages/core packages/schema packages/protocol packages/server packages/session-ui packages/ui
git diff --stat main...vX.Y.Z -- packages/app packages/desktop packages/opencode packages/core
git merge vX.Y.Z
```

Replace `vX.Y.Z` with the tag. Do not merge `upstream/dev` unless the user explicitly asked for a mid-cycle sync.

## Cherry-pick a single PR

Only when the user needs one KEEP-path fix before the next tag.

```powershell
git fetch upstream pull/NNNNN/head:pr-NNNNN
git log --oneline main..pr-NNNNN
git cherry-pick -x <sha>
```

If the PR is a stack, wait for the tag. Skip console/stats/web-only PRs.

## Conflicts

1. List conflicted files. Classify each with `FORK.md` (fork-owned / union / case-by-case / generated / SaaS / meta).
2. **Generated:** pick either side, then regenerate (`bun run generate` in `packages/client`; `./packages/sdk/js/script/build.ts` if V1 SDK moved).
3. **package.json:** take **upstream version numbers**. Union fork-added deps. Then `bun install` to rebuild `bun.lock`. Never hand-edit the lock.
4. **Fork-owned:** keep fork behavior. Apply upstream hunks only when they are unrelated bugfixes.
5. **Union:** combine. Template: `git show a747d51764` (websearch engines ∪ opencode-go check; e2e stub kept; versions from upstream).
6. **Pruned SaaS / nix:** delete. `git rm` the path. Then `bun run fork:prune`.
7. **Meta** (`AGENTS.md`, `FORK.md`, workflows, updater, README): keep ours. Port a new always-on KEEP-code rule if upstream added one.
8. If ownership is unclear, **stop** and ask. Do not guess.

## After the merge commit

Write a merge message body that lists unions and deliberate stubs (see `a747d51764`).

```powershell
bun install
bun --cwd packages/opencode typecheck
bun --cwd packages/app typecheck
bun --cwd packages/desktop typecheck
```

Run focused tests for touched KEEP packages. Then tell the user to run `bun run --cwd packages/desktop dev` and look at the window. Do not claim desktop works from typecheck alone.

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
