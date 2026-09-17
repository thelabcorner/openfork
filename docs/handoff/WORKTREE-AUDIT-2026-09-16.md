# Work-tree audit and commit slicing (2026-09-16)

Audit of the OpenFork work tree before the dev pre-release push. Every tracked
modification, deletion, and untracked file is listed below with the commit that
carries it, or the exclusion decision that drops it.

## Repository context

- Remote: `origin https://github.com/thelabcorner/openfork.git` (push), upstream `anomalyco/opencode`.
- Branch: `main` (pushed to `origin/main`).
- Git user: Jackson Cummings <126146472+thelabcorner@users.noreply.github.com>.
- GitHub auth: `gh` logged in as `thelabcorner` (scopes include `workflow` and `repo`).

## Audit totals

| State | Count | Notes |
| --- | --- | --- |
| Tracked modified | 211 | 73 were hidden by an `assume-unchanged` index watermark (see below). |
| Tracked deleted | 1 | `packages/opencode/src/claude/index.ts` (unused barrel). |
| Untracked | 65 | 58 committed, 7 excluded as local scratch. |
| Commits created | 14 | Feature/package/doc slices, each with a multi-line summary. |

## Line-ending watermark (why the count jumped from 133 to 211)

The working tree had **3,683 tracked files marked `assume-unchanged`**; those
files were checked out with CRLF while the index/HEAD blobs are LF, so git
reported a clean path list. The watermark was masking both:

1. ~3,600 files whose only difference was CRLF-vs-LF (no content change), and
2. **73 files with real content changes** on top of the EOL churn.

