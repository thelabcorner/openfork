# OpenFork ownership

Canonical map for humans and for the `upstream-sync` skill. If this file and a merge commit message disagree, believe the newer of the two and update this file.

## Remotes

```
origin    https://github.com/thelabcorner/openfork.git
upstream  https://github.com/anomalyco/opencode.git
```

Default branch: `main`. Fetch `upstream/dev` for curiosity. Merge **tags**.

## Product boundary

OpenFork `main` is a **client-side product fork**. It intentionally keeps the
local OpenCode runtime/server infrastructure required by the desktop, browser, and
mobile clients, while pruning upstream hosted SaaS/backend product infrastructure.

The local sidecar is therefore part of the client architecture, not evidence that
OpenFork carries the upstream hosted backend. Our compatibility target is the
upstream local OpenCode infrastructure and behavior: preserve 1:1 fidelity where
applicable, and keep stronger fork correctness/performance behavior when it can be
composed without breaking that contract.

```powershell
bun run fork:sync preflight v1.18.29
git merge v1.18.29
bun run fork:sync resolve
# ... handle MANUAL items, re-run resolve until clean ...
bun install
git commit  # union-listing message, see a747d51764
bun run fork:sync verify --tag v1.18.29
```

`script/fork-sync.ts` owns the mechanical resolutions (DROP auto-prune,
`bun.lock` theirs+regen, canonical `package.json` union, generated
theirs+regen, fork-owned/meta ours) and enforces the semantic checklist as
failing checks. Never hand-roll an ad-hoc union script: v1.18.29 lost the
`@opencode-ai/core` `./memory` export that way. Extend `mergePackageJson`
and add a regression test in `script/fork-sync.test.ts` instead.

## KEEP workspace

`packages/app`, `client`, `codemode`, `core`, `desktop`, `effect-drizzle-sqlite`, `effect-sqlite-node`, `http-recorder`, `httpapi-codegen`, `llm`, `opencode`, `plugin`, `protocol`, `schema`, `script`, `sdk/js`, `server`, `session-ui`, `ui`.

Compatibility exception: `packages/tui` also remains in the workspace for now.
It is **not an OpenFork product surface**; embedded upstream CLI code still imports
it, so pruning it before that coupling is removed breaks install/typecheck. The
machine-readable source of truth is `keep-manifest.json`, where this is recorded as
`deferred-coupled-to-embedded-cli`.

## DROP — not on `main`

`packages/console`, `stats`, `enterprise`, `function`, `slack`, `web`, `storybook`, `cli`, `sdk-next`, `docs`, `identity`, `containers`, `infra/`, `sst.config.ts`, `github/`, `sdks/`, `nix/`.

TUI is not a product. The embedded CLI/TUI compatibility code under
`packages/opencode/src/cli` and the deferred `packages/tui` workspace leaf should
normally take upstream behavior rather than accumulate fork-specific product work.
Re-evaluate pruning only with a deliberate embedded-CLI decoupling design.

These are deleted from the branch. After every tag merge run `bun run fork:prune`. A re-added DROP path is a failed sync, not something to "fix" by keeping.

## Conflict classes

### Fork-owned — keep fork behavior

Replay an upstream hunk only when it is a clear bugfix in the same file and does not remove the feature.

