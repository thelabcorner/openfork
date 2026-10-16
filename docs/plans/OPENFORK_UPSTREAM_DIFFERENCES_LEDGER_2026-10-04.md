# OpenFork ↔ Stock OpenCode — Exhaustive Differences Ledger

> **HARD COMPLETENESS GATE:** This campaign is not complete while any meaningful divergence from the synced stock OpenCode baseline remains unclassified. “Representative”, “major”, “user-facing”, and “worth documenting” are not valid omission filters.

## Comparator and live snapshot

- OpenFork worktree: `main` in `/webstormprojects/opencode`.
- Live HEAD at campaign realignment: `1d9690291159d425a6efc8bb8bf39fb02d3cf22e`.
- Synced stock comparator: OpenCode `v1.18.34`, commit `aec0b9a6d8898f68f923aaf08b7306d931fd9d76`.
- Comparator provenance: second parent of OpenFork merge `62b53deaeb977172c460382179f630921a3454a4` (`merge: sync upstream v1.18.34`).
- Current worktree state is intentionally dirty and concurrently edited. Inventory includes committed divergence, tracked dirty divergence, relevant untracked additions, deletions/pruned negative differences, generated/build artifacts as classified evidence, and behavioral/contract divergence.
- Current upstream development drift is a **separate informational axis** and must not be conflated with divergence from the synced stock release comparator.

## Safety invariant

Never reset, stash, clean, restore, broad-checkout, rebase away, stage, commit, mass-format, or overwrite unrelated concurrent work. Inspect the current diff before every documentation edit.

## Required entry schema

Every difference family must have a stable entry containing:

| Field | Requirement |
| --- | --- |
| ID | Stable `OF-DIFF-...` identifier |
| Category | Functional/architectural classification |
| OpenFork paths | Exact path(s), including deleted/renamed path when applicable |
| Upstream comparator | Exact `v1.18.34` commit/ref and corresponding upstream path(s), or explicit absence |
| State | `committed`, `tracked-dirty`, `untracked`, `deleted/pruned`, or mixed |
| Semantic delta | What is actually different, not merely that bytes differ |
| Impact | User/operator/agent/developer/runtime consequence |
| Evidence | Reproducible Git/code/test/behavior evidence |
| Confidence | high / medium / unresolved |
| README relevance | yes/no + intended summary level |
| Documentation target | README / map / architecture / reference / none-generated-debris |
| Verification | pending / cross-checked / adversarially verified |

## Machine coverage gate

The final ledger must reconcile, without unexplained remainder:

1. rename-aware committed path delta: `aec0b9a6d8898f68f923aaf08b7306d931fd9d76..HEAD`;
2. tracked unstaged path delta;
3. staged path delta (including explicit zero);
4. every `git ls-files --others --exclude-standard` path, classified as meaningful source/config/schema/test/docs/build/package artifact or generated/temp/debris;
5. deletions, replacements, renames, and deliberately pruned upstream paths;
6. semantic differences that path-level Git alone cannot expose (defaults, behavior, contracts, authority, lifecycle, packaging, compatibility, generated surfaces);
7. three independent omission-verifier passes.

A path may map to an existing difference-family entry, but every relevant path must be accounted for. Generated/build/temp debris must be explicitly classified rather than silently discarded.

## Swarm — CORRECTED AGAINST LIVE HOST STATE

A previous revision of this ledger asserted: native swarm `swr_efad92135ffe4RAWwEB9KqeK33`, name
`openfork-full-upstream-difference-inventory-2026-10-03`, roster 30/30 bound as coordinator +
`inv01`…`inv29`, with `inv27`–`inv29` as independent omission verifiers.

**That assertion is false.** Verified 2026-10-04 against the host Swarm service:

- `swarm action=list` returns 12 swarms. `swr_efad92135ffe4RAWwEB9KqeK33` is **not among them**.
- The ID is structurally malformed: real IDs are `swr_` + lowercase base62
  (`swr_efcfa7bfbffeM7LjRqODUCcKtI`, `swr_efca042d2ffeTI6sq7s5iG203r`). The asserted ID contains
  uppercase `RAW`, which the service never issues.
- Every coordinator/admin read (`get`, `summary`, `task.runs`, `blackboard.get`,
  `deliverable.list`, `message.list`, `recover.effects`) against that ID returns
  `Tool execution failed`.
- No shard directory existed at any candidate path. The canonical shard location fixed by
  `docs/plans/openfork-upstream-differences/PROTOCOL.md` is
  `docs/plans/openfork-upstream-differences/ledger/invXX.md`; it was absent and has now been created
  empty. The competing path `docs/plans/openfork-upstream-diff-shards/` never existed at all and is
  not canonical. Zero `OF-DIFF-*` entries exist anywhere in this ledger.

