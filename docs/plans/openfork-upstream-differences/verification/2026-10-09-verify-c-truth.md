# Verify-C — independent state-truth and documentation-integrity verification (2026-10-09)

Verifier: Swarm member `verify-c-truth`, swarm `openfork-upstream-diffs-completion-2026-10-09`
(task `swt_b_880b3587054140eeb315cdcdb5edde2e3d2b9dee`). Read-only pass. No reset/stash/clean/
restore/rebase/checkout/stage/commit/mass-format, no swarm-state mutation, no peer messages sent.
Raw evidence: `verification/tmp-c/status-uall-2026-10-09.txt` (10,396 lines),
`verification/tmp-c/committed-delta-2026-10-09.txt` (5,699 lines).

## 0. Live baseline (measured, not copied from prior censuses)

| Measure | Ledger / snapshot / drift doc | Live 2026-10-09 | Verdict |
| --- | ---: | ---: | --- |
| HEAD | `1d96902911` | **`95543517ae`** | moved |
| New commits since realignment | 0 | `96371fcce5`, `4f15d3ccf8`, `95543517ae` | moved |
| Comparator | `aec0b9a6d88` | `aec0b9a6d88` | holds |
| Committed rename-aware delta | 5685 | **5699** | stale |
| — added / deleted / modified / renamed | 2765 / 1875 / 991 / 54 | **2779 / 1875 / 991 / 54** (sum 5699) | A stale |
| Fork-only commits | 452 | **455** | stale |
| Staged | 0 | **0** | holds (explicit zero) |
| Unstaged (tracked-dirty) | 354 (snap) / 387 (drift) | **719** | stale |
| Untracked | 9329 (snap) / 9357 (drift) | **9677** | stale |
| Unstaged deletions (` D`) | not tracked | **0** | new fact |

Commands: `git rev-parse HEAD`; `git log --oneline -8`;
`git -c diff.renameLimit=100000 diff --name-status aec0b9a6...HEAD`;
`git status --porcelain -uall`; `git rev-list --count aec0b9a6..HEAD`;
`git cat-file -e HEAD:<path>`.

## 1. Stale-state table — in-flight families 014, 026–034

