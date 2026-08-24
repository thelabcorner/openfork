# T1 — Checkpoint product

**Lane:** git-ops  
**After:** T0  
**Unlocks:** T2

## Do

1. `git status` / `git diff` / `git log --oneline -8`.
2. Stage **wanted** product only. Must consider:

   - `packages/opencode/src/quota/**` and quota routes/tests
   - dirty app/desktop/search/session files the human marked as product
   - already-staged HttpApi wiring for quota

3. Leave untracked junk unstaged: swarm DBs, CDP logs, `_archivetest`, sample DBs, `*.bak`.
4. Confirm `../../../../.gitignore` covers `.opencode/swarms/*.chunkdb*` and `packages/desktop/resources/opencode-cli*`.
5. Commit: `chore: checkpoint fork work before isolating thelabcorner/openfork`

## Do not

Change remotes. Slim workspaces. Rewrite `../../../handoff/AGENTS.md`. Push. Mix isolation edits into this commit.

## Done when

`git status` shows no wanted product as untracked/modified. Quota is in the last commit if T0 said it is product.