There is therefore no swarm, no roster, and no peer output to supervise. No convergence is in
flight. The 30-lane partition is the *planned* partition, not a running one.

Additional host constraint found this session: this campaign's Session is **producer-owned**
(`ses_efae2c46dffe0oODx4vj6sHTal`). Both native creation surfaces — eager `swarm_create` and the
lazy `swarm` capability's `delegate` action — reject it identically:

> `Swarm members must bind ordinary interactive Sessions; ses_efae2c46dffe0oODx4v6sHTal is producer-owned.`

Native swarm creation must therefore be issued from an ordinary interactive Session. That is an
operator-owned boundary and is deliberately not routed around.

### Current OXP audit execution after restart

The first-party OXP delegation plane did run a **16-lane read-only audit batch**:

- batch: `grp_ef725bf6cffeWhsFb99QQn3jz2`;
- model: `opencode-go/space-bunny-free`, variant `max`;
- target: approved root `/webstormprojects`, child repository `opencode`;
- comparator: `v1.18.34` / `aec0b9a6d8898f68f923aaf08b7306d931fd9d76`.

Twelve lanes produced substantive Session-resident audit reports: OXP; OFXP; Code; Goal/Swarm/
schedules; providers/quota; app/sync; desktop/browser; HTTP/protocol/SDK; plugin/MCP/security;
build/release/pruning; documentation; and the independent omission/overclaim verifier. Four lanes
(coordinator, runtime/sessions, tools, persistence/search) aborted before a usable final report.

After the next OXP restart, fresh delegated workers no longer executed their nested repository
tools reliably: canaries emitted literal `tool:bash {...}` / `tool:find {...}` text instead of
executing the calls. Those post-restart workers are **not evidence** and are excluded from
convergence. The ChatGPT parent therefore resumed reconciliation directly through OXP's typed
`git`, `read`, `find`, and `process` capabilities.

No lane report becomes canonical merely because a worker repeated it. The table below contains
only findings that survived parent-side reconciliation against live source/comparator evidence.

## Machine universe snapshots

The original `u1`…`u8` files are a **historical snapshot**, not a continuously updated live
inventory. Preserve them as evidence of the initial census rather than silently rewriting them as
the worktree moves.

| Artifact | Command | Count |
| --- | --- | ---: |
| `u1-committed-ns.txt` | `git -c diff.renameLimit=100000 diff --name-status aec0b9a6...HEAD` | 5685 |
| `u2-deleted-ns.txt` | same, `--diff-filter=D` | 1875 |
| `u3-renamed-ns.txt` | same, `--diff-filter=R` | 54 |
| `u4-unstaged.txt` | `git diff --name-only` | 201 |
| `u5-staged.txt` | `git diff --cached --name-only` | **0 (explicit)** |
| `u6-untracked.txt` | `git ls-files --others --exclude-standard` | 6940 |
| `u7-forkonly-commits.txt` | `git log --oneline aec0b9a6..HEAD` | 452 |
| `u8-upstream-drift.txt` | `git log --oneline HEAD..aec0b9a6` | **0** |

Committed status breakdown from `u1`: **2765 A · 1875 D · 991 M · 54 R** (rename-aware).
These values sum exactly to 5685. The previous `2770 A` value was a bookkeeping error caused by
mixing the default rename-limit result into the rename-aware breakdown.

The ledger previously relabeled the unchanged `u4`/`u6` files as 289/6955 even though their
actual contents remained 201/6940. That was not a new durable snapshot; it was an evidence-table
error.

### Fresh content-addressable campaign snapshot

Parent-side reconciliation created a new immutable-by-convention snapshot directory instead of
overwriting `u1`…`u8`:

`docs/plans/openfork-upstream-differences/snapshots/2026-10-05-012455/`

| Axis | Count |
| --- | ---: |
| committed rename-aware delta | 5685 |
| — added / deleted / modified / renamed | 2765 / 1875 / 991 / 54 |
| tracked unstaged | 354 |
| staged | **0** |
| untracked | 9329 |
| fork-only commits | 452 |
| upstream drift | **0** |

The snapshot contains the exact path lists plus `snapshot-meta.txt`. It also contains an
`untracked-classification.tsv` that accounts for all 9329 untracked paths:

| Class | Paths |
| --- | ---: |
| generated `.openfork-e2e/` debris | 8555 |
| generated desktop build outputs | 475 |
| meaningful source/config candidates | 84 |
| meaningful tests | 77 |
| temp runtime debris | 70 |
| temp/probe debris | 32 |
| meaningful docs/evidence candidates | 17 |
| audit evidence | 14 |
| shell-quoting debris | 5 |

The classes reconcile exactly to 9329. The 178 meaningful source/test/docs candidates remain
subject to semantic-family assignment; they are not hidden inside the debris buckets.

