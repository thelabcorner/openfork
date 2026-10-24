# Hosted provider routes for OpenFork special agents

## Failure mode

An OpenFork-owned special-agent request can accidentally inherit a parent Session's OpenCode Public/free binding, or choose Public under an unpinned account-routing strategy, even when authenticated accounts are configured. Upstream may reject the resulting request with "OpenCode's free tier can only be used from within OpenCode." Retries do not fix this deterministic route/admission mismatch.

OpenFork must not forge hosted credentials or impersonate another product to bypass upstream admission. Treat upstream OpenCode Zen/Go endpoints, headers, model identity, and quota as an external compatibility contract; repair local routing before provider dispatch.

## Source of truth and execution

1. Provider and ProviderRoute own actual candidate eligibility, model-to-account capability, credential-backed transport, and route attribution. Catalog membership does not prove route eligibility. The V1 Provider service's routed availability check is the **authoritative Public/free eligibility gate** for special-agent requests: callers declare `executionPurpose: "special-agent"`, not a locally computed `allowPublic: false` flag.
2. A normal user/worker Session owns its durable ProviderRoute and is unchanged by this special-agent policy.
3. When a maintenance child inherits an existing *account* route, compile precisely that committed generation. No automatic account failover, rebinding, or revision changes.
4. When the parent's hosted route is *Public*, special-agent maintenance may resolve one eligible, account-backed transient route for its own request with `executionPurpose: "special-agent"`. Never mutate the parent or persist this temporary selection.
5. Configured cross-provider or account overrides also require a transient, eligible route. Do not fall back to ambient hosted authentication or silently substitute an unrelated model after an explicit selection.
6. For detached Session special agents such as Dreamer, pass the same semantic purpose at normal child Session admission. The canonical built-in classification comes from the shared schema Agent.SpecialBuiltInTopology, not from UI visibility. The provider resolver owns the resulting Public eligibility decision.
7. The V1 LLM stream has a second defense: if the agent is a canonical built-in special agent or request-local Goal/SPAD agent, hosted execution requires explicit account route attribution before network work.

## Coverage

| Family | Account ownership |
| --- | --- |
| Goal Auditor | Production V1 Goal runtime and Core maintenance resolution; independent verdict/retry semantics remain unchanged |
| Goal/Prompt Revisor | V1 Prompt Revisor and Core Prompt Revisor; inherited account or one-call transient account |
| Title generator | Shared V1 maintenance and Core SessionTitle; same-provider and explicitly configured alternatives |
| SPAD Auditor | Shared V1 maintenance; no hosted Public fallback |
| Compaction | Inherited account or one-call transient account for Public/no-route parent, including configured tiers |
| Dreamer, summary, and other canonical built-ins | Ordinary child Session route admission with hosted Public unavailable |
| Agent generation and project-copy names | Dedicated account-backed transient route; optional project naming can fall back to local slug |

System One semantic inference is a separate, explicitly tested primitive and is not classified as a special agent. Do not modify its independently supported Public semantics as an accidental consequence of this fix.

## Other Public selectors

Normal V1 worker turns resolve durable routes through `Provider.resolveRoutedModel`; Core/current worker turns use `SessionRunnerModel.resolveWithInfo`. These are allowed to consider Public when the upstream hosted catalog, zero-cost trust, route health, and explicit user route intent permit it. Scheduled tasks and delegated workers propagate their authorized worker route intent through these same paths; they are not implicitly special agents.

Standalone System One inference uses its explicitly tested `Provider.resolveTransientRoutedModel` route, including deliberate Public selection, and is out of scope for the special-agent restriction. It identifies `executionPurpose: "system-one"` explicitly. In contrast, project-copy naming and standalone Agent generation are host-owned maintenance: both now identify their execution purpose to Provider and cannot choose hosted Public. Core/current `SessionRunnerModel.resolveMaintenanceWithInfo` already disallows Public in its maintenance resolution path and must remain aligned.

