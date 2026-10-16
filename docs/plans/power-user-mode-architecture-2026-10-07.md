# OpenFork Power User Mode — Architecture and Investigation Ledger

**Date:** 2026-10-07
**State:** Design proposal / investigation only. **No implementation authorized by this plan.**
**Repository:** /webstormprojects/opencode
**Goal:** Substantially reduce unnecessary interactive permission prompts for expert operators while preserving independent, enforceable protections against unauthorized, malicious, irreversible, and catastrophic operations.

## 0. Non-negotiable product contract

Power User Mode is **low-friction authorization, not skipped authorization**.

1. Ordinary, explainable, workspace-scoped development operations should proceed without modal interruptions.
2. Explicit denials, actor/root restrictions, agent read-only limits, credential controls, and host policy are NEVER relaxed by the mode.
3. Commands with genuinely destructive or malicious effects must not become auto-executable merely because the operator enabled Power User Mode. Known prohibited actions are denied before invocation.
4. Ambiguous / opaque effects cannot be assumed safe. They must run under a technically enforced constrained environment or require manual intervention; dangerous categories remain denied in Power User Mode even if the model insists.
5. The safety boundary must sit in the **local sidecar/tool invocation authority**, not a frontend toggle, prompt, model opinion, or shell-string heuristic.
6. Disabling the mode or revoking authority must take effect for subsequent invocations, including delegated workers and background tasks. In-flight command cancellation/termination must follow an explicit policy, not a silent UI promise.
7. No new Goal continuation mode or manual/auto Goal policy. Power User Mode is orthogonal execution authorization and cannot change Goal's intrinsic worker/auditor lifecycle.
8. Do not broadly alter the current dirty working tree, reset, stash, clean, or revert unrelated changes.

**Reality constraint:** A general-purpose command interpreter running with the full host user's filesystem, network, and process privileges cannot be guaranteed non-destructive by static syntax classification. Shell scripts, package lifecycle hooks, interpreters, environment expansion, indirect processes, symbolic links, and time-of-check/time-of-use races defeat a simple text denylist. To provide a *strict* guarantee, classify and enforce actual authority through a constrained execution boundary; otherwise fail closed for ambiguous actions. A claim of zero possible malicious effects without such confinement is not defensible.

## 1. Evidence ledger — inspected live primary checkout

Evidence is source inspection, not a claim that fresh tests were run. Preserve this distinction in follow-up work.

