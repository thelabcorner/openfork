# 07 — Agent Orchestration

> **STATUS: COMPLETE**

## Why this is sequenced

Creating the GitHub repo and renaming remotes can push this tree to the wrong place. Slimming before a remote exists leaves you with no backup. Writing AGENTS.md before the ownership map exists produces fiction.

One coordinator. Specialist lanes only after the human gate.

## Lanes

| Lane | Owns | Must not touch |
|---|---|---|
| **human-gate** | Decision log, private repo create, first push, desktop smoke | — |
| **git-ops** | remotes, branch rename, `../../../.gitignore` hygiene | product code |
| **slimmer** | workspace allowlist, root scripts, CI delete | `../../../packages/app` feature code |
| **docs-owner** | `../../handoff/AGENTS.md`, `../../../FORK.md`, `upstream-sync` skill, README | runtime code |
| **branding** | updater, `repository.url`, desktop author/homepage | session/tool logic |
| **verifier** | typecheck, `bun run dev`, semantic checklist | drive-by refactors |

## Gates

```
G0  human accepts 00-INDEX decision log
      │
      ▼
G1  product checkpoint committed (quota + wanted dirty work)
      │
      ▼
G2  remotes renamed, thelabcorner/openfork exists, main pushed
      │
      ├── parallel ──────────────────────────────────────────┐
      ▼                       ▼               ▼              ▼
   slimmer                 docs-owner      branding       (optional sparse-checkout)
      │                       │               │
      └─────────── G3 all three PRs/commits on main ─────────┘
                      │
                      ▼
                   verifier
                      │
                      ▼
G4  desktop boots; install no longer pulls console
                      │
                      ▼
G5  dry-run of upstream-sync skill (replay notes or next tag)
```

No lane starts G2 work before G1. No verifier "fixes" product bugs it did not cause.

## Taskfiles

| ID | File | Lane | After |
|---|---|---|---|
| T0 | `tasks/T0-human-gate.md` | human-gate | — |
| T1 | `tasks/T1-checkpoint.md` | git-ops | G0 |
| T2 | `tasks/T2-create-repo.md` | git-ops + human | G1 |
| T3 | `tasks/T3-agent-docs.md` | docs-owner | G2 |
| T4 | `tasks/T4-updater-branding.md` | branding | G2 |
| T5 | `tasks/T5-workspace-slim.md` | slimmer | G2 |
| T6 | `tasks/T6-ci-strip.md` | slimmer | G2 |
| T7 | `tasks/T7-verify-desktop.md` | verifier | T3–T6 |
| T8 | `tasks/T8-sync-dry-run.md` | sync-owner | G4 |

T3, T4, T5, T6 are parallel after G2.

## Prompt contract for spawned agents

Every spawn gets:

1. "Read `00-INDEX.md` and your taskfile. Do not expand scope."
2. The decision log IDs that constrain them (D1–D11).
3. "Do not `git push` unless the taskfile says so. Do not force-push. Do not push to `upstream`."
4. "Do not `filter-repo`. Do delete unused SaaS trees from `main`. After merges, prune — never keep re-added DROP paths."
5. Acceptance criteria copied from the taskfile.

Coordinator does not re-implement a lane. Coordinator only unblocks gates and records decisions.

## What not to swarm

- The first remote rename (one human, one terminal)
- The first `gh repo create`
- The first desktop smoke (`bun run dev` — you have to look at the window)

Agents may prepare the commits. Humans push and look.