| ID | Ledger state label | Live state at `95543517ae` | Verdict | Evidence |
| --- | --- | --- | --- | --- |
| OF-DIFF-014 | tracked-dirty + untracked (core product integration); evidence: "tracked `code-mode.ts` deletion + untracked Code integration" | **Label holds; evidence sub-claim is stale.** Integration all-untracked: `?? packages/opencode/src/code/{error,execution,input-admission,prepared,revision,run,saved-capability,saved,schema,service}.ts`, `?? packages/opencode/src/exchange/code.ts`, `?? packages/opencode/src/tool/code.ts`, `?? packages/opencode/src/tool/capability.ts`, `?? packages/opencode/src/session/capability-invocation-{gateway,limits}.ts`, `?? packages/opencode/src/exchange/capability-search.ts`, `?? packages/core/src/code/admission{,.sql}.ts`. `packages/codemode` 8 files ` M` (tracked-dirty). **`packages/opencode/src/tool/code-mode.ts` EXISTS at HEAD** and is ` M` in the worktree; **zero ` D` deletion entries exist anywhere in the tree**; `tool/execute.ts` was never at HEAD. | label OK / evidence STALE | `git status --porcelain -uall`; `git ls-tree HEAD --name-only packages/opencode/src/tool/`; `git cat-file -e HEAD:packages/opencode/src/tool/code-mode.ts` → exists |
| OF-DIFF-026 | untracked + tracked-dirty wiring | **Holds, with scope growth.** All listed paths untracked: `?? packages/schema/src/session-limit-recovery.ts`, `?? packages/schema/test/session-limit-recovery.test.ts`, `?? packages/core/test/session-limit-recovery.test.ts`, `?? packages/opencode/src/server/routes/instance/httpapi/{groups,handlers}/session-limit-recovery.ts`. Wiring is tracked-dirty: ` M packages/opencode/src/server/routes/instance/httpapi/{api.ts,server.ts}`, ` M packages/opencode/src/session/{processor.ts,prompt.ts}`, ` M packages/opencode/src/server/routes/instance/httpapi/handlers/session-control.ts`, ` M packages/schema/src/event-manifest.ts`, ` M packages/sdk/js/src/v2/gen/sdk.gen.ts` (worker imports confirmed by content grep). New unlisted untracked app surface: `?? packages/app/src/context/limit-recovery.tsx`, `?? packages/app/src/components/limit-recovery-composer-shelf.tsx` (+test). | holds | `git status --porcelain`; working-tree content grep `session-limit-recovery\|sessionLimitRecovery` (28 matches) |
| OF-DIFF-027 | untracked + tracked-dirty generated schema | **Holds.** `?? packages/core/src/database/migration/20261003223630_saved_code_admission.ts`, `?? .../20261003233000_share_cleanup.ts`, `?? .../20261003233100_share_cleanup_route.ts`, `?? .../20261003233200_share_cleanup_ready.ts`, `?? .../20261005022342_session_tool_output.ts`; generated seam ` M packages/core/src/database/schema.gen.ts`, ` M packages/core/schema.json`; Code admission `?? packages/core/src/code/admission{,.sql}.ts`. | holds | same status snapshot |
| OF-DIFF-028 | mixed: committed UI ancestry + untracked policy owner + tracked-dirty enforcement/schema | **Holds.** `?? packages/opencode/src/permission/auto-accept-policy.ts`. Dirty seams: ` M packages/core/src/v1/config/{permission,migrate,config}.ts`, ` M packages/opencode/src/permission/index.ts`, ` M packages/opencode/src/config/config.ts`, ` M packages/opencode/src/server/routes/instance/httpapi/groups/permission.ts`, ` M packages/schema/src/v1/permission.ts`, ` M packages/app/src/context/permission{,-auto-respond}.ts(x)` (+tests). `packages/app/src/context/permission-auto-respond.test.ts` **EXISTS at HEAD**. | holds | `git status --porcelain`; `git cat-file -e HEAD:...permission-auto-respond.test.ts` |
| OF-DIFF-029 | untracked | **Holds.** `?? packages/core/src/diagnostics/support-bundle.ts`, `?? packages/opencode/src/cli/cmd/debug/support-bundle.ts`, `?? packages/core/test/diagnostics/support-bundle.test.ts`, `?? packages/opencode/test/cli/debug-support-bundle.test.ts`. | holds | status snapshot |
| OF-DIFF-030 | untracked + tracked-dirty integration; "still in-flight"; verification "pending integration verification" | **STALE — now committed at HEAD.** Commit `96371fcce5` committed: `packages/core/src/search/everything.ts` (1415 lines, new), `packages/core/src/filesystem/search-policy.ts` (new), `packages/core/src/filesystem/search.ts` (modified), `packages/core/src/search/mention-fast.ts` (new), 4 tests (`search-everything{,-generation,-ipc}.test.ts`, `search-differential-parity.test.ts`), and `docs/plans/everything-path-search-architecture.md` (2729 lines, whose line 1601 reads "**Phase 4 promotion status: HOLD.**" and line 1640 "…Phase 4 remains HOLD."). Still untracked: 8 bench harnesses `?? packages/core/script/everything-bench/*.ts` (7) + `?? packages/core/test/bench-everything-endtoend.ts`. Correct current label: **committed (provider/tests/architecture) + untracked benches + tracked-dirty search integration** (` M packages/core/src/search/index-service.ts`, ` M packages/core/src/session/search{,-text}.ts`, search tests). | **STALE** | `git log -3 --stat`; `git cat-file -e HEAD:packages/core/src/search/everything.ts` → exists; status snapshot |
| OF-DIFF-031 | untracked + tracked-dirty; evidence "snapshot 27 app paths + tests" | **Label holds; count stale.** 44 untracked app paths (sample matching the family: `?? packages/app/src/pages/session/v2/chat-sidebar-oxp-{model.ts,section.tsx,tree.ts}`, `?? packages/app/src/context/global-sync/command-catalog.ts`, `?? packages/app/src/context/notification-session.ts(x)`, `?? packages/app/src/pages/new-session-enhanced.tsx`, `?? packages/app/src/pages/session/timeline/{row-index,progressive-detail-fence}.ts`, `?? packages/app/e2e/utils/accessibility/*`) + 137 ` M` app files. | label holds / count stale | status snapshot |
| OF-DIFF-032 | untracked + tracked-dirty; "snapshot 19 session-ui + 2 TUI paths" | **Label holds; count moved.** 24 untracked session-ui paths (incl. `code-tool-model.ts`, `code-tool.tsx`, `tool-output-xml.ts`, `markdown-large-*.ts`, `background-monitor-presentation.ts`, `lazy-tool*.tsx`) + 27 ` M` session-ui files; TUI: `?? packages/tui/src/util/code-trace-presentation.ts` (+test), ` M packages/tui/src/routes/session/index.tsx`. | label holds / count stale | status snapshot |
| OF-DIFF-033 | untracked; "snapshot 8 desktop source/test paths" | **Label holds; scope grew to 12.** Untracked: `?? packages/desktop/src/main/background-cli-health.ts`, `oxp-state-dispatch.ts`, `oxp/runtime-state-projection.ts`, `store-write-queue.ts` (+4 tests) **plus unlisted** `?? packages/desktop/src/main/sidecar-readiness.ts`, `sidecar-request-lifetime.ts` (+2 tests). Dirty integration: ` M packages/desktop/src/main/background-cli.ts`, ` M packages/desktop/src/main/{store,ipc,index}.ts`, oxp runtime-refresh/tunnel-health/supervisor. Remainder of desktop untracked set is `dist-dev*`/`dist-patched` build debris (classification unchanged). | label holds / count stale | status snapshot |
| OF-DIFF-034 | committed + tracked-dirty; evidence "763 committed + 69 tracked-dirty paths" | **Label holds; counts stale.** Committed portfolio intact; dirty universe now: app 137 ` M` + 44 `??`; session-ui 27 ` M` + 24 `??`; ui 12 ` M` + 1 `??` (`syntax-theme.test.ts` still untracked). | label holds / count stale | status snapshot |