| ID | Status | Evidence | Implication |
| --- | --- | --- | --- |
| F01 | Confirmed source | Repository AGENTS.md and docs/map/v1-v2.md: V1 execution/local API remain production targets; V2/new-layout UI is the presentation direction | Design one shared domain policy with a narrow production V1 adapter; do not force a V2 runtime migration |
| F02 | Confirmed source | packages/app/src/context/permission.tsx, permission-auto-respond.ts: session/directory auto-accept, inheritance, defaults, explicit-off behavior, UI and server synchronization | Existing client UX and per-session controls may be reused, but are not an adequate safety authority |
| F03 | Confirmed source | packages/opencode/src/permission/index.ts: configured deny wins before auto-accept, and server auto-accept resolves asks before emitting a prompt | Reuse V1 sidecar ownership and transport; extend its decision model rather than adding renderer interception |
| F04 | Confirmed source | packages/opencode/src/permission/auto-accept-policy.ts: durable directory-scoped map/revision, bounded cache and serialization | Can provide a migration/projection path, but a boolean lacks risk, actor, resource and origin context |
| F05 | Confirmed source and test intent | packages/opencode/src/agent/agent.ts and test/agent/agent.test.ts: YOLO appends a final unrestricted allow; its test explicitly expects override of project permission denials | **YOLO is NOT the security contract for Power User Mode**; do not make the mode a renamed YOLO agent |
| F06 | Confirmed source | packages/opencode/src/tool/shell-safety.ts and test/tool/shell-safety.test.ts: narrow catastrophic recursive-delete guard for known root/home targets | Guard is useful defense in depth, not complete safety proof; tests intentionally permit scoped deletions |
| F07 | Confirmed source | packages/opencode/src/tool/shell.ts: parses shell AST and invokes catastrophicDeleteReason before ctx.ask for foreground/background shell | This entry point is protected against supported lexical patterns; opaque scripts, expansion and other execution surfaces remain unproven |
| F08 | Confirmed source | packages/opencode/src/agent/subagent-permissions.ts and session/subagent-delegation.ts: YOLO ask-to-allow propagation with inherited denies | Child sessions need monotone rights, explicit revocation and no capability amplification |
| F09 | Confirmed source | packages/opencode/src/tool/registry.ts: MCP tool invocation is permission-checked by tool identity with wildcard resources | High-impact third-party tool arguments/effects are not semantically classified by wildcard permission alone |
| F10 | Confirmed source | packages/opencode/src/tool/code.ts and V1 permission execution approvals: programmable capabilities can invoke nested host operations | Authorization must occur at each effectful host capability, not only at top-level Code tool entry |
| F11 | Confirmed source | packages/core/src/permission.ts and packages/core/src/tool/bash.ts: current/V2 has a separate permission evaluator and an unrestricted host-user shell execution path (apart from permission checks) | Cross-generation safety parity is an audit criterion; never extrapolate V1 guard coverage to V2 |
| F12 | Confirmed source | packages/opencode/src/acp/permission.ts: ACP transports permission requests to an IDE client | Mode needs truthful CLI/ACP/desktop/PWA behavior, not client-specific unapproved shortcuts |
| F13 | Confirmed source | docs/map/surfaces.md and packages/opencode/src/oxp/request-control-v1.ts: OXP has separate approved-root and external-supervision authority | Local mode cannot expand OXP root grants or turn external-path reject-only authority into allow |
| F14 | Confirmed source | packages/opencode/src/permission/index.ts invokes plugin permission.ask before UI auto-accept | Policy/guard decisions must remain authoritative even if plugins return allow |
| F15 | Confirmed source | packages/opencode/src/agent/agent.ts defaults generally permit ordinary build actions; asks concentrate on external directory, sensitive-file reads, doom-loop and user-specific rules | Establish a real baseline before claiming the feature reduces all permission prompts |

**Working tree:** At investigation time, git status showed hundreds of concurrent edits. No existing power-user-mode plan file was found by filename search. Treat concurrent changes as owned work.

### 1.1 Material gaps to resolve in implementation research

- Inventory all paths that launch subprocesses or cause remote/local side effects: shell, background shell, PTY, script/test runners, package managers, Node/Bun/Python processes, formatter/LSP commands, browser automation, desktop native IPC, custom tools, plugin hooks, MCP, Code Mode, saved capabilities, OXP and scheduled tasks. Not all were exhaustively traced during this planning pass.
- Determine actual shell launcher profiles, parser-fallback behavior, dynamic expansion, nested shell and pipeline handling, command canonicalization, interpreter invocations, environment and redirection effects.
- Establish whether every effectful V1/V2 path passes a shared authority sink. Any missing sink is a release blocker.
- Confirm persisted per-session policy semantics, connection identity, revocation, multi-client races, and inherited worker execution after sidecar restart.
- Distinguish tool-originated command content from trusted human authorization. Data from repo files, tool output, fetched pages and third-party MCP servers cannot self-authorize broader privilege.
- Map all existing configuration, managed/global restrictions, per-agent deny rules, and OXP/OFXP grants. A mode setting must not supersede them.

## 2. Architectural thesis

**Separate four independent axes:**

1. **Authorization:** Who delegated what rights, for which session/workspace and resources?
2. **Impact:** What filesystem, process, network, credential and external-world effects can occur?
3. **Confidence/enforcement:** Are those effects proven constrained by typed tools or an OS-enforced sandbox, or merely inferred from text?
4. **Interaction:** Can the host admit the operation without involving the human?

**Power User Mode changes axis 4 and the default handling of low-risk axis-2 actions. It cannot independently grant broader axis-1 authority or pretend uncertain axis-3 evidence is certainty.**

