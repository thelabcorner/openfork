# Verify-A — independent committed/history universe re-derivation and omission falsification

- Verifier lane: A (committed + history axes)
- Date: 2026-10-09
- Method: first-hand git re-derivation in `/webstormprojects/opencode`; no prior summary or
  coordinator claim was trusted. Every number below was recomputed from git and from the
  snapshot artifacts during this pass.
- Scope note: this lane covers the **committed rename-aware delta** and the **fork-commit
  history** axes only. Working-tree axes (unstaged / untracked) are other lanes' territory; a
  drift census is recorded in §7 for context only.

## 1. Overall verdict

**PASS** — the reconciled `path_level_unexplained = 0` claim on the committed and history axes
**could not be falsified** at the current tree. My independent re-derivation reproduces every
snapshot count exactly, extends the universe by exactly the 14 new committed paths from the three
post-snapshot commits, and every one of those paths is assignable to an existing OF-DIFF family
(or the explicit non-product bucket) with semantic justification. The rename-limit trap is
demonstrated live.

However, the adversarial sample in §5 **does** find real, reproducible **semantic mislabeling**
(6 discrepancy classes, including 548/671 rows of one family that contradict that family's own
ledger description, and one ledger family — OF-DIFF-005 — that claims committed paths while having
**zero** rows in all three maps). These are mis-explained, not unexplained: the mechanical
zero-unexplained claim survives, but the semantic accuracy of the reconciliation needs a repair
pass before the ledger text can be treated as truth. Verdict is PASS for the universe claim, with a
mandatory follow-up register in §6.

## 2. Git identity (step 1)

```
> git rev-parse HEAD
95543517ae1a92780a68c96da62ca447d010adff

> git merge-base HEAD aec0b9a6d8898f68f923aaf08b7306d931fd9d76
aec0b9a6d8898f68f923aaf08b7306d931fd9d76        # equals the comparator -> HEAD contains it

> git log --oneline HEAD..aec0b9a6d8898f68f923aaf08b7306d931fd9d76 | Measure-Object -Line
0                                                # upstream drift == 0
```

Upstream drift axis is **closed at zero**, first-hand.

## 3. Committed rename-aware delta (step 2)

Commands (both, to demonstrate the rename-limit effect of step 5):

```
git -c diff.renameLimit=100000 diff --name-status aec0b9a6d8898f68f923aaf08b7306d931fd9d76..HEAD
git diff --name-status aec0b9a6d8898f68f923aaf08b7306d931fd9d76..HEAD     # NO raised limit
```

| Status | Rename-aware (`renameLimit=100000`) | Default limit (misleading) | Snapshot `1d96902911` |
| --- | ---: | ---: | ---: |
| A | **2779** | 2784 | 2765 |
| D | **1875** | 1880 | 1875 |
| M | **991** | 991 | 991 |
| R | **54** | 49 | 54 |
| **Total** | **5699** | 5704 | **5685** |

Default-limit run emits the expected warning (`exhaustive rename detection was skipped …
renameLimit variable to at least 2784`). The misleading pair is **D=1880 / R=49** vs the correct
**D=1875 / R=54** — exactly the trap documented in the ledger, reproduced from scratch. Any
deletion count produced without the raised limit is wrong by 5 deletions / 5 renames here.

### 3.1 Snapshot arithmetic, independently re-run (step 5)

Re-counted from the snapshot artifacts themselves, not from its summary text:

- `snapshots/2026-10-05-012455/committed-name-status.txt` → 2765 A / 1875 D / 991 M / 54 R =
  **5685** rows. Matches `snapshot-meta.txt` and the ledger table exactly.
- `committed-family-map.tsv` → **5685 rows**, no duplicate paths, 5352 rows with an
  `OF-DIFF-*` label + 333 rows `NONPRODUCT-DOCS-EVIDENCE`. **5352 + 333 = 5685** holds.
- Path-set integrity: symmetric difference between `committed-name-status.txt` path set and
  `committed-family-map.tsv` path set = **0** (every path labelled, no duplicate, no orphans).
- Fork-commit map: **452 rows** = 426 family-mapped + 26 `HISTORY-NO-NET-DIFF` (426 + 26 = 452),
  and `fork-commits.txt` = 452 rows. Both hold.

**Snapshot arithmetic: holds, first-hand.**