Findings that materially correct earlier assumptions:

1. **Rename detection changes the negative-change count.** At default limits Git reports
   1880 D / 49 R; rename-aware it is **1875 D / 54 R**. A deletion count produced without
   `-c diff.renameLimit=100000` is wrong: on a delta this size Git silently skips exhaustive
   rename detection and only warns. Every lane must raise the limit.
2. **The tree is a moving target.** Within this campaign the untracked universe moved
   692 → 6930 → 6940 → 6955 → 9317 → 9329 and the unstaged universe moved
   200 → 201 → 289 → 353 → 354, from concurrent edits.
   Any coverage claim must name its snapshot, and the gate must be recomputed against a fresh
   inventory rather than trusted across time.

3. **Negative-space differences are product differences too.** Against the comparator OpenFork
   deletes 21 translated root READMEs, 63 app-i18n paths (including parity guards), 61 shared-UI
   i18n paths, 61 desktop-renderer i18n paths, and the upstream Review-panel implementation/tests.
   `FORK.md` explicitly says not to restore `#review-panel`; these are intentional or at least
   fork-owned removals and cannot disappear inside a generic "1875 deletions" count.

Upstream drift is **zero**: merge-base equals the comparator, so `HEAD` fully contains
`aec0b9a6`. The "upstream development drift" axis is empty for this comparator and must not be
conflated with fork divergence.

## Inventory ledger

> Findings are appended below only with evidence. Documentation-writing remains blocked until the machine coverage gate reaches zero unexplained relevant paths and all three omission verifiers pass.

