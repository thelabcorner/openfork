# Sync dry-run — T8 evidence

> **Lane:** sync-owner · **Date:** 2026-08-22 · **Mode:** REPLAY of `v1.18.21` (no newer tag exists — verified against the remote, not assumed).
> **No merge was performed.** No rebase. No `-X ours` / `-X theirs`. Working tree untouched; only read-only git commands and this file.

## 1. Newest upstream tag vs main

| Fact | Value |
|---|---|
| Newest tag on remote (`git ls-remote --tags`) | **`v1.18.21`** (`826d9ad46a release: v1.18.21`) |
| Already merged into `openfork`? | Yes — `openfork..v1.18.21` = **0 commits** (merge commit `a747d51764`) |
| Next tag | Does not exist yet. `origin/dev` is only **10 commits** ahead of `v1.18.21`, so the next tag (`v1.18.22`) will be small |
| Remotes today | Only `origin` → `anomalyco/opencode`. **No `upstream` remote yet** (git-ops T2 pending) |

Because no newer tag exists, this dry-run replays `v1.18.20..v1.18.21` — the exact commit range the last merge consumed — as the rehearsal for the next tag.

## 2. What came in with v1.18.21 (KEEP paths)

7 commits total; KEEP-path diff: **19 files, +199/−79**.

```
826d9ad46a release: v1.18.21
57fa34f235 fix(opencode): continue unknown finish responses (#43892)
8ecd4c21bf chore: generate
361a71ffad fix(opencode): route Vertex multi-regions through REP (#42648)
b6a1f95858 fix(app): preserve file search results while loading (#43836)
f357e70779 fix(app): register archive session command in both layouts (#41741)
a9cac91d60 sync release versions for v1.18.20
```

Read it yourself:

```powershell
git log --oneline v1.18.20..v1.18.21 -- packages/app packages/desktop packages/opencode packages/core packages/schema packages/protocol packages/server packages/session-ui packages/ui packages/client "packages/sdk/js"
git diff --stat v1.18.20...v1.18.21 -- packages/app packages/desktop packages/opencode packages/core
```

## 3. Predicted conflict classes

Evidence base: the files that differ from **both** parents of merge `a747d51764` (= true conflict sites), classified with `FORK.md`.

### Union — combine both sides (FORK.md already covers these)

| File | v1.18.21 resolution (from merge message) |
|---|---|
| `packages/opencode/src/tool/registry.ts` | fork's 5 websearch engine flags ∪ upstream opencode-go provider check |
| `packages/opencode/src/plugin/index.ts` | Cerebras plugin union in `reloadPluginEntry` |
| `packages/opencode/src/provider/provider.ts` | upstream network_error fail-fast + fork credential/usage hooks |
| `packages/opencode/src/session/prompt.ts` | upstream 'unknown' finish condition + fork hooks preserved |
| `package.json` (app, opencode, session-ui) | upstream versions, unioned fork deps |
| `bun.lock` | regenerated via `bun install` — never hand-merge |
| `packages/opencode/test/tool/websearch.test.ts` | fork expanded suite ∪ upstream rename + opencode-go assertion |

### Case-by-case union — resolved by reading both sides, NOT yet in FORK.md tables (gap → §5)

These were real conflict sites in v1.18.21 but have no ownership row. An agent hitting them next tag must read both sides and prefer fork behavior where the hunk is fork feature work:

- `packages/app/src/pages/session/timeline/message-timeline.tsx`
- `packages/app/src/pages/session/use-session-commands.tsx` (archive command registered in both layouts)
- `packages/app/src/pages/session/v2/session-file-browser-tab.tsx`
- `packages/app/e2e/utils/mock-server.ts`
- `packages/core/src/session/projector.ts` (FTS wiring without dangling SessionContextEpoch)
- `packages/core/src/session/runner/llm.ts` (affinity headers + yieldNow)
- `packages/opencode/src/session/llm/ai-sdk.ts`
- `packages/opencode/src/session/session.ts`
- Unit tests: `test/session/prompt.test.ts`, `test/session/compaction.test.ts`, `test/provider/provider.test.ts`

### Meta — keep ours

- `.github/workflows/beta.yml`: anomalyco publish workflow — deleted in the merge; stays deleted.
- `nix/hashes.json`: take upstream values per FORK.md (release-pipeline artifact).

### Pruned SaaS — will become delete-conflicts after slimming

In v1.18.21 the console/stats/web/tui/sdks paths still existed on the branch and took upstream wholesale (~170 of the 190 combined-diff files). **After slimmer's T5 lands, the same paths arrive as `deleted by us, modified by them` → `git rm`, then `bun run fork:prune`.** Expect the next tag's raw conflict list to look alarming; most of it is this class.

