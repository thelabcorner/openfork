# T8 — Prove the sync skill

**Lane:** sync-owner  
**After:** T7

## Do

Do **not** merge a new tag unless the human asks. This task is a written rehearsal.

1. Load `.opencode/skills/upstream-sync/SKILL.md` and `FORK.md` as if you were about to merge the next tag (or replay `v1.18.21` if no newer tag exists).
2. `git fetch upstream --tags --prune`
3. Write `openfork-isolation-plan/sync-dry-run.md` containing:

   - newest upstream tag vs `main`
   - `git log --oneline main..<tag> --` KEEP paths (summary)
   - predicted conflict classes (fork-owned / union / generated / SaaS)
   - exact commands the skill would run
   - any `FORK.md` gaps discovered (new union files)

4. If you find a gap, patch `FORK.md` in a small docs commit.

## Do not

Actually merge unless asked. Rebase. `-X ours`.

## Done when

An agent that has never seen this planning folder can execute the next tag merge using only `AGENTS.md` + `FORK.md` + the skill. The dry-run file is the evidence.
