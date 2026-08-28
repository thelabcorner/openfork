# Claude First-Party (claude) — Setup, Migration, Support, Rollback

Status: integration lane (tasks 07/08/09)

Date: 2026-08-24

This is the first-party Claude CLI provider. Its provider ID is `claude`. The external `@openchamber/opencode-claude` plugin remains `claude-code`, and the API-key provider is `claude-api`. Quota source remains `claude` (advisory only).

## Setup

- No npm plugin install or `plugin` entry is required for the first-party provider.
- Requires official Claude CLI (`claude`) on PATH (or `CLAUDE_CONFIG_DIR`).
- Auth is CLI-owned: use `claude auth login --claudeai` (or via OpenCode relay if exposed).
- OpenCode never reads/writes/refreshes Claude credentials.
- First-party is enabled by default. Rollback with env var (see below).

Model references: `claude/sonnet`, `claude/opus`, and `claude-api/<model>` are first-party/API-key references. `claude-code/<model>` remains reserved for the external plugin.

Effort variants (e.g. `/high`) supported via first-party.

## Quota and Observability (Task 07)

- Quota is **advisory only**; never gates inference or turns.
- Uses 5-minute cache (including 429s) for upstream usage.
- CLI credential paths + `CLAUDE_CODE_OAUTH_TOKEN` respected (same as plugin).
- Redacted diagnostics: categories, counts, latencies, cache status only. No prompts, args, tokens, paths.
- Support summary (redacted/bounded):
  ```ts
  import { claudeQuotaStatusSummary } from "@/quota/providers/claude"
  ```
- UI states: "CLI/Anthropic usage", "cached", "stale", "rate-limited", "unavailable".

## Migration and Deprecation (Task 08)

### Detection
- External plugin `@openchamber/opencode-claude` is detected by exact package identity (not substring).
- See `ConfigPlugin.detectClaudeExternal(...)` and `isClaudeExternalPlugin` in `src/plugin/shared.ts`.

### Provider ownership
1. `claude` → first-party Claude CLI/Agent SDK runtime.
2. `claude-api` → Anthropic API-key provider using the standard API transport.
3. `claude-code` → external `@openchamber/opencode-claude` plugin.
4. These IDs are intentionally distinct, so all three may be configured simultaneously.

### Safe duplicate prevention
- The external Claude plugin is not marked deprecated by the first-party feature.
- The first-party runtime never registers `claude-code`.
- Provider IDs, config, auth, model references, and runtime selection remain separate.

### Aliases and binding
- `claude/<model>` resolves directly to first-party canonical model IDs.
- `claude-code/<model>` is never migrated by first-party code.
- Session bindings use OpenCode-owned store (project-scoped, validated cwd/project/modelFamily/settingsDigest + transcript check).
- On mismatch: history-transfer (bounded) or fresh; never silent wrong billing.

### Rollback behavior
- Set `OPENCODE_DISABLE_CLAUDE_FIRST_PARTY=1` (or `true`) to disable only `claude`. The old `OPENCODE_DISABLE_CLAUDE_CODE_FIRST_PARTY` name remains accepted.
- The `claude-code` external plugin and `claude-api` remain available.
- Does **not** delete credentials, transcripts, sessions, or config.
- Existing sessions keep their binding records (inert on rollback).

### Owned migration contract (single source)
- `shouldEnableClaudeFirstParty({ disableClaudeCodeFirstParty? })` in `src/plugin/shared.ts`.
- Used by core provider wiring (rollback gate for `claude` autoload).
- When disabled: first-party produces additive "disabled" readiness (distinct from error/unavailable) and fast-fails before any CLI/SDK work. Hosts can map to external-plugin fallback.
- Re-enable by unsetting flag (or remove env).

### Deprecation timeline (future)
- After one release + telemetry, external path may be removed.
- Keep documented rollback release.

## Packaging and Release (Task 09)

- Run from package dir: `bun typecheck`, `bun test test/quota test/claude test/config ...`
- Node sidecar: `bun script/build-node.ts` (Agent SDK listed under `optionalDependencies` for visibility to packagers/installers, but load is lazy/optional/guarded via indirect specifier + `/* @vite-ignore */` in `src/claude/availability.ts`; never a hard dep and not present in bundle at build time. claude runtime modules are force-pulled for sidecar completeness — see build-node.ts).
- Smoke: `bun run dev` from `../../../packages/desktop`; also standalone `bun run --conditions=browser ...`
- Windows process cleanup (killProcessTree) in `src/claude/runtime.ts` (parity with plugin).
- No stale bundle can resurrect old plugin for claude-code.

Release gates (from plan/testing-release.md) tracked in integration review.

## Support / Diagnostics

Use:
- `opencode debug config`
- Quota: `/quota/claude` (advisory)
- Redacted events include: provider mode, availability category, model family+effort, turn latency buckets, tool count+outcome, resume hit/miss/invalidation, cache status.
- Never: prompts, tool args, full paths, tokens, auth material.

Example support command output (sanitized):
```
claude first-party: active (CLI detected, SDK lazy)
quota: ok configured windows=3 cached=fresh
external-plugin: suppressed (migration)
```

## Privacy

- CLI credentials stay in `~/.claude/.credentials.json` (or equiv) and official env.
- OpenCode reads access token transiently for quota only (advisory); never persists.
- Tool calls go through OpenCode permission + project scope.
- All cross-boundary data is untrusted-fenced.

## Files changed (this lane)

- src/effect/runtime-flags.ts (rollback flag)
- src/plugin/shared.ts (claude external identity + conditional deprecate + shouldEnableClaudeFirstParty helper as single owned contract)
- src/plugin/loader.ts (migration skip comment + import)
- src/config/plugin.ts (detect helpers + rollback advisory)
- src/quota/providers/claude.ts (status summary + small reconcile)
- script/build-node.ts (bundling note)
- test/plugin/shared.test.ts + test/config/config.test.ts + test/quota/providers.test.ts (extended)
- docs/claude-first-party.md (this + runtime handoff notes)
- (plus integration tests added; all in-repo only)

## Remaining integration risks (as of handoff)

- Provider registration and first-party runtime files from other lanes (runtime-auth task complete; provider-ux, bridge-sessions, runtime-integration, provider-wiring, tools-sessions remain for full wiring) — review contracts only.
- Flag wiring: **resolved** — owned `shouldEnableClaudeFirstParty()` (from `@/plugin/shared`) is now used by plugin loader **and** core provider wiring (provider-wiring adopted it for the rollback gate). Additive "disabled" readiness + fast-fail with zero side effects. External fallback supported.
- Bridge/sessions integration tests may need cross with quota/diag.
- Actual Agent SDK dep addition + package.json (lazy/optional) + sdk gen if routes added.
- Full desktop smoke + Windows tree-kill validation (run manually; no external temp fixtures allowed per coordinator).
- Legal/branding approval artifact (Task 00).
- If first-party adds HttpApi, must regen sdk/js and client if overlap.
- Temp fixture permission walls: pre-existing in test/fixture (os.tmpdir); migration work stayed strictly in-repo. Runtime-auth was removed due to these stalls.

See claude-first-party-plan/ for full plan, tasks 07/08/09, security, testing matrix.

**Final parity note (migration lane):** All owned migration/rollback safeguards (duplicate detection via exact pkg, conditional deprecation, `shouldEnableClaudeFirstParty()` contract, docs) are complete and wired. Core provider now uses the helper. Replacement runtime worker (if needed) must consult `shouldEnableClaudeFirstParty()` for "disabled" mode.

See claude-first-party-plan/ for full plan, tasks 07/08/09, security, testing matrix.
