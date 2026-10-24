# AX: Session, native Swarm and OXP failure recovery (2026-10-21)

**Status:** canonical source patches and focused executable tests; **not** a claim that today's later source modifications have been deployed to the connected OXP host. Preserve the multi-writer dirty worktree. No database mutation or live Session/Swarm replacement is part of this change.

## User intent and AX invariants

This investigation follows `.agents/skills/agent-experience/SKILL.md`, the AX-16 matrix, `AGENTS.md`, `docs/architecture/tool-surface-parity.md`, and the production V1 tool ownership rule.

Optimize verified task completion, not raw schema length or successful request admission. An agent must be able to discover the correct operation, provide a valid request, receive a stable identity/receipt, recover from partial or unknown outcomes, and independently verify the intended result, without privilege escalation, fabricated Sessions, silent account/model substitutions, or duplicate side effects.

A Session record's `updatedAt` is not execution liveness, and a created Swarm is not evidence that its workers ran. For partial work, retain successful siblings and only retry failed/missing stable keys. For ambiguous writes, inspect durable state **before** replay.

## Applied owner-level changes

| Failure | Owner | Correction | Evidence / boundary |
| --- | --- | --- | --- |
| Direct OXP Session tool search/cursor unavailable although underlying executor supported them | `src/oxp/session.ts` | Add typed `tool` and `cursor` to direct input; preserve bounded decoder, authority and pagination behavior | `test/oxp/session-ax-direct-contract.test.ts`; `test/oxp/session.test.ts` |
| Conflicting Go account selectors (`model@zen-ID` together with mismatched `accountID=key3`) | `src/swarm/profile-preflight.ts` | Reject contradictory explicit identifiers before persistent admission, with catalog-guided recovery; do not guess/change accounts | `test/swarm/profile-preflight.test.ts` |
| Review mail without reply contract | `src/tool/swarm-member.ts` | Require `replyExpected=true` for `kind=review` at schema decoding; document normal one-way kinds and exact roster naming | `test/tool/swarm-member.test.ts` |
| Recovered/bound worker silently retains different model, account or variant | `src/swarm/member-session.ts` | Compare saved Session selection and Swarm desiredProfile both on candidate binding and existing binding; preserve Session and fail closed on mismatch | `test/swarm/member-session.test.ts` |
| OXP activity attribution waits on foreground 15-second SQLite BEGIN retry despite a 450ms recorder retry budget | `packages/core/src/database/database.ts`, `sqlite-busy.ts`, `oxp-activity/activity.ts`; OXP `activity-recorder.ts` | Lazy isolated activity writer, 350ms BEGIN retry, 650ms outer activity deadline; keep control/Session writer lanes independent. Attribution timeouts are **unknown**, never permission to replay user operations | `test/oxp/activity-link-sqlite-recovery-20261011.test.ts`; Core typecheck |
| Native SQLite error code invisible behind `EffectDrizzleQueryError` | `src/oxp/diagnostics.ts` | Bounded traversal of known adapter wrapper and Effect `reasons`; emit allowlisted SQLite codes only, never query text/parameters | `test/oxp/diagnostics-ax.test.ts`; file-backed link tests |
| Usage OXP/native action parity declaration stale after expanded analytics | `src/oxp/tool-coverage.ts`, generated parity document | Explicitly describe shared and OXP-only analytics actions; retain separate default-off `globalUsageAnalytics` authorization | `test/oxp/tool-parity-matrix.test.ts` (7/7) |

### Architecture / security

The `Database.Interface.activityDb` connection is **not** the Session/Swarm or lease writer. On file-backed databases, it has its own async SQLite handle and its own `permitLane=activity` deadline; on `:memory:` it aliases the original DB to avoid a divergent database. Its lifetime is scoped to the owning Database instance, with no permanent foreground initialization on an otherwise unused activity service. The activity owner consumes this shared Database service rather than opening an ad hoc connection. SQLite still has one physical WAL writer: starvation remains possible; failure is reported rather than hidden.

The recorder's whole-operation timeout is additional defense because a lower-level adapter could regress admission latency. A timeout does not establish rollback. No user workspace mutation is performed by the recorder.

The worker-selection comparator checks agent, provider, exact model identity, account, and variant. Missing variant is canonically `default`; a requested `max` must never be accepted as `default`. Existing bound Sessions are neither automatically rewritten nor deleted.

