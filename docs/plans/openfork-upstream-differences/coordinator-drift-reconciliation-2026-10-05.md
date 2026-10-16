# Coordinator drift reconciliation — 2026-10-05

Coordinator-side verification pass. This artifact reconciles the live tree against immutable
snapshot `2026-10-05-012455`. It records only evidence-backed corrections. It does **not** close
the documentation gate.

## 1. Independent re-derivation of snapshot `2026-10-05-012455`

Every universe was re-counted from the snapshot artifacts rather than trusting
`reconciliation-summary.txt`. All four reconcile exactly.

| Universe | Artifact rows | Summary claim | Re-derived | Verdict |
| --- | ---: | ---: | ---: | --- |
| Committed rename-aware delta | 5685 | 5352 OF-DIFF + 333 non-product | 5352 + 333 = 5685 | holds |
| Tracked unstaged delta | 354 | 344 OF-DIFF + 10 non-product | 344 + 10 = 354 | holds |
| Untracked paths | 9329 | 9164 non-product + 165 meaningful | 9164 + 165 = 9329 | holds |
| Fork-only commits | 452 | 426 mapped + 26 no-net-diff | 426 + 26 = 452 | holds |
| Staged | 0 | 0 | 0 | holds (explicit zero) |
| Upstream drift | 0 | 0 | 0 | holds |

Path-set integrity checks:

- `committed-name-status.txt` path set vs `committed-family-map.tsv` path set →
  symmetric difference **0** (5685 unique paths on both sides, no path unlabelled).
- `unstaged.txt` vs `dirty-family-map.tsv` → symmetric difference **0** (354 / 354).
- `untracked-classification.tsv` has 9329 rows across 9 mutually exclusive classes
  (`generated-e2e-debris` 8555, `generated-desktop-build` 475, `meaningful-source-config` 84,
  `meaningful-test` 77, `temp-runtime-debris` 70, `temp-probe-debris` 32,
  `meaningful-doc-or-evidence` 17, `audit-evidence` 14, `shell-quoting-debris` 5).
- `untracked-meaningful-family-map.tsv` has 178 rows = 165 `OF-DIFF-*` + 13 non-product, which
  matches the three "meaningful-*" classes (84 + 77 + 17 = 178). Consistent.

**Conclusion: the snapshot's `path_level_unexplained=0` is genuinely supported, not asserted.**

Note on file shape for downstream lanes: `committed-family-map.tsv` is a 3-column TSV
(`status`, `family`, `path`) with **no header row**, while `dirty-family-map.tsv` and
`untracked-meaningful-family-map.tsv` are 2-column (`family`, `path`) with no header. Consumers
must not assume a header or a fixed column count across these files.

## 2. Live census and drift since the snapshot

Measured twice in this pass to confirm the tree is still moving.

| Measure | Snapshot `2026-10-05-012455` | Live (first read) | Live (re-read) |
| --- | ---: | ---: | ---: |
| HEAD | `1d96902911` | `1d96902911` | `1d96902911` |
| Comparator | `aec0b9a6d88` | `aec0b9a6d88` | `aec0b9a6d88` |
| Committed paths | 5685 | 5685 | 5685 |
| Fork-only commits | 452 | 452 | 452 |
| Unstaged | 354 | 384 | 387 |
| Staged | 0 | 0 | 0 |
| Untracked | 9329 | 9355 | 9357 |

The committed and history axes are **stable**. Only the in-flight working-tree axes move.

Set difference against the snapshot:

- unstaged: **+33 added, 0 removed**
- untracked: **+28 added, 0 removed**

### 2a. The 28 new untracked paths are not new product surface

| Count | Paths | Classification |
| ---: | --- | --- |
| 20 | `snapshots/2026-10-05-012455/*` (snapshot evidence files themselves) | audit evidence |
| 6 | `docs/perf/investigation-2026-10-01/*-2026-10-05.json` | audit evidence (perf probes) |
| 1 | `.tmp-oxp-retirement-inspect.ts` | temp-probe debris |
| 1 | `packages/ui/src/theme/syntax-theme.test.ts` | **real source** → `OF-DIFF-034` |