### 3.2 New arithmetic at current HEAD `95543517ae`

| Axis | Snapshot `1d96902911` | Current `95543517ae` | Delta |
| --- | ---: | ---: | ---: |
| Committed rename-aware paths | 5685 | **5699** | **+14** (all A; 0 removed) |
| — of which `OF-DIFF-*` | 5352 | **5365** | +13 |
| — of which `NONPRODUCT-DOCS-EVIDENCE` | 333 | **334** | +1 |
| Deletions | 1875 | 1875 | 0 |
| Renames | 54 | 54 | 0 |
| Modifications | 991 | 991 | 0 |
| Fork-only commits | 452 | **455** | +3 |
| — mapped to live semantic diff | 426 | **429** | +3 |
| — no-net-diff/superseded | 26 | 26 | 0 |
| Staged | 0 | 0 | 0 (explicit zero) |
| Upstream drift | 0 | 0 | 0 |

Current map-vs-diff check: symmetric difference between current rename-aware path set and the old
family map = **exactly the 14 new paths** (they are the only rows the old map lacks). No path
disappeared, so **5699 = 5365 + 334 with 0 unexplained at current HEAD** once the 14 are assigned
(below). No duplicate paths in the current diff.

## 4. New paths since the snapshot, assigned to families (step 2/3)

The three post-snapshot commits contribute exactly 14 added paths; their `M` entries
(`packages/core/src/filesystem/search.ts`, `packages/core/src/search/mention-fast.ts`,
`package.json`) are already Added-vs-comparator, so they add no new path and keep M = 991.

`git show --name-status` per commit: 96371fcce5 → 7 A (+2 M); 4f15d3ccf8 → 5 A (+1 M);
95543517ae → 2 A (+0 M). 7 + 5 + 2 = 14.

| New path | Source commit | Family | Justification |
| --- | --- | --- | --- |
| `docs/plans/everything-path-search-architecture.md` | 96371fcce5 | **OF-DIFF-030** | Named verbatim in the ledger's OF-DIFF-030 row; previously untracked, now committed. |
| `packages/core/src/filesystem/search-policy.ts` | 96371fcce5 | **OF-DIFF-030** | OF-DIFF-030 is "Everything-backed path search … search policy/test"; this is the policy module it names. |
| `packages/core/src/search/everything.ts` | 96371fcce5 | **OF-DIFF-030** | Named verbatim in the ledger's OF-DIFF-030 row. |
| `packages/core/test/search-differential-parity.test.ts` | 96371fcce5 | **OF-DIFF-030** | Search-policy differential-parity test for the same feature. |
| `packages/core/test/search-everything-generation.test.ts` | 96371fcce5 | **OF-DIFF-030** | Everything index-generation test. |
| `packages/core/test/search-everything-ipc.test.ts` | 96371fcce5 | **OF-DIFF-030** | Everything IPC test. |
| `packages/core/test/search-everything.test.ts` | 96371fcce5 | **OF-DIFF-030** | Everything unit test. |
| `.github/workflows/experimental-ts-rust-frontier.yml` | 95543517ae | **OF-DIFF-025** | CI workflow; all 32 `.github/workflows*` committed rows in the map are OF-DIFF-025. |
| `packages/core/tsconfig.effect-frontier.json` | 4f15d3ccf8 | **OF-DIFF-025** | Typecheck-harness config; root `tsconfig.json` row precedent is OF-DIFF-025. |
| `packages/opencode/tsconfig.effect-frontier.json` | 4f15d3ccf8 | **OF-DIFF-025** | Same harness family. |
| `script/typecheck-frontier-lib.mjs` | 4f15d3ccf8 | **OF-DIFF-025** | All 30 `script/*` committed rows in the map are OF-DIFF-025. |
| `script/typecheck-frontier.mjs` | 4f15d3ccf8 | **OF-DIFF-025** | Same. |
| `script/typecheck-frontier.test.mjs` | 4f15d3ccf8 | **OF-DIFF-025** | Same. |
| `docs/perf/typecheck-frontier-2026-10-08.md` | 95543517ae | **NONPRODUCT-DOCS-EVIDENCE** | Perf evidence doc; all 11 committed `docs/perf/*` rows in the map are NONPRODUCT-DOCS-EVIDENCE. |

