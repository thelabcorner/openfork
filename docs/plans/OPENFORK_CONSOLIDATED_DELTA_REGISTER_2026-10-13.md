# OpenFork consolidated delta register (v1.18.34 ledger + v2.0 inventory)

> Built on the OF-DIFF-001..034 ledger (`docs/plans/OPENFORK_UPSTREAM_DIFFERENCES_LEDGER_2026-10-04.md`)
> and the v2.0.22-vs-main six-slice inventory (in-session, 2026-10-13), re-verified live at HEAD.
> Committed-HEAD truth is separated from in-flight worktree state throughout.

## Refs (re-pinned 2026-10-13)

| Ref | Value |
|---|---|
| Upstream v2 latest | `v2.0.22` = `527f0b931d` (2026-10-02) |
| Upstream v2.0.0 | `63f7ceecbe` (V2 Docker artifact split) |
| Sync comparator | `v1.18.34` = `aec0b9a6d8` (merged via `62b53deaeb`, verified `75303d5b75`) |
| Local HEAD | `95543517ae` (`docs(ci): document Rust frontier findings…`) |
| Merge-base `main..v2.0.22` | `0e2dd4ad15` (2026-06-26) |
| Ranges | upstream `0e2dd4ad15..v2.0.22` = 4051 commits; `0e2dd4ad15..main` = 1785 |
| Diff scale `main..v2.0.22` | 11577 files, +1,286,577 / −1,546,487 |
| Packages | upstream 34 vs main 22; fork-only 5 (`browser-visual, effect-sqlite-node, llm, mobile, opencode`); upstream-only/pruned 18 + `infra/, sst.config.ts, nix/, sdks/, services/*` |

## Live census at HEAD

- Committed rename-aware `aec0b9a6..HEAD`: **5699** (2779A/1875D/991M/54R) — +14 vs the 2026-10-05
  snapshot (5685), all from post-snapshot commits `1d96902911 → 95543517ae`.
- Staged: **0** (explicit). Unstaged: **890**. Untracked: **10310** (8555 `.openfork-e2e` debris).
- Fork-only commits: **455**. Upstream drift vs v1.18.34: **0**.
- **Unexplained meaningful paths on committed+history axes: 0.**

## OF-DIFF-001..034 → six-slice map

| Families | Slice | State |
|---|---|---|
| 001 (identity/distro/sync), 025 (CI/release), 007 (T3 facade) | Distro/branding | Holds; Verified-A mislabel note: 025 is a 548/671-row source/test catch-all needing re-bucket |
| 002 (pruned SaaS) | Distro/branding | Holds — 18 upstream-only pkgs + infra/sst/nix confirmed pruned at v2.0.22 |
| 003 (i18n), 004 (review-panel), 034 (app residual) | UI | Holds; `#review-panel` stub test present at HEAD |
| 005 (V1/V2) | Runtime | **Stale ledger entry**: claims committed paths but holds zero rows in all 3 family maps — needs rewrite, not deletion |
| 006 (API expansion) | API | Holds — 129-file V1 httpapi intact at HEAD |
| 008/009 (OXP/OFXP), 016 (browser), 017 (quota), 018 (desktop), 019 (mobile), 023 (wakatime), 024 (system-one) | Runtime + UI | Hold — all fork surfaces confirmed present |
| 010 (swarm) | Runtime | Holds and growing: 20+ core files at HEAD + dirty runtime/lease/message/projection + 5 untracked host files |
| 011 (Goal), 012 (schedules), 013 (groups/provenance/SPAD) | Runtime | Hold |
| 014 (Code) | Runtime + tools | **Partially stale**: `code-mode.ts` deletion claim gone (only `tool/code-mode.ts` exists at HEAD); `packages/opencode/src/code/` (service, run, saved, revision, execution…) is live **untracked**; `packages/codemode/` dirty |
| 015 (tools), 022 (plugin/MCP) | Tools | Holds — `registry.ts` union intact, no auto-adopts |
| 020 (sync/perf), 021 (persistence) | Config/persistence | Holds — `core/src/v1/` rows belong to 005/013/021, not 025 (mislabel fix) |
| 026–033 (in-flight) | Dirty/untracked | Labels hold; counts moved |
| 030 (Everything search) | Search | **Landed**: `everything.ts` (4c138aa6) + `mention-fast.ts` at HEAD, 4+ committed tests; only 8 bench harnesses remain untracked |

## Backport verdicts (live-checked HEAD vs v2.0.22)

### Protocols — ADAPT #1–5 (strict-boundary adjacent)
1. `anthropic-messages.ts` interleaved-thinking + beta headers + `?beta=true` + redacted-thinking
   (`v2.0.22:packages/ai/src/protocols/anthropic-messages.ts` ~L1625–1661; commits `34a8938dc7`, `033b9ea560`).
   Keep fork `anthropic-capability.ts` as union hunks.
