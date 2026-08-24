# 03 — Repo Topology & First Push

> **STATUS: COMPLETE**

## Target remotes

```
upstream  https://github.com/anomalyco/opencode.git     (today's origin)
origin    https://github.com/thelabcorner/openfork.git  (does not exist yet)
```

Default branch on GitHub: `main` = current `openfork` commit (after the checkpoint).

Do **not**:

- Press GitHub's Fork button
- `git filter-repo`
- Force-push to anomalyco (today's `origin` still points there — rename it **before** any push)
- Rewrite shared upstream commits

## License

MIT, Copyright (c) 2025 opencode. Keep `LICENSE` intact. Add a second copyright line for fork-owned files if you want; do not relicense. Quota is a port of OpenChamber (also MIT) — keep that attribution in the quota module.

Name collision: other GitHub repos named `openfork` exist. `thelabcorner/openfork` is free.

## Phase-0 hygiene (must happen before `gh repo create`)

### A. Product that is currently uncommitted — commit or lose

Highest risk: **quota is untracked**.

```
packages/opencode/src/quota/**
packages/opencode/src/server/routes/instance/httpapi/groups/quota.ts
packages/opencode/src/server/routes/instance/httpapi/handlers/quota.ts
packages/opencode/test/quota/**
packages/opencode/test/server/httpapi-quota.test.ts
```

Plus a large dirty set: app titlebar/prompt/models, desktop main/sidecar/updater/windows, core search matcher, session run-state, generated SDK files.

Recommended: one or two checkpoint commits on `openfork`, same style as `5374a0963b` / `fccc8b3385`.

```
chore: checkpoint fork work before isolating thelabcorner/openfork
```

Do not mix isolation (allowlist, remotes, AGENTS) into the product checkpoint. Isolation is a later commit on the new `main`.

### B. Do not add

See the prune list in `02-keep-drop.md`. Especially:

- `.opencode/swarms/swarms.chunkdb*`
- CDP logs / screenshots
- sample DBs
- `_archivetest/`

Confirm `../../../.gitignore` covers swarm DBs and `packages/desktop/resources/opencode-cli*`.

### C. Rename remotes — order matters

Today `origin` **pushes to anomalyco**. One wrong `git push -u origin openfork` is a PR-shaped disaster (or a rejected push, depending on permissions). Assume it is dangerous.

```powershell
git remote rename origin upstream
gh repo create thelabcorner/openfork --private --source=. --remote=origin --description "Branch-fork of OpenCode Desktop"
# do not let gh push yet if the tree is still dirty
git branch -M main
git push -u origin main
```

Start **private**. Flip public later if you want. Isolation is not a launch.

`gh repo create --source=.` can push immediately. Prefer creating empty, then push after you inspect `git status`.

### D. Branch notes after the move

| Local name | After isolation |
|---|---|
| `openfork` | rename to `main` or keep as an alias of `main` |
| `dev` | leave as a local stale copy of old upstream; do not treat as truth |
| `upstream/dev` | fetch this, but merge **tags** by default |
| `api-keys-tab-menu`, `upstream-sync`, `tabs-context-menu` | leftover locals; ignore unless you still need them |

## What the GitHub repo should contain on day one

- Full history (so `git merge v1.18.22` has a merge-base)
- Product checkpoint
- **Not yet required on first push:** allowlist, new AGENTS, skill. Those can be commit 2 on `main` once the remote exists. Safer: remote exists → then slim, so you have a backup of the pre-slim tree.

Recommended first three commits on `origin/main`:

1. (already on the branch) product checkpoint
2. `docs: add OpenFork isolation plan` (this folder) — optional
3. After remote exists: `chore: isolate desktop workspace and fork agent docs`

## Upstream fetch after remotes change

```powershell
git fetch upstream --tags --prune
git tag --list "v1.18.*" | Select-Object -Last 8
```

Sync command that matches history (also in the skill):

```powershell
git fetch upstream tag v1.18.22
git merge v1.18.22
```

Never `git pull` from `upstream/dev` as the default.

## Branding / identity files to change after the repo exists

Not on the first push. Tracked in `04-slim.md` and `tasks/T4-updater-branding.md`.

- README (replace 20 locale READMEs with one OpenFork README)
- `../../../package.json` `repository.url`
- desktop `author` / `homepage` if you package
- electron-updater feed
- GitHub workflows

## Safety checklist before the first `git push`

- [ ] `git remote -v` shows `origin` = `thelabcorner/openfork` and `upstream` = `anomalyco/opencode`
- [ ] `git status` has no wanted untracked product (quota especially)
- [ ] `git log -1 --show-signature` / `git log -3 --oneline` looks like the checkpoint you meant
- [ ] you are not on a detached HEAD
- [ ] you will not `git push --mirror`
- [ ] repo is private
