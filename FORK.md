# OpenFork ownership

Canonical map for humans and for the `upstream-sync` skill. If this file and a merge commit message disagree, believe the newer of the two and update this file.

## Remotes

```
origin    https://github.com/thelabcorner/openfork.git
upstream  https://github.com/anomalyco/opencode.git
```

Default branch: `main`. Fetch `upstream/dev` for curiosity. Merge **tags**.

```powershell
git fetch upstream --tags --prune
git merge v1.18.22
```

## KEEP workspace

`packages/app`, `client`, `codemode`, `core`, `desktop`, `effect-drizzle-sqlite`, `effect-sqlite-node`, `http-recorder`, `httpapi-codegen`, `llm`, `opencode`, `plugin`, `protocol`, `schema`, `script`, `sdk/js`, `server`, `session-ui`, `ui`.

Machine copy: `openfork-isolation-plan/drafts/keep-manifest.json` until that file is moved to repo root as `keep-manifest.json`.

## DROP — not on `main`

`packages/console`, `stats`, `enterprise`, `function`, `slack`, `web`, `storybook`, `cli`, `tui`, `sdk-next`, `docs`, `identity`, `containers`, `infra/`, `sst.config.ts`, `github/`, `sdks/`, `nix/`.

TUI is not a product. `packages/opencode/src/cli/tui` may still exist inside the sidecar package — take upstream on those files, do not maintain them.

These are deleted from the branch. After every tag merge run `bun run fork:prune`. A re-added DROP path is a failed sync, not something to "fix" by keeping.

## Conflict classes

### Fork-owned — keep fork behavior

Replay an upstream hunk only when it is a clear bugfix in the same file and does not remove the feature.

| Area | Paths |
|---|---|
| Tab chrome | `packages/app/src/components/titlebar-*`, `packages/app/src/context/tabs.tsx` |
| Project explorer | `packages/app/src/components/project-explorer*`, `packages/app/src/pages/session/v2/project-explorer*` |
| Models / usage | `packages/app/src/pages/session/models-panel*`, `packages/app/src/components/models/`, `packages/app/src/context/fork-usage.tsx`, `packages/app/src/utils/fork-client.ts` |
| Hosted browser | `packages/desktop/src/main/browser/**`, `packages/app/src/pages/session/v2/browser*` |
| Session groups | `packages/schema/src/session-group*`, `packages/core/src/session/group-id.ts`, `packages/opencode/src/session/group.ts`, `httpapi/**/session-group.ts`, `packages/app/**/session-group*` |
| Pause / retitle | V1 pause/resume/regenerate-title handlers, `packages/core/src/session/title.ts` |
| SPAD | `packages/opencode/src/session/spad/**` |
| Quota | `packages/opencode/src/quota/**`, `httpapi/**/quota.ts` |
| Fork credentials | `packages/opencode/src/fork/**`, `httpapi/**/fork-credential.ts` |
| Extra tools | `packages/opencode/src/tool/{json,background,sqlite,git,typecheck,project,symbols,test,refactor,sympy,patch,archive,swarm,browser,reload}*` |
| Search extras | `packages/core/src/search/**` |
| Checkpoints | `packages/core/src/checkpoint.ts`, `packages/opencode/src/session/checkpoint.ts` |
| Conversation Control | `packages/schema/src/session-context.ts`, `packages/core/src/session/sql.ts` (context tables), `packages/core/src/database/migration/*conversation_control*`, `packages/opencode/src/session/context/**`, `packages/opencode/src/session/fork/**`, `httpapi/**/session-context.ts`, `packages/opencode/src/session/message-v2.ts` (context seam), `packages/app/src/components/context-ledger/**`, `packages/app/src/components/context-history/**` |
| Meta | `docs/handoff/AGENTS.md`, `FORK.md`, `.github/workflows/**`, root `README.md`, `packages/desktop/src/main/updater.ts` |

### Union — combine both sides

| Path | Rule |
|---|---|
| `packages/opencode/src/tool/registry.ts` | Fork tools **plus** every new upstream tool |
| `packages/opencode/src/plugin/index.ts` | Union provider/plugin hooks |
| `packages/opencode/src/session/prompt.ts` | Take upstream loop/safety fixes; keep fork hooks (SPAD, quota, pause, **conversation-control compiler**) |
| `packages/opencode/src/session/message-v2.ts` | Keep fork hook (effective-context compiler) — upstream has no context overlay |
| `packages/opencode/src/provider/provider.ts` | Take upstream provider fixes; keep fork credential/usage hooks |
| `packages/opencode/src/server/routes/instance/httpapi/api.ts` | Re-register fork groups after upstream edits |
| `packages/opencode/src/server/routes/instance/httpapi/server.ts` | Same |
| root / package `package.json` | **Upstream versions.** Union fork deps. |
| `bun.lock` | Regenerate with `bun install`. Never hand-merge. |
| i18n `en.ts` | Keep fork keys. Do not drop English source. |

Worked example: `git show a747d51764` (v1.18.21).

### Case-by-case — read both sides

These KEEP-path files had real conflicts in v1.18.21 but follow no blanket rule: keep fork feature hunks, take upstream bugfixes, and let `git show a747d51764` decide.

`packages/app/src/pages/session/timeline/message-timeline.tsx`, `packages/app/src/pages/session/use-session-commands.tsx`, `packages/app/src/pages/session/v2/session-file-browser-tab.tsx`, `packages/app/e2e/utils/mock-server.ts`, `packages/core/src/session/projector.ts`, `packages/core/src/session/runner/llm.ts`, `packages/opencode/src/session/llm/ai-sdk.ts`, `packages/opencode/src/session/session.ts`, `packages/core/src/session/sql.ts`

### Generated — do not hand-merge

`packages/client/src/generated/**`, `packages/client/src/generated-effect/**`, `packages/sdk/js/src/gen/**`, `packages/sdk/js/src/v2/gen/**`.

Take either side, then regenerate.

### Pruned SaaS — always delete

`packages/console/**`, `packages/stats/**`, `packages/web/**`, `infra/**`, `sst.config.ts`, `nix/**`, and every other `pruneFromMain` path.

`deleted by us, modified by them` → `git rm`. Then `bun run fork:prune`.

### Tests that assume deleted fork UI

Keep the fork stub. Do not restore `#review-panel` because an upstream e2e wants it.

Unit tests carrying both fork and upstream assertions (`test/tool/websearch.test.ts`, `test/session/prompt.test.ts`, `test/session/compaction.test.ts`, `test/provider/provider.test.ts`): union the suites — fold upstream renames and new cases into the expanded fork test instead of dropping either side.

## Semantic checklist (every tag merge)

- Fork credentials / Go usage cache wired
- Pause / resume / regenerate-title on V1 HttpApi
- Session groups listed
- Quota routes registered
- Extra tools present **and** new upstream tools present
- Websearch = fork engines ∪ upstream additions
- Plugin/provider unions intact
- Explorer/tab e2e match fork UI
- `bun run --cwd packages/desktop dev` boots
- Channel DB still fork-specific
- Updater still disabled or still this repo

## License

MIT. Keep the 2025 opencode copyright. Quota is a port of OpenChamber (MIT) — keep that attribution.