**Consequence for the ledger text:** OF-DIFF-030's state field (`untracked + tracked-dirty`) is now
stale — 7 of its paths are committed at `95543517ae` — and OF-DIFF-025 gains 6 committed rows. No
new family is required; all 14 assignments land inside the existing 34-family taxonomy.

New commit dispositions (fork-commit axis): 96371fcce5 → `OF-DIFF-030` (touches `OF-DIFF-021`
files as secondary); 4f15d3ccf8 → `OF-DIFF-025` (+ `package.json`); 95543517ae → `OF-DIFF-025`
(+ one `NONPRODUCT-DOCS-EVIDENCE` doc). Hence 426 + 3 = **429 mapped**, 26 no-net-diff, 452 + 3 =
**455** total commits — 0 classified as no-net-diff, 0 unclassified.

## 5. Adversarial sample (step 4)

45 path rows were checked against real semantics: the first map row of each of the 25 families
present in the committed map + `NONPRODUCT-DOCS-EVIDENCE` (26), 10 random committed rows, 6 probes
targeting suspicious buckets, and the first untracked-meaningful row of families OF-DIFF-026…033
(8, since those families have no committed rows). Rename rows (54) and a random deletion were
verified against the comparator tree. Verdict column: OK = assignment matches real semantics;
BAD = provably wrong; DUB = defensible but weak/contradicted by the ledger's own text.

