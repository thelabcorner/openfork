# Agent Experience (AX) — OpenFork Tool-Surface Audit
**Date:** 2026-10-09 · **Scope:** running OXP connector + checked-out OpenFork V1 registry, OXP adapters, source/test contracts · **Method:** AX v1.0 practitioner skill · **Status:** investigation, not an agent-level A/B benchmark.

## Executive assessment

- **43 native V1 built-in tool identities** are enumerated in `docs/architecture/oxp-native-tool-parity.md` (generated matrix, lines 206–252). Four have reviewed OXP exceptions: `@github`, `@quota`, `@invalid`, `@plan_exit`. One native identity may map to the same OXP capability as others; these inventories are **not additive**.
- The **live OXP broker exposes 33 OpenFork capabilities: 23 default and 10 lazy**. The configured MCP namespace in the inspected root returned zero tools; this does not assert all possible user/plugin MCP integrations are absent.
- All 33 capability input schemas were described via the live OXP broker. All project their properties without embedded `description`; this is intentional in `src/oxp/schema-projection.ts` lines 9–16, not proof that every corresponding native tool has poor guidance.
- Full broker descriptors total approximately **113,928 UTF-8/ASCII JSON bytes** in this sample. `browser` ~28,105 B, `schedule` ~11,523 B, `openfork_swarm` ~8,878 B. Do not eagerly inject this whole collection into a model context.
- Executed `bun packages/opencode/script/verify-oxp-native-parity.ts`: **133 passing tests, 0 failed**, across Core 4, OXP/shared 100, native project 19, application occupancy 10; all four selected gates passed. This is source-tree regression evidence, **not proof of live deployment parity or ACP/OFXP/MCP certification**.
- The root checkout already had **325 Git status entries** when inspected. No existing source files or worker/swarm/scheduled-task state were changed by this audit.

## Confirmed findings and repair hypotheses

