# 04 — Slim `main` to Desktop + Sidecar

> **STATUS: COMPLETE** — D5 accepted as delete-from-main, not allowlist-only.

## Rule

`main` should only contain what Electron + the Node sidecar need. Unused trees are **removed from the branch**, not left as inert merge fodder.

History stays intact (no `filter-repo`). Every tag merge will try to put DROP paths back. That is expected. The last step of every sync is `bun run fork:prune`.

## What "not scorched earth" means

Delete SaaS and marketing. Do **not** delete:

| Keep | Why |
|---|---|
| Full git history | Next tag merge needs a merge-base |
| `../../../packages/desktop` `app` `opencode` `core` `schema` `protocol` `server` `plugin` `llm` `codemode` `sdk/js` `script` `ui` `session-ui` | Desktop + sidecar |
| `../../../packages/client` `httpapi-codegen` | Regen after protocol merges |
| `../../../packages/http-recorder` | Sidecar/core tests |
| `../../../packages/effect-drizzle-sqlite` `effect-sqlite-node` | Sidecar DB |
| `../../../packages/opencode/src/cli/tui` | Lives inside the sidecar package. Do not strip it (merge hell). Do not *maintain* it. |
| `../../../patches` catalog lockfile | Sidecar breaks without them |
| `LICENSE` | MIT obligation |

Do **not** delete `../../../packages/opencode`'s CLI entry. It is the same package as the sidecar.

## Delete from `main` (T5)

Exact list in `drafts/keep-manifest.json` `pruneFromMain` and `drafts/scripts/fork-prune.ts`.

```
packages/console
packages/stats
packages/enterprise
packages/function
packages/slack
packages/web
packages/storybook
packages/cli
packages/tui
packages/sdk-next
packages/docs
packages/identity
packages/containers
infra/
sst.config.ts
sst-env.d.ts
github/
sdks/
flake.nix flake.lock nix/
install
README.*.md          (keep one root README.md)
script/publish.ts script/release script/beta.ts script/stats.ts script/duplicate-pr.ts
```

Anomalyco workflows: delete as in T6 (fork-owned `.github`).

## Also do (same phase)

1. **Workspace allowlist** — even after prune, pin `workspaces.packages` so a half-merged tag cannot reinstall console.
2. **Root scripts** — drop `dev:console`, `dev:stats`, `sso`. `dev:web` → `dev:app` or drop.
3. **Root `@aws-sdk/client-s3`** — drop if no KEEP package imports it.
4. **Do not** mass-delete catalog keys or `patchedDependencies`.
5. **Updater** — T4. Official feed cannot overwrite this tree.
6. **One README** — OpenFork, how to run desktop, link `../../../FORK.md`.

## After every tag merge

```powershell
git merge vX.Y.Z
# resolve KEEP conflicts per FORK.md
bun run fork:prune
# any DROP path that came back is git rm'd
# "deleted by us, modified by them" on a prune path → git rm
git add -A
# finish the merge commit, then prune leftovers if the merge already committed:
# git commit -m "chore: prune SaaS trees after vX.Y.Z"
```

Conflict rule for DROP paths: **always delete**. Never "take theirs" on `packages/console` just to make git shut up.

The skill's last step is this prune. An agent that "fixes" a re-added console file by keeping it has failed the sync.

## Costs you are accepting

- Every tag that touches console/web/sst produces delete/modify conflicts. Mechanical. Scripted.
- `git clone` is not much smaller (history still has the videos). `git checkout` and GitHub file tree are.
- You cannot casually browse upstream SaaS code in this checkout. Use `upstream` or github.com/anomalyco/opencode.

## What we will not do

- `git filter-repo` / orphan branch
- Strip `../../../packages/opencode/src/cli/tui` (KEEP package; take upstream on those files, do not maintain)
- Vendor OpenCode as a submodule
- Point desktop at a published npm `opencode` as the only backend

## Verification

```powershell
git ls-files packages/console packages/web infra sst.config.ts
# must be empty
bun install
bun --cwd packages/desktop typecheck
bun --cwd packages/app typecheck
bun --cwd packages/opencode typecheck
```

Then `bun run --cwd packages/desktop dev`. If typecheck fails because a KEEP package imported a pruned path, **restore that path** — it was not unused. Update `../../../keep-manifest.json`. Do not stub.