### Fork-owned — keep fork behavior

No quota/spad/session-group/tab-chrome files conflicted in v1.18.21, but the current dirty tree touches their neighborhoods (`api.ts`, `server.ts`, titlebar tabs). Any upstream edit near those files conflicts; resolution = keep fork behavior, replay upstream hunks only if they are unrelated bugfixes.

## 4. Exact commands the skill would run

As written in `.opencode/skills/upstream-sync/SKILL.md` (drafts copy — see gap G1), with one environment correction until T2 lands:

```powershell
# 0. Clean tree — NON-NEGOTIABLE. Today 7 of the 19 tag-touched KEEP files are
#    locally modified (layout.tsx, message-timeline.tsx, use-session-commands.tsx,
#    provider.ts, prompt.ts, provider.test.ts, prompt.test.ts).
#    Checkpoint-commit first (T1 pattern, cf. 5374a0963b) or the merge starts dirty.
git status

# 1. Fetch tags. Skill says `upstream`; that remote does not exist yet (T2 pending),
#    so today the identical fetch is:
git fetch origin --tags --prune      # becomes: git fetch upstream --tags --prune after T2

# 2. Confirm the tag and size the read BEFORE merging:
git log --oneline main..vX.Y.Z -- packages/app packages/desktop packages/opencode packages/core packages/schema packages/protocol packages/server packages/session-ui packages/ui
git diff --stat main...vX.Y.Z -- packages/app packages/desktop packages/opencode packages/core

# 3. Merge the tag (never dev, never -X, never --squash):
git merge vX.Y.Z

# 4. Resolve per FORK.md classes (§3 above); generated dirs: take either side + regenerate
#    (`bun run generate` in packages/client; ./packages/sdk/js/script/build.ts if V1 SDK moved).

# 5. Lockfile + verification:
bun install
bun --cwd packages/opencode typecheck
bun --cwd packages/app typecheck
bun --cwd packages/desktop typecheck

# 6. Prune (mandatory last step):
bun run fork:prune
git ls-files packages/console packages/web infra sst.config.ts   # must be empty
```

Then the semantic checklist from FORK.md §"Semantic checklist", then a human runs `bun run --cwd packages/desktop dev` and looks at the window.

## 5. Gaps discovered (for docs-owner / git-ops)

- **G1 — skill not installed.** `.opencode/skills/upstream-sync/SKILL.md` does not exist; only `openfork-isolation-plan/drafts/skills/upstream-sync/SKILL.md`. Root `AGENTS.md` instruction order references skills, so until docs-owner installs it (T3), agents have no discoverable sync doctrine. Draft content itself is sound — no edits needed.
- **G2 — no `upstream` remote.** Every command in skill/FORK.md says `git fetch upstream …`. Until git-ops finishes T2, the equivalent is `git fetch origin --tags --prune` (origin still points at anomalyco). After T2 the commands become correct as written. No doc change needed; just don't run the pre-T2 tree with the post-T2 commands.
- **G3 — FORK.md missing rows for case-by-case union files.** The nine files + three unit tests listed in §3 were genuine conflict sites in v1.18.21 but appear in no FORK.md table. Recommend docs-owner add a "Session timeline / commands / core session plumbing" row (fork-owned-leaning, resolve by reading both sides) and a unit-tests note alongside the existing e2e-stub rule.
- **G4 — checkpoint dependency is real.** 7/19 tag-touched KEEP files are dirty right now. The pre-merge ritual step 1 is not ceremony; skipping it guarantees overlapping-hunk conflicts on the next tag.

Per T8 I could patch FORK.md myself, but docs-owner owns it and T3 is mid-flight — gaps are handed to them instead to avoid write collisions. If T3 closes without absorbing G3, sync-owner will pick it up.

**Update (same day):**
- **G1 resolved** — docs-owner T3 commit `9a04164c0f` installed `.opencode/skills/upstream-sync/SKILL.md`, root `AGENTS.md`, `FORK.md`, `README.md`.
- **G3 resolved** — T3 landed FORK.md byte-identical to drafts (per its spec), so sync-owner picked up the gap as pre-committed: commit `eab5c9d715` adds the "Case-by-case — read both sides" subsection (the 8 files) and the unit-test union rule to root `FORK.md`.
- **G4 addressed** — git-ops checkpoint `d24ef852bb` committed the wanted product work; the tag-touched KEEP files are no longer uncommitted.
- **G2 still open** until git-ops lands T2; use `git fetch origin --tags --prune` until then.

## 6. Done-when check

An agent that has never seen this planning folder can execute the next tag merge using only root `AGENTS.md` + `FORK.md` + the installed skill — provided G1–G3 close. This file is the evidence that the doctrine was rehearsed end-to-end against real data, and that nothing was merged.