| Area | Paths |
|---|---|
| Tab chrome | `packages/app/src/components/titlebar-*`, `packages/app/src/context/tabs.tsx` |
| Project explorer | `packages/app/src/components/project-explorer*`, `packages/app/src/pages/session/v2/project-explorer*` |
| Models / usage | `packages/app/src/pages/session/models-panel*`, `packages/app/src/components/models/`, `packages/app/src/context/fork-usage.tsx`, `packages/app/src/utils/fork-client.ts` |
| Hosted browser | `packages/desktop/src/main/browser/**`, `packages/app/src/pages/session/v2/browser*` |
| Session groups | `packages/schema/src/session-group*`, `packages/schema/src/event-manifest.ts` (group events), `packages/core/src/session/{group-id,sql}.ts`, `packages/core/src/database/migration/*session_group*`, `packages/opencode/src/session/group.ts`, `packages/opencode/src/tool/task.ts` (subagent auto-grouping), `httpapi/**/session-group.ts`, `packages/app/**/session-group*`, `packages/app/src/context/server-sync.tsx` (group-event coherence) |
| Pause / retitle | V1 pause/resume/regenerate-title handlers, `packages/core/src/session/title.ts` |
| SPAD | `packages/opencode/src/session/spad/**` |
| Quota | `packages/opencode/src/quota/**`, `httpapi/**/quota.ts` |
| Fork credentials | `packages/opencode/src/fork/**`, `httpapi/**/fork-credential.ts` |
| Extra tools | `packages/opencode/src/tool/{json,background,sqlite,git,typecheck,project,symbols,test,refactor,sympy,patch,archive,swarm,browser,reload,checkpoint,shell-safety}*` |
| Search extras | `packages/core/src/search/**` |
| Checkpoints | `packages/core/src/checkpoint.ts`, `packages/opencode/src/session/checkpoint.ts`, `packages/opencode/src/tool/checkpoint.ts` |
| JetBrains ACP | `packages/opencode/script/install-jetbrains-acp.ts`, `packages/opencode/src/tool/shell-safety.ts` |
| Conversation Control | `packages/schema/src/session-context.ts`, `packages/core/src/session/sql.ts` (context tables), `packages/core/src/database/migration/*conversation_control*`, `packages/opencode/src/session/context/**`, `packages/opencode/src/session/fork/**`, `httpapi/**/session-context.ts`, `packages/opencode/src/session/message-v2.ts` (context seam), `packages/app/src/components/context-ledger/**`, `packages/app/src/components/context-history/**` |
| Throughput | `packages/schema/src/session-message.ts` + `v1/session.ts` (`streamedAt`), `packages/schema/src/session-event.ts` (`Step.Streamed`, `requestSentAt` on `Step.Started`), `packages/core/src/session/{throughput,message-updater,projector,runner}` (boundary + projection + pure calc), `packages/opencode/src/session/processor.ts` (V1 stamps — the path that serves the desktop timeline), `packages/session-ui/src/components/message-part.tsx` (`toThroughputMessage`, footer meta) + `session-turn.tsx`, `packages/app/src/pages/session/timeline/message-timeline.tsx` (the chip the desktop actually renders), `packages/ui/src/i18n/en.ts` (`ui.message.throughput`) |
| Goal Mode | `packages/schema/src/goal*`, `packages/core/src/goal/**` (including `auditor.ts` + browser-safe `auditor-prompt.ts` policy/protocol), `packages/core/src/goal.ts`, `packages/core/src/tool/goal.ts`, `packages/core/test/goal/**`, `packages/core/src/database/migration/*goal*`, `packages/opencode/src/tool/goal.ts`, `httpapi/**/goal.ts`, `packages/app/src/context/goals.ts`, `packages/app/src/components/goal-composer-shelf*`. Shared seams are union-owned: V1 `session/{prompt,session}.ts`, V1 `tool/registry.ts`, V2 `core/session/{runner/llm,execution/local}.ts`, `core/tool/builtins.ts`, config + V1 config migration, `core/location-services.ts`, `app/{app,components/prompt-input-v2,components/settings-v2/general,context/settings}.tsx`, app i18n, and `session-ui/v2/components/prompt-input/index.tsx`. Preserve durable CAS state, crash-safe auditor-authored continuation reservations, Goal-context injection, worker focus inheritance, independent auditor gating, and the zinc composer shelf when taking upstream changes. |
| Meta | `docs/handoff/AGENTS.md`, `FORK.md`, `.github/workflows/**`, root `README.md`, `packages/desktop/src/main/updater.ts` |

### Union — combine both sides