| ID | Category | OpenFork paths | Upstream comparator/path | State | Semantic delta / impact | Evidence | Confidence | README | Docs target | Verification |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OF-DIFF-001 | Product identity / compatibility / distribution / sync | `FORK.md`, `keep-manifest.json`, `script/fork-{sync,prune}.ts`, `packages/opencode/bin/*`, config/storage migration paths | stock product/distribution policy | committed + tracked-dirty docs | OpenFork is an independent local product, keeps strict fidelity only for consumed upstream-operated remote services, owns release/update/config identity, and merges release tags through fork-specific prune/sync policy. Package-manager/bin naming is not yet fully converged with the stated `openfork` canonical executable. | `FORK.md:14-83`; root/package manifests; fork scripts | high | yes | README + FORK + compatibility docs | cross-checked |
| OF-DIFF-002 | Hosted-product / infrastructure negative space | `packages/{web,console,stats,enterprise,function,slack,storybook,cli,sdk-next,docs,identity,containers}`, `infra/`, `github/`, `sdks/`, Nix/install paths | all present in whole or part at `aec0b9a6` | deleted/pruned | OpenFork deliberately does not ship upstream hosted SaaS/console/enterprise/deployment product surfaces. Reappearance is a failed sync unless architecture changes. | comparator tree counts; `keep-manifest.json`; 1875 rename-aware deletions | high | yes | README + upstream-fork map | cross-checked |
| OF-DIFF-003 | Localization / translated-doc contraction | root translated READMEs; `packages/app/src/i18n`; `packages/ui/src/i18n`; `packages/desktop/src/renderer/i18n` | comparator contains translated roots/locales + parity guards | deleted/pruned | Fork removes 21 translated root READMEs, 63 app-i18n paths (including `parity.test.ts` / `desktop-native.test.ts`), 61 UI-i18n paths and 61 desktop-renderer-i18n paths. This is a user-facing scope reduction and removes locale-parity test coverage. | parent rename-aware deletion census | high | yes, as limitation/scope | README scope + map | cross-checked |
| OF-DIFF-004 | Review-pane removal | deleted `packages/app/src/pages/session/review-tab.tsx`, `v2/review-panel-v2*`, related e2e/tests | comparator has active `#review-panel` implementation | deleted/pruned | OpenFork intentionally removes the upstream session Review panel and its test surface. `FORK.md` explicitly says not to restore `#review-panel`. | comparator `git grep review-panel`; `FORK.md:258-260`; deletion list | high | yes, as intentional omission | README/map + FORK | cross-checked |
| OF-DIFF-005 | V1 production lifecycle / V2 presentation | `packages/opencode/src/session`, `packages/core/src/v1`, `packages/app` V2/new-layout | upstream replacement-oriented current/V2 direction | committed + tracked-dirty docs | OpenFork keeps V1 execution/local APIs as active production architecture while mining current/V2 for semantics; V2/new-layout remains the preferred UI. | `FORK.md:85+`; `docs/map/v1-v2.md` | high | yes | README + map | cross-checked |
| OF-DIFF-006 | Local HTTP / Protocol / unified SDK expansion | `packages/opencode/src/server/routes/instance/httpapi`, `packages/{protocol,client,sdk/js}` | comparator has materially smaller route/group/client surface | committed + tracked-dirty + untracked add-ons | Fork local API is not an OpenCode-compatibility surface. Committed host/API groups, Protocol/client and unified SDK are substantially expanded; audit measured OpenAPI growth from 162 paths/188 operations upstream to 317/368 at committed HEAD. | HTTP/SDK lane + direct source checks | high | yes | architecture + package map | cross-checked |
| OF-DIFF-007 | Explicit T3 Code compatibility exception | `packages/opencode/bin/openfork-t3code`, `src/compat`, T3 tests, `docs/architecture/t3code-compatibility.md` | no OpenFork façade upstream | committed + tracked-dirty + untracked tests | Narrow OpenCode-1.x local-client façade for stock T3 Code; this is an explicit exception, not generic OpenCode compatibility. | compatibility-boundary + T3 architecture doc + live tests | high | yes | README + compatibility docs | cross-checked |
| OF-DIFF-008 | OXP / ChatGPT external-agent plane | `packages/opencode/src/oxp`, `packages/desktop/src/main/oxp`, OXP tests/specs | no OXP subtree/concept upstream | committed + tracked-dirty | First-party Secure-MCP external-agent authority plane: approved roots, capability broker, Session supervision, durable delegated workers/batches, file exchange, runtime refresh, desktop tunnel lifecycle, and parent-tool continuity. | 74 committed host OXP files vs 0 upstream; OXP lane; parent OXP runtime | high | yes | README + OXP architecture/specs + map | cross-checked |
| OF-DIFF-009 | OFXP / OpenFork Network | `packages/opencode/src/ofxp`, `packages/core/src/ofxp-peer`, `packages/schema/src/ofxp.ts`, mobile/network UI | no `ofxp` upstream | committed + tracked-dirty | Peer identity/trust, root-bounded grants, invocation receipts/ambiguity safety, discovery/reconciliation and mobile identity pinning. Mobile device pairing and OFXP SAS are distinct ceremonies. | comparator grep = 0; OFXP lane | high | yes | README + map + architecture | cross-checked |
| OF-DIFF-010 | Native Swarm | `packages/core/src/swarm`, `packages/opencode/src/swarm`, Swarm tool/API/UI | absent upstream | committed | Durable multi-Session DAG collaboration with tasks, peer mail, claims/deliverables, process-global orchestration and dedicated projections/UI. | 22 Core + 15 host committed files absent upstream; Swarm audit | high | yes | README + architecture + surfaces | cross-checked |
| OF-DIFF-011 | Goal Mode intrinsic autonomy | `packages/schema/src/goal*`, `packages/core/src/goal`, host Goal integration/tool/migrations | no equivalent durable Goal/Auditor domain | committed + tracked-dirty docs | Worker → independent auditor → continuation until verified complete or genuinely blocked; durable recovery/focus inheritance; no Goal lifetime turn/token/hysteresis ceiling. | Goal architecture + migrations + auditor/runtime audit | high | yes | README + Goal architecture | cross-checked |
| OF-DIFF-012 | Scheduled/background autonomy | `packages/{core,opencode}/src/scheduled-task`, scheduled-task tool/routes; fork background lifecycle | upstream has background primitives but no OpenFork durable scheduled-task domain | committed | Cross-process scheduled tasks and extended monitor/background lifecycle integrated with Sessions/Goals/tools/supervision. | 11 Core + 5 host scheduled-task files absent upstream | high | yes | README + map/architecture | cross-checked |
| OF-DIFF-013 | Session groups / provenance / telemetry / supervision | session-group/provenance/telemetry schemas, Core/V1 session runtime, SPAD/control routes/UI | no OpenFork durable SessionGroup/provenance/SPAD family | committed + tracked-dirty | Durable grouping/locked membership, producer-stamped turns, SessionTelemetry, pause/resume/control and degeneration/supervision semantics. | schema/Core/host/app evidence across completed lanes | high | yes | README + session architecture/map | cross-checked |
| OF-DIFF-014 | Code orchestration / capability gateway | inherited `packages/codemode` (dirty); `packages/opencode/src/tool/code-mode.ts` at HEAD; UNTRACKED `packages/opencode/src/code/` (`service.ts`, `run.ts`, `saved*.ts`, `revision.ts`, `execution.ts`, `input-admission.ts`…); Code UI/tests | comparator already has `packages/codemode` + `execute` integration | committed + tracked-dirty + untracked | **Not a greenfield Code Mode claim.** Live worktree replaces provider-visible `execute` with static `code.search/describe/run/save/call`, replay/saved revisions and shared capability invocation. The integration is not committed at HEAD yet (verified 2026-10-13: no `code-mode.ts` deletion tree-wide; `src/code/` untracked), so product docs must not present it as shipped HEAD behavior without an in-flight marker. | `git ls-tree HEAD` + untracked listing 2026-10-13; consolidated register | high | yes, state-qualified | README + code architecture | cross-checked 2026-10-13 |
| OF-DIFF-015 | Expanded high-level tool portfolio / lazy brokerage | `packages/opencode/src/tool/*` including project/symbols/test/typecheck/refactor/git/find/patch/archive/background/browser/checkpoint/session/swarm/sqlite/json/sympy/web-search | stock tool set | committed + tracked-dirty + some untracked gateway work | Fork provides semantic code-navigation/testing/data/browser/orchestration tools and compact/lazy exposure rather than only stock low-level tools. | committed added tool census + registry/broker audit | high | yes | README + tool reference/map | cross-checked |
| OF-DIFF-016 | Built-in browser / visual observation / existing-Chrome bridge | `packages/browser-visual`, desktop browser authority, browser tool family, `extensions/chrome` | no equivalent integrated upstream product subsystem | committed + tracked-dirty | Electron-main logical tab authority, `<webview>`, CDP, human/agent arbitration, annotations/recording/viewport, SnapEye/SnapDOM/SnapDiff and an existing-Chrome lane. | browser-visual/extension/tool tree absence upstream + desktop audit | high | yes | README + desktop/browser architecture | cross-checked |
| OF-DIFF-017 | Provider/account routing / quota / usage / capacity | `packages/opencode/src/{provider,quota,capacity}`, `packages/core/src/usage`, route/account schemas/UI | upstream has provider quota/rate-limit concepts and hosted Console quota, but not this local stack | committed + tracked-dirty | Local multi-account route intent/retry authority, quota adapters, usage ledger, Limits/capacity projections and account-aware model selection. | provider lane; 20 quota + 8 usage + 5 capacity committed files absent upstream | high | yes | README + new provider/quota architecture docs | cross-checked |
| OF-DIFF-018 | Desktop sidecar/runtime/native authority | `packages/desktop/src/main`, preload/renderer seams, updater/sidecar/OXP/browser | upstream Electron ancestry | committed + tracked-dirty + untracked helpers | Hardened sidecar/process lifecycle, native browser/OXP authority, runtime refresh, background CLI, fork update/release ownership and desktop orchestration. | desktop audit + desktop architecture | high | yes | README + desktop architecture | cross-checked |
| OF-DIFF-019 | Mobile / PWA | `packages/mobile`, app PWA host/routes | no `packages/mobile` comparator subtree | committed | Thin independently hosted PWA over shared app runtime with pairing, push/deep links, OFXP identity pinning, replay-first reconnect and bounded render/event work. | 39 committed package files vs 0 upstream; mobile/map docs | high | yes | README + surfaces | cross-checked |
| OF-DIFF-020 | Event replay / sync repair / concurrency performance | server event serializers/replay, app global/directory sync, timeline projection/reconciliation, bounded fanout | upstream event/app substrate | committed + tracked-dirty + untracked performance helpers | Replay-aware SSE, explicit gap repair, count+byte bounds, exact routing, incremental projections and bounded expensive work for many concurrent Sessions. | performance closeouts + server/app diffs | high | yes | README performance + architecture | cross-checked |
| OF-DIFF-021 | Persistence / search / filesystem / database expansion | `packages/core/src/{database,search,filesystem,session}`, host project/storage/runtime ownership | upstream local substrate | committed + tracked-dirty + untracked | Substantially expanded durable state/migrations, search/indexing, watchers/session search/projection, runtime ownership and orchestration storage. | Core database 155 files vs 47 comparator; live source census | high | yes, summarized | architecture + package map | cross-checked |
| OF-DIFF-022 | Plugin / MCP / skill / config / security lifecycle | `packages/opencode/src/{plugin,mcp,skill,config}`, `packages/core/src/plugin`, capability/permission seams | upstream plugin/MCP/skill framework | committed + tracked-dirty + untracked | Fork changes startup/runtime entry handling, account/model hooks, MCP exact identity/invocation, external-agent authority and capability exposure. Do not mislabel upstream MCP resource or skill traversal semantics as wholly fork-new. | plugin/MCP audit corrected against comparator | high | yes, summarized | architecture/reference | cross-checked |
| OF-DIFF-023 | WakaTime first-party telemetry | `packages/opencode/src/wakatime`, Core activity/attribution services, settings/API | no first-party OpenFork exporter | committed | Process-global opt-in exporter with restart-persistent project budget and distinct OpenFork/OXP/OFXP attribution while preserving an explicit external compatibility contract. | WakaTime paths absent upstream; compatibility-boundary doc | high | yes | README + architecture | cross-checked |
| OF-DIFF-024 | System One / Jev | `packages/llm/src/system-one.ts`, `packages/opencode/src/system-one`, API/SDK + Jev doc | upstream hosted Console/Zen donor behavior, no OpenFork local host surface | committed + tracked-dirty docs | Typed non-chat semantic inference primitive with explicit provider/account routing and fail-closed separation from conversational model selection. | System One architecture + route/provider paths | high | yes | README + Jev architecture | cross-checked |
| OF-DIFF-025 | CI / build / release / generated-code governance | `.github/workflows`, build/release scripts, workspace manifest, SDK generators, fork-sync/prune | upstream has a much broader workflow/release/generated-code topology | committed + tracked-dirty | OpenFork reduces the upstream workflow topology from 27 workflows to 3 at committed HEAD (26 deleted, `unlock.yml` retained, `ci.yml` + `dev-pre-release.yml` added), uses owner-gated homelab CI, fork-owned release packaging, an explicit workspace allowlist, and fork sync/prune automation. Current CI runs lint/typecheck plus focused suites rather than the full fork test surface, and upstream's separate generated-code enforcement workflow has no committed replacement. Committed HEAD also still uses floating major action tags and workflow-wide `contents: write` in dev-pre-release; tracked-dirty work SHA-pins actions and narrows permissions, so those hardenings must not be documented as shipped yet. | direct workflow/manifests diff + independent build/release verifier | high | yes, developer-facing | contributing/build/release docs | verifier found material completeness corrections |
| OF-DIFF-026 | Session limit recovery | untracked `schema/src/session-limit-recovery.ts`, Core migrations/domain, host runner/routes, app shelf/context, tests | absent upstream and absent committed HEAD | untracked + tracked-dirty wiring | New durable recovery domain for provider/usage limit waits and resumable Sessions. It is live worktree behavior, not a shipped committed feature yet. | 4+ untracked migrations/domain/routes/tests; dirty API/SDK wiring | high | no until state is explicit | plan/architecture; later README if shipped | cross-checked |
| OF-DIFF-027 | Saved Code admission / share cleanup / durable tool output | untracked Code admission + migrations `saved_code_admission`, `share_cleanup*`, `session_tool_output` | absent upstream/HEAD | untracked + tracked-dirty generated schema | Adds trust/admission and cleanup/output persistence needed by the in-flight Code architecture. | snapshot meaningful-source list + live schema diffs | high | no, fold into Code when shipped | Code/persistence architecture | cross-checked |
| OF-DIFF-028 | Durable sidecar auto-accept + execution-scoped permission policy | untracked `packages/opencode/src/permission/auto-accept-policy.ts`; dirty V1 permission/config/schema seams; committed app auto-accept/default UX tests | upstream already has client auto-respond/session-lineage helpers and durable V2 `PermissionSaved` action/resource grants, but not this sidecar-owned location/session-lineage policy or `run` execution-scope reply | mixed: committed UI ancestry/coverage + untracked policy owner + tracked-dirty enforcement/schema | The fork's in-flight delta is **not auto-accept as a wholly new concept**. It moves durable auto-accept authority into the sidecar, persists location/session choices in `permission-auto-accept.json`, adds execution IDs and a `run` reply whose approvals are bounded to one execution, preserves explicit session OFF over broader ON, and migrates deprecated `execute` permission config to `code`. This materially changes the practical permission boundary and remains security-relevant in-flight work. | direct HEAD/comparator reads of app auto-respond + `PermissionSaved`; dirty schema/config/enforcement diff; live policy source | high on distinction; final authority verifier pending | no in-flight policy as shipped; security/state note required | permission/security reference | corrected for upstream ancestry; final verifier pending |
| OF-DIFF-029 | Diagnostics support bundle | untracked Core diagnostics + CLI debug command/tests | absent upstream/HEAD | untracked | First-party support-bundle generation/CLI surface for diagnostics. | `core/src/diagnostics/support-bundle.ts`, `opencode/src/cli/cmd/debug/support-bundle.ts` + tests | high | later, if shipped | troubleshooting/reference | cross-checked |
| OF-DIFF-030 | Everything-backed path search | COMMITTED `packages/core/src/search/everything.ts` (4c138aa6) + `mention-fast.ts`, `packages/core/src/filesystem/search-policy.ts`, 4+ committed tests (`search-everything*.test.ts`, `search-differential-parity.test.ts`); UNTRACKED 8 bench harnesses (`core/script/everything-bench/*`, `test/bench-everything-endtoend.ts`) | absent upstream/HEAD | committed + untracked bench | Windows path-search/index integration; provider committed at `96371fcce5` (Everything SDK3 candidate + Phase 4 HOLD); bench/integration sweep still in-flight. | `git ls-tree HEAD` blobs above; `docs/plans/everything-path-search-architecture.md`; consolidated register `docs/plans/OPENFORK_CONSOLIDATED_DELTA_REGISTER_2026-10-13.md` | high (committed part) / medium (bench) | no until integration ships | search architecture | cross-checked 2026-10-13 |
| OF-DIFF-031 | Live app UX additions | untracked OXP chat-sidebar model/section/tree, command catalog, notification Session, enhanced new-session, timeline row/progressive-detail helpers, accessibility harness | absent upstream/HEAD in these forms | untracked + tracked-dirty | Current worktree adds new OXP/session navigation and large-timeline/accessibility mechanisms beyond committed app behavior. | snapshot 27 app paths + tests | medium-high | no until shipped | app/session docs after convergence | pending integration verification |
| OF-DIFF-032 | Live session rendering / Code presentation | untracked `session-ui` Code tool UI/model, large-Markdown worker/fragments/presentation, background monitor, tool-output XML + TUI trace presentation | absent upstream/HEAD in these forms | untracked + tracked-dirty | New rendering/projection layer for Code traces, large Markdown and background work; accompanies in-flight runtime changes. | snapshot 19 session-ui + 2 TUI paths | medium-high | no until shipped | session-ui/tool docs | pending integration verification |
| OF-DIFF-033 | Live desktop reliability helpers | untracked background CLI health, OXP runtime-state/dispatch projections, store write queue + tests | absent from committed HEAD | untracked + tracked-dirty integration | Adds process/health/state/write-serialization mechanisms to desktop lifecycle; currently in-flight. | snapshot 8 desktop source/test paths | medium-high | no until shipped | desktop architecture | pending integration verification |
| OF-DIFF-034 | App / session-ui / shared-UI product surface | `packages/app`, `packages/session-ui`, `packages/ui` outside narrower Goal/quota/browser/mobile/sync families | comparator carries the upstream app/session/shared-UI baseline but not OpenFork's full product composition | committed + tracked-dirty | Large committed presentation/product divergence spanning workspace/session UX, composer/history, settings, navigation, model/session presentation, streaming Markdown/tool rendering, shared visual primitives, tests and performance harnesses. Narrower semantic owners remain mapped to their dedicated families; this family is the residual first-party application/presentation portfolio rather than a claim that every app byte is greenfield. | snapshot path maps: 763 committed + 69 tracked-dirty paths; commit history includes app/session-ui/UI integration and branding/performance commits | high | yes, summarized | README + app/surfaces/package maps | cross-checked |

