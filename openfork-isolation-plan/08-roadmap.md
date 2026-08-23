# 08 — Roadmap, Risks, Acceptance

> **STATUS: COMPLETE**

## Phases

| Phase | Name | Exit |
|---|---|---|
| 0 | Accept decisions + checkpoint product | clean `git status` except known trash |
| 1 | Create `thelabcorner/openfork`, remotes, push `main` | `gh repo view thelabcorner/openfork` works |
| 2 | Slim + docs + branding on `main` | allowlist installed; AGENTS/FORK/skill present; updater safe |
| 3 | Verify | desktop `bun run dev` works; no console in `node_modules` |
| 4 | Prove the skill | written dry-run of the next tag or a replay of v1.18.21 |
| 5 (later) | Own CI, public repo, skip Rust CLI download | only if you still want them |

Do not combine Phase 0 and Phase 2 in one commit.

## Risk register

Severity: S1 catastrophe · S2 major · S3 pain. Likelihood H/M/L.

| ID | Risk | Sev | Lik | Mitigation |
|---|---|---|---|---|
| R1 | `git push` to anomalyco because `origin` was not renamed | S1 | M | Rename first. Task T2. Assume push to current origin is forbidden. |
| R2 | Quota / dirty UX left untracked and never published | S1 | H | T1 checkpoint. Explicit quota path list. |
| R3 | `filter-repo` or deleting console "to be like OpenChamber" | S1 | M | D4/D5. Skill forbids it. |
| R4 | `-X ours` merge drops upstream security/provider fixes | S1 | M | Union doctrine. Skill forbids `-X`. |
| R5 | Official updater overwrites the fork | S1 | M | T4 disable or retarget before any packaged build. |
| R6 | Allowlist drops a real sidecar import | S2 | L | T7 typecheck. If it fails, restore the package — do not stub. |
| R7 | Agents keep editing console/web because they are still in the tree | S2 | H | AGENTS.md + FORK.md ignore list. Optional sparse-checkout. |
| R8 | Generated SDK hand-merged into nonsense | S2 | H | Skill: regenerate, never union-by-eye. |
| R9 | Local `dev` used as sync baseline (it is stale) | S2 | H | Tags only. Skill says so. |
| R10 | Stage B prune without a script → every tag is a fight | S2 | H if B | Do not start B in phase 1–4. |
| R11 | Publishing swarm DBs / sample DBs | S3 | M | T1 ignore list. |
| R12 | Relicensing or dropping MIT notice | S3 | L | Keep LICENSE. |

## Acceptance — isolation complete

Copy this into the coordinator's final check.

**Repo**

- [ ] `thelabcorner/openfork` exists
- [ ] default branch `main` has the openfork history (not an orphan)
- [ ] `upstream` = `anomalyco/opencode`
- [ ] `origin` = `thelabcorner/openfork`
- [ ] repo private until you say otherwise

**Slim**

- [ ] `packages/console` / `web` / `infra` / `sst.config.ts` **absent from `main`**
- [ ] `bun run fork:prune` exists and is a sync last step
- [ ] `workspaces.packages` is the allowlist
- [ ] `bun install` does not install console/stats/enterprise/web/slack
- [ ] anomalyco publish/deploy workflows gone
- [ ] history still has those trees (`git log --all -- packages/console`)

**Docs**

- [ ] Root `AGENTS.md` is the fork guide and still contains style/API/V2 rules
- [ ] `FORK.md` has remotes + ownership + checklist
- [ ] `.opencode/skills/upstream-sync/SKILL.md` exists and matches `05-upstream-sync.md`

**Runtime**

- [ ] `bun run --cwd packages/desktop dev` launches Electron against current source
- [ ] sidecar healthy, a session can be opened
- [ ] fork chrome still present (tabs / explorer / models — smoke, not full QA)
- [ ] updater cannot install official OpenCode

**Sync**

- [ ] Skill dry-run written (T8)
- [ ] No rebase-onto-dev in the procedure
- [ ] Next real tag can be merged by an agent that only read the skill + FORK.md

## Non-acceptance

These are **not** required to call isolation done:

- Public repo
- Published installers
- `filter-repo` / smaller clone
- Stripping `packages/opencode/src/cli/tui` (leave it unmaintained)
- Own desktop CI green
- Feature-complete quota
- Contributing back to anomalyco
