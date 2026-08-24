# T6 — Strip anomalyco CI

**Lane:** slimmer  
**After:** T2  
**Parallel with:** T3 T4 T5

## Do

1. Delete or disable workflows listed in `04-slim.md` §A3 (publish, deploy, stats, storybook, docs, containers, nix, triage, discord, compliance, vscode, github-action).
2. Remove `CODEOWNERS` / `TEAM_MEMBERS` if they name anomalyco people.
3. Keep `../../../../.github/actions/setup-bun` if present and useful.
4. Do not add a full desktop CI in this task. A later optional workflow can typecheck KEEP packages.
5. Note in the commit body that `.github/workflows` is now fork-owned (matches `../../../../FORK.md`).

## Do not

Delete `packages/console`. Touch product code.

## Done when

A push to `thelabcorner/openfork` cannot start anomalyco deploy/publish jobs.

Commit: `chore: remove anomalyco SaaS and publish workflows`