| Public-selection surface | Authoritative service | Policy |
| --- | --- | --- |
| V1 interactive Session, including explicit Public model choice | `Provider.resolveRoutedModel` + `ProviderRoute` | Preserve eligible Public and committed worker affinity |
| Current/Core interactive Session | `SessionRunnerModel.resolveWithInfo` + Core route resolver | Preserve ordinary worker Public eligibility |
| Scheduled tasks, OXP/OFXP workers, delegated workers | Their authenticated worker Session model/route-intent lineage, then the normal provider resolver | Do not classify as special agents merely because execution is automated |
| Standalone System One inference | `SystemOne.infer` + `Provider.resolveTransientRoutedModel` | Preserve explicit Public semantics for this separately contracted primitive |
| V1 Goal/Prompt Revisor, title, SPAD, compaction, Dreamer, Summary | V1 `Provider`, `executionPurpose: "special-agent"` | Account-backed hosted transport only; independent LLM dispatch fence |
| V1 Agent.generate, project-copy naming | V1 `Provider`, `executionPurpose: "special-agent"` | Account-backed hosted transport only; project-copy may use local slug fallback |
| Current/Core Goal/Prompt Revisor and Title | `SessionRunnerModel.resolveMaintenanceWithInfo` | Account-backed hosted transport only; no parent-route mutation |
| `plugin/zen` Public sentinel and provider model catalog | Transport construction and catalog projection, respectively | Not independent authorization to select Public for a special operation |

The service boundary preserves backwards compatibility for ordinary Session routing, but `executionPurpose: "special-agent"` overrides even `allowPublic: true`. Inherited maintenance routes are always Public-ineligible, regardless of whether a caller supplied the purpose marker. **Detached/transient routes default to Public-ineligible** unless the caller explicitly declares the independently supported `executionPurpose: "system-one"`; merely omitting a marker or supplying `allowPublic: true` does not enable the free tier. The Provider refuses explicit Public intent and Public inheritance before upstream model dispatch; an eligible account-backed route is materialized/attributed by the same authority. Consumer-side route-kind assertions and the V1 LLM are defense-in-depth rather than competing eligibility policies.

Existing committed Public worker Sessions stay on their exact route while upstream Public eligibility remains true. `account-first` influences **new** Adaptive/Round Robin bindings, not migration of a healthy committed worker route. If that Public route loses eligibility, the Core resolver may evaluate authorized account failover without changing a special agent's parent binding. An earlier hard account pin belongs to the explicitly pinned turn; a subsequent explicit strategy selection can soften it and apply the chosen policy. Neither behavior relaxes the special-agent restrictions.

The sticky-Public fast path must compile only the **observed Public route revision** with `compileExisting`, never run generic strategy selection with an intentionally empty account-candidate snapshot. If a concurrent request commits a different route between the two reads, the exact-generation check fails, and account candidates are fetched once to resolve the authoritative winner. In particular, an account winner must not be rebound to Public by the stale fast path; this is exercised by the deterministic concurrency test in `packages/core/test/plugin/opencode-provider-route.test.ts`.

## Negative invariants

- Never stream a hosted special-agent request using Public/free or an un-attributed ambient credential.
- Never mutate the parent's durable route or retry a model on an unrelated account/provider without its owning route policy.
- Credential revisions and account pins must be checked at materialization; stale or conflicted authorization fails visibly.
- Infrastructure/model resolution failure is not a Goal auditor verdict. Preserve Goal audit lease identity and durable recovery/backoff.
- Do not claim global typecheck or end-to-end hosted certification from isolated tests. Test against a real, authorized model/account before deployment.
- A retry button must never be used to mask a deterministic Public/free rejection.

## Verification

Run Bun tests from package directories, not the monorepo root (the root Bun test config explicitly blocks test discovery). The relevant suites include:
- packages/opencode/test/session/goal-auditor-runtime-route.test.ts
- packages/opencode/test/prompt-revisor/runtime.test.ts
- packages/opencode/test/session/regenerate-title-route.test.ts
- packages/opencode/test/session/hosted-route-policy.test.ts
- packages/opencode/test/provider/hosted-route-fail-closed.test.ts
- packages/opencode/test/session/llm-route-auth-suppression.test.ts
- packages/opencode/test/session/compaction.test.ts
- packages/opencode/test/agent/agent-generate-route.test.ts
- packages/core/test/session-maintenance-route.test.ts

Positive tests must prove account-backed execution from a Public parent with parent identity and revision unchanged. Negative tests must prove absence of provider dispatch and ambient lookup when no eligible account exists. The V1 production path is authoritative; Core/current is a semantic counterpart, not a reason to migrate V1 execution.