**Stale labels to correct:** OF-DIFF-030 state + evidence + verification column (primary);
OF-DIFF-014 evidence sentence (secondary); OF-DIFF-031/032/033/034 evidence counts (tertiary).

## 2. Documentation-integrity findings (gate condition 3: worktree state presented as released)

Product docs are themselves worktree-dirty here (` M README.md`, ` M FORK.md`, all `docs/map/*.md`, ` M docs/architecture/code-mode.md`); findings are quoted from the working-tree text as shipped today, with git state attached.

1. **`README.md:75` (worktree; row absent at HEAD)** — claims the in-flight Code contract as a shipped product row:
   `| **Code orchestration** | Contains the `packages/codemode` interpreter and the older `execute` integration | Fork-owned static `code` contract with search/describe/run/save/call, compressed capability brokerage, replay/saved revisions, and native/ACP/OXP/OFXP projections |`
   `git diff -- README.md` shows this row is an uncommitted worktree addition; `git show HEAD:README.md` contains no "Code orchestration" row; every implementation path behind the claim (`packages/opencode/src/code/*`, `tool/code.ts`, `exchange/code.ts`, `tool/capability.ts`, `session/capability-invocation-*`) is `??` untracked. Presents worktree-only behavior as released.
2. **`docs/map/surfaces.md:15` (row absent at HEAD)** — lists an untracked file as a native surface:
   `| Code tool / Code Mode | `packages/opencode/src/tool/code.ts` + `packages/codemode` | Native tool invocation gateway | Search, describe and invoke eligible tools under host-provided authority; a searchable entry alone is not an executable guarantee. |`
   `packages/opencode/src/tool/code.ts` is `??` untracked; `packages/codemode` is tracked-dirty. A native-tool surface row for a path that does not exist at HEAD.
3. **`docs/architecture/code-mode.md:3` and `:33-34` (tracked-dirty, 370 insertions / 90 deletions vs HEAD)** — marks uncommitted architecture as adopted with no in-flight marker:
   `> Status: **adopted OpenFork architecture**.` … `The former provider tool named `execute` is retired. OpenFork never exposes `execute` and `code` together.`
   The described static contract (`code.search/describe/run/save/call`, lines 18–22, 42–50) exists only in the untracked worktree tree listed in §1/OF-DIFF-014. HEAD's version of the same doc instead describes the upstream `@opencode-ai/codemode` default path; `tool/code-mode.ts` still exists at HEAD.
4. **`docs/map/README.md:63` (link absent at HEAD)** — map index links to an untracked document:
   `- [Agent Experience: ranked capability discovery and Code Mode parity](../architecture/ax-capability-discovery.md)` — `docs/architecture/ax-capability-discovery.md` is `??` untracked, so the committed map at HEAD has no such entry and the linked target is not shipped.
