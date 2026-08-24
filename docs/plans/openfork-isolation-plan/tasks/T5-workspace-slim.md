# T5 — Prune `main` to desktop + sidecar

**Lane:** slimmer  
**After:** T2  
**Parallel with:** T3 T4 T6

## Do

1. Copy `drafts/keep-manifest.json` → repo root `../../../../keep-manifest.json`.
2. Copy `drafts/scripts/fork-prune.ts` → `../../../../script/fork-prune.ts`. Fix the import path to `../keep-manifest.json`.
3. Add root script `"fork:prune": "bun run script/fork-prune.ts"`.
4. Change `workspaces.packages` to the keep-manifest `workspace` list.
5. Remove root scripts `dev:console`, `dev:stats`, `sso`.
6. Grep KEEP packages for `@aws-sdk/client-s3`. Drop the root dep if unused.
7. Do **not** delete catalog keys or `patchedDependencies`.
8. Inline `packages/opencode/src/util/{record,error,locale}.ts` so they no longer re-export `@opencode-ai/tui`. Remove `@opencode-ai/tui` from `../../../../packages/opencode/package.json`. Do **not** delete `../../../../packages/opencode/src/cli/tui`.
9. `bun run fork:prune` (includes `../../../../packages/tui` on the prune list).
10. `Remove-Item -Recurse -Force node_modules` then `bun install`.
11. `git ls-files packages/console packages/web infra sst.config.ts` must be empty.

## Do not

`git filter-repo`. Inline TUI utils. Touch app feature code. Keep a DROP path "for later."

## Done when

`main` has no SaaS/infra trees. `bun install` does not pull console/stats/web. History still contains those blobs (`git log --all -- packages/console` still works).

Commit: `chore: prune SaaS trees; allowlist desktop workspace`