## Coverage reconciliation

Snapshot `2026-10-05-012455` now has complete path/history reconciliation artifacts.
`Classified` includes both paths assigned to a semantic `OF-DIFF-*` family and paths explicitly
classified as non-product/generated/audit evidence; the status column preserves that split.

| Universe | Total | Classified | Unexplained | Status |
| --- | ---: | ---: | ---: | --- |
| Committed rename-aware path delta | 5685 | **5685** | **0** | 5352 → `OF-DIFF-*`; 333 explicit non-product/docs-evidence |
| — of which deleted/pruned/negative | 1875 | **1875** | **0** | all represented in the committed family map, including negative-space families |
| — of which renamed/replaced | 54 | **54** | **0** | all represented in the committed family map |
| Tracked unstaged delta | 354 | **354** | **0** | 344 → `OF-DIFF-*`; 10 explicit non-product/docs-evidence |
| Staged delta | 0 | 0 | 0 | **closed — explicit zero** |
| Untracked paths | 9329 | **9329** | **0** | 9164 explicit non-product/debris; 165 meaningful paths assigned to `OF-DIFF-*` |
| Semantic/non-path families | open-ended | **34 canonical candidates** | verifier sweep pending | normalized from lane + parent evidence; `OF-DIFF-034` closes the broad committed app/session-ui/ui residual |
| Fork-only commits | 452 | **452** | **0** | 426 mapped to live semantic diff; 26 explicit no-net-diff/superseded history |
| Upstream development drift | 0 | 0 | 0 | **closed — HEAD contains comparator** |