5. **Inverse direction — `FORK.md:240` at HEAD retains removed Goal policy language** (worktree `FORK.md:240` fixes it, uncommitted):
   HEAD text: `…until independent verification reaches a terminal Goal state, the Goal is explicitly paused/cancelled, execution is explicitly interrupted, or an explicitly configured continuation bound is reached…` and `…`blocked` uses semantic hysteresis…`
   Committed `AGENTS.md:16-30` and `AGENTS.md:223` (Goal Mode intrinsic-autonomy invariant) forbid exactly these ("no continuation mode … blocked-streak/hysteresis"; migration `20261003023542_goal_intrinsic_autonomy.ts`). `docs/architecture/goal-mode.md:78-88` correctly lists them under "What does not exist". Net: HEAD-shipped FORK.md states removed policy as normative; the converging fix is worktree-only.
6. **Observation (not a product-truth claim, for doc lanes):** the repository guide (`AGENTS.md`, dirty) and session-injected guides reference `docs/architecture/tool-surface-parity.md` and `docs/architecture/oxp-native-tool-parity.md`, both `??` untracked in this worktree — guide-to-artifact mismatch to settle before the doc rewrite cites them.

Checked and cleared: `docs/map/architecture.md:223` code-mode.md reference exists at HEAD; `docs/map/packages.md:41` codemode row refers to the upstream-inherited package committed at HEAD; FORK.md has no Code/Everything/support-bundle claim.

## 3. Ledger-accuracy findings

1. **Swarm existence (decisive contradiction; observation only).** Ledger `OPENFORK_UPSTREAM_DIFFERENCES_LEDGER_2026-10-04.md:51-73` asserts, without an as-of bound on the decisive sentence: "There is therefore no swarm, no roster, and no peer output to supervise. No convergence is in flight." and `coordinator-drift-reconciliation-2026-10-05.md` §3 repeats "`swarm action=list` still shows no `openfork-*-difference-*` swarm; the roster narrative in earlier ledger revisions remains unbacked."
   Observed 2026-10-09 via `swarm_member status` (no mutation): this verifier is a **live member** of native swarm **`openfork-upstream-diffs-completion-2026-10-09`** (role: independent state-truth and documentation-integrity verifier), with **4 working tasks** and this TaskRun (`swt_b_880b3587054140eeb315cdcdb5edde2e3d2b9dee`) in `running`/`taskAuthority: running` state. The host swarm list additionally reports **`swr_efad92135ffe4RAWwEB9KqeK33` — `openfork-full-upstream-difference-inventory-2026-10-03`, 30-member roster (coordinator + `inv01`…`inv29`), many tasks in ready/working/review_pending** — the exact swarm the 2026-10-04 revision declared nonexistent and structurally malformed. The 2026-10-04 observation may have been true then; as timeless claims they are now false, and the "0 of 3 verifiers / no verifier artifact anywhere" gate text is likewise superseded by this pass.
2. **Machine-coverage headline numbers are snapshot-relative and stale** (§0 table): committed delta 5699 vs 5685, A 2779 vs 2765, fork-only commits 455 vs 452, unstaged 719 vs 387, untracked 9677 vs 9357; staged 0 and upstream-drift 0 still hold. Every "closed / 0 unexplained" row remains true only for snapshot `2026-10-05-012455` and the two later censuses — consistent with the ledger's own warning (`:307-310`) that the gate must be recomputed against a fresh timestamped snapshot; the headline table does not carry that caveat.
3. **OF-DIFF-014's evidence sentence is no longer reproducible** (`code-mode.ts` deletion; zero deletions tree-wide, file present at HEAD) — see §1.
4. **Cross-artifact consistency:** `PROTOCOL.md:37` vocabulary and ledger `:28` remain consistent; no contradiction found there.

## 4. Overall verdict: **FAIL**

- Label accuracy: **2 stale labels** (OF-DIFF-030 primary; OF-DIFF-014 evidence secondary) + 4 stale evidence counts (031/032/033/034).
- Documentation gate condition 3: **violated** — 5 findings (4 worktree-as-released: README.md:75, docs/map/surfaces.md:15, docs/architecture/code-mode.md:3/:33-34, docs/map/README.md:63; 1 inverse: FORK.md:240@HEAD removed-policy language).
- Ledger accuracy: **1 decisive contradiction** (live 30-member roster + this completion swarm vs "no swarm, no roster … no convergence is in flight") + stale census headline.

Consequence per PROTOCOL.md:51-53 and the ledger's Documentation gate — README / `docs/map/*` / architecture-reference rewrites remain **BLOCKED** until the OF-DIFF-030/014 labels are corrected, the doc claims above are either committed or in-flight-marked, and a fresh timestamped snapshot is taken after the verifiers settle.