### 2.1 Proposed decision algebra

    decide(actor, session, invocation, workspace, policyRevision, environment)
      -> ALLOW | CONFINED_ALLOW | ASK | DENY

With stable reason codes, scope, evidence and risk class attached. Decisions are made by the authoritative host service immediately before execution. Effective precedence:

1. **Hard fences:** host/global policy, OXP grants, system integrity boundaries, workspace authorization, read-only agent ceiling, protected credentials, explicit operator-denied actions, platform sandbox constraints. These are not mutable by Power User Mode.
2. **Side-effect safety:** canonical target and worktree state, exact typed capability, script provenance/hash, ability to confine effects, external writes, privilege amplification, potential exfiltration, effect reversibility.
3. **Trusted, narrow approvals:** explicit, session/workspace/resource bounded permissions, never broad implicit star-rules.
4. **Power User admission:** if otherwise ASK and provably routine/authorized, admit silently; if effects are unknown, use confinement or ask; if prohibited/destructive, deny.
5. **Prompt and log:** the client receives the server decision and reason, never becomes the authority itself.

**No mutable allow decision may downgrade a DENY; no plugin/model decision may override mandatory safety.** Keep operator-intent authorizations separate from model-written session text.

### 2.2 Trust and scope

- **Authority unit:** exact active server identity + canonical workspace/worktree root + operator-selected mode + session ID + actor type + operation/resource. No implicit global carryover.
- **Child sessions:** inherit at most the parent ceiling; can be narrower. Read-only explore/plan agents remain read-only even under Power User Mode. Worker scope and root remain pinned through continuation/restart.
- **Revocation:** new calls observe current policy generation. Cached decisions include a revision or must invalidate. Running processes may need explicit revocation cancellation.
- **Workspace provenance:** workspace-scoped automatic edits do not authorize writes to sibling worktrees, ancestors, external mounts, or arbitrary home directories.
- **Symlink/reparse safety:** resolve and revalidate the actual target at invocation, not only a string prefix; guard against aliases/reparse points and races.
- **Secrets:** do not infer consent to read .env, SSH keys, credentials, or send them externally. Authorization to use a provider does not imply authority to disclose its credential.
- **Remote side effects:** OXP/OFXP, browser, deployment, git push, email, network mutation, third-party MCP and cloud actions require their own explicit, typed authority. No ambient inheritance from local Power User Mode.

## 3. Admission matrix — proposed, not existing implementation

| Operation | Proposed Power User behavior | Necessary evidence or invariant |
| --- | --- | --- |
| Search, read non-sensitive code, glob, diagnostics, git status/log/diff | ALLOW | Within authorized workspace; no secret/foreign path |
| Atomic edit/write/patch within authorized worktree | ALLOW | Conflict/stale revision guard; no overwrite of unrelated concurrent edits; explicit paths |
| Routine format/build/test on verified trusted scripts | CONFINED_ALLOW preferred; otherwise ASK | Scripts can run arbitrary code; trusted script provenance is not by itself a host-privilege boundary |
| Package install/update, dependency postinstall, ad hoc interpreters | CONFINED_ALLOW or ASK | Unknown arbitrary code and network effects; no automatic unrestricted execution |
| Delete recognized generated files in a verified project directory | ALLOW only through bounded reversible typed deletion; otherwise ASK | Canonical target, clean worktree safeguards, no silent destruction of user-created ignored files |
| Git add/commit | ALLOW for exact authorized files/task scope; otherwise ASK | No implicit staging of unrelated concurrent edits or ref mutation outside user intent |
| Git hard-reset, clean, force checkout, stash drop, worktree removal, force push | DENY in Power User Mode by default | These can destroy work or alter shared history; a separate explicit manual workflow is required |
| Recursive deletion of root/home/drive, volume operations, hostile persistence or credential exfiltration | DENY | Always-on action/impact boundary, not a mode-dependent regex |
| Privilege escalation, environment/config/credential changes outside scope | DENY or ASK under independent operator authority; NEVER silent ALLOW | Power User preference is not a credential/OS privilege grant |
| Read sensitive files, outbound HTTP POST, deployments, publishes, remote git push | ASK, narrowly scoped | Requires explicit authorization for data release or external mutation |
| Unknown shell chain, eval, downloaded script, dynamic expansion, indirect binary | CONFINED_ALLOW if OS isolation is proven, else ASK/DENY | Unknown is not safe; classifier abstention is a valid first-class result |
| Third-party MCP or programmable Code capability | Decision at actual host-side effect; do not whitelist by tool name alone | Proven provider identity, typed operation metadata, resource scope and nested permissions |