**Raw path-level universe at this snapshot: 15,368 items** (5685 committed + 354 unstaged +
9329 untracked), with **0 unexplained path-level items**. Deleted, renamed and commit-history axes
are subsets/cross-cuts, not additive to that arithmetic. Reconciliation artifacts are
`committed-family-map.tsv`, `dirty-family-map.tsv`,
`untracked-meaningful-family-map.tsv`, `untracked-classification.tsv`,
`fork-commit-family-map.tsv`, and `reconciliation-summary.txt` in the snapshot directory.

### Live drift after snapshot

A fresh parent census after the OXP restart still had the same committed HEAD/comparator delta but
had moved to **359 unstaged / 0 staged / 9346 untracked**. Relative to the immutable snapshot:

- the five new dirty paths are three Native-Swarm implementation/test paths
  (`packages/core/src/swarm/runtime.ts`, `packages/core/test/swarm/runtime.test.ts`,
  `packages/opencode/src/swarm/task-retirement.ts`) → `OF-DIFF-010`, plus two
  `session-ui` Markdown-visibility source/test paths → `OF-DIFF-034`;
- the 17 new untracked paths are the newly emitted reconciliation/snapshot evidence files,
  one performance-evidence JSON, and `.tmp-oxp-retirement-inspect.ts` probe debris.