2. `shared.ts` foundation (`lenient`, `fitThinkingBudget`, Media helpers, AIError constructors);
   preserve fork media byte caps.
3. `openai-chat.ts` compat shims (`detectSupportsStore`, `reasoning_effort`, vendor stream-`index`
   stripping, `choice.usage`).
4. Bedrock chain (`bedrock-auth` default-chain + typed errors, `bedrock-event-stream` frame errors,
   converse family image placement).
5. Gemini (thought-signature fallback, blocked-reason `b03d760f43`, `gemini-json-schema` convergence).
   Plus: systematic error-shape migration `isContextOverflow` → `classifyProviderFailure`/`AIError`.
   `open-responses` core (60KB) = separate campaign, never piecemeal.
   REJECT: alibaba/meta/zai/mistral/xAI/media-modality shims (~40 files) unless routed via Zen/Go.

### Runtime — 6 covered, 3 adapt, 2 reject, 1 defer
- ALREADY-COVERED: `inbox.ts` (fork `input.ts` superset), `runner/step.ts` + `runner/retry.ts`
  (fork `runner/llm.ts` 1170 + `session/retry.ts` supersets), `generate.ts`
  (`special-agent-completion.ts`), `execution/restart.ts` (`execution-owner.ts` + `recovery.ts`).
- ADAPT: `move.ts` semantics (genuine gap, `command.session.move` exists); `model-request.ts`
  fitted-output + `boundImages` into V1 `provider/transform.ts`; `provider-context.ts`
  provenance-hash + `compatible()` gate into V1 compaction.
- REJECT: `model-transport.ts` (stateful WS, no need), `transfer.ts` (durable import, no need),
  `event-feed.ts` (replay-less; fork `httpapi/handlers/event.ts` 304 lines strictly richer).
- DEFER: `persistent-pty.ts` handler (real gap, inseparable from absent daemon+schema+protocol stack;
  needs daemon-owner decision + Tier-3 routing first).

### Tools — reject second spawner, defer tinyfish
- Upstream `subagent`: REJECT as tool; fork `task` is superset. Backport-only micro-list into
  `subagent-delegation.ts` if gaps proven (depth-limit, bg-fallback notify, failure-keeps-ID).
- Tinyfish (`3f579f53f4`, `core/src/plugin/websearch/tinyfish.ts` → `agent.tinyfish.ai` MCP):
  REJECT auto-union; DEFERRED candidate as 9th V1 engine with review+tests if product wants it.
- Migrations: REJECT 9 of 10 verbatim (`loose_psylocke` destroys V1 tables; `workspace_domain` /
  `nullable_workspace_binding` collide; `session_inbox` / `execution_claim_attempts` /
  `session_viewed_state` need absent `session_v2`; `clear_v1_session_permission` is a wipe).
  Only `project_time_active` (additive) is a candidate, re-stamped with a fresh fork ID.

## Risk register (R1–R6, refreshed live)

- **R1** `packages/opencode` deleted upstream — manual semantic ports only, forever.
- **R2** ChunkDB vs drizzle driver fork (`database.ts` ±388, `migration.ts` ±366).
- **R3** Fat V1 `runner/llm` (1170) vs slim upstream (363) + model-transport split.
- **R4** Rewritten compaction/projector/server-session.
- **R5** Route re-registration fragility (`api.ts`/`server.ts` fork groups).
- **R6** Generated-client skew (`gen/**` — take-side-then-regenerate).
- Guard files (12) verified present at HEAD: `desktop/electron-builder.config.ts`,
  `src/main/{updater.ts,constants.ts}`, `opencode/src/installation/index.ts`, `script/{release,publish.ts}`,
  `protocol/src/api.ts`, `core/package.json`, `goal-composer-shelf.tsx`,
  `use-session-hash-scroll.test.ts`, `httpapi/{api.ts,server.ts}`.

## Verification status

- **Verify-A: PASS** — zero-unexplained on committed+history holds (modulo 6 mislabel classes).
  Artifact: `docs/plans/openfork-upstream-differences/verification/2026-10-09-verify-a-universe.md`.
- **Verify-C: FAIL/semantic** — OF-DIFF-030 now partially resolved (landed); OF-DIFF-014/005/025 fixes
  recorded above; doc-gate violations open. **Rewrites stay BLOCKED.**
  Artifact: `verification/2026-10-09-verify-c-truth.md`.
- Docs gate: 0 of 3 independent verifiers → fresh snapshot → committed-vs-inflight rewrites.
  Hard rule stands: no README/MAP/docs edits first.

## Next actions

1. Fix stale families in ledger: 030 (landed), 014 (untracked Code), 025 (re-bucket), 005 (zero-rows).
2. Execute protocol adapts #1–5 + error-shape migration.
3. Execute small V1-local adapts (move, model-request fns, provider-context gate).
4. Fresh immutable snapshot files, then re-run verify-A/C before any doc rewrite.