**Interpretation:** 'Destructive' is contextual. A verified replacement of one source file is a normal development mutation. Deleting a whole repository or overwriting unrelated uncommitted work is destructive. A command may be benign in intent but still unsafe in effect. Neither its name nor the model's intent is sufficient evidence.

## 4. Shell threat model and confinement requirement

Static AST classification is valuable for fast *detection* but insufficient for universal *exoneration*.

Threat classes to test: aliases/functions; shells launched inside shells; command substitution and environment interpolation; pipes/redirection; PowerShell encoded commands and invocation operators; cmd expansions; Python/Node/Bun/Ruby one-liners; sourced files; npm/bun install lifecycle hooks; test runners; compiler/plugin hooks; downloaded executables; symlink/reparse redirection; indirect scripts; job/background processes; WSL, containers and host bridges; git custom hooks; privilege and registry modifications; outbound data release; malicious repo instructions in AGENTS/README/tool output.

**Strictness strategy:**
- Prefer typed, minimal-effect capability operations over general shell for common git, file, search, test and patch workloads.
- Give the command parser a fast ALLOW/DENY/UNKNOWN classification. It may reject obvious prohibited operations, but UNKNOWN must not turn into unrestricted allow.
- For high utility with low modal count, evaluate a *real restricted execution environment*: writable roots, denied protected paths/credentials, explicit network destinations, process-tree restriction, child-process inheritance rules, resource ceilings, and an audit of host bridges. Windows Job Objects alone are NOT filesystem or credential isolation; do not count process cleanup as a sandbox. Assess actual OS/AppContainer/VM/WSL containment behavior empirically.
- If confinement is absent or unproven, run only a narrow set of semantically verified host operations silently; otherwise ask or deny. Do not market a lexical denylist as malicious-command prevention.
- Any reviewer/model classifier is advisory on ambiguous calls and can only raise concern or select review, never grant authority beyond the deterministic policy.
- Continue preserving timeouts, bounded background processes and machine safety budgets; Power User Mode is not a bypass of resource budgets.

## 5. Concrete ownership and integration design

Proposed server-owned pieces (names are design concepts, not existing modules):

1. **PermissionProfileStore (Tier 0/1 + session admission):** durable explicit mode selection, scope and revision; no incidental full instance bootstrap for settings/status reads.
2. **ExecutionPolicyEvaluator:** pure deterministic authorization precedence, minimal inputs, reason codes, independent of GUI and chosen LLM.
3. **SideEffectDescriptor:** signed/host-produced typed effect claims (paths, network destination, workspace ref operations, credential access, known command/script identity); untyped shell defaults UNKNOWN.
4. **EffectGate:** invoked immediately before every real side effect across native tools, Code capability, plugin/MCP adapter, shell launch, background shell/PTY and subagents. Unknown/uncovered tools cannot silently bypass.
5. **ConfinementProvider:** platform-specific real isolation or explicit unavailability. Cannot report 'sandboxed' merely because a process has timeout or tree-kill.
6. **DecisionLedger:** small, privacy-conscious, append-only decision observations. Include decision, source, rule, actor, workspace fingerprint, time, authority revision, and rejection class; never persist credential payloads in logs.
7. **V1 adapter:** adapt current V1 Permission.ask / ctx.ask to the common evaluator and stable event transport. Do not replace V1 runtime with current/V2.
8. **Current/V2 adapter:** ensure PermissionV2 and bash equivalent enforce the same mandatory fences if that path can execute operations.
9. **Presentation:** composer-adjacent Power User toggle, compact explicit scope ('This session' by default, optional 'This project'), persistent small status icon, and an Activity/Permissions summary for suppressed prompts and denied actions. Use V2/new-layout as canonical presentation.
10. **ACP/CLI/PWA/OXP:** expose effective server-owned mode and decision explanations. IDE frontends must not 'allow' a denied command merely by replying to a prompt. Remote agents cannot widen approved roots.