| ID | Priority | Finding | Direct evidence | AX dimensions | Safe corrective direction |
|---|---|---|---|---|---|
| AX-OF-01 | **P0 deployment** | **Live OXP lacks source Swarm actions** `member.batch` and `task.batch`. Current native `src/tool/swarm.ts` defines both (action list lines 31–67); the live `openfork_swarm` descriptor has 33 actions and neither. Source/architecture describes partial admission but connected runtime cannot invoke it. | Actual broker `capability.describe(openfork_swarm)`; `docs/architecture/oxp-native-tool-parity.md` lines 269–285; `openfork_info.status.runtime.refreshable=false`. | AX01, AX08, AX15 | Install/restart a **tested compatible host** through a separately authorized deployment workflow; verify real post-deployment broker actions, dispatch, failure receipts, and rollback. A source rebuild alone does not refresh this connector. |
| AX-OF-02 | **P1 observability** | OXP activity recording repeatedly reports `SqlError`, including incidents attached to read, process, patch and request operations. Tool calls can still complete; activity/attribution persistence is unreliable. | `openfork_info.status.diagnostics.incidents`, current `activity_recording` phase; `sessionPersisted=false`; `src/oxp/activity-recorder.ts` and `docs/architecture/oxp-internal-diagnostics.md`. | AX06, AX11, AX16 | Instrument SQLite failure **class** (busy/constraint/schema/etc.) and operation identity safely without logging credentials or prompts; identify root cause; add concurrent success/failure receipt tests and durable observability coverage. Do **not** presume the `SqlError` is lock contention without evidence. |
| AX-OF-03 | **P1 semantics** | All 33 broker descriptors strip nested `description` metadata. Compactness helps token economy, but action-dependent meaning disappears even where source schemas annotate it. | Live descriptor inspection; `src/oxp/schema-projection.ts:9-16`, native Swarm / worker annotations. | AX02, AX03, AX04 | Preserve high-value **semantic hints only when selected**, e.g. `describe(capability, action)` or curated parameter help; compare exact token increase with wrong-call and repair rates. Preserve the lean catalog. |
| AX-OF-04 | **P1 conditional input** | Direct `openfork_request(action=list)` without `sessionID` fails with `OXP_INVALID_ARGUMENT`; host-visible parameters treat `sessionID` as optional. Source has `ACTION_REQUIRED` and `TransportActionConstraints.oneOf`: the conditional rule is implemented but may not survive connector schema lowering. | Reproduced live invalid call; `src/oxp/request.ts:59-116`; current direct-tool advertised schema. | AX03, AX07, AX15 | Confirm schema constraints in actual MCP wire and agent-visible projection. Surface action-discriminated required fields or action-specific `describe`, never weaken runtime validation. |
| AX-OF-05 | **P1 context / selection** | A small number of multifunction schemas dominate full-contract size and unrelated parameter branching. Browser ~28 KB; scheduler ~11.5 KB; Swarm 53 top-level fields. | Live `describe` output sizes and schemas. | AX01–AX04 | Test action-level describe, concise common-path examples, source-of-truth shared leaf handler. Do not split tools merely for aesthetics or double-register semantic owners. |
| AX-OF-06 | **P2 scoped navigation** | With approved root `webstormprojects`, direct `read` into nested `opencode/` succeeds, but root-scoped `symbols.search(OxpCapability)` examined 96 files and found zero despite an exported symbol in nested repo. `skill.list` for broad root returned 0 despite `opencode/.opencode/skills/` existing. | Live read/symbols/skill calls plus nested source inspection. | AX01, AX02, AX03 | Determine expected nested-project behavior. Consider validated `workdir`/project locator or root-suggestion diagnostics for project-scoped tools; do not silently expand root authority. |
| AX-OF-07 | **P2 tool choice** | Agent faces overlapping tool families: `read/find/symbols/lsp`; `write/edit/patch`; `schedule/schedule.create`; `swarm/worker`. Existing text explains some distinctions, not always the quickest task-oriented decision. | Live catalog + `AGENTS.md` + tool schemas. | AX01, AX02, AX04 | Add a *very compact* decision guide to existing tool discovery, with negative examples and side-effect class. A/B test propensity/effectiveness; avoid new permanent tools. |
| AX-OF-08 | **P2 test discovery** | Broker `test(action=list, workdir=opencode, path=packages/opencode/test/oxp/capability.test.ts)` returned `files=0` although that test exists and ran in the verifier. This may be documented discovery semantics/filters, not necessarily a bug. | Live call and verifier output; `src/oxp/test.ts` delegates to `ExchangeTest`. | AX03, AX07, AX10 | Reproduce with the intended `ExchangeTest` filter contract and direct workdir. If expected, improve empty-result hints; if unexpected, fix path interpretation. |
| AX-OF-09 | **P2 performance** | A four-tool parallel call group including project inspection took ~33.7 s elapsed; the isolated attribution to any one call is **unknown** due shared dispatch scheduling. Native `tool.project` suite took 105.7 s for 19 tests, notably involving instance initialization. | Timed invocation group and verifier. | AX14 | Measure individually with cold/warm controls, queue and bootstrap breakdowns. Do not advertise a speed improvement or diagnose `project` without isolation. |
| AX-OF-10 | **P2 protocol evolution** | Direct worker tool schema excludes `model_catalog` while the current live broker and current source include it; source `surface.ts` explicitly describes live contract fallback. | Direct host-exposed `openfork_worker` actions versus broker `describe(openfork_worker)`; `src/oxp/worker.ts:48-71`. | AX01, AX03, AX15 | Enforce connected-host schema fingerprint and direct/broker action comparison at deployment/handshake. Guide agents to broker when advertised direct tool is stale; avoid unsafe blind retries. |

**Priority notation** reflects engineering review, not measured agent success probability. P0 applies to the *deployment/release promise*, not proof that the older running actions are unsafe.

## Live tool-by-tool evidence (33/33 catalogued and described)