Remediation (index metadata only; the CRLF-only files' bytes are untouched):

- The 73 real-change files were normalized CRLF -> LF, matching HEAD and the
  rest of the repo, so their commits contain only the semantic diff.
- The pure-EOL files were re-marked `assume-unchanged` so the audit stays
  focused on real changes and the operator's original watermark is preserved.

Real changes that had been hidden and are now committed include:
`packages/schema/src/{index,event-manifest}.ts`,
`packages/opencode/src/server/routes/instance/httpapi/{api,server}.ts`,
`packages/opencode/src/usage/usage.ts`,
`packages/core/src/{event.ts,location-services.ts,snapshot.ts}`,
`packages/app/src/context/personal-usage.tsx`, and the per-package `AGENTS.md` files.

## Excluded untracked files

| Path | Decision | Why |
| --- | --- | --- |
| `.tmp-spad-anchor-sim.cjs` | gitignored (not committed) | OneOff SPAD reasoning-runaway forensics; reads the operator's `~/Downloads` and is not source. |
| `.tmp-spad-degen-analyze.cjs` | gitignored (not committed) | OneOff SPAD reasoning-runaway forensics; reads the operator's `~/Downloads` and is not source. |
| `.tmp-spad-degen-extract.cjs` | gitignored (not committed) | OneOff SPAD reasoning-runaway forensics; reads the operator's `~/Downloads` and is not source. |
| `.tmp-spad-degen-math.cjs` | gitignored (not committed) | OneOff SPAD reasoning-runaway forensics; reads the operator's `~/Downloads` and is not source. |
| `.tmp-spad-degen-probe.cjs` | gitignored (not committed) | OneOff SPAD reasoning-runaway forensics; reads the operator's `~/Downloads` and is not source. |
| `.tmp-spad-degen-probe.js` | gitignored (not committed) | OneOff SPAD reasoning-runaway forensics; reads the operator's `~/Downloads` and is not source. |
| `.tmp-spad-onset.cjs` | gitignored (not committed) | OneOff SPAD reasoning-runaway forensics; reads the operator's `~/Downloads` and is not source. |

`.gitignore` now carries `.tmp-spad-*` next to the existing
`packages/opencode/.tmp-spad-*` rule (commit `4200678786`).

## Commits

### `4200678786` chore(repo): ignore root-level SPAD scratch analysis scripts

```text
The repository root had seven untracked OneOff SPAD reasoning-runaway
forensics scripts. They read from the operator's Downloads directory and are
throwaway analysis, not source, so they are excluded rather than committed:

  .tmp-spad-anchor-sim.cjs
  .tmp-spad-degen-analyze.cjs
  .tmp-spad-degen-extract.cjs
  .tmp-spad-degen-math.cjs
  .tmp-spad-degen-probe.cjs
  .tmp-spad-degen-probe.js
  .tmp-spad-onset.cjs

Changes:
- .gitignore: add `.tmp-spad-*` next to the existing
  `packages/opencode/.tmp-spad-*` rule so root-level scratch can never be
  staged accidentally.

Decision: exclude (do not commit, do not delete the operator's files).
```

<details><summary>Files in this commit</summary>

```text
M	.gitignore
```

</details>

### `9ced217a22` docs(governance): add root ownership contract, playbook, and AGENTS enforcement

```text
Publish the repository-wide architecture/ownership contract and the long-form
review guidance that the instance-bootstrap/concurrent-session postmortem
requires, then propagate the enforced rules into the package-level AGENTS.md
files that agents actually read.

Changes:
- AGENTS.md (new): root contract - architecture-before-call-sites, server
  ownership tiers 0-3, concurrency/shared-ownership rules, performance closure
  standard, workspace dependency direction, API-surface selection, and
  dirty-worktree safety.
- docs/handoff/ARCHITECTURE-OWNERSHIP-PLAYBOOK.md (new) and
  docs/handoff/TASK-instance-bootstrap-concurrency-architecture.md (new):
  detailed heuristics and the open remediation task.
- docs/handoff/AGENTS.md: requires causal bottom-up narration, ownership tiers,
  negative invariants, and process audits in every handoff/closeout.
- Per-package AGENTS.md updates: FORK.md, packages/app/AGENTS.md,
  packages/app/e2e/performance/AGENTS.md, packages/core/AGENTS.md (new),
  packages/desktop/AGENTS.md, packages/opencode/AGENTS.md,
  packages/opencode/src/server/routes/instance/httpapi/AGENTS.md,
  packages/opencode/src/session/llm/AGENTS.md,
  packages/opencode/test/server/AGENTS.md, packages/schema/AGENTS.md,
  packages/session-ui/AGENTS.md, packages/ui/AGENTS.md - dense UI must consume
  materialized projections, no directory-less provider/session calls, hidden UI
  is not free UI.
```

<details><summary>Files in this commit</summary>

```text
A	AGENTS.md
M	FORK.md
M	docs/handoff/AGENTS.md
A	docs/handoff/ARCHITECTURE-OWNERSHIP-PLAYBOOK.md
A	docs/handoff/TASK-instance-bootstrap-concurrency-architecture.md
M	packages/app/AGENTS.md
M	packages/app/e2e/performance/AGENTS.md
A	packages/core/AGENTS.md
M	packages/desktop/AGENTS.md
M	packages/opencode/AGENTS.md
M	packages/opencode/src/server/routes/instance/httpapi/AGENTS.md
M	packages/opencode/src/session/llm/AGENTS.md
M	packages/opencode/test/server/AGENTS.md
M	packages/schema/AGENTS.md
M	packages/session-ui/AGENTS.md
M	packages/ui/AGENTS.md
```

</details>

### `ba1ea2fb8d` docs(plans): add scheduled-tasks, macroturn-mode, and snapeye planning docs

```text
Add the durable planning set for upcoming work so the ownership decisions are
reviewable before implementation.

Changes:
- docs/plans/scheduled-tasks/ (new): README, 01-architecture,
  02-scheduling-semantics, 03-execution-and-safety, 04-surface-and-ux,
  05-verification, 06-risks-and-open-questions, and task briefs
  T0-design-gate through T9-verification-closeout, plus .gitkeep.
- docs/plans/macroturn-mode-plan/ (new): README and
  01-runtime-architecture.
- docs/drafts/snapeye-openfork-show-and-tell.md (new): show-and-tell draft.
```

<details><summary>Files in this commit</summary>

```text
A	docs/drafts/snapeye-openfork-show-and-tell.md
A	docs/plans/macroturn-mode-plan/01-runtime-architecture.md
A	docs/plans/macroturn-mode-plan/README.md
A	docs/plans/scheduled-tasks/.gitkeep
A	docs/plans/scheduled-tasks/01-architecture.md
A	docs/plans/scheduled-tasks/02-scheduling-semantics.md
A	docs/plans/scheduled-tasks/03-execution-and-safety.md
A	docs/plans/scheduled-tasks/04-surface-and-ux.md
A	docs/plans/scheduled-tasks/05-verification.md
A	docs/plans/scheduled-tasks/06-risks-and-open-questions.md
A	docs/plans/scheduled-tasks/README.md
A	docs/plans/scheduled-tasks/tasks/T0-design-gate.md
A	docs/plans/scheduled-tasks/tasks/T1-schema-and-migration.md
A	docs/plans/scheduled-tasks/tasks/T2-recurrence-engine.md
A	docs/plans/scheduled-tasks/tasks/T3-core-service.md
A	docs/plans/scheduled-tasks/tasks/T4-runner.md
A	docs/plans/scheduled-tasks/tasks/T5-execution-adapter.md
A	docs/plans/scheduled-tasks/tasks/T6-http-api.md
A	docs/plans/scheduled-tasks/tasks/T7-loop-files.md
A	docs/plans/scheduled-tasks/tasks/T8-client-surface.md
A	docs/plans/scheduled-tasks/tasks/T9-verification-closeout.md
```

</details>

### `8458e95ead` feat(core): add SessionTelemetry projection and UsageRecord ledger

```text
Make execution lifecycle state a server-owned, compact projection instead of
something dense UI reconstructs by scanning message/part history.

New services and storage:
- packages/core/src/session/telemetry.ts (new): SessionTelemetry begin/observe/
  streamed/settle/retry/idle/fail/snapshot; in-memory live state, coalesced
  `session.telemetry.updated` (75ms), TTL 15m / LRU 2048; only settled steps are
  persisted.
- packages/core/src/usage/record.ts (new): UsageRecord.record /
  recordMaintenance / revision() watermark for the scalar usage_record table.
- packages/schema/src/session-telemetry.ts (new): wire contracts (Phase,
  Tokens, Model, Step, Context, Info, Updated).
- packages/protocol/src/groups/session.ts: telemetry request/result contracts.
- migrations: 20260916025456_session_telemetry,
  20260916031203_session_telemetry_records, 20260916032430_usage_records
  (one-time JSON backfill), 20260916033126_session_telemetry_model_name; plus
  regenerated packages/core/src/database/{migration,schema}.gen.ts and
  packages/core/schema.json.
- packages/core/src/session/sql.ts, packages/core/src/usage/sql.ts: store the
  settled/aggregate rows.
- packages/schema/src/event-manifest.ts and packages/schema/src/index.ts:
  register/export SessionTelemetry.Updated.
- packages/core/package.json: export ./usage/record.
- packages/sdk/js/src/v2/gen/{sdk,types}.gen.ts: regenerated SDK and types.

Tests:
- packages/core/test/session-telemetry.test.ts (new): phase transitions and
  settlement.
- packages/core/test/event.test.ts: scoped listener dispatch.
```

<details><summary>Files in this commit</summary>

```text
M	packages/core/package.json
M	packages/core/schema.json
M	packages/core/src/database/migration.gen.ts
A	packages/core/src/database/migration/20260916025456_session_telemetry.ts
A	packages/core/src/database/migration/20260916031203_session_telemetry_records.ts
A	packages/core/src/database/migration/20260916032430_usage_records.ts
A	packages/core/src/database/migration/20260916033126_session_telemetry_model_name.ts
M	packages/core/src/database/schema.gen.ts
M	packages/core/src/session/sql.ts
A	packages/core/src/session/telemetry.ts
A	packages/core/src/usage/record.ts
M	packages/core/src/usage/sql.ts
M	packages/core/test/event.test.ts
A	packages/core/test/session-telemetry.test.ts
M	packages/protocol/src/groups/session.ts
M	packages/schema/src/event-manifest.ts
M	packages/schema/src/index.ts
A	packages/schema/src/session-telemetry.ts
M	packages/sdk/js/src/v2/gen/sdk.gen.ts
M	packages/sdk/js/src/v2/gen/types.gen.ts
```

</details>

### `8dd23c4dc3` feat(core): own event/location scope, project inventory, and special-agent sessions

```text
Remove implicit-cwd and message-scan fallbacks from core; give tracked-file
coverage, project inventory, and special-agent turns a single owner.

Scoped event/location ownership and infra hardening:
- packages/core/src/event.ts: add listenType/listenDirectory/listenDirectoryAll
  with explicit type/directory dispatch maps.
- packages/core/src/filesystem/ignore.ts + watcher.ts: coverage()/nativeIgnored()
  so ignore rules never drop tracked files, whitelist tracked dirs, normalize
  backslashes; watcher refcounts active roots and refreshes on git ref change.
- packages/core/src/location-services.ts: canonicalLocationRef and LayerMap
  wrappers collapse path/case aliases and invalidate consistently.
- packages/core/src/installation/version.ts: InstallationReleaseVersion and
  canonical InstallationUserAgent(); models-dev.ts uses it.
- packages/core/src/fs-util.ts: copyFileAtomic; packages/core/src/git.ts:
  index.list/index.tracked (ls-files) plus tracked-aware helpers.
- packages/core/src/snapshot.ts: indexValid/healIndex rebuild a corrupt shadow
  git index before capture/preview.
- packages/core/src/database/chunk-sealer.ts: semantic-prune no-progress
  backoff.
- packages/core/src/tool/registry.ts + tool/tool.ts: thread optional userTurn
  into tool execution context.
- packages/core/src/session/runner/model.ts: resolveWithInfo; runner/llm.ts:
  telemetry + special-agent/provenance seams.
- packages/core/src/session.ts: explicit OperationUnavailableError instead of
  cwd fallback.

New services:
- packages/core/src/project-inventory.ts (new): Git-authoritative tracked/
  untracked inventory with watcher deltas, coverage/complete diagnostics, and a
  single-flight rebuild.
- packages/core/src/session/host-child.ts (new): Tier-1 idempotent parent-scoped
  child session creation.
- packages/core/src/special-agent-session.ts (new): deterministic ids and
  provision/publisher/settleTurn/is over the Kind union, backed by host-child +
  UsageRecord.
- packages/core/src/prompt-revisor.ts, packages/core/src/session/title.ts:
  route turns through SpecialAgentSession.
- packages/core/src/search/index-service.ts: reconcile/compact a persisted
  index when indexedAt is stale under the cold-seed lease (truncation-safe);
  docs/architecture/at-mention-sync.md documents service-owned reconcile.

Tests:
- packages/core/test/{project-inventory,fs-util-atomic}.test.ts (new),
  test/filesystem/ignore.test.ts, test/location-layer.test.ts,
  test/session-runner.test.ts, test/database/chunkdb-crash.test.ts,
  test/search-index-service.test.ts.
```

<details><summary>Files in this commit</summary>

```text
M	docs/architecture/at-mention-sync.md
M	packages/core/src/database/chunk-sealer.ts
M	packages/core/src/event.ts
M	packages/core/src/filesystem/ignore.ts
M	packages/core/src/filesystem/watcher.ts
M	packages/core/src/fs-util.ts
M	packages/core/src/git.ts
M	packages/core/src/installation/version.ts
M	packages/core/src/location-services.ts
M	packages/core/src/models-dev.ts
A	packages/core/src/project-inventory.ts
M	packages/core/src/prompt-revisor.ts
M	packages/core/src/search/index-service.ts
M	packages/core/src/session.ts
A	packages/core/src/session/host-child.ts
M	packages/core/src/session/runner/llm.ts
M	packages/core/src/session/runner/model.ts
M	packages/core/src/session/title.ts
M	packages/core/src/snapshot.ts
A	packages/core/src/special-agent-session.ts
M	packages/core/src/tool/registry.ts
M	packages/core/src/tool/tool.ts
M	packages/core/test/database/chunkdb-crash.test.ts
M	packages/core/test/filesystem/ignore.test.ts
A	packages/core/test/fs-util-atomic.test.ts
M	packages/core/test/location-layer.test.ts
A	packages/core/test/project-inventory.test.ts
M	packages/core/test/search-index-service.test.ts
M	packages/core/test/session-runner.test.ts
```

</details>

### `b1d422d9cb` feat(goal): authorize creation from turn provenance and host auditor sessions

```text
Gate Goal creation on trusted turn provenance and give auditor verification a
durable, host-owned session instead of client-supplied ownership.

Core and schema:
- packages/core/src/goal/creation-policy.ts (new): GoalCreationPolicy.authorize
  requires explicitlyRequestsGoal/confirmsGoalProposal; guards unattended/draft
  escalation.
- packages/core/src/goal/agent.ts: create action consults the policy and derives
  ownership from sessions.get(sessionID)/sourceMessageID.
- packages/core/src/goal/{auditor,auditor-prompt,automation,index,sql}.ts:
  auditor session linking, criteria/evidence reconciliation, and
  auditor_complete_verified / auditor_reconciliation_failed / auditor_stale
  outcomes; prepares goals from SQL-derived project/workspace.
- packages/core/src/tool/goal.ts: goal tool integration.
- packages/schema/src/goal.ts: goal/auditor contracts.
- packages/core/src/database/migration/20260916221336_goal_auditor_session.ts
  (new): goal_auditor_session table.

Opencode seams:
- packages/opencode/src/tool/goal.ts: turnProvenance adapter.
- packages/opencode/src/server/routes/instance/httpapi/groups/goal.ts and
  handlers/goal.ts: POST /session/:sessionID/goal/prepare.

Tests:
- packages/core/test/goal/{creation-policy,auditor,goal}.test.ts,
  packages/opencode/test/tool/goal.test.ts.
```

<details><summary>Files in this commit</summary>

```text
A	packages/core/src/database/migration/20260916221336_goal_auditor_session.ts
M	packages/core/src/goal/agent.ts
M	packages/core/src/goal/auditor-prompt.ts
M	packages/core/src/goal/auditor.ts
M	packages/core/src/goal/automation.ts
A	packages/core/src/goal/creation-policy.ts
M	packages/core/src/goal/index.ts
M	packages/core/src/goal/sql.ts
M	packages/core/src/tool/goal.ts
M	packages/core/test/goal/auditor.test.ts
A	packages/core/test/goal/creation-policy.test.ts
M	packages/core/test/goal/goal.test.ts
M	packages/opencode/src/server/routes/instance/httpapi/groups/goal.ts
M	packages/opencode/src/server/routes/instance/httpapi/handlers/goal.ts
M	packages/opencode/src/tool/goal.ts
A	packages/opencode/test/tool/goal.test.ts
M	packages/schema/src/goal.ts
```

</details>

### `c64e8aff8b` feat(app): consume server telemetry and usage projections instead of message history

```text
Dense session surfaces now read materialized Session/Usage projections rather
than hydrating or scanning messages/parts to decorate rows.

- packages/app/src/context/server-sync.tsx (+ test): batched telemetry
  ensure/apply from `session.telemetry.updated`, plus session index
  directory/reindex tracking.
- packages/app/src/components/prompt-input/live-generation-rate.ts: derive
  tokens/sec and phase from telemetry.step/phase (no part sampling).
- packages/app/src/pages/session/v2/chat-sidebar-pane{,-state}.tsx (+ test):
  per-row telemetryLive/contextPercent/aggregates from the projection.
- packages/app/src/utils/server-compat.ts, hooks/use-limits/index.ts,
  components/usage/use-usage-valuation.ts, pages/usage/usage-page-models.tsx,
  components/usage/usage-model-groups.ts (+ tests): usage/pricing/credits from
  server usage profiles and generationMs.
- packages/app/src/context/personal-usage.tsx: replace persisted message-scan
  store with the server usage.modelProfile snapshot; export
  PersonalUsageProvider (app.tsx / app-session-routes.tsx re-wire the provider
  above ServerSync).
- packages/app/src/components/{session-context-usage.tsx,
  session/session-context-tab.tsx, models/models-panel-content.tsx,
  dialog-manage-models.tsx, model-tooltip.tsx,
  pages/session/composer/session-composer-controls.ts}: telemetry-backed
  context/economics; drop global provider queries and message-scan fallbacks.
- packages/app/src/context/global-sync/bootstrap.ts: prefer
  sdk.global.health().path when no directory is supplied (no cwd fallback).
```

<details><summary>Files in this commit</summary>

```text
M	packages/app/src/app-session-routes.tsx
M	packages/app/src/app.tsx
M	packages/app/src/components/dialog-manage-models.tsx
M	packages/app/src/components/model-tooltip.tsx
M	packages/app/src/components/models/models-panel-content.tsx
M	packages/app/src/components/prompt-input/live-generation-rate.ts
M	packages/app/src/components/session-context-usage.tsx
M	packages/app/src/components/session/session-context-tab.tsx
M	packages/app/src/components/usage/usage-model-groups.test.ts
M	packages/app/src/components/usage/usage-model-groups.ts
M	packages/app/src/components/usage/usage-model-identity.test.ts
M	packages/app/src/components/usage/use-usage-valuation.ts
M	packages/app/src/context/global-sync/bootstrap.ts
M	packages/app/src/context/personal-usage.tsx
M	packages/app/src/context/server-sync.test.ts
M	packages/app/src/context/server-sync.tsx
M	packages/app/src/hooks/use-limits/index.ts
M	packages/app/src/pages/session/composer/session-composer-controls.ts
M	packages/app/src/pages/session/v2/chat-sidebar-pane-state.test.ts
M	packages/app/src/pages/session/v2/chat-sidebar-pane-state.ts
M	packages/app/src/pages/session/v2/chat-sidebar-pane.tsx
M	packages/app/src/pages/usage/usage-page-models.tsx
M	packages/app/src/utils/server-compat.ts
```

</details>

### `3b5950ad07` feat(app): project model sections and add provider/auto-accept settings

```text
- packages/app/src/components/dialog-select-model-search.ts (+ test): new
  selectModelSections makes Favorites/Recent a projection of the
  search-filtered rows (at most one row per model group, a favorite never
  repeats under Recent, recency order from recentGroupKeys).
- packages/app/src/components/dialog-select-model.tsx: controller returns
  sections(); providerGroups suppresses rows already shown in a visible
  section; remove useSync buildHitRateIndex/buildModelCostIndex fallbacks.
- packages/schema/src/model-select/{badges,cost,usage-yield}.ts and
  packages/app/src/utils/model-badges.test.ts: freeTierOf becomes the single
  free-tier owner; shared cost/yield helpers.
- Provider settings: packages/app/src/hooks/use-provider-settings.ts (new) and
  use-model-visibility-settings.ts (new); dialog-custom-provider.tsx,
  dialog-connect-provider.tsx, settings-providers.tsx,
  settings-v2/providers.tsx, settings-models.tsx, settings-v2/models.tsx,
  hooks/use-providers.ts split directory-scoped vs global credentials and stop
  falling back to global cwd.
- New-session auto-accept default:
  packages/app/src/context/permission-auto-respond.ts (+ test) adds
  directoryAutoAccept/resolveNewSessionAutoAccept; context/permission.tsx,
  context/settings.tsx, components/prompt-input.tsx,
  components/prompt-input/submit.ts, settings-general.tsx,
  settings-v2/general.tsx wire the setting; e2e
  packages/app/e2e/regression/auto-accept-permissions-default.spec.ts (new).
```

<details><summary>Files in this commit</summary>

```text
A	packages/app/e2e/regression/auto-accept-permissions-default.spec.ts
M	packages/app/src/components/dialog-connect-provider.tsx
M	packages/app/src/components/dialog-custom-provider.tsx
M	packages/app/src/components/dialog-select-model-search.test.ts
M	packages/app/src/components/dialog-select-model-search.ts
M	packages/app/src/components/dialog-select-model.tsx
M	packages/app/src/components/prompt-input.tsx
M	packages/app/src/components/prompt-input/submit.ts
M	packages/app/src/components/settings-general.tsx
M	packages/app/src/components/settings-models.tsx
M	packages/app/src/components/settings-providers.tsx
M	packages/app/src/components/settings-v2/general.tsx
M	packages/app/src/components/settings-v2/models.tsx
M	packages/app/src/components/settings-v2/providers.tsx
M	packages/app/src/context/permission-auto-respond.test.ts
M	packages/app/src/context/permission-auto-respond.ts
M	packages/app/src/context/permission.tsx
M	packages/app/src/context/settings.tsx
A	packages/app/src/hooks/use-model-visibility-settings.ts
A	packages/app/src/hooks/use-provider-settings.ts
M	packages/app/src/hooks/use-providers.ts
M	packages/app/src/utils/model-badges.test.ts
M	packages/schema/src/model-select/badges.ts
M	packages/schema/src/model-select/cost.ts
M	packages/schema/src/model-select/usage-yield.ts
```

</details>

### `ea60dd53d8` feat(app): rebuild Goal Mode as an inline composer shelf

```text
Replace the floating Goal popover with an inline, spring-animated dock panel
that stacks with the todo dock.

- packages/app/src/components/goal-composer-shelf.tsx: 42px summary row,
  GoalCriteriaTicks, KeybindV2 checklist (roving tabindex, digit shortcuts),
  Disclosure sections, sticky status/action bar; useSpring reveal measures the
  panel; a different Goal resets expansion.
- packages/app/src/context/goals.ts and
  packages/app/src/components/prompt-input-v2.tsx: drop the goalShelf slot and
  the client-supplied projectID/workspaceID from createAndFocus (server now
  derives them).
- packages/app/src/pages/session/composer/{question-controller,
  session-composer-region-controller,session-composer-region,
  session-question-card}: re-pick clears single-choice answers; wire the shelf
  into the composer region.
- packages/session-ui/src/v2/components/prompt-input/index.tsx (+ stories):
  remove the retired goalShelf fixture.
- e2e packages/app/e2e/regression/{goal-composer-shelf,goal-mode-lifecycle}.spec.ts
  updated for the inline panel.
```

<details><summary>Files in this commit</summary>

```text
M	packages/app/e2e/regression/goal-composer-shelf.spec.ts
M	packages/app/e2e/regression/goal-mode-lifecycle.spec.ts
M	packages/app/src/components/goal-composer-shelf.tsx
M	packages/app/src/components/prompt-input-v2.tsx
M	packages/app/src/context/goals.ts
M	packages/app/src/pages/session/composer/question-controller.ts
M	packages/app/src/pages/session/composer/session-composer-region-controller.ts
M	packages/app/src/pages/session/composer/session-composer-region.tsx
M	packages/app/src/pages/session/composer/session-question-card.tsx
M	packages/session-ui/src/v2/components/prompt-input/index.tsx
M	packages/session-ui/src/v2/components/prompt-input/prompt-input.stories.tsx
```

</details>

### `b6c44405a8` perf(app): trim sidebar, menu, tooltip, and markdown-target reactive work

```text
- packages/app/src/components/markdown-target-actions.tsx: one delegated
  ancestor walk, geometry equality check, shared scroll/resize listeners only
  while active, parent-scoped MutationObserver, one RAF per frame.
- packages/app/src/pages/layout/{sidebar-project,sidebar-shell}.tsx:
  isWorking reads the shared workingDirectories index; expanded no longer
  forced by mobile.
- packages/app/src/components/titlebar.tsx: skip re-navigation for the
  already-active tab; packages/app/src/context/tabs.tsx ignores identical
  navigations.
- packages/app/src/components/session-menu/{menu-renderer,session-context-menu,
  session-menu-model,menu-model}: multiline menu rows with a description slot.
- packages/ui/src/v2/components/{menu-v2.css,tooltip-v2.tsx} and
  packages/ui/src/v2/components/tooltip-v2-observer.ts (new): shared tooltip
  observer and multiline CSS.
- packages/app/src/{context/language.tsx,i18n/en.ts,pages/layout.tsx,
  pages/session.tsx,pages/draft-route.tsx}: plural keys and routing cleanup.
```

<details><summary>Files in this commit</summary>

```text
M	packages/app/src/components/markdown-target-actions.tsx
M	packages/app/src/components/session-menu/menu-model.ts
M	packages/app/src/components/session-menu/menu-renderer.tsx
M	packages/app/src/components/session-menu/session-context-menu.tsx
M	packages/app/src/components/session-menu/session-menu-model.ts
M	packages/app/src/components/titlebar.tsx
M	packages/app/src/context/language.tsx
M	packages/app/src/context/tabs.tsx
M	packages/app/src/i18n/en.ts
M	packages/app/src/pages/draft-route.tsx
M	packages/app/src/pages/layout.tsx
M	packages/app/src/pages/layout/sidebar-project.tsx
M	packages/app/src/pages/layout/sidebar-shell.tsx
M	packages/app/src/pages/session.tsx
M	packages/ui/src/v2/components/menu-v2.css
A	packages/ui/src/v2/components/tooltip-v2-observer.ts
M	packages/ui/src/v2/components/tooltip-v2.tsx
```

</details>

### `b03f85a3fe` fix(workbuddy): present first-party identity and classify account-forbidden auth

```text
Stop self-identifying as a third-party reverse proxy and make account-scoped
Tencent restrictions first-class, without forging device attestation.

- packages/opencode/src/plugin/workbuddy-identity.ts (new): resolve installed
  app/CLI versions and compose the official User-Agent plus X-Product/X-IDE-*
  headers; deliberately no Qimei36/X-Private-Data.
- packages/opencode/src/plugin/workbuddy.ts: official UA/headers, omit empty
  X-Enterprise-Id/X-Tenant-Id, drop Content-Type on GETs, shared trace and
  conversation lifecycle headers, no_proxy gateway bypass.
- workbuddy-model-entitlement.ts: 11140/11142 -> ACCOUNT_FORBIDDEN
  (WORKBUDDY_FORBIDDEN_COOLDOWN_MS, 1h), 11155 thinking round-trip, 429+14018
  -> quota exhaustion.
- workbuddy-governor.ts: forbidden admission/quarantine, RefreshResult, clear
  learned blocks, transient refresh no longer persists AUTH_INVALID.
- workbuddy-accounts.ts: router excludes forbidden accounts, deprioritizes
  AUTH_INVALID, auto-rotates pinned sessions, tries desktop heal.
- plugin/index.ts, plugin/verdent.ts, quota/providers/workbuddy.ts: identity +
  refresh alignment.
- script/probe-workbuddy-refresh.ts (new): live re-auth probe (prints no
  tokens).
- tests: test/plugin/workbuddy-{11140,identity,reauth,thinking}.test.ts (new).
- HY4_WORKBUDDY_FINDINGS.md: ASAR auth findings and live 11140 blast radius.
```

<details><summary>Files in this commit</summary>

```text
M	HY4_WORKBUDDY_FINDINGS.md
A	packages/opencode/script/probe-workbuddy-refresh.ts
M	packages/opencode/src/plugin/index.ts
M	packages/opencode/src/plugin/verdent.ts
M	packages/opencode/src/plugin/workbuddy-accounts.ts
M	packages/opencode/src/plugin/workbuddy-governor.ts
A	packages/opencode/src/plugin/workbuddy-identity.ts
M	packages/opencode/src/plugin/workbuddy-model-entitlement.ts
M	packages/opencode/src/plugin/workbuddy.ts
M	packages/opencode/src/quota/providers/workbuddy.ts
A	packages/opencode/test/plugin/workbuddy-11140.test.ts
A	packages/opencode/test/plugin/workbuddy-identity.test.ts
A	packages/opencode/test/plugin/workbuddy-reauth.test.ts
A	packages/opencode/test/plugin/workbuddy-thinking.test.ts
```

</details>

### `98d9499d55` refactor(opencode): finish Claude bridge ownership and abort proven reasoning runaways

```text
- Delete the unused packages/opencode/src/claude/index.ts barrel.
- packages/opencode/src/claude/bridge.ts: MAX_RETAINED_ENTRIES prune of terminal
  entries; tool-bridge.ts registerDisposer binds store lifetime to instance
  teardown.
- packages/opencode/src/claude/{runtime,sessions}.ts: require an explicit cwd
  (no process.cwd fallback); bounded transcript discovery.
- packages/opencode/src/session/llm/claude-runtime.ts: require StreamInput
  context and surface permission-infrastructure errors instead of bogus
  denials.
- packages/opencode/src/session/llm/permission-binding.ts (new): bindPermission
  restores InstanceRef for async permission callbacks; wired in session/llm.ts.
- SPAD: config abortReasoningRunaway/reasoningRunawayChars, detector
  provenMotif/provenPeriod, policy isProvenReasoningRunaway, supervisor abort
  reason reasoning-runaway, types.
- packages/opencode/src/session/{prompt,processor,tools,status,session}.ts and
  event-v2-bridge.ts: special-agent/host-owned sessions, snapshot mutation
  leases, telemetry emission.
- tests: test/claude/*, test/session/llm-request-identity.test.ts (new),
  test/session/llm/permission-binding.test.ts (new), test/session/prompt.test.ts.
```

<details><summary>Files in this commit</summary>

```text
M	packages/opencode/src/claude/bridge.ts
D	packages/opencode/src/claude/index.ts
M	packages/opencode/src/claude/runtime.ts
M	packages/opencode/src/claude/sessions.ts
M	packages/opencode/src/claude/tool-bridge.ts
M	packages/opencode/src/event-v2-bridge.ts
M	packages/opencode/src/session/llm.ts
M	packages/opencode/src/session/llm/claude-runtime.ts
A	packages/opencode/src/session/llm/permission-binding.ts
M	packages/opencode/src/session/llm/request.ts
M	packages/opencode/src/session/processor.ts
M	packages/opencode/src/session/prompt.ts
M	packages/opencode/src/session/session.ts
M	packages/opencode/src/session/spad/config.ts
M	packages/opencode/src/session/spad/detector.ts
M	packages/opencode/src/session/spad/policy.ts
M	packages/opencode/src/session/spad/supervisor.ts
M	packages/opencode/src/session/spad/types.ts
M	packages/opencode/src/session/status.ts
M	packages/opencode/src/session/tools.ts
M	packages/opencode/test/claude/bridge.test.ts
M	packages/opencode/test/claude/integration.test.ts
M	packages/opencode/test/claude/runtime-path.test.ts
M	packages/opencode/test/claude/runtime.test.ts
M	packages/opencode/test/claude/sessions.test.ts
A	packages/opencode/test/session/llm-request-identity.test.ts
A	packages/opencode/test/session/llm/permission-binding.test.ts
M	packages/opencode/test/session/prompt.test.ts
```

</details>

### `2a1212c129` feat(opencode): add Tier-0 provider-settings/usage API and bound snapshot/inventory work

```text
- New Tier-0 group packages/opencode/src/server/routes/instance/httpapi/groups/
  provider-settings.ts and handlers/provider-settings.ts (list/models/
  credentials) mounted in api.ts without InstanceContextMiddleware; negative
  ownership test packages/opencode/test/server/httpapi-tier0-ownership.test.ts.
- Global/usage API: groups/{global,usage}.ts, handlers/{global,usage,event,file,
  session,pty,prompt-revisor}.ts; api.ts moves UsageApi to RootHttpApi;
  server.ts mounts new handlers and SessionTelemetry/UsageRecord nodes; usage
  gains modelProfile/pricingCatalog and generationMs.
- packages/opencode/src/{usage/usage.ts, session/checkpoint.ts,
  snapshot/index.ts, tool/project.ts, cli/cmd/debug/snapshot.ts,
  storage/reset-local-data.ts, share/share-next.ts}: usage aggregates over
  usage_record; single-flight snapshot captures, mutation barrier, index
  self-heal, inventory-backed file listing, per-directory subscriptions.
- packages/opencode/src/middleware/workspace-routing.ts: empty
  directory/query/header is treated as absent, never cwd.
- Session admission/groups: session/group.ts, schema/session-group.ts,
  handlers/session.ts; packages/server/src/handlers/session.ts adds
  session.telemetry (capped 512 ids), routes.ts registers it.
- Tools/background: tool/{registry,reload,shell}.ts,
  background/shell-job.ts, project/{project,vcs}.ts, installation/index.ts;
  snapshot mutation guards.
- tests: test/server/*, test/session/group.test.ts, test/usage/usage.test.ts,
  test/snapshot/snapshot.test.ts, test/tool/registry.test.ts.
```

<details><summary>Files in this commit</summary>

```text
M	packages/opencode/src/background/shell-job.ts
M	packages/opencode/src/cli/cmd/debug/snapshot.ts
M	packages/opencode/src/installation/index.ts
M	packages/opencode/src/project/project.ts
M	packages/opencode/src/project/vcs.ts
M	packages/opencode/src/prompt-revisor/runtime.ts
M	packages/opencode/src/server/routes/instance/httpapi/api.ts
M	packages/opencode/src/server/routes/instance/httpapi/groups/global.ts
A	packages/opencode/src/server/routes/instance/httpapi/groups/provider-settings.ts
M	packages/opencode/src/server/routes/instance/httpapi/groups/usage.ts
M	packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts
M	packages/opencode/src/server/routes/instance/httpapi/handlers/file.ts
M	packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts
M	packages/opencode/src/server/routes/instance/httpapi/handlers/prompt-revisor.ts
A	packages/opencode/src/server/routes/instance/httpapi/handlers/provider-settings.ts
M	packages/opencode/src/server/routes/instance/httpapi/handlers/pty.ts
M	packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts
M	packages/opencode/src/server/routes/instance/httpapi/handlers/usage.ts
M	packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts
M	packages/opencode/src/server/routes/instance/httpapi/server.ts
M	packages/opencode/src/session/checkpoint.ts
M	packages/opencode/src/session/group.ts
M	packages/opencode/src/share/share-next.ts
M	packages/opencode/src/snapshot/index.ts
M	packages/opencode/src/storage/reset-local-data.ts
M	packages/opencode/src/tool/project.ts
M	packages/opencode/src/tool/registry.ts
M	packages/opencode/src/tool/reload.ts
M	packages/opencode/src/tool/shell.ts
M	packages/opencode/src/usage/usage.ts
M	packages/opencode/test/server/httpapi-control-plane.test.ts
M	packages/opencode/test/server/httpapi-global-replay.test.ts
M	packages/opencode/test/server/httpapi-global.test.ts
M	packages/opencode/test/server/httpapi-quota.test.ts
M	packages/opencode/test/server/httpapi-sdk.test.ts
A	packages/opencode/test/server/httpapi-tier0-ownership.test.ts
M	packages/opencode/test/session/group.test.ts
M	packages/opencode/test/snapshot/snapshot.test.ts
M	packages/opencode/test/tool/registry.test.ts
M	packages/opencode/test/usage/usage.test.ts
M	packages/schema/src/session-group.ts
M	packages/server/src/handlers/session.ts
M	packages/server/src/routes.ts
```

</details>

### `d2dbaf0495` chore(release): add GitHub-hosted dev pre-release workflow and build/fork-sync updates

```text
- .github/workflows/dev-pre-release.yml (new): packages the dev CLI and creates
  a GitHub pre-release. All jobs run on ubuntu-latest (GitHub-hosted) - the
  homelab/self-hosted runner used by .github/workflows/ci.yml is never used.
  Builds packages/opencode/script/build.ts --single under OPENCODE_CHANNEL=dev,
  archives opencode-dev-linux-x64.tar.gz, and generates release notes that
  enumerate commits, changed packages with file counts, benchmarks/release
  scripts, and every changed file. This is the dev-channel stand-in for the
  upstream publish.yml that script/release dispatches and script/publish.ts
  drives; script/publish.ts (npm/AUR/desktop signing) is intentionally not run.
- packages/opencode/script/build.ts, script/build-node.ts: stamp
  OPENCODE_RELEASE_VERSION so client identity stays on the release version for
  preview builds (Console free-tier gate).
- script/fork-sync.ts (+ test): verify Goal creation-provenance surface.
- packages/mobile/dev/agent-token-provision.ts and tsconfig.json updates.
```

<details><summary>Files in this commit</summary>

```text
A	.github/workflows/dev-pre-release.yml
M	packages/mobile/dev/agent-token-provision.ts
M	packages/opencode/script/build-node.ts
M	packages/opencode/script/build.ts
M	script/fork-sync.test.ts
M	script/fork-sync.ts
M	tsconfig.json
```

</details>

## Release / workflow findings

- The workspace **does** already contain `.github/workflows/` (contrary to the
  task brief): `ci.yml` (runs on `[self-hosted, homelab]`) and `unlock.yml`
  (`ubuntu-latest`). There is **no `publish.yml`**, even though
  `script/release` runs `gh workflow run publish.yml`.
- Added `.github/workflows/dev-pre-release.yml`: all jobs on `ubuntu-latest`
  (GitHub-hosted), triggered by push to `main` and `workflow_dispatch`.
  It builds `packages/opencode/script/build.ts --single` with
  `OPENCODE_CHANNEL=dev` + an `OPENCODE_VERSION` dev stamp, archives
  `opencode-dev-linux-x64.tar.gz`, and creates a GitHub **pre-release** whose
  notes enumerate commits, changed packages, benchmark/release scripts, and
  every changed file.
- `script/publish.ts` is intentionally not executed (it publishes npm/AUR/
  desktop artifacts and needs secrets a dev pre-release must not require); it is
  referenced as the release-logic source of truth the workflow mirrors.

## Assumptions

- Push target: `origin/main` (the only fork remote/branch checked out).
- Dev version/tag format: `0.0.0-dev.<run_number>+<short-sha>` /
  `v0.0.0-dev.<run_number>+<short-sha>` unless an explicit `version` input is
  supplied to the `workflow_dispatch`.
- Git hooks: `core.hooksPath` is unset (husky not wired), so no `pre-push`
  `bun typecheck` runs. No hook was skipped via `--no-verify`.

## Reproducibility

```powershell
git ls-files -v | Where-Object { $_ -cmatch '^[a-z]' }   # list assume-unchanged watermark
git diff --ignore-cr-at-eol --name-only                  # real changes, EOL-agnostic
git log --reverse --name-status 68ad438c36..HEAD          # this document's source
git push origin main
gh workflow run dev-pre-release.yml --ref main
```