### 5.1 UX behavior

- **Default:** conventional permissions; Power User is an explicit operator opt-in.
- **Activation:** describe effective workspace/session scope in one compact affordance; do not hide an all-host/remote permission expansion behind a checkbox.
- **When allowed:** execution simply proceeds; optional unobtrusive audit entry. Avoid repeated toast spam.
- **When ambiguous:** one actionable request with precise command/resources/reason and constrained alternative, not a series of redundant tool prompts.
- **When forbidden:** immediate clear block with machine-readable reason and an allowed alternative. No endless ask-loop or silent retries.
- **Disable:** immediate authoritative switch for future work; show when already-running work cannot safely be retroactively undone.
- **Naming:** Power User Mode describes admission policy, not the agent identity. Do not silently select or alias YOLO. Existing auto-accept and YOLO need an explicit later coexistence/migration decision.

## 6. Evaluation plan and measurable release gates

### Phase 0 — pre-implementation baseline and coverage
- Instrument representative existing permission events *without changing behavior*; identify actual modal triggers and their frequency in real sessions, builds and subagents.
- Build an invocation-edge census for all tool families, including Code, plugin/MCP, OXP, PTY, browsers, scheduled tasks and fallback runtimes.
- Mark every effect sink with an owning authority, exact origin and protected boundary; identify unmediated paths.
- Record existing tests and actual permissions inheritance expectations. Snapshot UI/current runtime behavior. No perf claims without measurements.

### Phase 1 — threat corpus and reference decision model
- Prepare positive ordinary-workflow cases and adversarial cases across Bash, PowerShell and cmd, including indirect interpreter/script paths.
- Define mandatory-deny, operator-deny, auto-safe, confined-safe and abstain/ask expectations before coding heuristics.
- Explicitly distinguish **malicious intent**, **destructive effect**, **irreversibility**, **unknown effects**, and **scope violations**.
- Write property tests for precedence and monotonicity: toggling Power User cannot turn any previously explicit/hard DENY into ALLOW; children cannot gain parent-denied authority; untrusted content cannot self-grant.

### Phase 2 — dry-run authoritative policy
- Place evaluator in the host, emit shadow decisions against current behavior, no changed execution.
- Compare predicted decisions with actual tool traces and static fixtures; examine every false safe classification.
- Prefer high precision of ALLOW over maximizing the percentage of commands auto-approved. Record reason codes and abstentions.
- Verify mode persistence, generation fencing and multi-client race tests under sidecar restart.

### Phase 3 — constrained execution research
- Prototype actual constrained child execution separately from unrestricted host shell.
- Empirically prove filesystem, network, credential and process boundaries on target OS, including process trees, WSL/native host escapes, symlinks and TOCTOU.
- If robust confinement is unavailable, explicitly downscope admission to typed proof-backed capabilities. Do not ship 'strictly safe shell' based on command names alone.

### Phase 4 — guarded V1 + UI integration
- Integrate authoritative admission to V1 permission path and actual tool effect sinks, preserve V1/fork local API strategy.
- Bind the V2/new-layout session/composer UX to host effective mode, not a local optimistic boolean.
- Test subagents, Goal/Swarm continuations, Code Mode, MCP/plugin, background shell, ACP, PWA and OXP ceilings.
- Retain old auto-accept/YOLO until behavioral migrations are explicit and reproducible.