| Capability | Exposure | Live execution in this audit | AX disposition |
|---|---|---|---|
| archive | lazy | not invoked; related source tests in verifier | Preserve read/write separation; probe hostile archive, traversal and partial extract recovery |
| browser | default | not invoked (would interact with Desktop browser) | 28 KB union: action-level disclosure; tab ownership and irreversible navigation tests |
| code | default | search succeeded | Preserve composition and leaf authority; measure search/describe/run repair |
| edit | default | schema/source only, no mutation | Verify stale grounding, partial batch, create-vs-edit clarity |
| file.transfer | default | schema only, no mutation | Verify provenance of provided ChatGPT file, destination confirmation, replay |
| find | default | schema/source tests, no live invocation | Pagination/truncation and literal-vs-regex discoverability |
| git | default | status succeeded, dirty checkout preserved | Typed guarded mutations; dry-run and conflict after ref drift |
| json | lazy | inline validation succeeded | Good authority separation; test JSONC/JSONL/BSON selection and patch refusal |
| lsp | default | source regression tests; not live invoked | Start/timeout behavior, location precision, missing server recovery |
| memory | default | source regression tests; not live invoked | Saved durable memory vs historical session evidence; provenance |
| models | lazy | public model search succeeded (3 returned of 1,891) | Good filtering; clearly distinguish catalog from configured/quota-private state |
| ofxp | default | status succeeded | Peer scope, receipt reconciliation, remote authority, partitions |
| openfork_session.checkpoint | lazy | schema only | Restore preconditions, preview, authorization and uncertain commit status |
| openfork_swarm | lazy | list succeeded | **Live missing batch actions**; action contract complexity; durable per-item receipts |
| openfork_worker | default | agent catalog and worker list succeeded | Direct/broker schema drift; staged batch admission, worker blocking and idempotence |
| patch | default | schema/source only, no mutation | Proven independent-file partial receipts vs atomic invariants; replay after unknown commit |
| process | default | start/poll/status succeeded | Good opaque handles; kill/wait/reconciliation and stream cursor tests |
| project | default | nested summary succeeded | Nested root selection and isolated cold/warm latency |
| read | default | normal and mixed-success batch succeeded | **Verified sibling preservation** with targeted `OXP_NOT_FOUND` |
| refactor | lazy | schema/source only, no mutation | Preview/commit hash fence, TS diagnostics, atomically dependent files |
| runtime.refresh | default | status `refreshable=false`; mutation not attempted | Reliable version/deployment recovery separate from source tests |
| schedule | default | schema only; mutation not attempted | Large conditional union; duplicate task prevention and list/preview semantics |
| schedule.create | default | schema only; mutation not attempted | Simplified common path vs general schedule duplication |
| skill | default | root-scoped list succeeded with 0 results | Nested repo discovery and skill provenance |
| sqlite | lazy | schema only; no production DB accessed | Read/run/export authority, safe bind params, transactions, unknown outcome |
| symbols | default | root-scoped search succeeded but 0 results | Scoped project locator and exact-vs-fuzzy query hints |
| sympy | lazy | schema only; no Python launched | Numeric/domain bounds, symbolic timeout and resource budget |
| system-one | default | schema only; inference not invoked | Provider cost, confidence calibration, deterministic schema/errors |
| test | lazy | list invoked, 0 files | Investigate path semantics and discover/run divergence |
| typecheck | default | source contract inspected; no compiler call | Explain vs run, diagnostics provenance and bounded compiler output |
| usage | lazy | source tests in verifier; no private Session read | Maintain supervised-session boundary and settled/live differentiation |
| web | default | provider discovery succeeded without web search | Search/fetch provider selection, provenance, truncation, network failure recovery |
| write | default | no mutation performed on existing source | Atomic create/replace, overwrite guard, read-after-write proof |

**Native tool coverage:** 43 native rows include `apply_patch, archive, background, bash, browser, checkpoint, code, edit, find, git, github, goal, invalid, json, lsp, memory, models, ofxp, patch, plan_exit, project, question, quota, read, refactor, runtime_refresh, scheduled_task, session, skill, sqlite, swarm, swarm_create, swarm_member, symbols, sympy, task, test, todowrite, tool, typecheck, usage, web, write`. See generated per-action native-to-OXP mapping and its four reviewed exceptions in `docs/architecture/oxp-native-tool-parity.md`. Native Session-only/context-dependent operations were not impersonated by fabricating a Session.

## AX-16 dimension-by-dimension review

| Axis | Status | Evidence / next proof |
|---|---|---|
| AX01 Discovery | observed friction | stale live Swarm/model actions; broad root misorientation; preserve compact catalog |
| AX02 Selection | hypothesis | tool overlaps and source/broker hints; run unguided scenario selection |
| AX03 Arguments | observed friction | conditional `sessionID`, stripped field semantics, crowded action unions |
| AX04 Context | observed structural cost | 113.9 KB total full descriptor payload; evaluate progressive action slices |
| AX05 Execution predictability | partially verified | source guards and multiple runtime read calls; mutations untested live |
| AX06 State observability | degraded in diagnostic channel | repeated OXP activity SqlError; tool states can still be observed |
| AX07 Recovery | verified for read batch | missing file localized; additional tool families need live failure injection |
| AX08 Partial progress | verified read; source supports Swarm | batch read sibling preservation; live swarm batch unavailable |
| AX09 Replay/idempotence | untested live for writes | need timeout-after-commit and duplicate request experiments |
| AX10 Verification | partial | 133 source tests and live read receipts, not task-level hidden assertions |
| AX11 Continuity | risk | activity attribution errors; worker/session durable protocols inspected |
| AX12 Delegation | partial | live worker/swarm reads; do not create/cancel workers solely as a smoke test |
| AX13 Security | no observed violation | root/authority tests passed; no independent full security audit |
| AX14 Economics | unmeasured | no controlled agent token/cost/completion baseline; latency attribution unclear |
| AX15 Evolution | confirmed deployment gap | source/live Swarm actions and direct/broker worker schema mismatch |
| AX16 Diagnostics | confirmed degradation | activity recording incidents across multiple tool classes |