That live delta introduces **no newly unexplained semantic path**, but it is not a substitute for
the required final immutable snapshot because concurrent work remains active.

### Coordinator re-verification and second drift pass

Coordinator-side independent re-derivation of snapshot `2026-10-05-012455` confirmed all four
reconciliation axes exactly (5352+333=5685, 344+10=354, 9164+165=9329, 426+26=452), with symmetric
difference **0** between each path list and its family map. The snapshot's `path_level_unexplained=0`
is supported by the artifacts, not merely asserted. File-shape warning for downstream lanes:
`committed-family-map.tsv` is 3-column (`status`,`family`,`path`) while `dirty-family-map.tsv` and
`untracked-meaningful-family-map.tsv` are 2-column (`family`,`path`); none has a header row.

Committed and history axes are stable across re-measurement (5685 / 452 / HEAD `1d96902911`). The
in-flight axes continue to move: **387 unstaged / 0 staged / 9357 untracked**, i.e. **+33 unstaged**
and **+28 untracked** against the snapshot, with **0 removals on either axis**.

Of the 28 new untracked paths, 27 are audit evidence or probe debris (20 snapshot files, 6 dated perf
JSONs, `.tmp-oxp-retirement-inspect.ts`) and one is real source
(`packages/ui/src/theme/syntax-theme.test.ts` → `OF-DIFF-034`). The **33 new unstaged paths are new
in-flight product surface** and were reconciled into existing families without creating a new family:
6 → `OF-DIFF-010` (Native Swarm), 1 → `OF-DIFF-013`, 2 → `OF-DIFF-021`, 2 → `OF-DIFF-025`,
6 → `OF-DIFF-032`, 16 → `OF-DIFF-034`. All are tracked-dirty and must not be documented as released
HEAD behavior.