### Phase 5 — adversarial release certification
- **Hard invariant:** zero mandatory-deny executions across curated corpus and every supported entry point. Include runner/indirect commands, not only permission-evaluator unit tests.
- **Hard invariant:** zero broadening of explicit project/operator deny or agent read-only ceilings under Power User Mode.
- **Hard invariant:** zero allowed access outside bound roots or to disallowed secrets/remote destinations using indirect paths.
- **Hard invariant:** zero silent escalation after revocation, restart, child delegation or disconnected UI.
- **UX metric target (proposed, not measured):** >=90% reduction in approval modals for a predefined benign trusted-workspace benchmark, with zero measured hard-fence violations.
- **Performance budget target (proposed, not measured):** deterministic policy p95 <=10 ms excluding OS sandbox startup; track all per-call overhead and mode-toggle latency.
- **Transparency:** audit reasons for each blocked or reviewed action; no sensitive argument or credential retention.
- Test both allowed normal development and forbidden scenarios. A filter that denies every command would trivially meet safety yet fail this product goal.

## 7. Key design traps to actively avoid

1. **Rename YOLO.** Existing YOLO intentionally overrides configured project denies, contradicting the requested safety invariant.
2. **Frontend-only auto-reply.** Renderer may be hidden, disconnected, stale, or competing with mobile/ACP; client decisions are not authoritative.
3. **A giant regex blacklist.** Indirection/expansion scripts defeat lexical filtering; root recursive-delete recognition is only defense in depth.
4. **Global star-allow.** Silently expands credential, external path, plan/read-only, MCP or remote-write authority.
5. **Safety by model reasoning alone.** LLM classification can add a veto or triage but cannot be the only enforcement boundary.
6. **Trusting tool labels.** An MCP 'search' could mutate; npm 'test' may execute arbitrary scripts; git 'checkout' can discard work.
7. **Prompts as safety equivalent.** User approval and technical isolation are different properties; interactive prompting alone does not guarantee effect confinement.
8. **Unsafe cache keys.** Cached ALLOW after script changes, cwd changes, symlink retargeting, changed actor/session, policy revision, or provider change must invalidate.
9. **Treating a snapshot as universal rollback.** Git-only checkpoints do not capture ignored/untracked state, secrets, external services, or all OS effects.
10. **Conflating Goal with permission mode.** Do not introduce new Goal scheduling or continuation policy from this work.

## 8. External prior art and independent research references (as of 2026-10-07)

- [OpenCode current/V2 permissions](https://opencode.ai/v2/docs/permissions): ordered allow/ask/deny rules, saved approvals, and organizational deny policy. Architectural reference, not an OpenFork compatibility requirement.
- [OpenCode legacy permissions](https://opencode.ai/docs/agents/): V1 tool action models and subagent rules. Reference only.
- [Claude Code Auto Mode (Mar 24, 2026; GA update Jul 10, 2026)](https://claude.com/resources/articles/auto-mode): pre-tool classifier and fewer interruptions; importantly acknowledges residual false-safe classifications and recommends isolation.
- [Running Codex safely at OpenAI (May 8, 2026)](https://openai.com/index/running-codex-safely/): explicit separation between sandbox boundaries, approval policies, networking, managed restrictions, and telemetry.

**Takeaway from prior art:** combine low-friction admission with *enforceable capability boundaries*. Do not copy the weakest property of any implementation — a safety classifier without a sandbox remains probabilistic.

## 9. Recommended product decision and next engineering action

**Recommendation:** Build Power User Mode as a host-owned, explicit **risk-aware auto-admission policy** over mandatory, monotonic authorization ceilings. It should make safe development frictionless, not make arbitrary host shell privileged.

**First implementation task when authorized:** A read-only execution-surface/side-effect census and baseline prompt trace, followed by a pure decision-model test harness. The feature must NOT be implemented by flipping YOLO rules or the existing auto-accept boolean to true.

**Outstanding questions requiring measured evidence rather than a guess:**
- What fraction of real interruptions arise from external-directory, .env, doom-loop, shell or third-party tools?
- Which platform sandbox can actually enforce the desired Windows workspace boundary without breaking normal tooling?
- Which non-shell effects currently bypass both Permission.ask and shell-safety, and which side-effect sinks can be normalized?
- How should intentional, explicitly user-requested destructive maintenance exit Power User Mode into a separate manual action without ever silently escalating?
- What are the policy semantics for human remote/PWA sessions versus unattended or externally delegated OXP sessions?

**Current completion boundary:** investigation and architecture plan only; no implementation, tests or platform containment certification have been performed for this proposal.