**Hard safety gates:** no unauthorized execution was observed. High-risk destructive/permission/timeout-after-commit cases remain untested, not passing by default.

## Engineering worklist (ordered)

1. **Deployment provenance gate:** capture source commit, OXP host build ID/fingerprint, direct/broker action unions and intended Native V1 action set. Assert availability of `member.batch`, `task.batch`, and `model_catalog` against the **actual live connected runtime** after authorized rollout; fail the release or document a narrow exception.
2. **Activity recorder reliability:** test and repair SQLite persistence separately from leaf call success. Preserve incident IDs, sanitized source type, operation/commit receipts and a non-DB diagnostic fallback. Verify under parallel operations, shutdown, WAL contention, process replacement and stale data.
3. **Action-shaped tool contracts:** compare current flat schema with an `action`-discriminated `oneOf` and with progressive `describe(action)`; preserve meaningful descriptions only for active action, with domain owner unchanged. Ensure host tool schema renderer does not discard required branches.
4. **Nested-project targeting:** introduce or document a strictly confined project/workdir locator for `symbols` and `skill`, and honest suggestions when root is a multi-repo parent. Never silently scan outside authorized roots.
5. **Long-tail execution:** keep independent operations best-effort with `created/satisfied/failed/skipped/unknown` receipts; maintain strict all-or-none for dependent invariants and guarded mutation boundaries.
6. **Agent benchmark:** pre-register the corpus below, run existing versus candidate under identical models/config/roots, record successful verified tasks, wasted calls/retries, context, latency, total cost, duplicate side effects and regression count. Count an unavailable tool as a discoverability/deployment failure rather than automatically blaming model behavior.

## Minimal representative eval corpus

| Scenario | Plain-language task | Proof |
|---|---|---|
| E01 | Find the Swarm member batch action without being given a tool name | Correct catalog/describe selection and successful capability invocation |
| E02 | Create three independent workers where one configuration is invalid | Two valid survive; per-item failures named; staged retry deduplicates |
| E03 | Patch three unrelated files with one stale hunk | Good changes persist, one conflict localized, no double changes on retry |
| E04 | Read three files with the middle one missing | Two complete file results, one precise missing receipt |
| E05 | Find a symbol inside a repo nested under a broad approved root | Returns exact declaration, correct file/line without root escape |
| E06 | List tests for a known test file in a nested package | Correct discovered file or actionable reason for zero matches |
| E07 | Ask for configured/quota-qualified model details through an external principal | Public-only fields remain public, denied private fields correctly signaled |
| E08 | Timeout after a successful non-idempotent write | Reconcile commit by receipt/state before retry; no duplicate side effect |
| E09 | Inspect a blocked delegated worker | Recognize permission/question blocker; don't cancel or duplicate worker |
| E10 | Restore checkpoint with stale source revision | Mutation denied or reconciled before commit; no silent corruption |
| E11 | Discover whether scheduled task already exists | No duplicate schedules and exact state-based reply |
| E12 | Record concurrent OXP tool activity while database is contended | Leaf success unaffected; diagnostic or durable audit accurately distinguishes persistence failure |

Use a bare baseline, existing behavior, candidate, and at least two model families. Seed identical initial workspace state and score authoritative state, not model confidence. Do **not** label this run an agent benchmark until such trajectories actually exist.

## Reproducibility / boundaries

- OXP roots: approved `webstormprojects` and `openfork`, no synthetic Session. Live host reports `runtime.refreshable=false`.
- OXP broker dynamic descriptors were loaded and read; 33/33 inspected. Read-only smoke probes were limited to safe operations; browser interaction, worker spawning, scheduling, file mutations, checkpoint restore, database writes and provider inference were intentionally not triggered.
- `openfork_request list` missing-session error was intentional negative probing; action-specific source validation is present, so investigate the **host-visible projection** before changing the validator.
- All source-test claims refer only to the checked-out source/test execution. Dynamic third-party MCP tools, other root catalogs and independently executable ACP/OFXP/MCP adapters are outside this pass.
- Existing code changes in the busy checkout were preserved. This document itself is an additive audit artifact, not a deployment or production tool change.