| Path | Rule |
|---|---|
| `packages/opencode/src/tool/registry.ts` | Fork tools **plus** every new upstream tool |
| `packages/opencode/src/agent/agent.ts` | Take upstream agent fixes; keep native `yolo` primary mode and its final permission-allow policy |
| `packages/opencode/src/tool/shell.ts` | Take upstream shell/parser fixes; keep the `catastrophicDeleteReason` pre-execution guard |
| `packages/opencode/src/plugin/index.ts` | Union provider/plugin hooks |
| `packages/opencode/src/session/prompt.ts` | Take upstream loop/safety fixes; keep fork hooks (SPAD, quota, pause, **conversation-control compiler**, **Goal context + durable continuation + GoalAuditor semantic gate**) |
| `packages/opencode/src/session/message-v2.ts` | Keep fork hook (effective-context compiler) — upstream has no context overlay |
| `packages/opencode/src/provider/provider.ts` | Take upstream provider fixes; keep fork credential/usage hooks |
| `packages/opencode/src/server/routes/instance/httpapi/api.ts` | Re-register fork groups after upstream edits |
| `packages/opencode/src/server/routes/instance/httpapi/server.ts` | Same |
| root / package `package.json` | Canonical union in `mergePackageJson` (`script/fork-sync.ts`): **upstream versions**; union deps (upstream wins overlaps); union scripts minus `dev:console/dev:stats/dev:storybook/sso` (fork wins `dev`); union `exports`/`imports` (fork wins overlaps, reported); union `files`; **curated explicit `workspaces.packages`** — never upstream `packages/*` globs (v1.18.29 broke `bun install` via pruned `packages/slack`). |
| `bun.lock` | Regenerate with `bun install`. Never hand-merge. |
| i18n `en.ts` | Keep fork keys. Do not drop English source. |

Worked example: `git show a747d51764` (v1.18.21).

### Case-by-case — read both sides

These KEEP-path files had real conflicts in v1.18.21 but follow no blanket rule: keep fork feature hunks, take upstream bugfixes, and let `git show a747d51764` decide.

`packages/app/src/pages/session/timeline/message-timeline.tsx`, `packages/app/src/pages/session/use-session-commands.tsx`, `packages/app/src/pages/session/v2/session-file-browser-tab.tsx`, `packages/app/e2e/utils/mock-server.ts`, `packages/core/src/session/projector.ts`, `packages/core/src/session/runner/llm.ts`, `packages/opencode/src/session/llm/ai-sdk.ts`, `packages/opencode/src/session/session.ts`, `packages/core/src/session/sql.ts`

For Goal Mode specifically, `packages/core/src/session/runner/llm.ts` and `packages/opencode/src/session/prompt.ts` must continue to use the same `GoalAutomation` service and the same independent `GoalAuditor` contract. Automatic continuation is never a blind loop: the auditor gets only workspace-confined `read`, `grep`, `glob`, and the terminating `audit_verdict` tool; `complete` enters formal verification, `blocked` uses semantic hysteresis, and model/provider failure uses the separate bounded `maxAttempts` retry policy before automation blocks. The auditor prompt is a global `auditor_prompt` setting, while the auditor model is durable **per Goal** in `auditorPolicy`; do not add a global auditor-model preference. `packages/opencode/src/session/session.ts` must inherit a parent's focused Goal synchronously before returning a new child Session; Session Group decoration may remain asynchronous.

Agent-assisted Goal creation is a delegated **user-owned** action, not permission for an agent to invent durable orchestration state. `packages/core/src/goal/creation-policy.ts` is the authoritative host gate: `goal.create` is allowed only when trusted turn provenance proves that the current human user explicitly requested Goal creation/setup/start or affirmatively confirmed the immediately preceding assistant Goal-creation proposal. Never replace this with a model-supplied `userRequested`, `confirmed`, project ID, workspace ID, or similar self-attestation. V2 must carry the authoritative current user turn through `Tool.Context.userTurn`; V1 must derive the equivalent provenance from its persisted message list. `GoalAgent` derives project/workspace ownership from the durable Session row, refuses to displace a different focused Goal, treats matching retries idempotently, attributes creation to the triggering user message, defaults ordinary creation to `auto_continue`, honors explicit draft/no-start requests, and permits `unattended` only when the human turn explicitly requests unattended Goal mode.