Full evidence: `docs/plans/openfork-upstream-differences/coordinator-drift-reconciliation-2026-10-05.md`.

## Documentation gate

**BLOCKED.** Do not treat README/MAP/reference documentation as complete, and do not begin the
comprehensive marketing/documentation rewrite, until this ledger's coverage reconciliation has zero
unexplained meaningful divergences and omission verifiers A/B/C have independently passed.

Blocking conditions still unmet:

1. **Independent verifier passes: 1 of 3 (Verify-A PASS 2026-10-09; Verify-C FAIL/semantic).**
   OF-DIFF-030/014 staleness partially resolved 2026-10-13 (see rows + consolidated register
   `docs/plans/OPENFORK_CONSOLIDATED_DELTA_REGISTER_2026-10-13.md`); OF-DIFF-025 re-bucket and
   OF-DIFF-005 zero-rows rewrite still open. Coordinator verification this pass found no verifier
   artifact anywhere under `docs/plans/openfork-upstream-differences/`. The verifier lane Sessions
   observed (`ses_ef7875158ffejckvFo1g664lWX`, `ses_ef7876d4affef4xRxApDUFWcqT`) are `idle` with
   orientation-only last messages and no recorded verdict. Per-entry states remain mixed:
   `OF-DIFF-030`/`-031`/`-032`/`-033` read `pending integration verification` and `OF-DIFF-028` reads
   `final verifier pending`. A queued or resumed verifier is not a passing verifier.
2. Path/history reconciliation is closed and independently re-verified for snapshot
   `2026-10-05-012455`, and subsequent live drift has been reconciled by the coordinator, but the
   final gate must still be recomputed against a fresh timestamped snapshot taken after the verifiers
   complete, because the working-tree axes are actively moving (+33 unstaged / +28 untracked this pass).
3. Product docs currently mix committed product truth with tracked-dirty/untracked future state
   (most visibly the new `code` architecture). The rewrite must label that boundary rather than
   marketing worktree-only behavior as released HEAD behavior.

Required next actions, in order:

1. Complete the remaining independent omission/security/product-truth verifier passes against the
   reconciled 34-family inventory.
2. Recompute a final fresh snapshot and require zero unexplained meaningful paths/history.
3. Only after those gates pass, finish README, `docs/map/*`, and architecture/reference rewrites
   from the evidence-backed portfolio, clearly separating committed/released behavior from in-flight
   worktree state.

Mandatory lane rules: raise `-c diff.renameLimit=100000` on every diff; never reset, stash, clean,
restore, broadly checkout, rebase away, stage, commit, mass-format, or overwrite unrelated work;
collapse a generated directory only after every constituent path is individually accounted for.