| # | Path (status) | Map family | Verdict | Evidence / real semantics |
| --- | --- | --- | --- | --- |
| 1 | `.openfork/.gitignore` (A) | OF-DIFF-001 | OK | Config/storage migration path, exactly 001's scope |
| 2 | `README.ar.md` (D) | OF-DIFF-003 | OK | Translated root README removal (003's stated scope) |
| 3 | `packages/app/e2e/performance/timeline/review-pane-scaling-benchmark.spec.ts` (D) | OF-DIFF-004 | OK | Review-panel removal |
| 4 | `packages/client/src/contract.ts` (M) | OF-DIFF-006 | OK | Protocol/client surface |
| 5 | `docs/architecture/t3code-compatibility.md` (A) | OF-DIFF-007 | OK | T3 Code compatibility doc |
| 6 | `packages/desktop/src/main/oxp/config.test.ts` (A) | OF-DIFF-008 | OK | OXP subsystem |
| 7 | `docs/plans/ofxp-credential-transfer.md` (A) | OF-DIFF-009 | OK | OFXP plan doc |
| 8 | `docs/plans/swarm-port-plan/00-first-party-overhaul-2026-09-18.md` (A) | OF-DIFF-010 | OK | Swarm plan doc |
| 9 | `docs/architecture/goal-mode.md` (A) | OF-DIFF-011 | OK | Goal Mode doc |
| 10 | `docs/handoff/CLOSEOUT-scheduled-tasks-2026-09-17.md` (A) | OF-DIFF-012 | OK | Scheduled-task closeout |
| 11 | `docs/handoff/AGENT_HANDOFF_spad-r-integration.md` (A) | OF-DIFF-013 | OK | SPAD/session-group handoff |
| 12 | `docs/architecture/code-mode.md` (A) | OF-DIFF-014 | OK | Code Mode doc |
| 13 | `packages/core/src/tool/builtins.ts` (M) | OF-DIFF-015 | OK | Native tool registry |
| 14 | `extensions/chrome/INTEGRATION.md` (A) | OF-DIFF-016 | OK | Existing-Chrome bridge doc |
| 15 | `docs/handoff/CLOSEOUT-usage-limits-model-selector-performance-2026-09-14.md` (A) | OF-DIFF-017 | OK | Quota/usage closeout |
| 16 | `.run/desktop dev.run.xml` (A) | OF-DIFF-018 | OK | Desktop IDE run config |
| 17 | `docs/handoff/CLOSEOUT-pwa-mobile-contention-2026-09-14.md` (A) | OF-DIFF-019 | OK | Mobile/PWA closeout |
| 18 | `packages/app/src/context/directory-sync.ts` (M) | OF-DIFF-020 | OK | App sync/substrate |
| 19 | `packages/core/src/database/FORMAT.md` (A) | OF-DIFF-021 | OK | Persistence format doc |
| 20 | `packages/core/src/config/compaction.ts` (M) | OF-DIFF-022 | OK | Config-owned compaction schema |
| 21 | `docs/architecture/jev-system-one.md` (A) | OF-DIFF-024 | OK | System One/Jev doc |
| 22 | `.dockerignore` (M) | OF-DIFF-025 | OK | Release/build governance |
| 23 | `packages/app/AGENTS.md` (M) | OF-DIFF-034 | OK | App product surface |
| 24 | `.workbuddy-ai/memory/2026-08-29.md` (A) | NONPRODUCT-DOCS-EVIDENCE | OK | Agent memory evidence, non-product |
| 25 | `.opencode/agent/duplicate-pr.md → .openfork/agent/duplicate-pr.md` (R100) | OF-DIFF-001 | OK | Pure rename, storage migration; 54 such rows all 001 |
| 26 | `packages/console/app/src/routes/changelog.json.ts` (D) | OF-DIFF-002 | OK | Verified: exists at `aec0b9a6`, absent at HEAD; hosted Console surface |
| 27 | `packages/web/src/content/docs/gitlab.mdx` (D) | OF-DIFF-002 | OK | Hosted web content removal |
| 28 | `docs/plans/plan-limits/tasks/T1-core-foundation.md` (A) | OF-DIFF-017 | OK | Usage/limits plan |
| 29 | `packages/opencode/src/tool/reload.ts` (A) | OF-DIFF-015 | OK | Tool reload |
| 30 | `packages/app/src/lab/send-control/concepts.ts` (A) | OF-DIFF-034 | OK | App lab surface |
| 31 | `packages/opencode/src/server/routes/instance/httpapi/groups/file.ts` (M) | OF-DIFF-006 | OK | Local HTTP API group |
| 32 | `packages/core/src/database/OPS_RUNBOOK.md` (A) | OF-DIFF-021 | OK | Persistence runbook |
| 33 | `README.md` (M) | OF-DIFF-001 | OK | Product identity |
| 34 | `packages/opencode/test/tool/websearch.test.ts` (A) | OF-DIFF-015 | OK | Web-search tool test (015 names `web-search`) |
| 35 | `OF-DIFF-026` untracked: `docs/plans/usage-limit-recovery-architecture-research-2026-10-03.md` | OF-DIFF-026 | OK | Session-limit recovery research |
| 36 | `OF-DIFF-027` untracked: `packages/core/src/code/admission.sql.ts` | OF-DIFF-027 | OK | Saved-code admission migration |
| 37 | `OF-DIFF-028` untracked: `packages/opencode/src/permission/auto-accept-policy.ts` | OF-DIFF-028 | OK | Auto-accept policy owner |
| 38 | `OF-DIFF-029` untracked: `packages/core/src/diagnostics/support-bundle.ts` | OF-DIFF-029 | OK | Support-bundle generator |
| 39 | `OF-DIFF-030` untracked: `docs/plans/everything-path-search-architecture.md` | OF-DIFF-030 | OK | Now committed (see §4) |
| 40 | `OF-DIFF-031` untracked: `packages/app/e2e/utils/accessibility/axe.ts` | OF-DIFF-031 | OK | Accessibility harness |
| 41 | `OF-DIFF-032` untracked: `packages/session-ui/src/components/background-monitor-presentation.test.ts` | OF-DIFF-032 | OK | Session rendering |
| 42 | `OF-DIFF-033` untracked: `packages/desktop/src/main/background-cli-health.test.ts` | OF-DIFF-033 | OK | Desktop reliability |
| 43 | `packages/core/test/session-runner.test.ts` (M) | OF-DIFF-025 | **BAD** | See D2 |
| 44 | `packages/core/src/v1/config/config.ts` + `migrate.ts` + `provider.ts`, `v1/session.ts` (M) | OF-DIFF-025 | **BAD** | See D3 |
| 45 | `packages/app/lab-oxp-activity.html` (A) | OF-DIFF-023 | **BAD** | See D5 |
| 46 | `STATS.md` (D) | OF-DIFF-002 | **DUB** | See D6 |
| 47 | `packages/core/src/brand.ts` (A) | OF-DIFF-025 | **BAD** | See D1 |
| 48 | `packages/core/src/filesystem.ts` (M) | OF-DIFF-025 | **BAD** | Sibling `filesystem/search.ts` is OF-DIFF-021; same directory split across two families |

All 8 untracked sample rows for families 026–033 are semantically correct; that half of the
inventory is in good shape. Sampling result: **33 OK / 3 clearly BAD buckets containing dozens of
rows / 1 DUB / 1 sibling-split BAD** — the failures cluster into systematic buckets, not scattered
one-offs.

## 6. Discrepancy register (all reproducible)

**D1 — OF-DIFF-025 is a catch-all bucket that contradicts its own ledger row (systematic, largest
finding).** The ledger describes OF-DIFF-025 as "CI / build / release / generated-code governance".
Reality: of 671 committed rows labelled OF-DIFF-025, **548 are `packages/**/*.ts|tsx` source/test
files** (239 core, 257 opencode, 26 tui, 24 schema, 2 httpapi-codegen) — only ~123 rows are
remotely build-scoped (`.github/workflows`, `script/`, manifests, root configs). The mechanism is
visible in history: `packages/core/src/brand.ts` was created by `fc67ed41bc` (tags
`OF-DIFF-021,022,025`) inside checkpoint commit `5374a0963b` (tags including 025); the path's label
is the **intersection** of its creating commits' family tags, i.e. `{025}`. Random sample of the
bucket shows `runtime-owner.ts`, `event/sql.ts`, `control-plane/move-session.ts`, `memory/*`,
`database/{database,sqlite.bun,sqlite.node}.ts`, `plugin/zen.ts`, `provider-route-intent.test.ts`,
`tool/websearch*.ts`, `cli/cmd/tui.ts` — semantics belong to 021/022/017/016/013, not build.
Reproduce: `grep 'OF-DIFF-025' committed-family-map.tsv | grep -c 'OF-DIFF-025\tpackages/.*\.tsx\?$'`
after excluding build-scoped paths (`/script/`, `drizzle.config`, `/tsconfig`, `package.json`,
`schema.json`, `script/migration.ts`) → **548** source/test rows out of 671; and
`git log --format=%h --diff-filter=A -- packages/core/src/brand.ts` (created by `5374a0963b`,
re-touched by `fc67ed41bc` with tags `OF-DIFF-021,OF-DIFF-022,OF-DIFF-025`).

**D2 — hosted-identity-header test and its commit are labelled OF-DIFF-025 instead of OF-DIFF-013.**
Commit `1d96902911` ("test(core): align hosted identity header expectation") changes exactly one
file, `packages/core/test/session-runner.test.ts`, adding `x-opencode-session-id` /
`x-session-affinity` expectations. The implementation it tests
(`packages/core/src/session/runner/provider-request-headers.ts` and
`packages/opencode/src/session/llm/request.ts`) is mapped to **OF-DIFF-013**. The test row and the
commit row (`1d96902911 → OF-DIFF-025`) should both be OF-DIFF-013.

**D3 — V1 runtime/config files labelled OF-DIFF-025.** `packages/core/src/v1/config/{config,migrate,provider}.ts`
and `packages/core/src/v1/session.ts` (all M) are V1 session/config runtime source, not build
governance; they belong to OF-DIFF-013/021.

**D4 — OF-DIFF-005 claims committed paths but has ZERO rows in all three maps.** The ledger's
OF-DIFF-005 row states state = `committed + tracked-dirty docs` and names
`packages/opencode/src/session`, `packages/core/src/v1`, `packages/app` V2 as its paths. First-hand
counts: `OF-DIFF-005` appears **0 times** in `committed-family-map.tsv`, **0** in
`dirty-family-map.tsv`, **0** in `untracked-meaningful-family-map.tsv`. Its claimed paths are in
fact absorbed by OF-DIFF-013 (77 `session` rows) and OF-DIFF-025. So one of the 34 families is
unevidenced: either the row's state/paths must be corrected, or rows must be re-labelled to 005.
(No path is thereby unclassified — this is a ledger-vs-map inconsistency, not a coverage hole.)

**D5 — `packages/app/lab-oxp-activity.html` and commit `220ce756d2` labelled OF-DIFF-023
(WakaTime telemetry).** The file's own header comment says it is a dev-only review surface for the
ChatGPT/OXP activity transcript; it belongs to OF-DIFF-008 (OXP plane). Commit
`220ce756d2 "test(app): add OXP activity lab entrypoint"` carries the same wrong tag.

**D6 — `STATS.md` (D) labelled OF-DIFF-002 (DUB).** `git show aec0b9a6:STATS.md` is a root
GitHub/npm download-stats table — distribution/release evidence. OF-DIFF-002's stated scope is
hosted `packages/{web,console,stats,…}`/infra/sdks; OF-DIFF-001 (distribution) or OF-DIFF-025
(release governance) fit better. Defensible-if-loose; flag for relabel.

**D7 — ledger text vs map conflict for web-search tools.** Ledger OF-DIFF-015 explicitly lists
`web-search` among its paths, but every committed `tool/websearch*` / `*-websearch.ts` file
(`firecrawl`, `brave`, `duckduckgo`, `searxng`, `tavily`, `mcp-websearch`, `websearch.ts`,
`websearch-shared.ts`, `websearch.txt`) is labelled OF-DIFF-016; only the test file is labelled
015. Provenance: created by `4667437f74` whose tag set intersected to 016. One of the two texts is
wrong.

**Not discrepancies (checked and cleared):** duplicate paths = 0 in map and in current diff; every
family label used in the maps (`OF-DIFF-001…025`, `OF-DIFF-034`, `NONPRODUCT-DOCS-EVIDENCE`,
`HISTORY-NO-NET-DIFF`) exists in the ledger; deletion rows verified against the comparator
(console changelog: present at `aec0b9a6`, absent at HEAD); 54 R100 renames are pure
`.opencode/* → .openfork/*` migrations correctly labelled OF-DIFF-001; snapshot vs map path-set
symmetric difference = 0.

## 7. Live drift census (context only, not this lane's verdict)

Measured once at `95543517ae`: staged **0**, unstaged **819**, untracked **10027**. The
working-tree axes have moved heavily since the snapshot (354 / 9329) from concurrent editing; those
axes belong to the dirty/untracked verifier lanes and must not be read from this artifact. None of
that motion changes the committed or history numbers above, which are functions of HEAD and the
comparator only.

## 8. Commands used (reproduction)

```bash
git rev-parse HEAD                                              # 95543517ae...
git merge-base HEAD aec0b9a6d8898f68f923aaf08b7306d931fd9d76      # == comparator
git log --oneline HEAD..aec0b9a6...                             # 0 (upstream drift)
git -c diff.renameLimit=100000 diff --name-status aec0b9a6...HEAD # 5699 rows: 2779A/1875D/991M/54R
git diff --name-status aec0b9a6...HEAD                           # 5704 rows: 2784A/1880D/991M/49R (misleading)
git log --oneline aec0b9a6...HEAD                                # 455 commits
git show --name-status --format='%h %s' 96371fcce5 4f15d3ccf8 95543517ae
git show aec0b9a6...:STATS.md | head                             # D6 evidence
git cat-file -e aec0b9a6...:packages/console/...changelog.json.ts  # rc=0
git cat-file -e HEAD:packages/console/...changelog.json.ts          # rc=128
git log --format=%h --diff-filter=A -- packages/core/src/brand.ts    # D1 evidence
git diff --cached --name-only | Measure-Object -Line              # 0 staged
```

## 9. Conclusion and required follow-ups

1. The reconciled zero-unexplained claim on the committed + history axes **holds at current HEAD
   `95543517ae`**: 5699 committed paths (5365 OF-DIFF + 334 non-product, 0 unexplained), 455
   fork-only commits (429 mapped + 26 no-net-diff), staged 0, upstream drift 0. The 14 paths added
   since the snapshot are fully assigned (§4).
2. Semantic labeling needs a repair pass before documentation use: re-bucket the 548 OF-DIFF-025
   source/test rows to their real families (D1); fix D2/D3 (two paths + two commits to 013),
   D5 (one path + one commit to 008), D6, D7; and resolve D4 — OF-DIFF-005 must either gain
   evidence rows or have its state/paths corrected, because a family that claims committed paths
   while holding zero rows in every map is not reconciled evidence.
3. OF-DIFF-030's ledger state must be updated from `untracked + tracked-dirty` to
   `committed + tracked-dirty` (7 committed rows at this HEAD).

Temporary files used during this pass were kept under
`docs/plans/openfork-upstream-differences/verification/tmp-a/` and removed before completion.