Prompt Revisor, session-title generation, and Goal Auditor must share `packages/core/src/special-agent-completion.ts` for terminal-tool protocol handling and tool-choice compatibility. Do not reintroduce per-agent `required -> auto` negotiation or bespoke prose-retry loops. A failed completion attempt (prose/no tool, wrong or mixed tools, extra prose, or invalid completion payload) is continued in the **same special-agent conversation** with the failed assistant response preserved, unresolved tool calls settled with host protocol errors, and a bounded host-authored correction turn that exposes only the agent's completion tool. Prompt Revisor commits with `revised_prompt`, title generation with `generated_title`, and Goal Auditor with `audit_verdict`. Legacy/V1 hosts may adapt transcript formats, but the retry/classification/budget state machine remains the shared Core implementation.

### Generated — do not hand-merge

`packages/client/src/generated/**`, `packages/client/src/generated-effect/**`, `packages/sdk/js/src/gen/**`, `packages/sdk/js/src/v2/gen/**`.

Take either side, then regenerate.

### Pruned SaaS — always delete

`packages/console/**`, `packages/stats/**`, `packages/web/**`, `infra/**`, `sst.config.ts`, `nix/**`, and every other `pruneFromMain` path.

`deleted by us, modified by them` → `git rm`. Then `bun run fork:prune`.

### Tests that assume deleted fork UI

Keep the fork stub. Do not restore `#review-panel` because an upstream e2e wants it.

Unit tests carrying both fork and upstream assertions (`test/tool/websearch.test.ts`, `test/session/prompt.test.ts`, `test/session/compaction.test.ts`, `test/provider/provider.test.ts`): union the suites — fold upstream renames and new cases into the expanded fork test instead of dropping either side.

## Semantic checklist (every tag merge)

`bun run fork:sync verify` enforces the machine-checkable subset (quota
routes, fork tools, pause/regenerate-title, session groups, updater pin,
core `./memory` export, websearch union, workspaces installability, no DROP
tracked, no conflict markers). The rest still needs eyes:

- Fork credentials / Go usage cache wired
- Pause / resume / regenerate-title on V1 HttpApi
- Session groups listed
- Subagent auto-grouping intact
- Locked session-group memberships enforced
- Session-group plugin hooks registered
- Quota routes registered
- Extra tools present **and** new upstream tools present
- JetBrains custom `OpenCode (OpenFork)` ACP installer still preserves existing `~/.jetbrains/acp.json` entries
- Native YOLO ACP mode remains permission-frictionless while catastrophic recursive root/home deletion stays hard-blocked
- ACP runtime still exposes fork tools including `checkpoint`; automatic per-turn checkpoints remain active
- Websearch = fork engines ∪ upstream additions
- Plugin/provider unions intact
- Explorer/tab e2e match fork UI
- `bun run --cwd packages/desktop dev` boots
- Channel DB still fork-specific
- Updater still disabled or still this repo
- Throughput boundary stamped, `streamedAt` projected, footer chip renders a value on a live turn
- Goal API + single discriminated Goal tool registered on V1/V2
- Goal context remains request-only on both runners; no synthetic transcript Goal messages
- Durable Goal continuation reservations survive restart and user input supersedes them
- Goal child workers inherit focus before first prompt and remain in normal Session Groups
- Goal composer shelf remains an absolute V2 zinc surface below the existing mention/command popover z-layer

## License

MIT. Keep the 2025 opencode copyright. Quota is a port of OpenChamber (MIT) — keep that attribution.
