# Startup Autopsy — `bun run dev` (packages/desktop)

**Mission:** Explain why `bun run dev` from `../../../packages/desktop` is extraordinarily slow. Instrument, measure, attribute, rank root causes, propose fixes.

**Date:** 2026-08-21 · **Coordinator:** ox-alpha · **Team:** 5-peer swarm `startup-autopsy`, all on `openrouter/stealth/ox-alpha`.

## Environment baseline

- Repo root: `C:\Users\slooshied\WebstormProjects\opencode` (Windows, PowerShell 7, bun)
- Entry: `../../../packages/desktop/package.json` → `predev` (`bun ./scripts/predev.ts`) → `dev` (`electron-vite dev`)
- Electron 42.3.3 · electron-vite ^5 · vite (catalog) · solid-js · renderer imports workspace packages `@opencode-ai/app` + `@opencode-ai/ui`; main deps include `effect`, `drizzle-orm`, `electron-store`, `electron-updater`, `@lydell/node-pty`

## Deliverables index

| # | Doc | Owner lane | Status |
|---|-----|------------|--------|
| 00 | [`00-executive-summary.md`](./00-executive-summary.md) | coordinator | pending |
| 01 | [`01-entrypoint-chain.md`](01-entrypoint-chain.md) | entry-chain | pending |
| 02 | [`02-main-process.md`](02-main-process.md) | main-proc | pending |
| 03 | [`03-vite-renderer.md`](03-vite-renderer.md) | vite-lane | pending |
| 04 | [`04-backend-link.md`](04-backend-link.md) | backend-link | pending |
| 05 | [`05-methodology-trials.md`](05-methodology-trials.md) | metrics-harness | pending |

Every doc follows the same contract: TL;DR ranked verdict → Method (exact commands/env) → Evidence (timings tables, log excerpts) → Code-path analysis (file:line) → Root causes (cause → evidence → impact → fix + effort) → Instrumentation edits made → Handoff notes.

Raw timing data, logs, and harness scripts live in [`raw`](./raw/) named `<lane>-*.{jsonl,log,txt,ts}`.

## Ground rules (all lanes)

1. **Evidence discipline:** no timing without a number; no claim without `file:line` or captured output. Every measurement labeled COLD or WARM.
2. **Official clock:** `metrics-harness` owns the canonical timed trials. Other lanes request run slots via direct message instead of launching overlapping `bun run dev` runs (CPU contention corrupts numbers).
3. **Instrumentation hygiene:** temporary probes must be env-gated or tagged `// STARTUP-AUTOPSY:` and declared in the lane doc's "Instrumentation edits made".
4. **Clean teardown:** kill spawned electron/vite/bun dev processes after each measurement.
5. No commits, no `bun install`, no tests from repo root.