OXP Session supervision and filesystem/process grants remain separate. At the initial handshake the host advertised `sessionSupervision=approved-roots`; a fresh post-repair check now advertises `sessionSupervision=all-native` (operator-configured grant), independently of the AX source patches. This does not grant filesystem or process permissions over those Session directories, nor prove a Session's execution liveness.

## Tests and observed results

- Previous direct schema / profile / worker-action suite: **33 passed, 122 expectations**.
- Broader Session, native Swarm creation/command and generated transport suite: **53 passed, 368 expectations**.
- File-backed OXP recorder + diagnostics suite: **33 passed, 315 expectations** after isolated activity-writer introduction.
- More recent strengthened isolated-writer contention case: **1 passed, 15 expectations**; approximately **1.86 seconds** including fixture initialization, versus the pre-repair **15-second test timeout**.
- Worker lifecycle / profile suite with mismatch cases: **18 passed, 68 expectations**.
- Native/OXP action parity matrix after updating the usage contract: **7 passed, 131 expectations**.
- Core package `bun run typecheck`: passed.
- Host `bun run typecheck`: **passed** after restoring the shared Usage workload type exports and tightening test expectations in `test/oxp/usage.test.ts`, `test/session/stored-route-intent.test.ts`, and `test/server/httpapi-session.test.ts`. These fixes do not change runtime routing or permission behavior. A later worker-root assertion was also added; recheck before release if concurrent edits continue.
- Complete `bun packages/opencode/script/verify-oxp-native-parity.ts --quick`: **PASS**, all selected release gates; 125 tests / 1,648 expectations in its broker/parity/usage/shared-domain group after correcting the usage matrix.
- Generated transport manifest `--check`: **PASS**, 14 direct tools, fingerprint `8ca6d5c5bedcf783c55728097f5402ef5dcf6c82610ba72a8649a4514c67bf92`.
- Native Swarm member/profile/communication targeted suite after rejecting parent-bound Session drift: **36 tests / 149 expectations passed**.

## Live host status and remaining issues

After the initial patch and user-restored tunnel, `openfork_info(status)` advertised transport fingerprint `8ca6d5c5bedcf783c55728097f5402ef5dcf6c82610ba72a8649a4514c67bf92`, proving **only that prior transport version**, not the later SQLite/Swarm changes. `AX_IMPLEMENTATION` source now declares `activityPersistence=isolated-350ms-sqlite-activity-lane-wrapper-diagnostics-v3` and `sessionSwarmReliability=bound-profile-drift-guard-direct-tool-recall-v1` as post-deployment handshakes. Check both on authorized rollout. The OXP host explicitly reports `runtime.refreshable=false`; do not claim in-place refresh.

The live exact-tool searches for `swarm_member` and `session` succeed, but `coverage.complete=false` and **all five historical index readiness flags are false**. This is the next high-severity AX observability issue: successful top-N results do **not** establish complete historical recall. A proper repair must use Core's bounded watermark-based backfill, not hydrate message histories in each search, and must get separately scoped mutation authorization before operating on indexes spanning unapproved Session roots.

Other unrepaired categories include command queue admission saturation, provider timeout/unknown execution receipts, swarm creation rescue from durable `creating` state, GUI/model effective-variant attribution, blackboard payload formatting, and external provider/CI failures. Do not mark them closed without reproduction and execution-path tests. Fixing diagnostic classification does not itself prove that every historical link failure is repaired.

## Release gates

1. Run `bun packages/opencode/script/verify-oxp-native-parity.ts --quick` and `bun packages/opencode/script/generate-oxp-transport-manifest.ts --check` from repo root.
2. Resolve or separately triage the host-wide TypeScript errors against the current multi-writer checkout.
3. Run the file-backed activity test under a second WAL writer, plus 1/3/6 OXP host contention and p50/p95/p99 foreground session-commit latency. Check DB handles and resource lifetime after shutdown.
4. Validate existing bound Sessions against desired profiles and prove no automatic deletion/rebinding or provider/account fallback; test cross-project refusal.
5. Run client/native/OXP dispatcher-backed, denied-grant, revoked-grant and post-commit interruption cases; catalog presence alone is not parity.
6. Only after an explicitly authorized host deploy, compare both `implementation.ax` revision fields and static transport fingerprint; then perform live tool retrieval and worker-state checks.

No stage/commit/reset/stash/clean or live database mutation was performed during this campaign. Preserve concurrent changes.