### 2b. The 33 new unstaged paths ARE new in-flight product surface

These are meaningful working-tree source changes not present in the snapshot's
`dirty-family-map.tsv`. They are reconciled here into existing families; none is a new family.

| Family | New unstaged paths | Note |
| --- | ---: | --- |
| `OF-DIFF-010` Native Swarm | 6 | `core/src/swarm/runtime.ts`, `core/test/swarm/runtime.test.ts`, `opencode/src/swarm/containment.ts`, `opencode/src/swarm/task-retirement.ts`, `opencode/src/session/subagent-delegation.ts`, `opencode/test/tool/task.test.ts` |
| `OF-DIFF-013` Session supervision | 1 | `opencode/src/server/routes/instance/httpapi/groups/session.ts` |
| `OF-DIFF-021` Search / persistence | 2 | `core/src/search/mention-fast.ts`, `core/test/search-mention-fast.test.ts` |
| `OF-DIFF-025` Build / generated governance | 2 | `opencode/script/build.ts`, `sdk/js/script/build.ts` |
| `OF-DIFF-032` Session rendering | 6 | `session-ui` `markdown-frame-work.ts`(+test), `markdown-visibility.ts`(+test), `markdown.worker.ts`, `pierre/index.ts` |
| `OF-DIFF-034` App / session-ui / shared UI | 16 | `app` project-explorer tree/search-runner(+test)/markdown-viewer, `new-session-draft-controller`; `ui` theme resolve/`oc-2.json`/`theme.css`×2/`marked`+`marked-theme`/`auto-scroll-intent`(+test)/`create-auto-scroll`/`scroll-view` |

Every one of the 33 is tracked-dirty (unstaged modified), i.e. **in-flight**, not committed.
They must not be documented as released HEAD behavior.

## 3. Verifier status — the gate is NOT satisfied

This is the decisive finding. The three independent omission verifiers have **not** passed.

Observed against the host session surface:

- Verifier lane sessions exist as Task subagent sessions, not as a native swarm
  (`swarm action=list` still shows no `openfork-*-difference-*` swarm; the roster narrative in
  earlier ledger revisions remains unbacked).
- `ses_ef7875158ffejckvFo1g664lWX` ("OF omission verifier B") is `idle`. Its most recent
  assistant message is orientation only: *"Let me re-derive the machine universe independently in a
  temp location (both target dirs are read-only)."* No verdict, no artifact.
- `ses_ef7876d4affef4xRxApDUFWcqT` ("OF audit core runtime/session") is `idle`, last message is
  orientation only: *"I'll start by orienting myself in the audit directory…"*
- No verifier artifact (pass/fail/omission report) exists anywhere under
  `docs/plans/openfork-upstream-differences/`. A recursive search for
  `verif|omission|audit|pass|fail` artifacts returned nothing.
- The canonical ledger's only mention of `inv27`/`inv28`/`inv29` is line 55, inside the section
  documenting that the asserted roster was false. No verifier has signed off in-repo.

Per-entry verification states are also still mixed: `OF-DIFF-030`, `-031`, `-032`, `-033` read
`pending integration verification`, and `OF-DIFF-028` reads `final verifier pending`.

**Therefore: documentation gate remains BLOCKED.** README, `docs/map/*`, and architecture/reference
rewrites must not begin. This pass makes no documentation-prose edits.

## 4. Net position

- Committed + history reconciliation: **closed and independently re-verified** at 0 unexplained.
- Working-tree reconciliation: reconciled through this artifact for the current instant; will drift
  again because lanes are actively editing.
- Independent verifier passes: **0 of 3**. This is the sole remaining hard blocker, plus the
  requirement for a final fresh snapshot taken after the verifiers complete.

Coordinator action required next: drive the three verifiers to an actual recorded verdict, then take
a final fresh immutable snapshot, then and only then start the documentation rewrite.