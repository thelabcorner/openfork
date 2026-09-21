# Cache Bust / Cache Identity Research Ledger

**Status:** adversarially re-audited research baseline / audit-program input / no source patching yet  
**Date:** 2026-09-18  
**Scope:** cache identity, invalidation, reuse, admission, eviction, and observability across OpenCode, including application/runtime caches and provider-side LLM prompt/KV caches.  
**Governing contracts:** root `AGENTS.md`, package-local `AGENTS.md`, `docs/handoff/ARCHITECTURE-OWNERSHIP-PLAYBOOK.md`, and the package-specific performance/ownership rules.
**V2 -> V1 feasibility companion:** `docs/plans/v2-v1-cache-context-backport-feasibility.md`

This is deliberately a **research ledger, not an implementation spec**. Its job is to establish the cache laws we can defend from the repository architecture plus current primary-source provider/runtime research, inventory the relevant OpenCode cache surfaces, and separate confirmed defects from hypotheses that still need a reproducer.

The working tree is currently heavily modified by unrelated Goal Mode / scheduled-task work. This ledger is intentionally isolated in a new file. Do not modify or normalize unrelated source while this program is in the research phase.

---

## 0. Executive findings

The central finding is that “cache busting” is not one problem. OpenCode currently contains several distinct cache classes with different correctness contracts:

1. **Authoritative-domain projection caches** — derived state whose producer/owner is inside OpenCode. These must be *stale-but-never-wrong*: owner identity, generation/version/watermark, and mutation publication determine correctness.
2. **Client/UI materialization caches** — renderer shortcuts over server-owned state. These must never have broader identity than the authoritative server/workspace/account owner and must remain bounded.
3. **Remote/API response caches** — quota/catalog/usage snapshots. These need explicit credential/account/server provenance and clear stale/error semantics.
4. **Provider-side prompt/KV caches** — OpenCode does not own the storage, but it *does* own request-prefix stability. Here a “cache bust” usually means the rendered model request changed before an eligible provider breakpoint.
5. **Inference-engine KV caches** — vLLM/SGLang/DeepSeek-style block or prefix storage. These teach identity/admission/eviction principles even where OpenCode does not itself own GPU KV memory.

The most reusable architectural rule discovered in this pass is:

> **A cache key's identity cardinality must be at least the cardinality of the authoritative owner that produced the value.**

If authoritative state is owned by `(server, workspace, account)`, a cache keyed only by `workspace` is invalid even if it has a tiny TTL. A shorter TTL reduces exposure; it does not repair wrong ownership.

For model-context caches, the analogous rule is:

> **A reusable prefix exists only while every cache-sensitive input before the reuse boundary remains identical under the same provider/model/cache domain. Prefer append-only changes after a stable boundary only when doing so preserves the semantic authority of the content. Correct authority outranks cache reuse.**

### Devil's-advocate consolidation: what survived, what did not

The 2026-09-18 adversarial pass deliberately treated the earlier ledger as a
hypothesis to attack. The strongest conclusion is **not** "copy V2 Context Epochs
into V1." The stronger architecture is:

```text
authoritative semantic producer
  -> durable semantic state / correlation
  -> exact route + capability resolution
  -> authority-preserving model-visible projection
  -> provider-protocol lowering
  -> provider cache mechanics
```

The following earlier ideas survived intact:

- V1 message-level turn provenance is the right compatibility model;
- provider role is not conversational ownership;
- Goal/recovery/automation continuations are host-owned Synthetic/user-role
  turns, not privileged System content;
- cache identity must include every authoritative owner dimension;
- provider cache mechanics belong below the session semantic owner;
- deterministic local compilation should prove request shape before paid calls.

The following earlier assumptions **did not** survive unchanged:

- current V2 is an oracle only for the **semantic message taxonomy**
  (`User/Synthetic/Shell/Compaction/System`), not for every Context Epoch or
  provider-fallback mechanism;
- a chronological System update is cache-safe only when the exact route preserves
  System authority in history; lowering it to wrapped user text is protocol-valid
  but **not authority-equivalent**;
- the durable privileged-context checkpoint should compare exact rendered bytes,
  not typed values whose renderer can drift independently;
- a newly introduced required source that is temporarily unavailable must not be
  silently omitted;
- arbitrary source-authored deltas are too easy to make semantically incomplete;
  the correctness path should compose one complete effective System surface;
- durable `SessionMessage.System` cannot be treated as a provider-visible oracle
  until non-model-visible special-agent markers are removed from that semantic
  channel;
- stateful privileged context must be reprojected after compaction rather than
  summarized into lower-authority conversation history;
- Goal reservation materialization/idempotency belongs with GoalAutomation, not
  in repeated transcript scans.

The current SystemContext/SystemSurface cutover removes another layer of
unnecessary state. The durable correctness path does **not** need a typed value
codec, custom equality, prior typed value, or source-authored update/removal
prose. The provider-visible fact is the exact admitted section text.

The implemented Context Source contract is:

```ts
{
  key
  load                     // authoritative value | absent | unavailable
  render                   // value -> exact complete current section
  availability             // required | optional
}
```

with a framework-owned checkpoint such as:

```ts
{
  projectionVersion
  sections: Record<SourceKey, string> // exact admitted bytes
}
```

`absent` and `unavailable` are deliberately different. `absent` removes the
section. `unavailable` may retain the last admitted bytes only while the stored
projection format is compatible. A projection-version change is therefore not
itself a provider-visible mutation: if a source is available and re-renders to
identical bytes, the effective prompt remains unchanged. The version exists to
decide whether **unavailable persisted bytes** can be safely carried across code
changes.

Stable section ordering belongs to the composition owner, not duplicated inside
every persisted source row. The current registry already key-sorts sources; the
eventual System-surface assembler should own any broader provider/agent/context
section order exactly once.

The earlier binary `in-history | head-only` rule was also too coarse. Current
provider contracts distinguish at least three semantics, with turn-scoping as an
orthogonal capability:

```text
HEAD_ONLY
  -> project the complete current privileged surface at the head

CUMULATIVE_PRIVILEGED
  -> append additive same-authority privileged updates/overlays
  -> arbitrary persisted-state replacement/removal stays HEAD_ONLY by default
     until a framework patch protocol has its own equivalence proof

REPLACE_COMPLETE
  -> append the complete current privileged surface when the provider explicitly
     defines the latest System message as the complete effective prompt

TURN_SCOPED (orthogonal)
  -> represent temporary privileged overlays with provider-native lifetime
     semantics when available
```

Never preserve a prefix by silently weakening privileged content into user-role
text.

### Highest-priority current findings

| Priority | Confidence | Finding | Failure / cost mode |
|---|---:|---|---|
| **P0 / provider mechanism — resolved in current tree** | Native suites 59/59 Responses + 29/29 Chat; shape/economics labs green | `packages/llm` now lowers GPT-5.6+ explicit cache breakpoints and mode/TTL controls on the exact supported direct-OpenAI contract, parses cache-write accounting, and keeps Responses diagnostics separate from semantic/cache identity. `cache:"auto"` intentionally remains provider-implicit pending an admission planner. | The mechanism gap is closed without inventing an automatic-write heuristic; remaining work is economics/admission policy, not protocol plumbing. |
| **P0 / fork-local — resolved in current tree** | Historical defect proven; focused Goal integration now green after correction | The local fork previously threaded each claimed Goal continuation into V2 `LLMRequest.system`. Current code materializes the claimed reservation as durable `SessionMessage.Synthetic`, removes the `goalContinuation` system argument, and passes the exact claimed reservation ID into the post-cycle auditor. | Continuation now stays append-only conversational/provider-user state instead of mutating the privileged prefix. Keep the negative invariant so future merges cannot reintroduce the fork-local regression. |
| **P0 / fork-local correctness — resolved by current Goal split** | Historical defect remains documented; live `GoalContext` no longer carries mutable Goal state | The prior Goal source mixed mutable specification/progress into a typed privileged snapshot with incomplete delta rendering. Current `GoalContext` contributes only stable mechanism policy; mutable specification/progress are projected separately as conversational Synthetic state. | The stale privileged Goal-delta failure mode is removed rather than patched with a more elaborate delta language. Preserve the split as a regression invariant. |
| **P0 / fork-local authority model — resolved in current tree** | Live source now matches the intended lifetime split | `GoalContext` owns stable privileged Goal mechanism policy only. Mutable user-owned specification/progress are separate conversational Synthetic snapshots, so Goal progress no longer rewrites privileged System bytes. | Keep authority/lifetime classification explicit; do not merge volatile Goal state back into the privileged Context Source merely for convenience. |
| **P0 / crash consistency + ownership — resolved in current tree** | Fault regression covers the message-before-part crash boundary | Modern Goal reservations persist the causal source and derive stable continuation message/part IDs from the reservation. Retry detects/repairs the same partial turn instead of treating correlation alone as completion. | The original silent-loss window is closed for modern reservations; retain failure-point/restart tests as a permanent invariant. |
| **P0 / performance + ownership — resolved for modern reservations** | Current V1 continuation path uses reservation-owned causal source + deterministic identities | Modern reservations no longer need newest-first hydrated-history scans to prove correlation or rediscover the worker root; exact keyed lookup repairs/loads the owned turn. | Modern continuation materialization/root resolution is O(1) in transcript length. Legacy compatibility fallback remains quarantined. |
| **P0 / privileged-context correctness — resolved for the V2 ambient/context slice** | Exact-byte SystemSurface tests 20/20; SystemContext producer tests 10/10 | Live Context Sources render exact complete sections and `SystemSurface` compares admitted bytes directly with a projection version for stale-byte compatibility. Typed source-value equality is retained only in the legacy row decoder. | Renderer drift is now a semantic change when bytes change; a byte-identical fresh rerender causes checkpoint-only/no provider churn. |
| **P0 / privileged-context admission — resolved for the V2 ambient/context slice** | SystemSurface explicitly tests new required/optional unavailable sources and projection-version incompatibility | `present | absent | unavailable` are distinct. A newly required unavailable source blocks; optional policy may omit; compatible admitted bytes may be reused temporarily; incompatible required bytes never fail open across a projection-version change. | Admission semantics are framework-owned and fail closed instead of being improvised by each producer. |
| **P0 / authority preservation** | Confirmed in provider lowering + focused tests | Unsupported chronological `Message.system(...)` updates are intentionally wrapped as lower-authority user text on OpenAI Chat/Responses, Gemini, Bedrock and unsupported Anthropic paths. | The protocol request remains valid but privileged authority is not preserved. Correct semantic fallback is a complete privileged-head projection, not authority demotion for cache reuse; any request-surface/cache break is a derived consequence. |
| **P0 / runtime capability divergence — native path resolved; cross-runtime convergence remains** | Native resolver 4/4 + provider/model capability matrix 26/26 | Native `packages/llm` now derives capability from the exact selected protocol and intersects documented Anthropic model semantics with native encoder support. Unsupported models and Claude-looking proxy/OpenAI-compatible routes fail closed to `HEAD_ONLY`; turn-scoped support remains off until encoded. AI-SDK remains a distinct runtime capability path. | Preserve one effective provider/model/runtime capability boundary; never infer Anthropic semantics from model naming alone or let adapters silently demote committed privileged intent. |
| **P0 / durable-surface truth** | Confirmed by current special-agent source + focused tests | `SessionEvent.ContextUpdated` / `SessionMessage.System` is overloaded. Context Epoch emits provider-intended partial System deltas; Goal Auditor / Prompt Revisor also publish lifecycle/protocol markers, and some of those durable System rows are never inserted into the actual outbound provider request or differ from the text that is inserted. | The durable Session transcript cannot universally answer “what privileged text did the model actually see?” Cache/replay/provenance analysis built from `SessionMessage.System` can therefore be false even when storage is internally consistent. |
| **P0 / compaction authority leak** | Confirmed in `SessionCompaction.serialize()` | Compaction serializes every `SessionMessage.System` as ordinary summary input (`[System update]: ...`), then the resulting compaction checkpoint lowers as provider-user history while Context Epoch separately re-establishes current privileged state. | Removed/stale privileged state can be echoed into lower-authority historical summary while the authoritative current System surface says something else. Stateful privileged projections must be reprojected from their owner, not summarized as conversation. |
| **P0 / authority + durability** | Confirmed in V1 source; loss demonstrated with a 10-batch micro-prototype | Monitor ingress labels payload `untrusted-external-data`, drains the whole in-memory queue, formats only the newest 8 batches, and inserts them into the privileged V1 system array. | This combines an authority mismatch with loss: drained-but-unrendered batches disappear, and a failure/restart after drain can lose observations before durable admission. |
| **P0 / externally in progress** | Confirmed in prior baseline; current worktree already contains a fix | The prior module-level file content/tree caches used directory/project scope without server identity. An unrelated in-progress worktree change now scopes both through `ScopedKey.from(serverSDK().scope, directory)` and propagates `cacheScope` into `tree-store`. | Do not duplicate this patch. Our program owns the cross-server regression invariant and should verify the in-progress implementation before considering the finding closed. |
| **P0 / externally in progress** | Confirmed in prior baseline; current worktree already contains a fix + focused key test | The prior app usage-summary cache keyed only `(window, projectID)` while reading through the current `ServerSDK`. Another concurrent worktree change now includes `serverSDK().scope` in the key and adds a server-separation test. | Do not duplicate the patch. Verify the current implementation under actual server switching and preserve the owner-key invariant. |
| **P0** | High | OpenRouter free-usage client cache is process/browser-global and keyed by `includeValue`, while the backend tracker is management-key/account scoped. | Cross-server/account stale positive/negative usage can be returned before a new request is made. |
| **P0** | Confirmed | `SkillV2.list()` owns a separate `Map<Source.key, Info[]>` not invalidated by `State.reload()`. | Reload may rebuild source ownership while still serving old on-disk skill contents. |
| **P1** | High | Generic persisted quota snapshots do not yet have a consistently proven credential/account provenance contract. | Credential rotation or account switching can reuse/misattribute a previous account's snapshot or negate persistence. |
| **P1** | Confirmed architecture concern; Goal-continuation subcase externally in progress | Per-generation V1 system assembly still includes runtime-changing `goalSystem`, monitor ingress, and format-specific system text in the privileged prefix. The concurrent turn-provenance campaign is correctly moving Goal continuation itself out of this category and into a durable host-owned user-role turn. | Remaining necessary system/context changes can still invalidate much more provider KV cache than an append-only/in-history representation would. Preserve the provenance fix and address true privileged context separately. |
| **P1** | Confirmed insertion-order dependence; semantic intent still needs decision | V2 `ToolRegistry.materialize()` emits definitions in `Map` registration order. Registration timing/plugin load order therefore participates in request identity unless order is deliberately semantic. | Accidental order drift can bust provider prefixes despite an unchanged tool set. Canonicalize by stable explicit order or document/order it as semantic state. |

### Positive findings that should be preserved

- `ScopedKey.from(ServerScope, ...)` already exists in the app and is the correct primitive for server-qualified renderer cache identity. The current dirty worktree already applies it to file-content/tree cache identity; preserve that implementation and verify it rather than duplicating it.
- Terminal workspace caching already includes server scope; treat it as a positive ownership example.
- The timeline snapshot cache is bounded (16 sessions) and uses the session route/session key rather than a bare session ID.
- WorkBuddy quota caches are per stable account identity and therefore model the correct “owner identity first” approach.
- The backend usage summary cache includes database filename + semantic range + project and a usage revision, which is much closer to the desired owner/version contract than a TTL-only cache.
- MCP instructions are currently sorted by server name before rendering, which protects deterministic prompt order.
- The legacy provider-visible tool path explicitly avoids filtering schemas by session permission because schema churn would destroy prompt-cache reuse; execution permission is enforced separately. Preserve this distinction.
- V2 `SessionContextEpoch` advances its structured snapshot inside the durable `ContextUpdated` event commit. That commit coupling is a strong atomicity pattern, but the adversarial pass disproved the broader assumption that every `ContextUpdated` row is exact provider-visible System surface: special-agent producers currently use the same event for some transcript-only/lifecycle markers.
- V2 already separates `SessionMessage.Synthetic` from `SessionMessage.System`. That semantic distinction is correct: Synthetic becomes provider `user`, while System denotes privileged operator state. The current wrapped-user protocol fallback for unsupported chronological System placement is **not** authority-equivalent and must not be treated as semantic preservation.

### Audit-of-audit evidence rules

This program has already falsified or superseded several plausible early
hypotheses. Keep that behavior deliberate. Evidence precedence for this ledger is:

1. **current local source + focused test** for what this fork actually does now;
2. **current upstream implementation/spec** for intended upstream V2 behavior;
3. current primary provider/Harness documentation for external contracts;
4. historical changelogs/agent notes for rationale and evolution;
5. comments/TODOs as hypotheses only.

When two levels disagree, record the disagreement instead of averaging them.

Examples already encountered:

- the file/tree owner-key defect existed in the earlier baseline, then became an
  externally in-progress fix before this program touched it;
- historical June 4 upstream V2 notes treated model switching as an epoch
  replacement trigger, while the current June 22+ contract explicitly preserves
  the Context Epoch across model/agent switches;
- local V2 Goal integration injects continuation text into `LLMRequest.system`,
  while public upstream V2 does not. The local green integration test verifies
  that fork behavior but does not prove that the ownership decision is correct.

Every finding is therefore implicitly **branch- and time-scoped**. Contradictory
new source/runtime evidence reopens it automatically, matching the root
`AGENTS.md` performance-closure rule.

### AGENTS.md re-audit after concurrent architecture edits

The governing contracts themselves changed while this audit was running, so they
were re-read rather than treated as a static prerequisite. The new text strongly
validates several findings:

- root `AGENTS.md` now has an explicit **"Turn provenance is not provider role"**
  section: durable producers stamp ownership, `part.synthetic` is fragment
  provenance only, current `User/Synthetic/Shell/Compaction` is the oracle, and
  semantic consumers must not infer user intent from `role === "user"`;
- `packages/opencode/AGENTS.md` now explicitly requires Goal/auditor
  continuations to be durable host-owned turns and **never changing entries in
  the worker system prompt**;
- `packages/schema/AGENTS.md` now defines V1 provenance as an additive temporary
  compatibility bridge toward current semantic message kinds, not a permanent
  alternate model;
- `packages/opencode/src/session/llm/AGENTS.md` defines the default AI-SDK/native
  runtime boundary and keeps provider lowering isolated from session ownership;
- independently, the canonical `packages/llm/src/protocols/shared.ts`
  chronological-System helper explicitly requires text-only privileged updates
  and says retrieved/tool/web content must remain in ordinary user/tool channels.
  That is implementation-level provider-boundary evidence, not an AGENTS.md rule;
  this ledger previously attributed it too broadly and is corrected here.

These contracts sharpen two conclusions:

1. the concurrent V1 provenance architecture is no longer just a local design
   preference; it is repository policy;
2. monitor ingress cannot be justified as privileged System content merely by
   wrapping the untrusted payload in defensive prose. The content's owner/trust
   class must determine its semantic channel first.

No current AGENTS contract was found that contradicts the research direction in
this ledger. Where the documents propose a temporary V1 compatibility surface,
it must map 1:1 toward the current semantic taxonomy and remain explicitly
temporary per Schema guidance.

### Local fork vs upstream V2 vs DeepSeek Harness — architecture crosswalk

| Concern | Current upstream OpenCode V2 | Current local fork | DeepSeek Harness analogue | Audit verdict |
| --- | --- | --- | --- | --- |
| immutable privileged baseline | Context Epoch baseline side table | same semantics | leading durable `system/message` surface state | same goal, different authority/reconstructability tradeoff |
| hidden comparison state | Context Epoch snapshot compares typed encoded values, not exact rendered bytes | same; reads can use dedicated `readDb` | projection/session fold state with explicit projection version | OpenCode target should persist exact admitted rendered sections; projection version gates reuse of unavailable persisted bytes, not force churn when fresh bytes are identical |
| changed privileged context | route-agnostic durable chronological `System` message | same | Harness `REPLACE_COMPLETE`: complete effective prompt appended only on exact capable route/series; otherwise head replacement | semantic intent aligns, mechanics do **not**; effective provider/API-route/model/runtime capability must precede projection |
| newly required source unavailable | currently omitted during reconciliation when no prior snapshot exists | same | projection/admission policy is explicit per subsystem | OpenCode needs required-vs-optional admission semantics |
| model/provider switch | preserve Context Epoch; apply selection next provider turn | same focused tests pass | route/context changes can change cache domain without necessarily starting a message series | **do not conflate epoch, series, cache domain** |
| context-source observation fan-out | unbounded in current upstream source | bounded at 8 | framework/provider-specific bounded ownership | local performance divergence; measure but architecturally consistent with root contract |
| host orchestration message | V2 has durable `Synthetic` -> provider `user` | same type/lowering | sourced `user/message` runtime context / synthetic injections | aligned semantic primitive |
| Goal continuation | not in public upstream runner | **fork-only system-head argument** | would fit user-role sourced/synthetic history, not system prompt | local regression; move to Synthetic |
| focused Goal state | not an upstream source | fork combines mutable Goal state + stable Goal worker policy in one System source | Harness-style runtime user snapshot + separate privileged mechanism policy | **split authority first**; mutable Goal state likely does not belong in System at all |
| compaction boundary | new Context Epoch after completed compaction | same mechanism; fork uses different policy constants | surface replacement/new series/consolidation | intentional cache reset, measure policy frequency/size |
| tool/header change | request/tool definitions change | same + fork tool work | `request/header` change/series identity | classify separately from history mutation |
| tool ordering | registration / Map insertion order | same | canonical lexical order unless explicit configured `toolOrder` | decide whether order is semantic; never let incidental plugin timing define cache identity |
| final provider/proxy transform | protocol/provider adapters | plus custom fork proxies (e.g. Verdent) | exact adapter prepares route and request context | cache lab must inspect final cache-sensitive native projection |

The crosswalk is intentionally semantic rather than file-for-file. A backport or
optimization is good when it converges ownership/invariants; copying an
implementation detail from either upstream or Harness without its owner/lifetime
proof is not evidence of correctness.

The critical distinction after the adversarial pass is:

> **Current V2 is the semantic taxonomy reference, not an unquestioned cache
> implementation reference.**

Its durable `Synthetic` versus `System` distinction is exactly what V1 should
converge toward. Its current Context Source delta API, missing render version,
new-source unavailability behavior, and wrapped-user System fallback are all
valid audit targets rather than assumptions to inherit.

---

## 1. Governing OpenCode architecture contract

The repository guidance changes how this audit must be performed.

### 1.1 Investigation order

For every cache candidate:

```text
producer / durable source
  -> authoritative owning service + lifetime
  -> ownership tier
  -> projection/materialization boundary
  -> cache identity + freshness proof
  -> invalidation path
  -> transport/client cache
  -> component / hot-path consumer
```

Do not begin at `Map`, `memo`, `localStorage`, or UI callsites and infer ownership backward.

### 1.2 Cache cannot repair wrong ownership

Per repository contract, a scheduler, memo, TTL, debounce, or LRU cannot make the wrong producer acceptable. Before optimizing a cache, prove that its underlying producer belongs in that lifetime/tier.

### 1.3 Required closeout invariant

Every performance/cache patch must state a **negative invariant**: what must *not* happen after the change.

Examples:

- switching servers must not reuse a same-path file snapshot from the previous server;
- a cache hit must not bypass a generation/revision mismatch;
- a permission change must not mutate provider-visible tool schemas if authorization can be enforced at execution instead;
- a prompt-only append must not rewrite earlier history;
- a failed cache write must not advance the cache watermark beyond durable source state.

### 1.4 Cache ownership tiers

Use the root architecture tiers when classifying caches:

- **Tier 0 — process/global:** provider/account/quota metadata, global event infrastructure, truly process-global immutable/memoized values. No hidden workspace bootstrap.
- **Tier 1 — durable location metadata:** cheap location reads with explicit location, no runtime bootstrap.
- **Tier 2 — workspace config/catalog:** workspace-scoped catalogs/configuration, no execution runtime unless required.
- **Tier 3 — execution/runtime:** session execution, PTY/LSP/tool runtime, runtime config, mutation-sensitive state.

Cache identity should make tier boundaries visible rather than erase them.

---

## 2. Frontier cache-bust taxonomy

This taxonomy combines current provider documentation, DeepSeek Harness architecture, and inference-engine research.

### 2.1 Identity bust — owner changed

The value was produced for a different owner.

Common identity axes:

- server / deployment / region,
- workspace / directory / project,
- account / credential / tenant,
- database filename / durable store,
- provider / model / route,
- LoRA/adaptor identity,
- multimodal asset identity,
- permission or capability realm *when it changes model-visible content*.

**Required response:** use a different key/domain. TTL is not a substitute.

This is the class implicated by the OpenRouter free-usage and quota-provenance findings, and it was the class behind the file-cache and usage-summary bugs now being repaired by concurrent worktree changes.

### 2.2 Mutation bust — authoritative source changed

The owner is the same but its source state mutated.

Preferred mechanisms, strongest to weakest:

1. producer-owned monotonic revision / generation / sequence;
2. event-driven targeted invalidation;
3. content/version digest;
4. timestamp/mtime when the source contract makes it authoritative enough;
5. TTL as a bounded-staleness fallback.

If the producer knows exactly when a mutation commits, a TTL-only invalidation policy is usually leaving correctness/performance information unused.

### 2.3 Prefix replacement bust — model-visible earlier content changed

For provider KV/prompt caching, replacing an earlier prompt/system/tool/history token invalidates reuse from the first changed cache-sensitive token/boundary.

Typical causes documented by providers/harnesses:

- changed system/developer instructions,
- timestamps/request IDs inserted early,
- model or route changes,
- tool add/remove/reorder/schema/description changes,
- structured-output schema changes,
- reasoning effort or verbosity settings that alter hidden/rendered instructions,
- history edits/reordering/deletion,
- compaction/truncation/summarization that rewrites earlier context,
- image presence/content/detail changes,
- changed tool-choice/parallel-tool settings on providers where these affect rendered context.

### 2.4 Append-only extension — usually *not* a prefix bust

Appending after a reusable prefix preserves earlier prefix identity.

Examples:

- normal conversation growth,
- tool calls/results appended after prior history,
- newly discovered scoped instructions appended as a new retained message,
- model-switch notices appended to history (the route itself may still change cache domain),
- DeepSeek Harness in-history system updates,
- provider-supported dynamic tool references/additional tools appended later rather than replacing the initial manifest.

This distinction is central to the OpenCode prompt-assembly audit, but the
DeepSeek Harness source audit adds a necessary qualifier:

> **Append-only message growth is cache-preserving only inside a continuing
> request series, an unchanged provider cache domain, and an unchanged semantic
> authority/placement contract.**

If the tool/header surface changed, provider/model route changed, the active
surface was replaced/compacted, or route capability changed, a message can still
be appended while the request as a whole legitimately starts a new cache series.

Track these independently:

```text
message mutation: append | replace | reorder | remove
request series:    continue | break
cache domain:      same | changed
```

### 2.5 Reorder bust

Same semantic set != same cache identity.

Provider docs explicitly call out ordering for tools, and exact serialized prefix identity makes order important for many schemas/objects even when program semantics are set-like.

Audit requirements:

- canonical sort where order is semantically irrelevant;
- stable insertion order where order is semantically meaningful;
- tests that randomized registration/plugin discovery cannot reorder provider-visible definitions;
- stable JSON/property serialization when the provider hashes rendered bytes/tokens.

### 2.6 Breakpoint / segmentation bust

A shared prefix is not necessarily a *written* or *eligible* cached prefix.

Provider systems use explicit or implicit write/read boundaries. A changing suffix may cause repeated writes/misses if the system never wrote the stable boundary separately.

This is especially important for GPT-5.6+ and Claude.

### 2.6.1 Request-series break

DeepSeek Harness exposes a useful application-level boundary in addition to raw
provider prefix identity: one conversation may enter a **new request series**.
Examples include tool/header changes, surface replacement/compaction, route
capability changes, or an explicit resume/reconstruction boundary.

On a new series it can be correct to consolidate the currently effective system
state at the head, even for a route that normally supports in-history system
updates. Therefore do not classify every head replacement as an accidental bust
without first proving whether the request series continued.

**OpenCode-specific correction:** this does not imply OpenCode needs a new
persisted `RequestSeries` aggregate. Current source has no such owner, and the
semantic correctness decision can be made from current System state + exact
effective route/runtime capability. Series identity is primarily a cache/
projection optimization and diagnostic unless a future correctness invariant
proves otherwise.

The initial implementation should therefore derive a small request-surface
fingerprint/reason rather than invent another durable state machine. A known
prefix break (for example tool/header replacement) may make an opportunistic head
consolidation cheaper, but failure to perform that optimization must not change
authority or conversation meaning.

### 2.6.2 Cache isolation principal — reuse scope is also a confidentiality/accounting boundary

Provider cache identity has another axis that must not be confused with semantic
prompt identity:

```text
safe cache-reuse domain
  = semantic prefix identity
  x provider/model/cache domain
  x confidentiality / isolation principal
```

Current OpenAI GPT-5.6+ documentation is especially useful here. The provider no
longer needs `prompt_cache_key` for cache-routing optimization, but distinct keys
remain useful for accounting/isolation and reducing cross-user cache-hit probing.
Therefore changing only `prompt_cache_key` can leave the complete model-visible
input byte/structure-identical while deliberately entering a different cache
domain.

The current OpenCode V2 runner uses the Session id as `promptCacheKey`; V1 also
normally uses `sessionID`. That is a conservative **per-thread isolation
principal**, not necessarily the throughput-optimal reuse scope. Removing or
widening it to account/workspace merely to improve hit rate would broaden an
isolation boundary and therefore requires an explicit product/security owner.

Permanent rule:

> **Do not optimize away a cache-isolation dimension until the owner of that
> confidentiality/accounting boundary has explicitly chosen the wider reuse
> domain. A cache-domain change is not a semantic prompt mutation.**

### 2.7 Lifetime / eviction miss

Identity may match perfectly but the entry is gone.

Causes:

- TTL expiry,
- memory pressure / LRU eviction,
- provider machine/routing change,
- distributed-cache placement,
- cache-capacity pressure from unrelated prefixes,
- admission policy deciding not to store the entry.

These are **misses**, but not logical invalidation bugs. Instrumentation must distinguish them from identity/mutation busts.

### 2.8 Negative-cache persistence

Caching “not configured”, “not found”, failed discovery, or transient upstream failure can suppress recovery long after the underlying condition changed.

Required review questions:

- What authoritative event clears the negative?
- Is the negative keyed by the same owner identity as success data?
- Is the negative TTL intentionally shorter than positive TTL?
- Does a force-refresh path bypass it?
- Does credential/config mutation clear it immediately?

### 2.9 Publication-order / crash-consistency bust

For durable projection caches, publication order determines whether a cache can become **ahead** of its source.

Desired rule from DeepSeek Harness projection caching:

> Durable/source event first; cache checkpoint second. A crash may leave cache stale, but never ahead/wrong.

Version/watermark mismatch should cause replay/rebuild, not guessed migration.

### 2.10 Concurrency-induced accidental bust/miss

Examples:

- duplicate in-flight recomputes race to publish different generations;
- a stale in-flight response overwrites a newer generation;
- concurrent callers miss single-flight and produce duplicate cache writes;
- request routing distributes identical prefixes so widely that per-machine cache reuse collapses;
- an invalidation during an in-flight refresh is accidentally cleared by that older refresh.

Existing file-tree stale-epoch testing is a positive pattern here.

---

## 3. DeepSeek research lane

DeepSeek is valuable in this program at **three distinct layers**: model architecture, API cache semantics, and DeepSeek Harness application architecture.

### 3.1 MLA: reduce the amount of state before optimizing its eviction

DeepSeek-V2 introduced Multi-head Latent Attention (MLA), using low-rank KV compression to attack the inference-time KV-cache bottleneck itself. DeepSeek reports a 93.3% KV-cache reduction and up to 5.76x maximum generation throughput versus DeepSeek 67B in the V2 report/repository.

OpenCode lesson:

> Before tuning TTL/LRU/invalidation, ask whether the cached representation is unnecessarily large or duplicated. “Make the cache smaller” can dominate “make eviction smarter.”

Source:

- https://github.com/deepseek-ai/DeepSeek-V2

### 3.2 DeepSeek API context caching: prefix units, not fuzzy similarity

Current DeepSeek API context caching is on by default and persists disk-backed prefix units. With the newer Sliding Window Attention behavior, a reusable cache prefix is an independent complete unit; later requests hit only when they fully match an already-persisted prefix unit.

Persistence can occur at:

1. user-input and model-output request boundaries,
2. detected common prefixes across multiple requests,
3. fixed token intervals for long inputs/outputs.

The API exposes `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`.

DeepSeek also documents two important limits on interpreting a live experiment:

- cache behavior is **best effort**, not a 100% hit guarantee;
- cache construction can take seconds, and unused cache is eventually cleared
  (typically on the order of hours to days).

OpenCode lessons:

- Preserve exact prefixes rather than assuming semantically similar prompts reuse.
- Append turns instead of extending/replacing an earlier message when possible.
- Treat cache-hit/miss token metrics as first-class telemetry.
- A cache can be correct yet miss because the useful prefix unit was never persisted.
- A single live miss is not proof that OpenCode mutated the prefix; first compare
  the exact prepared request and persisted-prefix eligibility, then repeat only
  within a pre-registered bounded confirmation protocol.

Sources:

- https://api-docs.deepseek.com/guides/kv_cache/
- https://api-docs.deepseek.com/news/news0802/

### 3.2.1 DeepSeek wire roles are another reason not to use provider roles as OpenFork ontology

Current DeepSeek Chat Completions accepts a first-class `role:"system"` message
through its OpenAI-compatible API. Its Responses-compatible API accepts
`user` / `assistant` / `system` / `developer`, but explicitly documents
`developer` as being treated as `user`.

That is a useful architectural counterexample:

```text
same-looking wire role name across providers
  != same instruction-authority semantics
  != durable conversational ownership
  != human authorship
```

Therefore OpenFork must compile its own semantic kind + instruction authority
into the exact provider/API-route/runtime representation instead of treating
OpenAI-style role strings as the domain model.

Sources:

- https://api-docs.deepseek.com/api/create-chat-completion/
- https://api-docs.deepseek.com/api/create-response/

### 3.3 DeepSeek Harness: the most directly applicable application-level model

DeepSeek Harness documents model-context impact per package using three fields:

1. **What the model sees**
2. **Token effect**
3. **KV Cache effect**

This should become a cache-sensitive review discipline for OpenCode context-producing features.

Source:

- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-package.md

#### System prompt updates

Harness explicitly distinguishes:

- **head/system replacement** — rewrite from the changed token, losing earlier prefix reuse;
- **in-history system update** — append the new prompt state after cached history in a continuing series, preserving the existing prefix.

The second behavior is conditional. The exact prepared route must declare
`systemPromptUpdate: "in-history"`, and the loop must still be in the same request
series. If either condition fails, Harness consolidates/replaces the effective
prompt at the leading system node rather than blindly appending another system
message.

Source:

- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/system-prompt/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/README.md

#### Tool schemas

Harness calls schemas prefix-stable only while the visible set, rendering, and ordering remain unchanged. Registration, restriction, or reordering can invalidate reuse from the first changed schema token.

This aligns with current OpenAI and Anthropic documentation and should be treated as a cross-provider law.

#### Scoped instruction changes

Harness appends newly discovered/updated/removed instruction context to history instead of mutating earlier prompt state. This preserves the reusable prefix while still informing the model that authority changed.

Source:

- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/context/agent-instructions/README.md

#### Two projection classes: privilege and volatility stay orthogonal

Current Harness implementation separates two mechanisms that are easy to
incorrectly merge when optimizing for cache reuse:

**`SystemPromptProjection`**

- owns genuinely privileged prompt state;
- commits it as `system/message` derived history;
- appends a changed non-empty system node only on an in-history-capable route in
  a continuing request series;
- otherwise consolidates/replaces the effective system state at the head.

**`RuntimeContextProjection` / `PromptContext`**

- owns dynamic runtime facts that do not need system privilege;
- emits a complete sourced user-role snapshot;
- appends only when the complete current snapshot changes;
- keeps producer/source identity independent of provider role.

This independently supports the OpenCode distinction:

```text
turn ownership / source provenance
  != content-fragment syntheticness
  != privileged System Context authority
  != provider wire role
```

A volatile fact must not gain system privilege just because moving it later
improves cache reuse. Conversely, a genuinely privileged context update should
not be disguised as a host/user-role continuation merely to preserve the prefix.

Sources:

- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/system-prompt.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-09-02-system-prompt-as-surface-node.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/src/types.ts

#### Reconstructable request identity and request-series diagnostics

Harness materializes request identity instead of reconstructing it from provider
output later:

- `request/header` stores canonical call config + assembled tool schemas and an
  `initial | resume | change | series` reason;
- `request/context` records provider, model, context window, and the selected
  route's `systemPromptUpdate` capability when changed;
- model-visible messages are derived from the authoritative Session log;
- derived message identities and the final request envelope are frozen before
  dispatch.

OpenCode should **not** copy these exact event types merely to mirror Harness.
The deterministic cache lab should be able to explain a request transition in
equivalent dimensions from derived request facts:

```text
history changed?
system generation changed?
tool/header changed?
provider/model route changed?
system-update capability changed?
derived request surface continued or broke?
```

A single full-request hash cannot diagnose those causes. Persist a request-series
identity only if later implementation work proves that some semantic behavior,
not merely cache optimization/observability, requires it.

Sources:

- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/src/agent.ts
- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md

#### Projection caches: stale but never wrong

Harness's session projection cache stores `{ver, seq, val}` checkpoints. The durable log is authoritative; the cache is a fold shortcut. A row may be behind, and `seq` says exactly how far, but it must never be logically ahead. Version mismatch drops/rebuilds the row rather than pretending compatibility.

This is an excellent pattern for OpenCode durable/materialized projections.

The current implementation is stricter than that short summary suggests. A
persisted projection row is accepted only when its version and sequence watermark
are compatible with the authoritative log slice. Cold reads seed from the
checkpoint and replay the durable tail. A row that claims state beyond the actual
stored end, or cannot safely be advanced from the supplied tail, is rejected and
refolded rather than trusted. Listing paths may consume bounded cached hints, but
the projection cache never becomes a second history database.

Sources:

- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session-projection.md
- https://deepseekdocs.com/en/docs/learn/core/session

### 3.4 DeepSeek Harness review rule to adopt

For every OpenCode subsystem that contributes provider-visible context, document:

```text
What the model sees:
Token effect:
KV cache effect:
Mutation mode: prefix-stable | append-only | replacement | reorder | independent
Owner / cache domain:
Expected invalidation boundary:
Request-series effect: continue | break | independent
Route capability dependency:
```

This should apply to:

- system/environment prompt,
- AGENTS/instruction discovery,
- skills,
- MCP instructions,
- Goal Mode state,
- monitor/system injections,
- tool schemas and lazy-tool discovery,
- model/provider switching,
- compaction,
- structured output,
- continuation/recovery messages.

---

## 4. OpenAI GPT-5.6+ cache semantics and OpenCode drift

Current OpenAI documentation materially differs from the historical “automatic prefix caching only” model.

### 4.1 Current provider behavior

For GPT-5.6 and later:

- minimum cacheable visible prefix: 1,024 tokens;
- cache writes: 1.25x normal input rate;
- cache reads: 0.1x normal input rate;
- implicit and explicit caching are supported;
- `prompt_cache_options.mode = "explicit"` disables implicit writes/lookups except developer-selected breakpoints;
- `prompt_cache_breakpoint: { mode: "explicit" }` can mark content-block boundaries;
- up to four cache writes per request;
- current cache TTL control is `prompt_cache_options.ttl`, presently `30m`;
- `prompt_cache_key` is no longer needed for routing optimization on GPT-5.6+, but remains useful for separate accounting/isolation;
- cache diagnostics expose classified miss reasons.

Sources:

- https://developers.openai.com/api/docs/guides/prompt-caching
- https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics

### 4.2 OpenAI's documented bust/miss classes

The diagnostic reason taxonomy is useful enough to mirror internally:

- `model_changed`
- `prompt_cache_key_changed`
- `service_tier_changed`
- `tools_changed`
- `text_format_changed`
- `reasoning_effort_changed`
- `verbosity_changed`
- `context_compacted`
- `input_changed`

OpenAI also documents that changes in `parallel_tool_calls`, tool definitions/order, structured-output schema, and cache-sensitive context management can alter the rendered prefix.

### 4.3 Native capability gap — mechanism now closed in the dirty worktree

Earlier repository state had a real capability gap:

- `packages/llm/src/cache-policy.ts` applies inline cache hints only to Anthropic Messages and Bedrock Converse.
- `packages/llm/README.md` describes OpenAI as implicit/out-of-band and therefore effectively a no-op for the canonical `cache` policy.
- `packages/llm/src/protocols/openai-responses.ts` supported only
  `prompt_cache_key` among the newer cache controls;
- there was no native `prompt_cache_options` / `prompt_cache_breakpoint`
  lowering.

The current dirty worktree now closes the **mechanism** layer without changing the
default auto policy:

- provider-neutral `CacheHint` lowers to an OpenAI explicit content-block
  breakpoint only for exact direct-OpenAI GPT-5.6+ routes;
- `promptCacheOptions { mode, ttl:"30m" }` lowers for that same exact capability;
- Azure/proxies/pre-5.6 models fail closed / omit unsupported explicit markers;
- Responses and Chat both parse `cache_write_tokens` into the canonical Usage
  breakdown;
- the full native OpenAI Responses suite is 59/59 and Chat is 29/29 after the
  change;
- `cache:"auto"` intentionally still means provider implicit behavior for
  OpenAI. It does **not** inherit Anthropic's explicit-marker heuristic.

Current OpenAI docs also matter for System-surface design. The Responses/Chat
contracts admit multiple `developer`/`system`-priority messages, and the current
prompt-caching guide explicitly warns that developer messages appearing after the
initial developer block are not automatic implicit-cache lookup boundaries. It
recommends preserving reusable messages and appending new messages rather than
extending/mutating an earlier message when conversation structure allows.

That is sufficient evidence that **additive privileged suffixes** are a real
OpenAI cache surface. It is not sufficient evidence that the newest developer
message structurally replaces all older developer instructions. Do not classify
OpenAI as `REPLACE_COMPLETE` from message-role support alone. Until an exact
provider/model/runtime contract proves state replacement/removal semantics, use
later developer messages only for additive/scoped overlays and use head
consolidation for arbitrary current-state replacement.

### 4.4 Converged mechanism; automatic-write policy remains research

Do **not** blindly map the Anthropic `cache` abstraction onto OpenAI. Their breakpoint semantics differ.

Resolved mechanism decisions:

- canonical manual `CacheHint` **does** lower to explicit OpenAI content-block
  breakpoints on exact direct GPT-5.6+ routes;
- `cache:"auto"` remains provider implicit for OpenAI until a cost/reuse planner
  proves an explicit write is beneficial;
- explicit options are a provider capability, not a reason to infer them through
  Azure/OpenAI-compatible proxies;
- `prompt_cache_key` remains separate cache-isolation metadata; changing it is
  classified independently from semantic input mutation.

Additional current-provider findings:

- Responses now has a narrow diagnostics-only
  `prompt_cache_options.comparison_response_id` seam. It does not load prior
  conversation state and is classified separately from semantic input,
  cache-isolation identity, and cache mechanics;
- returned `prompt_cache_diagnostics` flow through existing provider metadata
  rather than creating Session/cache state;
- the installed `@ai-sdk/openai@3.0.88` exposes `mode` + `ttl` but not the newer
  Responses diagnostic comparison field. Native Responses can therefore observe
  newer provider diagnostics without pretending AI-SDK feature parity;
- current OpenAI Responses reference also lists `prewarm` inside
  `prompt_cache_options`, but the primary reference material audited here does
  not specify enough lifecycle/cost/result semantics to implement it safely. Keep
  it unresolved and fail by omission rather than guessing.

Remaining policy questions:

- How do we model cache-write cost so `auto` does not write volatile tails every step?
- Should `cache` carry provider-neutral intent (`stable-prefix`, `moving-conversation`, `none`) rather than provider mechanics?
- Can OpenAI diagnostics be sampled in debug/perf mode to classify real OpenCode cache busts?

### 4.5 Deterministic request-shape lab — no inference required

`packages/llm/test/cache-shape-lab.test.ts` now compiles provider-native requests
and records canonical ordered regions with:

- canonical byte length;
- per-region SHA-256;
- cumulative framed-prefix SHA-256;
- cumulative bytes;
- first differing region.

The current 9/9 matrix proves:

1. OpenAI append-only conversation keeps the full prior model-input cumulative
   prefix identical;
2. privileged-head mutation first differs at the System input region;
3. `prompt_cache_key` mutation changes only cache-isolation metadata while
   model-visible input stays identical;
4. implicit/explicit cache mode mutation changes cache mechanics, not semantic input;
5. `comparison_response_id` changes only the diagnostics/observation region and
   leaves cache isolation, cache mechanics, tools, and model-visible input unchanged;
6. an explicit GPT-5.6 System breakpoint remains stable across a dynamic user
   suffix;
7. tool-manifest mutation is independently detected before conversation history;
8. valid Anthropic chronological System append preserves prior head/history
   regions;
9. Anthropic head mutation is classified separately from chronological append.

This lab deliberately uses canonical object-key ordering while preserving array
order. JavaScript object construction order is not treated as semantic model
input; message/tool array order remains cache-sensitive.

The OpenAI region split is intentionally explicit:

```text
route/model
cache-isolation     = prompt_cache_key
cache-mechanics     = mode + ttl
cache-diagnostics   = comparison_response_id
tools
model-visible input
generation
```

That prevents an observational diagnostic request from being mislabeled as a
semantic or cache-behavior mutation.

### 4.6 GPT-5.6+ cache economics — structural admission, not a call-count heuristic

`packages/llm/test/cache-economics.test.ts` is now 7/7 green against the current
documented normalized costs:

```text
ordinary input = 1.00x
cache write    = 1.25x
cache read     = 0.10x
```

The model proves several useful limits:

- one-shot work is cheaper without an explicit cache write;
- against a fully uncached baseline, one deterministic reuse already clears the
  1.25x write premium;
- explicit stable-prefix caching beats repeatedly writing one large boundary
  whose suffix changes every request;
- **provider implicit caching beats static-only explicit caching for naturally
  append-only history**, because each next request can read the complete previous
  prefix and write only the newly appended suffix;
- the minimum future-hit probability for explicit caching to beat a fully
  uncached prefix is ~43.5% over 2 requests, ~32.6% over 3, ~24.2% over 10, and
  asymptotically ~21.74%.

Therefore automatic explicit placement should not be expressed as “after N
calls.” The candidate admission problem is structural:

```text
benefit = implicit-policy expected cost - explicit-policy expected cost

subject to:
  stable prefix size / eligibility
  volatile suffix position
  expected reuse horizon + probability
  cache isolation principal
  TTL
  provider breakpoint/write limits
  overlapping/nested candidate boundaries
```

This is a bounded cache-admission problem over producer-known volatility domains,
not a prompt-text heuristic.

---

## 5. Anthropic cache semantics

Anthropic exposes both automatic and explicit prompt caching with a hierarchy:

```text
tools -> system -> messages
```

A change earlier in that hierarchy invalidates that layer and later layers.

Current documented notable busts include:

- tool definitions changed -> tools + system + messages;
- web-search/citation toggles -> system + messages;
- `tool_choice` / parallel-tool controls -> messages;
- image presence changes -> messages;
- thinking/effort changes -> messages, and on some models earlier layers too;
- changing content at/before a breakpoint changes its cumulative prefix hash.

Anthropic specifically recommends putting a breakpoint on the **last block whose prefix remains identical** rather than on a per-request timestamp/dynamic block.

Current automatic cache lookback is block-based and bounded; a shared stable prefix outside the lookback can miss unless another breakpoint was written near it.

Tool search/deferred loading is important architecturally: dynamically discovered tools can be appended as references without rewriting the initial tool prefix.

### 5.1 Current mid-conversation System contract — 2026-09-18 verification

Current primary Anthropic documentation now gives a materially richer contract
than the local adapters encode:

- ordinary mid-conversation `role:"system"` is available on Claude Fable 5.1,
  Mythos 5.1, Fable 5, Mythos 5, Opus 4.8 and Opus 5;
- it is explicitly **not** available on Claude Sonnet 5;
- ordinary mid-conversation System no longer requires a beta header;
- the instruction applies from its point in history onward;
- when System instructions conflict, later System messages take precedence over
  earlier System messages and over the top-level `system` field for following
  turns;
- Anthropic recommends appending an evolved instruction instead of editing or
  removing an already-sent System message because mutation invalidates the cached
  prefix (and can invalidate later thinking blocks on affected models);
- `clear_at: "next_user_message"` provides turn-scoped System lifetime on the
  same supported model family, but remains beta under
  `mid-conversation-system-clear-at-2026-08-21`.

This is **cumulative privileged state**, not DeepSeek-style complete replacement.
Later conflicts win, but the provider contract does not say that omitting an old
non-conflicting instruction revokes it.

### 5.2 Confirmed local runtime divergence

Current native `packages/llm/src/protocols/anthropic-messages.ts` recognizes only
exact model id `claude-opus-4-8` for native in-history System. All other models
fall back to escaped user-role text.

The default OpenCode runtime is AI SDK. Installed `@ai-sdk/anthropic@3.0.111`
groups a later System block into inline `role:"system"` unconditionally and adds
the now-obsolete `mid-conversation-system-2026-04-07` beta. A local converter
micro-test with `[System("BASE"), User("work"), System("REMINDER")]` produced
exactly that body with no warning/model check.

Therefore the same OpenCode semantic request may be:

```text
native runtime + supported non-Opus-4.8 model
  -> authority-demoted wrapped user text

AI SDK runtime + unsupported Sonnet 5
  -> raw inline System request the provider documents as unsupported
```

This is not just a cache issue; it is request-validity and authority drift.
Capability/no-send tests must cover the runtime intersection before any
System-surface migration is enabled.

Sources:

- https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching
- https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages

### OpenCode implications

Current `packages/llm/src/cache-policy.ts` auto placement (last tool, last system part, latest user message) is directionally aligned with Anthropic, but must be audited against:

- current automatic top-level caching support;
- moving breakpoint/lookback behavior in long tool loops;
- dynamic system fragments placed before the message breakpoint;
- native versus AI-SDK cache marker parity;
- native versus AI-SDK mid-conversation System capability parity;
- model-specific thinking/history behavior;
- the four-breakpoint budget.

---

## 6. Google Gemini cache semantics

Gemini 2.5+ implicit caching is enabled by default. Google recommends large/common content first and similar prefixes close together. Explicit cached-content objects are a separate mechanism in APIs that support them; explicit cached content is immutable and tied to the model/configured content.

OpenCode implications:

- implicit-prefix stability rules still matter even without inline markers;
- mutable application state should not be injected before large reusable corpora;
- explicit cache objects, if ever adopted, need model/owner identity and lifecycle management rather than being treated as generic prompt hints.

Source:

- https://ai.google.dev/gemini-api/docs/caching

---

## 7. vLLM / inference-system principles

### 7.1 PagedAttention: cache shape matters

PagedAttention/vLLM attacks KV fragmentation and duplicate storage with paging and enables KV sharing within/across requests. The original paper reports 2-4x throughput improvements against prior systems at comparable latency in its evaluated workloads.

Source:

- https://arxiv.org/abs/2309.06180

### 7.2 Cache key includes more than tokens

vLLM's automatic prefix caching hashes:

- parent-prefix hash,
- exact block token IDs,
- extra identity such as LoRA IDs,
- multimodal input hashes,
- optionally a cache salt for tenant/security isolation.

This strongly supports the OpenCode rule that cache identity must include every dimension capable of changing the producer's result.

Source:

- https://docs.vllm.ai/en/latest/features/automatic_prefix_caching/
- https://docs.vllm.ai/en/v0.20.0/design/prefix_caching/

### 7.3 Eviction is not invalidation

vLLM tracks refcounts and evicts only reusable/free blocks under pressure, using LRU/leaf preference. A logically valid entry can disappear because capacity is finite.

OpenCode observability should distinguish:

```text
logical invalidation
identity mismatch
TTL expiration
capacity eviction
admission skip
provider/routing miss
```

rather than reporting all as generic “cache miss.”

### 7.4 BatchLLM / queue-informed research

Recent inference research shows that request ordering and admission can materially affect reuse. BatchLLM groups requests with common prefixes to avoid premature eviction and improve reuse; newer queue-informed work such as PEEK protects cache blocks with known queued future demand.

OpenCode is not an inference scheduler, but the transferable principle is useful:

> Eviction policy should consider expected future reuse/value, not only recency, when the workload exposes that signal cheaply.

Sources:

- https://arxiv.org/abs/2412.03594
- https://arxiv.org/abs/2607.02525

---

## 8. OpenCode cache inventory — confirmed high-signal surfaces

This is not yet every `Map`. A flat grep found hundreds of maps/memos, most of which are transient indexes rather than semantic caches. The audit intentionally records only state reused across time/requests/renders where freshness or owner identity can become wrong.

### 8.1 App file tree snapshot cache

File:

- `packages/app/src/context/file/tree-store.ts`

Current worktree behavior:

- module-level `scopeCache = new Map<string, TreeSnapshot>()` survives `FileProvider` remounts;
- `TreeStoreOptions` now accepts a distinct `cacheScope` whose documented purpose is identity wider than a filesystem directory;
- `FileProvider` supplies `cacheScope = ScopedKey.from(serverSDK().scope, directory)`;
- `tree-store` uses `cacheScope()` for module-cache save/restore/switch identity while keeping `scope()` as the filesystem directory used by path/list semantics;
- bounded by scope/node/live-node limits;
- per-directory freshness uses loaded/stale epochs;
- tests cover stale-during-list races, node identity, and LRU/live-tree bounds.

Worktree provenance:

This server qualification is currently an **uncommitted change from another campaign**, not work performed by this cache program. Earlier baseline inspection exposed the unqualified owner mismatch; a later ownership re-read plus `git diff` proved that another concurrent change had already addressed it. Do not edit those hunks from this program.

Required closeout proof:

1. create two FileProvider/server contexts with the same directory path but different listings;
2. warm server A;
3. remount/switch to server B;
4. assert B does **not** hydrate A's snapshot before its authoritative refresh;
5. switch back to A and prove A still receives its own warm snapshot;
6. retain the existing stale-epoch / in-flight invalidation invariants.

### 8.2 App file-content scope cache

File:

- `packages/app/src/context/file.tsx`

Current worktree behavior:

- the module-level `contentScopeCache` remains bounded and survives FileProvider remounts;
- its key is now `ScopedKey.from(serverSDK().scope, directory)` rather than bare directory;
- the same server-qualified key is used when restoring and switching cached content scope;
- content byte/LRU accounting remains a separate mechanism and should not be confused with owner identity.

Disposition:

The current worktree implements the correct ownership shape. This cache program should add/retain a regression test for equal directory strings on distinct `ServerScope` values, but should not duplicate the source patch.

### 8.3 Usage summary client cache

File:

- `packages/app/src/components/usage/use-usage-summary.ts`

Prior baseline behavior:

- module-level cache;
- 30s TTL;
- key = `(windowKey, projectID)`;
- consumer fetches through `useServerSDK()`.

Current worktree behavior:

- another uncommitted campaign has changed the key to `(serverScope, windowKey, projectID)`;
- the resource source now reacts to `serverSDK().scope`;
- cache hit/store operations use the server-qualified key;
- the same work also changes the 40-entry overflow behavior from “clear everything” to bounded LRU-style oldest-entry eviction;
- a focused unit test asserts that server A and server B produce distinct keys for the same window/project.

Disposition:

The owner-key defect is externally in progress. This program should verify server-switch behavior and avoid editing those hunks.

Contrast with backend:

- `packages/opencode/src/usage/usage.ts` includes database filename in its summary cache key and checks `UsageRecord.revision()` in addition to a short TTL.

### 8.4 OpenRouter free-usage client cache

File:

- `packages/app/src/utils/openrouter-free-usage.ts`

Current behavior:

- positive memory/localStorage cache: 15s;
- negative cache: 5m;
- key primarily varies by `includeValue`;
- backend tracker is management-key scoped.

Risk:

Frontend key has less identity than backend producer. This is especially dangerous for the 5m negative cache because a “not available” result for one server/account can suppress a valid account after switching.

### 8.5 OpenRouter endpoint cache

File:

- `packages/app/src/utils/openrouter-endpoints.ts`

Current behavior:

- model-ID keyed;
- one-hour TTL;
- public endpoint metadata;
- stale fallback on fetch failure.

Preliminary disposition:

Likely valid as a cross-server cache because the authoritative data is public OpenRouter model endpoint metadata, not the selected OpenCode server/account. Keep unless further tracing proves server-specific proxy transformation.

### 8.6 Skill materialization cache

File:

- `packages/core/src/skill.ts`

Current behavior:

- `State.create` owns source registrations/reload;
- separate `Map<Source.key, Info[]>` memoizes loaded skill contents;
- `list()` reuses this map;
- current source contains an explicit question about filesystem-watch invalidation;
- `State.reload()` reconstructs source state but does not clear this separate loaded-content map.

Confirmed defect class:

**owner reload != materialized-content invalidation.**

Required tests:

- edit a local skill file -> reload -> `list()` returns new body;
- remove/rename skill -> reload -> old skill not retained;
- unchanged source -> repeated `list()` still avoids redundant load;
- URL/discovery source identity/version behavior separately defined.

### 8.7 Quota/provider snapshot caches

Files:

- `packages/opencode/src/quota/providers/http.ts`
- individual quota adapters
- `packages/app/src/hooks/use-limits/index.ts`

Positive:

- in-memory freshness checks commonly include current credential material;
- WorkBuddy has per-stable-account caches;
- cooldown/backoff semantics have focused tests.
- the app's persistent limits-cache helper already supports `ServerScope`, and a concurrent dirty-worktree change now passes `sdk().scope` on limits cache load/save; the renderer-side server-identity defect should therefore be treated as externally in progress, not duplicated here.

Confirmed backend provenance problem:

- `quota-cache.json` entries contain `{fetchedAt, result, cooldownUntil}` under provider-oriented persistent keys, but no credential/account provenance;
- `createQuotaCache` rehydrates a persistent entry with the adapter's constructor key (for example `"deepseek"`) rather than the credential key that produced the snapshot;
- therefore `fresh(currentCredential)` cannot normally reuse a persisted success after restart, defeating the persistence optimization;
- `isCoolingDown()` and `cachedResult()` are not credential-aware, so a persisted cooldown/error/result can be served while a different credential is active;
- Claude's hand-rolled cache is more explicit: a persisted snapshot is tagged with `accessToken: "persisted"`, then adopted into whichever access token resolves first. That can attribute prior-account quota state to the first post-restart credential.

Required invariant:

Credential/account rotation must never reuse a snapshot or cooldown produced by another account. Persistence identity should use a non-secret stable account/credential identity or another provenance token—not raw secret material in durable keys.

### 8.8 Desktop storage read-through cache

File:

- `packages/desktop/src/renderer/storage.ts`

Existing tests cover:

- one bulk read rather than per-key IPC;
- remount reuse;
- negative key caching;
- read-your-own-write;
- remove/clear semantics;
- failed read not cached;
- per-store separation.

Preliminary disposition:

Mechanically strong. Future audit should focus on whether the **store filename itself** always carries the correct server/workspace/window identity. The lower-level cache behaves correctly for the namespace it is given.

### 8.9 Timeline snapshot cache

File:

- `packages/app/src/pages/session/timeline/message-timeline.tsx`

Current behavior:

- process/module snapshot of measurements/open state;
- bounded to 16 entries;
- keyed by session route/session key;
- designed to preserve virtualizer measurement reuse across tab switches.

Preliminary disposition:

Keep. It is a renderer accelerator with bounded memory and route-qualified identity, and its comments document the avoided synchronous remeasurement cost.

---

## 9. Provider-visible request assembly audit

This is a separate workstream from application cache correctness because a provider cache miss can occur even when every OpenCode `Map` is correct.

### 9.1 Current legacy/session system assembly

`packages/opencode/src/session/prompt.ts` currently builds a per-generation system array from:

1. environment/model metadata,
2. instruction files,
3. MCP instructions,
4. skills catalog,
5. Goal Mode system context,
6. monitor ingress,
7. structured-output enforcement when active.

Dynamic request-only messages may then be appended for continuation/max-step behavior.

Research concern:

`goalSystem` and monitor ingress are runtime-changing state inserted into the privileged system prefix. A small state change late in that array still invalidates provider cache reuse after its boundary; if provider rendering combines/reorders system content, the effective impact may be larger.

Do not simply move these to user messages: authority/security semantics matter. The candidate direction is to investigate **chronological/in-history operator updates** where the provider/runtime supports them, or explicit cache breakpoints before volatile privileged suffixes.

### 9.2 Environment prompt

`packages/opencode/src/session/system.ts` renders:

- exact provider/model ID,
- working directory/worktree,
- git status,
- platform,
- current calendar date,
- sorted project references.

Implications:

- model/workspace/platform identity correctly changes the prefix when authority really changes;
- current date intentionally causes a once-per-day prefix change;
- references are sorted, protecting deterministic order;
- if future dynamic values are added here, they should be reviewed as early-prefix bust multipliers.

### 9.3 MCP instructions

Current MCP instruction rendering sorts connected servers by name before joining their instructions. This is a positive deterministic-order invariant.

Changes to connected server set/instructions remain real prefix mutations and should be observable as such.

### 9.4 Tool definitions

Current legacy registry contains an explicit cache-sensitive design choice:

> Do not filter provider-visible tools by session permission; keep schema stable and enforce explicit denies in execute closure.

Preserve this. It directly matches OpenAI/Anthropic/DeepSeek Harness guidance.

Remaining audit:

- prove stable tool ordering after built-in/custom/plugin materialization;
- prove `tool.definition` plugin interception cannot nondeterministically reorder/serialize schemas;
- diff manifests across two otherwise-identical consecutive turns;
- classify every expected schema mutation source;
- compare V1 and V2/core tool pipelines.

### 9.5 Native LLM lowering

`packages/opencode/src/session/llm/native-request.ts` currently:

- extracts system messages into canonical `SystemPart`s;
- maps tools with `Object.entries(...)` order;
- forwards provider options;
- builds a canonical `LLMRequest`.

`packages/llm/src/cache-policy.ts` then owns generic inline cache-hint placement for Anthropic/Bedrock-capable routes.

The seam is architecturally good: session assembly and provider protocol lowering are separate. GPT-5.6+ cache controls should be added at this canonical protocol/policy seam, not scattered in session UI/runtime callsites.

The canonical LLM protocol layer distinguishes `LLMRequest.system` (the initial
privileged head) from chronological `Message.system(...)`. That separation is a
good abstraction boundary, but the adversarial pass found that the current
fallback is **not semantically neutral**: unsupported routes lower a privileged
chronological System update into wrapped user text.

That fallback is useful as a protocol-compatibility mechanism, but it is not an
authority-preserving context mechanism. The session/context compiler must know
the exact selected route/model capability **before** deciding whether a context
change can be represented in history:

```text
resolve exact model / route capability
  -> reconcile privileged context
  -> capable + same series: chronological privileged System
  -> otherwise: rebuild complete privileged head + new series
  -> provider protocol encoding
```

The provider layer should validate/encode the semantic strategy chosen above it;
it should not repair an impossible privileged message by silently changing its
authority class.

### 9.6 V2 Context Epoch — hardened exact-surface bridge implemented

The dirty worktree has now cut the V2 Context Epoch runner path over from the
older source-authored delta engine to the shared exact-byte
`SystemContext -> SystemSurface -> SystemProjection -> SessionContextEpoch`
pipeline for **ambient/context-source privileged state**:

```text
authoritative typed producer
  -> observe once + render exact complete current section
  -> SystemSurface reconcile against exact admitted bytes
  -> resolve exact model/native capability
  -> SystemProjection seal
  -> none | complete head rebaseline | chronological privileged append
  -> provider lowering
```

The live producer contract is deliberately small:

```text
key
load()          # value | absent | unavailable
render(value)   # exact complete model-visible section
availability    # required | optional
```

`SystemContext` no longer owns equality, source-authored update prose, or
source-authored removal prose. `observeSurface()` observes each source once,
preserves explicit `absent` versus temporary `unavailable`, retains registry
order, and uses bounded concurrency (8). Reconciliation is O(S); there is no
history scan or per-source lookup pass.

The durable checkpoint is now versioned and provider-neutral:

```ts
{
  version: 1,
  surface: SystemSurface.Snapshot,
  projection:
    | { historyActive: false }
    | {
        historyActive: true,
        history: "cumulative-privileged" | "replace-complete"
      }
}
```

It stores exact admitted section bytes plus only the projection semantics needed
to interpret chronological System rows that still survive above
`baseline_seq`. Provider/model/cache identity is intentionally not persisted as
Session semantic state.

The current Context Epoch path has these mechanically enforced properties:

- exact rendered bytes, section order, projection version and availability are
  reconciled by `SystemSurface`;
- temporary unavailability reuses compatible admitted bytes, while a new
  required unavailable source blocks and incompatible persisted bytes cannot be
  reused across a projection-version boundary;
- explicit `absent` removes prior state without manufacturing revocation prose;
- `HEAD_ONLY` projects any semantic change as the complete current head;
- `CUMULATIVE_PRIVILEGED` appends only a true ordered suffix addition;
  replacement, removal or relative reorder rebaseline the complete head;
- `REPLACE_COMPLETE` appends the complete current surface, but exists as a
  semantic capability and is not fabricated for a production provider;
- a capability/model switch with no retained chronological System suffix does
  not rewrite semantic state; if active history would be reinterpreted, the
  complete current surface is rebaselined once;
- completed compaction likewise rebaselines current privileged state;
- `baseline_seq` is specifically the chronological-System floor. Ordinary
  user/assistant/tool history survives its advancement and remains governed by
  compaction separately;
- chronological update checkpoint advancement occurs inside the durable
  `ContextUpdated` event commit boundary, so snapshot state cannot advance
  ahead of its System row;
- head rebaseline computes the current durable aggregate frontier and replaces
  the epoch row in one transaction;
- old typed `SystemContext.LegacySnapshot` rows migrate lazily by freshly
  observing/re-rendering the current complete surface and rebasing once. They
  are never reverse-engineered into supposedly exact historical bytes;
- corrupt state that is neither the current checkpoint nor a valid legacy shape
  fails closed.

The earlier adversarial gaps are therefore now historical evidence for this
slice, not current behavior: renderer drift is detected from exact bytes, newly
required unavailable context blocks, source-authored delta/removal renderers are
gone from the live producer contract, and effective native capability is
resolved before non-initial Context Epoch projection. The legacy row schema
remains only as a lazy decode boundary.

One related concurrent Goal migration also now follows the intended lifetime
split: `GoalContext` contributes only stable privileged Goal **mechanism**
policy, while mutable Goal specification/progress are projected separately as
conversational Synthetic snapshots. This prevents ordinary Goal progress from
rewriting System bytes.

Two broader gaps remain and must not be hidden by the bridge:

1. **The Context Epoch surface is not yet the final all-contributor System
   surface.** Provider/model base policy, selected-agent policy, caller System,
   stable host policy, active overlays, and V1 plugin transformation are not yet
   unified under one final assembler.
2. **Durable System semantics outside Context Epoch still require cleanup.**
   Special-agent/lifecycle markers and compaction behavior must obey the rule
   that durable System rows mean model-visible privileged surface, not generic
   host bookkeeping.

The strongest architecture found in this pass is therefore **not** “add a
`state | directive` discriminator to the current partial System updates.” It is
to make one provider-visible System surface mean exactly one thing:

> **the complete effective privileged prompt for that request generation.**

Inputs that feel like “directives” become stateful policy overlays feeding that
surface. For example, a special-agent reminder, protocol-correction mode or time
pressure is an active privileged policy layer with a lifetime; it is not a second
free-form System-message semantic class.

This closely matches current DeepSeek Harness: the assembled prompt is one
complete `system/message` surface state, and the exact route decides whether a
changed complete rendering is appended in history or consolidated at the head.

The hardened source contract is now implemented for Context Sources and is
substantially simpler than the earlier typed-snapshot design:

```text
key
load()                       # value | absent | unavailable
render(value)                # exact complete current section
availability: required | optional
```

The provider-neutral `SystemSurface.Snapshot` stores exact admitted
model-visible section bytes plus one framework projection version:

```ts
type Snapshot = {
  projectionVersion: number
  sections: Record<SourceKey, string>
}
```

Storing exact rendered bytes is deliberate. If source A changes while
previously-admitted source B is temporarily unavailable, the framework can
recompose the effective state from A's fresh rendering plus B's last admitted
bytes without reinterpreting B's typed value under code that may have changed.

A projection-version mismatch matters only when stale bytes would otherwise be
reused. If the source is available, render it under the current code and compare
the resulting bytes: an implementation refactor that produces identical text is
`Unchanged`, while changed bytes produce a new semantic generation. If a required
source is unavailable across an incompatible projection version, block dispatch.
A newly introduced required unavailable source likewise blocks. An optional
source may be omitted only by explicit policy.

Removal no longer needs prose such as “the old source no longer applies.” The
next **complete effective System surface simply omits that source**. This removes
an entire source-specific correctness burden from `removed(previous)`.

Likewise, source-authored `update(previous,current)` prose is no longer part
of the live producer API. The framework operation is:

```text
observe source(s) once
  -> produce complete current section rendering for every present source
  -> reconcile exact sections centrally
  -> compose/project the effective privileged state
```

If a future optimization introduces compact deltas, it needs an equivalence proof
against that complete surface and must preserve the same authority on every route.

### 9.6.1 One semantic System state, capability-specific provider projections

The semantic state should be route-independent, but providers do **not** share one
meaning for a later privileged message. The exact provider/model/runtime route
chooses among distinct authority-preserving projections:

```text
complete effective privileged prompt generation G
                         │
        exact effective capability
          │
          ├─ HEAD_ONLY
          │    complete G at privileged head
          │
          ├─ CUMULATIVE_PRIVILEGED
          │    additive privileged append when semantics are monotonic
          │    otherwise conservative privileged-head projection
          │    (replace complete changed section / explicit remove)
          │
          └─ REPLACE_COMPLETE
               append complete G because provider contract says
               latest privileged message is the whole effective prompt

orthogonal: TURN_SCOPED for temporary privileged overlays
```

DeepSeek Harness is evidence for `REPLACE_COMPLETE`, not for a universal
provider law: its exact-model `systemPromptUpdate: "in-history"` explicitly means
the latest System message is the complete effective prompt.

Current Anthropic semantics are `CUMULATIVE_PRIVILEGED`: an appended System
instruction applies from that point onward and later System instructions win when
they conflict with earlier System instructions. Anthropic explicitly documents
mid-session state changes and mode exit notices, but it does **not** define an
arbitrary keyed-state replacement protocol. Therefore omission from a later
System message cannot be treated as structural revocation. The first safe
compiler should use cumulative placement for additive/scoped privileged updates
only; persistent state replacement/removal falls back to a complete privileged
head. A future framework-generated replace/remove patch is an optimization that
requires its own equivalence/live-behavior proof rather than being assumed from
the provider role semantics.

OpenAI current APIs accept multiple developer/System-priority messages and its
prompt-caching guide explicitly discusses preserving later developer messages as
dynamic suffixes. That proves additive same-authority suffixes can be useful; it
does **not** by itself prove that a later developer message structurally replaces
all prior developer state. Keep replacement/removal fail-closed until the exact
route/runtime contract is stronger.

`TURN_SCOPED` is independent of those three modes. Anthropic's current
`clear_at: "next_user_message"` feature is the canonical example: the historical
message remains byte-for-byte in the array but stops rendering/costing after the
next user message. This is a better target for one-turn special-agent reminders
than durable add/remove churn when the exact route supports it.

This also means provider/runtime adapters must expose a narrow exact capability
contract; they must not decide to demote privileged content into a user wrapper
after the session owner has already committed to System authority. Unknown
capability is `HEAD_ONLY`, never “try a raw System role and hope.”

### 9.6.1.1 Capability ownership is provider/model semantics ∩ runtime encoder

The local fork currently proves why model metadata alone is insufficient:

```text
provider/model API semantics
            ∩
selected OpenCode runtime/adapter lowering semantics
            =
effective System projection capability
```

The native `@opencode-ai/llm` resolver now derives capability from the exact
selected protocol first, then intersects documented Anthropic model semantics
with native encoder support. Only the native `anthropic-messages` protocol can
receive Anthropic cumulative semantics; Claude-looking IDs behind OpenAI-compatible
or unknown routes remain `HEAD_ONLY`. Unsupported Anthropic families likewise
fail closed. Native turn-scoped support remains disabled because the encoder does
not yet implement that lifetime contract.

Installed `@ai-sdk/anthropic@3.0.111` remains a separate runtime path with its
own lowering behavior. Capability resolution therefore still must not be
duplicated from model names independently across native and AI-SDK paths. The
semantic compiler must consume the **effective** provider/model/runtime
capability selected for that dispatch.

Current Anthropic primary documentation says ordinary mid-conversation System is
available on Fable 5.1, Mythos 5.1, Fable 5, Mythos 5, Opus 4.8 and Opus 5; it is
explicitly unavailable on Sonnet 5. Turn-scoped `clear_at` remains a separate
capability and is not inferred from ordinary chronological-System support.

### 9.6.1.2 `SystemContext` is a section owner, not the final System owner

Current OpenCode privileged assembly contains contributors outside
`SystemContext`: provider/model base policy, selected-agent policy, caller system
input, and V1's `experimental.chat.system.transform` plugin hook all participate
in the final bytes. Therefore “complete System surface” cannot mean “complete
Context Epoch text.”

The proper layering is:

```text
provider/model policy
agent policy
ambient privileged Context Sources
stable host mechanism policy
active privileged overlays
authorized plugin transformation
             │
             ▼
       SystemSurface assembler
             │
             ▼
 exact complete privileged bytes / sections
             │
             ▼
 provider projection strategy
```

An arbitrary legacy final-system plugin transform is opaque to section-level
diffing. Correct migration behavior is to treat its transformed output as one
opaque complete section until the plugin contract becomes section-aware; do not
reverse-engineer section identity through arbitrary plugin output.

### 9.6.2 Durable transcript rule: System means model-visible privileged surface

The durable message/event contract needs one hard invariant:

> A durable `SessionMessage.System` row must correspond to privileged text that
> actually participates in the provider-visible System surface. Lifecycle
> annotations, diagnostic markers and host bookkeeping must use a non-surface
> event/projection.

Current special agents violate this. Examples:

- Goal Auditor publishes a durable `[GOAL AUDIT CYCLE] ...` System marker, but
  the outbound request is assembled from a separate local `messages` array and
  `input.system`; that cycle marker is not inserted there.
- Prompt Revisor similarly publishes a durable revision-cycle System marker that
  is not the provider System surface.
- reminder/time-pressure paths sometimes publish and inject the same text;
  protocol-correction paths can publish one string while injecting a different
  privileged reminder/identity string.

Therefore `ContextUpdated` should be narrowed/renamed or replaced by a System
surface event whose semantics are exact. Special-agent lifecycle facts that the
model did not receive belong in special-agent/domain events or transcript
annotations that do not lower to provider messages.

### 9.6.3 Compaction must distinguish state from events

Current `SessionCompaction.serialize()` feeds System messages into the summary
as `[System update]: ...`. That turns privileged state into user-role historical
summary while Context Epoch separately re-establishes current System state.

The replacement rule is:

```text
stateful projection
  -> exclude from conversational summary
  -> reproject current state from authoritative owner after compaction

historical observation / orchestration event
  -> may participate in conversation summary if still semantically relevant
```

This applies beyond System:

- current Goal specification/progress snapshots are **state** and should be
  reprojected after compaction rather than summarized from old snapshots;
- Goal continuation is a historical orchestration **event** and may be retained
  or summarized with normal history;
- monitor observations are historical **events**, subject to normal relevance /
  summarization policy.

This distinction prevents stale state from being fossilized into lower-authority
compaction text.

Current upstream V2 clarifies one point that supersedes older June-4 design notes:
**model/agent switches do not replace the Context Epoch**. Selection changes
apply on the next provider turn while the immutable baseline and chronological
System Context remain. The remote provider cache domain may be cold after a model
switch; that does not imply OpenCode should rewrite its semantic baseline.

Sources:

- https://github.com/anomalyco/opencode/blob/dev/specs/v2/session.md
- https://github.com/anomalyco/opencode/blob/dev/CONTEXT.md
- https://github.com/anomalyco/opencode/blob/dev/specs/v2/schema-changelog.md

### 9.7 Resolved local V2 Goal-continuation regression

The local fork previously bypassed the semantic architecture by threading a
`goalContinuation?: string` argument through `runTurn` and appending it to
`LLMRequest.system`. That was fork-local and recreated the V1 authority/cache
defect.

The current tree now uses the existing narrow semantic path:

```text
GoalAutomation claimed reservation
  -> deterministic durable SessionEvent.Synthetic
  -> SessionMessage.Synthetic
  -> canonical provider role=user
```

while true privileged context remains independently owned by the System surface.
The `goalContinuation` system argument has been removed, and the exact claimed
reservation ID is passed into the post-cycle auditor so the audit reconciles the
same causal lease rather than silently stopping after an automatic cycle.

The focused integration test now asserts durable Synthetic history, absence of
continuation text from request System parts, and three worker/auditor cycles.

Permanent negative invariants:

- claimed Goal continuation text never enters V2 `LLMRequest.system`;
- each reservation materializes one **complete** continuation turn, or remains
  observably retryable; no crash point may leave a correlated empty/partial turn
  that suppresses recovery;
- reservation correlation, causal root and materialization identity are read
  directly from the GoalAutomation owner rather than discovered by transcript
  scans;
- canonical lowering remains Synthetic/provider-user, not privileged System;
- the previous Context Epoch baseline and retained history remain unchanged;
- user steering still supersedes pending/claimed autonomous work;
- restart/replay cannot duplicate the continuation.

### 9.7.1 Goal Context Source defect — historical evidence, authority split now implemented

The Goal continuation bug and Goal **state** context are separate. The first pass
assumed mutable Goal state was legitimately privileged System Context and only
audited snapshot completeness. The devil's-advocate pass rejected that
assumption, and the current dirty tree now implements the resulting split.

The **pre-fix** renderer combined:

```text
mutable Goal data:
  objective, constraints, criteria, steps, statuses, blocker, automation mode

stable host mechanism policy:
  Goal is durable
  worker != auditor
  use Goal tools
  completion requires verification
  record blockers instead of spinning
```

Those are not the same authority class. The Goal tool explicitly says objective
edits, cancellation and automation-policy changes are **user-owned**; Core's
specification-update audit defaults the actor to `user`. Giving those fields
System authority elevates user-owned task state above later user messages, then
tries to compensate with prose saying to respect the user.

The **pre-fix** `GoalContext` shape was:

```text
typed Snapshot:
  id, revision, status, title, objective, blocker, mode,
  criterion id/status/description,
  step id/status/title

outside Snapshot / captured by baseline closure:
  constraints
```

Its baseline rendered the full objective and constraints while its compatible
`update()` rendered only revision/status/mode, optional blocker, criterion
**statuses**, step **statuses**, and a reminder to call `goal_read`.

The Goal domain permits at least title, objective, constraints, continuation
policy and auditor policy to change while a non-terminal Goal is active; criteria
and steps have stricter replacement rules. Therefore a changed objective or
constraint can be durably authoritative while the old text remains in the
immutable privileged baseline with no explicit supersession/revocation message.

This violates the stronger rendered-section rule:

> **One source observation must produce the complete current model-visible
> section from authoritative state. No hidden closure-only model-visible fact may
> escape the rendered result, and no source-authored partial delta may be relied
> on for supersession.**

`revision` is not sufficient. It proves *something* changed; it does not tell the
model what changed, and the model cannot un-read the stale privileged baseline.

If mutable Goal state remained a System source, the minimum repair would be:

1. make one authoritative observation read every model-visible Goal fact,
   including constraints;
2. render the complete current section from that one observation without
   closure-only model-visible state;
3. eliminate the old two-observation/closure race where `forSession()`
   captured constraints from one observation while source `load` could observe
   newer Goal state under an older closure;
4. compare exact current rendered bytes rather than revision/value surrogates;
5. represent source disappearance as `absent`, not hand-written revocation prose;
6. prove restart/post-compaction reprojection yields the identical current
   rendered section.

Required negative tests:

- changing/removing a constraint cannot leave the old constraint effective in
  model history;
- changing objective/title cannot leave the old value as the only privileged
  statement of that field;
- a source cannot remain byte-identical when a model-meaningful Goal fact changes
  its rendered meaning;
- after a compatible update, replay and restart derive identical effective Goal
  meaning;
- completed compaction folds the same current Goal meaning into the fresh
  baseline that chronological updates had established before compaction.

This finding is especially important for the V1 backport: copying the Context
Epoch mechanism without auditing each source's snapshot/update completeness can
produce beautifully cache-stable **wrong context**.

The stronger recommended architecture is to **split authority and volatility
before optimizing updates**:

```text
Goal mechanism policy (stable host rules)
  -> System / privileged policy

Goal specification snapshot
  objective, constraints, acceptance-criterion descriptions,
  user-owned automation/spec policy
  -> sourced Synthetic/user-role context

Goal progress snapshot
  lifecycle status, blocker, criterion statuses, step statuses/assignment
  -> sourced Synthetic/user-role runtime context

Goal auditor continuation
  -> host-owned Synthetic/user-role turn
```

This has three advantages:

1. **authority correctness:** later genuine user input naturally outranks the
   projected Goal state instead of fighting a stale System instruction;
2. **provider portability:** Goal state no longer depends on chronological-System
   support to update without a head rewrite;
3. **token efficiency:** specification and progress can be separate complete
   snapshots, so a status tick does not have to repeat the full objective and
   constraints merely to avoid an unsafe hand-written delta.

The durable Synthetic projection is still host-authored as a **turn** even when
it projects user-owned Goal specification. Producer/source provenance should
identify `goal.spec` / `goal.progress` and their causal Goal/user root; it
must not be mistaken for a fresh user-intent turn.

This split is now implemented in the current dirty tree:
`GoalContext` exposes only stable `goal/mechanism` privileged policy, using
explicit `SystemContext.absent` when no Goal is focused. Mutable Goal
specification/progress are projected separately as conversational Synthetic
snapshots. Keep worker-behavior regression coverage around that boundary rather
than reintroducing volatile Goal state as a privileged Context Source.

### 9.7.2 Context Source proof is two-dimensional: semantic completeness **and producer freshness**

`SystemContext` reconciliation only compares what a source loader returns. It
cannot detect that the loader itself read a stale upstream cache.

Concrete example already present in this audit:

```text
SkillV2.list()
  -> materialized skill cache
  -> SkillGuidance.load(agent)
  -> SystemContext Source snapshot
  -> Context Epoch compare/admit
```

`SkillGuidance` itself renders a complete sorted current skill section, but
the confirmed `SkillV2.list()` reload-cache gap can feed it an old list. The
Context Epoch then faithfully preserves/adopts stale producer output.

Therefore every Context Source requires **both** proofs:

```text
A. source semantic proof
   snapshot contains all model-meaningful mutable state
   render/update/remove are semantically complete

B. producer freshness proof
   load() reaches the correct authoritative owner
   underlying cache key/lifetime match that owner
   source mutation/reload actually invalidates or advances that producer
```

Do not close a source migration merely because its `SystemContext.make(...)`
implementation is pure and deterministic. Trace `load()` all the way to storage /
catalog / filesystem / durable projection per root `AGENTS.md`.

### 9.8 Request-only tail injections are a separate semantic class

The V1 loop still has model-visible content that is intentionally **not durable**,
including:

- `explicitToolContext` appended after projected model history;
- `UNKNOWN_FINISH_CONTINUATION_PROMPT`, explicitly documented as request-only
  recovery guidance after an ambiguous provider finish.

These should not automatically be migrated into provenance-backed durable turns.
Their question is different:

```text
Is this durable conversation/orchestration state that must survive replay?
or
Is this attempt-local transport/runtime guidance whose correctness depends on
the current provider attempt only?
```

Cache-wise, both are trailing additions and therefore avoid the catastrophic
early-system-prefix mutation **when the request series/cache domain is otherwise
unchanged**. Replay/debug semantics still require explicit justification.

Required review for every request-only injection:

- authoritative producer and lifetime;
- whether restart/retry must reproduce it;
- whether it is safe to omit from the durable transcript;
- whether it can duplicate after retry;
- whether its bytes/order are deterministic;
- whether it begins a new provider message series;
- whether it can be represented as an existing durable Synthetic message without
  changing semantics, if durability is actually required.

### 9.9 Provider/proxy transforms are part of cache identity

Correct Session semantics do not guarantee a stable final provider prefix.
Provider and proxy adapters can transform messages after Session assembly.

Concrete local example: `packages/opencode/src/plugin/verdent.ts`:

- coalesces adjacent messages with the same provider role;
- appends a trailing user `"Please continue."` when the last assistant message
  has no tool use;
- normalizes tool schemas by model;
- builds a Verdent-specific encoded system/messages/tools envelope.

Those transforms are deterministic model-visible changes and can alter exact
provider cache boundaries even when the canonical Session history is unchanged.

The same Verdent wire body also contains intentionally volatile transport fields
such as per-conversation/per-turn identifiers. A naïve full-JSON hash would call
every request different even if those fields are not part of the upstream model's
prompt-cache identity.

Therefore the deterministic lab needs **three nested request views**:

```text
1. semantic request
   System Context / chronological messages / tool definitions / generation intent

2. provider-cache-sensitive native projection
   exact model-visible/provider-cache-relevant body after protocol/proxy transforms

3. full wire envelope
   transport IDs, auth-independent request metadata, encoded body, etc.
```

Use #2 for cache-bust claims. Use #1 to attribute the semantic producer. Use #3
to diagnose adapter/transport drift. Provider-specific policy decides which #3
fields, if any, also belong in #2; do not infer that merely because the bytes are
present on the wire.

This also means `LLMClient.prepare()` is necessary but not universally sufficient:
custom proxy/plugin paths that transform after canonical/native request lowering
need their own no-send body compiler or fixture capture at the last deterministic
pre-transport seam.

### 9.10 Current V2 compaction avoids a recently reported unbounded-tail regression class

A recent upstream issue documents a version/state where `keep.tokens` could be
defeated by walking backward from the token-budget split until a semantic `user`
boundary was found, retaining very large agent-driven/synthetic stretches. That
failure mode is especially relevant here because provider-user role and
conversational turn ownership are not equivalent.

**Audit correction:** a direct diff against the current local `upstream/dev` ref
shows that the present selector logic is already the same bounded algorithm in
both trees. Current `select()` serializes non-compaction messages, walks backward
only while `Token.estimate(...)` remains inside the configured keep-token budget,
and stops at the first overflow. There is no second walk back to a user message.
Synthetic/System/Shell entries are serialized explicitly and count against the
same bound.

Treat issue #43250 as a valuable historical/regression case, **not evidence of a
current local-vs-upstream divergence**.

The invariant is nevertheless worth pinning because provenance/Synthetic work
changes exactly the semantic boundary vocabulary that triggered the older bug.

Remaining proof gap:

- the small standalone compaction test file does not currently pin the bounded
  selection rule directly;
- add a focused long synthetic/autonomous-history case proving retained `recent`
  stays within the intended estimator budget (allowing only explicitly measured
  estimator granularity), without walking back to a human/user turn;
- include a long Goal/Synthetic sequence so future semantic-message changes
  cannot accidentally reintroduce the upstream pathology.

Upstream reference:

- https://github.com/anomalyco/opencode/issues/43250

### 9.11 V1 dynamic-system classification: authority first, cache second

The main V1 model-visible contributors now separate into distinct semantic
lifetimes:

| Contributor | Authority / lifetime | Cache treatment |
| --- | --- | --- |
| model/provider base prompt | exact model-route identity | stable within route; route/model switch changes cache domain |
| agent prompt | selected-agent privileged identity | selected-agent/request-series identity |
| environment/date/instructions/references/skills | ambient privileged state | typed Context Sources with chronological updates |
| Goal state | privileged durable state | typed Context Source after source-completeness repair |
| Goal continuation | host orchestration | durable Synthetic/user-role append |
| monitor ingress | explicitly untrusted external observation | sourced user-role/Synthetic runtime context, not privileged merely for labeling |
| MCP handshake instructions | external server text with unresolved trust policy | decide authority first; privileged Context Source or sourced user-role context |
| structured-output mode | request-local format/control plus tool-surface change | intentional request-series break |
| per-turn `PromptInput.system` | explicit caller-selected privilege | intentional per-turn head/series change |
| plugin system transform | plugin-owned privileged request mutation | include in prepared/native digests; expose lifecycle/generation |
| explicit lazy-tool context | attempt-local user-role capability metadata | tail append; stable provider-visible tool manifest |
| unknown-finish continuation | attempt-local recovery guidance | tail append; durability only if retry/replay semantics require it |

This matrix is a defense against optimizing the wrong authority boundary.

#### Monitor ingress

`MonitorIngressEvent` explicitly says `trust: "untrusted-external-data"`, and its
formatter says the payload has no user authority. V1 nevertheless embeds the
batch in the privileged system array. This is both an early-prefix bust and a
trust/authority mismatch.

The adversarial pass also proved a separate **loss/durability defect**:

- `SessionIngress.drain(sessionID)` removes the entire queued array immediately;
- `formatMonitorEvents()` renders only the newest 8 batches;
- a 10-batch micro-prototype rendered sequences 3-10 and permanently omitted
  sequences 1-2 after the drain boundary;
- the queue itself is process-memory `InstanceState`, so a process/provider
  failure after drain but before durable admission cannot reconstruct the batch.

The correct owner is therefore not "a system string generated immediately before
send." The likely architecture is:

```text
monitor producer / bounded source state
  -> bounded admission unit
  -> durable Synthetic/user-role runtime observation
  -> provider request history
  -> acknowledge/remove ingress item only after durable admission
```

If the underlying background-job log is already authoritative, project the
minimal model-visible observation from that owner instead of creating a second
raw event history. If an in-memory queue remains, use bounded take/ack semantics;
never drain more than can be represented and never silently truncate after
destructive drain.

Required negative invariants:

- no untrusted monitor payload enters privileged System authority;
- no drained batch is omitted without an explicit durable overflow/omission
  marker;
- provider failure between admission and dispatch does not lose the observation;
- restart has one unambiguous answer to whether a particular observation was
  admitted to model history;
- monitor admission remains bounded in items **and bytes**, not merely prompt
  batches.

#### MCP instructions

`MCP.instructions()` already sorts connected servers by configured name, which is
good deterministic-prefix hygiene. `SystemPrompt.mcp()` then permission-filters
the instructions every generation even though the main provider-visible tool
path deliberately avoids permission-driven schema churn for cache stability.

That mismatch may be correct, but it must be intentional: a permission change can
leave tool schemas stable while changing the privileged MCP instruction prefix.

DeepSeek Harness is a useful non-prescriptive comparator. Its current released
MCP client bridges tools only; MCP server instructions are not model-visible, and
an open discussion identifies injection placement as unresolved. That reinforces
the requirement to decide trust/authority before choosing the cache representation.

References:

- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md
- https://github.com/deepseek-ai/deepseek-harness/discussions/5003

---

## 10. Audit matrix for every semantic cache

Every cache entry investigated in this program should receive one row with these fields:

| Field | Question |
|---|---|
| Cache ID | Stable audit name |
| File / owner | Where is it created and who owns its lifetime? |
| Tier | 0 / 1 / 2 / 3 |
| Authority | What source can prove the value? |
| Value | What exactly is cached? |
| Identity axes | Server/workspace/account/model/etc. |
| Current key | What dimensions are encoded today? |
| Missing identity | Any authority dimension absent from the key? |
| Freshness proof | Revision/event/watermark/digest/TTL? |
| Bust triggers | Exact mutations that must invalidate/change key |
| Non-bust changes | Changes that must *not* flush it |
| Negative cache | Is absence/error cached? How is it cleared? |
| Concurrency | Single-flight? stale response overwrite protection? |
| Bounds | entry cap/byte cap/TTL/GC? |
| Persistence | process/memory/localStorage/disk/database/provider? |
| Failure semantics | stale fallback, fail-open, fail-closed, rebuild? |
| Observability | hits/misses/evicts/bust reason/age/generation? |
| Negative invariant | What must never happen? |
| Reproducer | Minimal test that proves current/fixed behavior |

---

## 11. Prompt/KV-cache audit matrix for every model-visible contributor

Following DeepSeek Harness, every context contributor should receive:

| Field | Question |
|---|---|
| Contributor | System prompt / tools / instructions / goal / monitor / compaction / etc. |
| What model sees | Exact rendered placement and authority |
| Token effect | fixed / variable / retained / repeated / bounded |
| Mutation mode | prefix-stable / append-only / replacement / reorder / independent |
| Cache domain | provider/model/route/session/account |
| Bust boundary | first token/block/message likely affected |
| Stable ordering | how deterministic order is guaranteed |
| Provider differences | OpenAI / Anthropic / DeepSeek / Gemini / compatible |
| Request series | continue / break / independent, and why |
| Route capability | exact capability that permits/forbids in-history behavior |
| Measurement | cache-read/write tokens + TTFT before/after |
| Negative invariant | e.g. permission toggle must not reorder schema manifest |

### 11.1 Canonical semantic axes: keep them orthogonal

The provenance campaign started by separating three facts that V1 had collapsed.
The cache/authority audit shows that model-visible state actually spans several
orthogonal axes. They should be modeled independently where relevant; **do not
create one mega-enum or require every message to persist every axis.**

| Axis | Question | Example |
| --- | --- | --- |
| authoritative domain owner | which service/table/source can prove this state? | Goal service, instruction files, MCP connection, user prompt |
| conversational turn owner | who owns this durable turn boundary? | user vs host |
| producer/correlation | which trusted producer created/links it? | `goal.continuation`, reservation id, source message id |
| authorization/origin lineage | which durable act authorized/caused the domain state? | Goal creation source user message / scheduled-task definition |
| fragment origin | where did this individual content fragment come from? | `part.synthetic` |
| semantic kind | what durable/model-facing kind is this item? | User, Synthetic, Shell, System, Compaction |
| instruction authority | how strongly should this content constrain the model? | conversational/user lane vs privileged host/operator policy |
| trust class | may embedded content itself carry authority? | user content, trusted host policy, untrusted external data |
| provider encoding | how must this semantic item be represented on this route? | provider user/assistant/system/tool shape |
| request-series/cache identity | can the exact earlier request surface be reused? | same/broken series; same/changed provider cache domain |
| cache isolation principal | across which user/account/workspace/session boundary is provider-side reuse/accounting allowed? | session today for OpenAI prompt-cache key |

Several bugs in this campaign came from using one axis as a proxy for another:

- `role=user` as conversational ownership;
- `part.synthetic` as whole-turn ownership;
- `source` as potential privilege;
- authorization/origin lineage as permanent ownership of later mutable state;
- "host generated" as automatically trusted System authority;
- semantic `Synthetic` as automatically lower/higher authority without an explicit authority decision;
- chronological placement as proof that authority was preserved;
- same Session as proof that provider cache identity was unchanged.
- same semantic prompt as proof that provider cache isolation/accounting domain is unchanged.

The architecture should expose purpose-specific predicates/projections instead of
letting consumers reconstruct one axis from another.

#### Goal lineage correction

The Goal domain is a concrete example of why origin lineage must remain separate
from current-state ownership:

- `GoalCreationPolicy.authorize()` requires a current human user turn;
- Goal creation passes that `userMessageID` into the Goal service;
- the Goal `created` audit event durably records `sourceMessageID`;
- Goal specification updates default to audit actor `user` while criterion/step
  progress updates default to `agent`;
- GoalAutomation deliberately stores operational continuation cursors separately
  from user-owned Goal revisions.

Therefore a projected Goal specification/progress snapshot should be correlated
primarily by `goalID` + current revision. The creation source message is origin /
authorization audit lineage, not a magic instruction-authority token and not the
current-state owner.

### 11.2 Model-visible lifetime taxonomy

Every changing value should be classified by **authority and lifetime before
choosing a cache representation**:

| Class | Semantic representation | Replay / compaction behavior | Typical examples |
| --- | --- | --- | --- |
| privileged state source | System policy/context section | reconcile exact complete current semantic state; provider projection is `HEAD_ONLY`, `CUMULATIVE_PRIVILEGED`, or `REPLACE_COMPLETE` according to effective provider/API-route/model/runtime capability | ambient instructions, genuinely privileged host policy |
| sourced state snapshot | Synthetic/user-role complete snapshot | re-project current snapshot after a compaction/reset that removed its effective state | Goal specification, Goal progress, dynamic non-privileged runtime state |
| sourced observation event | Synthetic/user-role event | durable once admitted; normally summarized/aged out rather than re-emitted | monitor output observation |
| host orchestration turn | Synthetic/user-role turn | normal durable history with causal correlation | Goal continuation, recovery continuation |
| attempt-local control | request-only tail/control | not durable unless retry/replay semantics require it | unknown-finish guidance, some lazy-tool context |
| provider mechanic | protocol/cache metadata only | never becomes conversational authority | cache breakpoint/options, transport IDs |

The state-snapshot versus observation-event distinction is important. A Goal
progress snapshot represents **current state**, so if compaction removes the old
snapshot the producer must project the current state again without scanning old
history. A monitor event represents **an observation that happened**, so replaying
the same old event after compaction would be wrong unless it is still relevant.

This is the DeepSeek Harness lesson generalized without cloning its data model:
stateful projections and one-shot observations have different replay contracts.

### 11.3 Optimization rule: decompose before provider projection

An exact complete rendering **per semantic section** is the safest source model
because it makes source correctness locally checkable. Token growth is a provider
projection concern, not a reason to reintroduce source-authored deltas. The
preferred optimization order is:

```text
1. classify authority correctly
2. split independent volatility domains
3. remove state that should not be model-visible
4. render the smallest complete current section for each source
5. measure update frequency + retained token growth
6. let the framework choose head / additive cumulative append / complete
   replacement from exact effective capability; treat general cumulative state
   patches as a separately proven optimization
```

Goal is the concrete example:

- stable worker/auditor mechanism policy can remain tiny and privileged;
- Goal specification changes comparatively rarely;
- Goal progress changes more often and can be a compact complete snapshot;
- auditor continuation is already a separate Synthetic turn.

The resulting provider behavior is intentional:

```text
Goal continuation/spec/progress
  -> host-authored locally where applicable
  -> Synthetic semantic kind
  -> conversational authority
  -> provider user message

stable Goal mechanism policy
  -> host-owned
  -> System semantic kind
  -> privileged authority
  -> provider system/developer/top-level privileged representation
     selected by exact provider/model/runtime capability
```

Do not infer provider `user` means human-authored, and do not demote genuine System authority to provider `user` merely because one adapter cannot express chronological System updates.

That is both safer and cheaper than repeatedly emitting one large privileged Goal
blob or maintaining a source-authored semantic delta language. Where a cumulative
provider benefits from a compact update, the patch must be generated mechanically
from exact prior/current section bytes by the System-surface framework.

### 11.4 Required hot-path complexity targets

The architecture should have explicit asymptotic/per-turn targets:

| Operation | Target |
| --- | --- |
| modern V1 turn provenance classification | **O(1)** property/type reads; zero part/history scan |
| Goal reservation claim/materialization lookup | **O(1)** keyed durable reads/CAS; independent of transcript length |
| Goal continuation publication | bounded constant-number durable writes, or one composite publication; zero history walk |
| Context Source version/equality check | **O(S)** over the small registered source set, with O(1) version comparison per source |
| source rendering | proportional to changed source's complete rendered bytes, not total conversation length |
| route capability lookup | **O(1)** from already-resolved model/route metadata; zero provider/network lookup |
| request-series decision | **O(1)** over materialized header/context generations/digests |
| tool manifest stabilization | proportional to tool count; canonical order should be producer-owned/materialized when feasible, not repeatedly reconstructed from plugin timing |
| monitor admission | bounded by explicit item **and byte** caps; never proportional to unbounded background history |
| restart/replay | proportional to retained durable projection/history, never "scan until a semantic fact is rediscovered" when its producer owns an indexed row |

Hard negative performance invariants:

- no new per-session timers, pollers, watchers or background fibers solely for
  cache invalidation;
- no second workspace `Instance` creation for provenance/cache/context reads;
- no new N-per-visible-row or N-per-message request path;
- no provider request preparation performed twice merely to discover route
  capability;
- no full-history hydration to answer a scalar reservation/source/current-state
  question;
- no unbounded source/tool fan-out; concurrency remains explicitly bounded.

### 11.5 Token / storage cost model

Correctness fixes can still regress cost if retained context grows faster.
Measure these separately:

```text
privileged_update_bytes / tokens
synthetic_state_snapshot_bytes / tokens
synthetic_observation_bytes / tokens
updates per logical user turn
superseded bytes retained until compaction
cache-read tokens
cache-write tokens
cache-miss tokens
compaction frequency
post-compaction baseline/snapshot bytes
```

The decision rule is not "smallest update wins." It is:

> minimize total expected provider + CPU + storage cost **subject to exact
> authority, replay and freshness correctness**.

If complete source snapshots measurably drive compaction too often after source
decomposition, then evaluate a mechanically checkable delta representation or a
different rebaseline policy. Do not pre-optimize with hand-written partial prose.

---

## 12. Measurement program

No cache optimization is complete from static code inspection alone.

### 12.1 Application cache metrics

Instrument or benchmark, where worthwhile:

- hit / miss / stale-hit / negative-hit counts,
- invalidation counts by reason,
- evictions by reason (TTL / entry cap / byte cap / version mismatch),
- owner-key cardinality,
- entry count and approximate bytes,
- recomputation/fetch latency avoided,
- single-flight collapse ratio,
- stale-response-discard count.

### 12.2 Provider prompt-cache metrics

Normalize where provider permits:

- total input tokens,
- cache-read input tokens,
- cache-write input tokens,
- cache-miss input tokens (DeepSeek),
- cache-hit ratio by token rather than only request,
- cache writes per logical user turn,
- TTFT,
- provider/model/route,
- request-series reason / surface generation where available,
- tool/header digest,
- chronological-System route capability,
- stable manifest/system digest,
- bust reason when determinable.

For transformed/proxy routes, record all three digest layers from §9.9. The
cache-sensitive provider-native digest should exclude known transport-only
volatility only when that exclusion is backed by the provider/proxy contract.

For GPT-5.6+, OpenAI's `prompt_cache_diagnostics` can serve as a provider-grounded oracle during controlled experiments. It should not necessarily be enabled on every production request; sample/debug tooling is enough to validate the assembly strategy.

### 12.3 Required cache-bust experiment corpus

For a representative session, send controlled A/B turns varying exactly one dimension:

1. no change / append user turn only;
2. tool result appended;
3. one tool description byte changes;
4. tool order changes only;
5. one system suffix changes;
6. Goal Mode state changes;
7. monitor ingress appears;
8. reasoning effort changes;
9. verbosity changes;
10. structured-output schema changes;
11. compaction occurs;
12. model changes then changes back;
13. permission changes without schema change;
14. MCP server connects/disconnects;
15. AGENTS/instruction content changes;
16. skill content changes;
17. same logical state but nondeterministic source-registration order is perturbed.
18. append-only message after an intentional tool/header request-surface break;
19. same privileged context mutation under `HEAD_ONLY`,
    `CUMULATIVE_PRIVILEGED`, and `REPLACE_COMPLETE` effective capabilities;
20. local V2 Goal continuation before/after durable Synthetic materialization.
21. provider/proxy transform with identical semantic request (prove native/cache-sensitive digest stability or classify intentional rewrite);
22. transport-only volatile IDs changing while semantic/cache-sensitive projection remains unchanged;
23. long autonomous/Synthetic history under compaction keep-token bounds.
24. projection-version bump with fresh byte-identical Context Source rendering;
25. projection-version bump while a required admitted source is unavailable;
26. newly introduced required Context Source unavailable;
27. direct Anthropic supported model vs Sonnet 5 under AI SDK/native capability;
28. Claude-looking model behind an unaudited proxy/API route;
29. Goal continuation crash after message metadata but before content;
30. monitor queue larger than formatter/admission bound, with explicit no-loss /
    explicit-overflow accounting.

Record exact request-prefix/manifest digests plus provider usage/diagnostics.

### 12.4 Concurrency cases

For caches on shared hot paths test at least:

- 1 caller,
- 3 concurrent callers,
- 6+ concurrent callers,
- invalidation while fetch/recompute is in flight,
- owner switch while prior request is in flight,
- failure then immediate recovery/config mutation.

---

## 13. Candidate reusable cache primitives

Research direction only; do not centralize for aesthetics.

### 13.1 Scoped owner key

App already has:

```ts
ScopedKey.from(serverScope, ...ownerParts)
```

Use it where cache ownership is genuinely server scoped.

Do not add server scope to caches whose authority is intentionally public/process-global (for example public OpenRouter endpoint metadata) just to make keys look uniform.

### 13.2 Versioned projection entry

For durable/materialized projections, a DeepSeek-Harness-inspired shape is worth considering:

```ts
type ProjectionCacheEntry<T> = {
  version: number | string
  revision: number
  value: T
}
```

Where `revision` is meaningful only if the authoritative producer owns a monotonic revision.

### 13.3 Generation guard for asynchronous refresh

Pattern:

```text
read generation G
start fetch
source invalidates -> generation G+1
old fetch resolves
publish only if generation is still G
```

The file-tree stale-epoch race test already demonstrates this class of thinking.

### 13.4 Cache-bust reason enum

Avoid generic `clear()` where a cheap precise reason is available. A debug-only/internal enum could mirror classes such as:

```text
owner_changed
source_revision
schema_changed
config_changed
history_replaced
compacted
ttl_expired
capacity_evicted
negative_expired
manual_refresh
provider_route_changed
```

This is primarily for measurement and regression diagnosis, not user-facing complexity.

---

## 14. Patch-order proposal

Do not patch all caches at once.

### Phase A — correctness / isolation

1. verify the externally in-progress server-qualified file-content/tree cache fix with a two-server/same-directory negative invariant; do not duplicate its source changes;
2. server-qualify usage-summary client cache;
3. scope OpenRouter free-usage client cache to server/account authority or move ownership so the client cannot mis-scope it;
4. repair skill reload invalidation;
5. prove/fix quota persisted provenance;
6. make V1 Goal continuation publication crash-safe and move
   reservation/correlation/causal-root ownership into GoalAutomation so modern
   recovery performs zero transcript scans;
7. move monitor ingress out of privileged System authority and close the
   destructive-drain/truncation loss window.

Success criterion: no cross-owner stale data, no reload returning known old
materialization, no partial Goal continuation treated as complete, no
producer-owned correlation reconstructed from history, and no admitted monitor
observation silently lost.

### Phase B — deterministic cache/context lab

1. produce semantic-request, provider-cache-sensitive-native, and full-wire
   digests separately;
2. record exact provider/API-route/model/runtime/tool/header identity plus derived
   request-surface continuation/break reason;
3. add failure-point/restart injection for Goal publication;
4. add rendered-section/projection-version/availability microcases;
5. snapshot `HEAD_ONLY`, `CUMULATIVE_PRIVILEGED`, and `REPLACE_COMPLETE`
   privileged-context request shapes plus turn-scoped capability;
6. record history rows touched and SQLite work under 1 / 3 / 6+ sessions.

Success criterion: every later optimization can attribute its first model-visible
difference and prove it did not add consumer-first reconstruction.

### Phase C — harden shared privileged-context semantics

For the **V2 ambient/context-source slice**, the current dirty tree has now
implemented:

1. exact admitted rendered-section comparison;
2. explicit `present | absent | unavailable` plus required/optional policy;
3. one framework projection version for unavailable-byte compatibility;
4. complete-section producers with no live source-authored delta/removal prose;
5. framework-owned section composition/order;
6. exact native provider/model/protocol capability resolution before non-initial
   Context Epoch projection;
7. distinct `HEAD_ONLY | CUMULATIVE_PRIVILEGED | REPLACE_COMPLETE` semantics;
8. Goal authority/lifetime decomposition: stable mechanism policy privileged,
   mutable specification/progress conversational.

Turn-scoped lifetime remains deliberately disabled until an exact encoder
supports it. The larger Phase C boundary is also not complete: provider/model
base policy, selected-agent policy, caller System, active overlays and plugin
transformation still need one final SystemSurface assembly owner, and V1 must
consume the shared semantics rather than cloning them.

Success criterion remains: cached context can be stale-behind only under an
explicit admitted-rendering policy; it can never be semantically stale because a
surrogate value hid changed rendered bytes, fail open on newly required context,
carry unavailable bytes across an incompatible projection version, or preserve
reuse by weakening authority.

### Phase D — request-prefix stability + provider cache frontier

Current status:

1. canonicalize or explicitly define semantic tool order — **still open**;
2. fork-local V2 Goal continuation moved from `LLMRequest.system` to durable
   Synthetic history — **closed**;
3. audit compaction/reset frequency and reusable-prefix shape — **partially
   covered by ContextEpoch + request-shape proofs; broader audit remains**;
4. GPT-5.6+ native cache options/breakpoints — **mechanism closed**;
5. provider-neutral automatic cache-admission intent — **open**;
6. cache-read/write metrics and diagnostics separation — **mechanism closed;
   policy/observability expansion remains**.

Success criterion: expected append-only turns preserve prefix digest through the
intended boundary; derived request-surface breaks, provider cache-domain changes,
and head replacements are classified separately, and provider controls improve
reuse without semantic request changes.

### Phase E — admission/eviction and memory efficiency

Only after correctness and identity are proven:

- evaluate LRU quality,
- byte/entry caps,
- negative-cache TTLs,
- stale fallback policy,
- expected-reuse signals,
- cache representation size/duplication.

---

## 15. Required regression suite themes

### Owner isolation

- same directory, server A vs server B;
- same project ID, server A vs server B;
- account A vs account B;
- credential rotation under live TTL/cooldown;
- local vs remote server scope.

### Mutation correctness

- invalidate during in-flight load;
- mutation event immediately followed by read;
- source reload changes cached materialization;
- failed refresh never marks stale data fresh;
- older completion cannot overwrite newer generation.
- Goal crash after message-before-part cannot suppress continuation recovery;
- fresh Context Source rendering that changes bytes cannot remain `Unchanged`
  merely because a typed/domain value compares equal;
- projection-version change with fresh byte-identical rendering does not create
  provider-visible churn;
- incompatible projection version cannot reuse required unavailable persisted
  section bytes;
- newly introduced required unavailable source cannot be silently omitted;
- monitor take/drain cannot remove data that is not durably admitted or
  explicitly reported as dropped.

### Bounds

- LRU entry cap;
- byte cap;
- TTL expiration;
- persisted version mismatch;
- negative cache recovery.

### Prefix stability

- unchanged tool schemas byte-for-byte stable;
- permission-only execution changes do not mutate schema list;
- deterministic tool/MCP/reference ordering;
- tool-set equality produces the same definition order unless explicit semantic
  order changed;
- append-only history leaves prior prefix unchanged;
- append-only history is not labeled cache-preserving when the derived request
  surface or provider cache domain changed;
- system replacement is explicit and measured;
- compaction intentionally changes digest and is classified.
- model/provider switching does not rewrite the OpenCode Context Epoch baseline merely because the provider cache domain changed;
- later privileged messages are emitted only when effective
  provider/API-route/model/runtime capability preserves the intended semantics;
- `HEAD_ONLY` receives a complete privileged-head projection, never a
  lower-authority user wrapper as semantic substitution;
- cumulative state removal/replacement is not represented by omission unless the
  provider contract structurally defines replacement;
- `REPLACE_COMPLETE` is used only when the exact provider contract defines the
  newest privileged message as complete effective state;
- encoder capability cannot create provider capability, and a Claude-looking id
  behind an unaudited API route cannot inherit direct Anthropic semantics;
- V2 Goal continuation never enters `LLMRequest.system` after the fork-local correction.
- provider/proxy transforms are included in the cache-sensitive native digest rather than assumed transparent.
- transport-only volatile request fields are not mislabeled as prompt busts without provider evidence.

### Compaction bounds

- retained recent context obeys the configured keep-token policy under long autonomous/Synthetic runs;
- compaction does not walk arbitrarily backward looking for a provider-role `user` boundary;
- changing semantic turn taxonomy cannot silently turn a bounded selector into an unbounded one.

---

## 16. Open questions

1. Should OpenCode's canonical `cache` API eventually grow a higher-level
   stability/reuse intent beyond the current `auto | none` + explicit `CacheHint`
   mechanism? The current mechanism is now sufficient to express GPT-5.6
   explicit boundaries without changing `auto` semantics.
2. **Resolved mechanically:** GPT-5.6 explicit breakpoints can lower from existing
   `CacheHint`s on exact direct-OpenAI routes. Remaining work is policy: when, if
   ever, should OpenCode synthesize those hints automatically?
3. The capability vocabulary has converged on
   `HEAD_ONLY | CUMULATIVE_PRIVILEGED | REPLACE_COMPLETE` with orthogonal
   turn-scoped lifetime. Remaining question: where should selected-runtime
   encoder capability be exposed early enough that one System-surface compiler
   can consume the provider/API-route/model ∩ runtime intersection before
   provider projection?
4. Which prompt sections genuinely need to be regenerated every provider step versus being retained append-only once per session state change?
5. Is tool ordering semantically meaningful anywhere in OpenCode? If yes, what
   explicit owner/config defines it; if no, should every manifest be canonicalized
   lexicographically like DeepSeek Harness?
6. Do cache-sensitive JSON schemas have deterministic object-key order through every provider lowering path?
7. Which persisted client caches survive a server switch or application reload, and which owner dimensions are encoded in their namespaces?
8. Should account/credential cache provenance use a non-secret stable credential ID rather than hashing raw secret material?
9. Which negative caches should subscribe to config/auth mutation instead of waiting for TTL?
10. **Mechanism partially resolved:** native OpenAI Responses can request
    `comparison_response_id` diagnostics and surface the result through existing
    provider metadata without adding Session state. Remaining question: should a
    developer/perf command orchestrate these comparisons, or should they remain
    test/manual-only?
11. Should OpenCode expose a small **derived request-surface** diagnostic in
    debug/test tooling so cache regressions can distinguish header/tool/route
    transitions from history mutation without inventing a persisted RequestSeries
    aggregate?
12. Which V1 dynamic system contributors are true privileged Context Sources versus volatile runtime facts that belong in host/Synthetic user-role snapshots?
13. What is the narrowest GoalAutomation-owned materialization contract:
   composite append-turn transaction, or stable message/part IDs plus explicit
   completion state?
14. Which provider/proxy adapters need a dedicated deterministic pre-transport compile seam because `LLMClient.prepare()` does not cover their final model-visible transformation?
15. Which wire-envelope fields are documented cache identity versus transport-only volatility for custom proxies such as Verdent?
16. Should the current Context Epoch baseline remain a durable side table, or
   eventually become a projection/checkpoint over one reconstructable
   model-visible System surface? This is a long-term simplification question, not
   a V1-backport prerequisite.
17. What is the explicit OpenAI cache-isolation principal for GPT-5.6+:
    session, workspace, account/user, or provider-default/no key? Do not widen the
    current per-session boundary until privacy/accounting ownership is decided.
18. What exactly does the newly listed OpenAI Responses `prompt_cache_options.prewarm`
    contract guarantee and cost? Do not implement until primary documentation
    specifies lifecycle, charging, cache admission, and response semantics.

---

## 17. Source ledger

### Primary provider documentation

- OpenAI prompt caching: https://developers.openai.com/api/docs/guides/prompt-caching
- OpenAI prompt-cache diagnostics: https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics
- Anthropic prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Anthropic tool use + caching: https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching
- Anthropic mid-conversation system messages: https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages
- Google Gemini context caching: https://ai.google.dev/gemini-api/docs/caching
- DeepSeek API context caching: https://api-docs.deepseek.com/guides/kv_cache/
- DeepSeek disk-cache announcement/background: https://api-docs.deepseek.com/news/news0802/

### DeepSeek architecture / Harness

- DeepSeek-V2 / MLA: https://github.com/deepseek-ai/DeepSeek-V2
- DeepSeek Harness package documentation contract: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-package.md
- Harness system prompt: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/system-prompt/README.md
- Harness agent loop: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/README.md
- Harness session projection: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session-projection.md
- Harness session core: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/README.md
- Harness scoped instructions: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/context/agent-instructions/README.md
- Harness DeepSeek adapter: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-deepseek/README.md
- Harness current system-prompt subsystem types: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/system-prompt.md
- Harness agent-loop source / request-series logging: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/src/agent.ts
- Harness Session request-header/context model: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md
- Harness System Prompt surface-node architecture note: https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-09-02-system-prompt-as-surface-node.md
- Harness projection-cache cold-read contract: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session-projection.md

### OpenCode V2 upstream references

- Current V2 Session / Context Epoch spec: https://github.com/anomalyco/opencode/blob/dev/specs/v2/session.md
- Current runtime terminology/invariants: https://github.com/anomalyco/opencode/blob/dev/CONTEXT.md
- Context Epoch evolution / superseding June-22 change: https://github.com/anomalyco/opencode/blob/dev/specs/v2/schema-changelog.md
- Current V2 runner: https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/runner/llm.ts

### Inference systems / research

- PagedAttention / vLLM: https://arxiv.org/abs/2309.06180
- vLLM automatic prefix caching design: https://docs.vllm.ai/en/v0.20.0/design/prefix_caching/
- vLLM current APC feature guide: https://docs.vllm.ai/en/latest/features/automatic_prefix_caching/
- BatchLLM: https://arxiv.org/abs/2412.03594
- PEEK queue-informed KV management: https://arxiv.org/abs/2607.02525

---

## 18. Current baseline test evidence

Before the worktree became heavily modified by concurrent work, focused existing cache tests were run successfully:

- app file-content eviction/accounting: **3 passed / 0 failed**;
- backend fork usage + quota-cache tests: **16 passed / 0 failed**;
- desktop renderer storage tests: **12 passed / 0 failed**.

Additional focused audit checks on the current dirty tree (2026-09-17):

- V1 `SessionTurnProvenance`: **4 passed / 0 failed** in ~279 ms;
- V2 Context Epoch — producer change retains one durable baseline: **passed**;
- V2 Context Epoch — model switch preserves baseline + chronological System updates: **passed**;
- V2 Context Epoch — completed compaction directly rebuilds baseline: **passed**;
- V2 autonomous Goal-cycle integration: **passed** after separating auditor stream traffic from worker requests, moving Goal continuation to durable Synthetic history, and forwarding the exact claimed reservation ID into the automatic-cycle audit.

Focused capability/no-send groundwork added and run on 2026-09-18:

- `packages/core/test/session-runner-message.test.ts`: **6 passed / 0 failed**;
  the canonical semantic lowering keeps `SessionMessage.System -> Message.system`
  while `User/Synthetic/Shell/Compaction -> provider-conversational user`;
- `packages/llm/test/system-message-capability.test.ts`: **26 passed / 0 failed**;
- focused Anthropic Messages chronological-System provider cases: **7 passed / 0 failed**;
- `packages/opencode/test/session/llm-system-capability.test.ts`: **9 passed / 0 failed**;
- Goal continuation message-without-part crash recovery: **1 passed / 0 failed**;
  deterministic reservation-derived IDs repaired the same logical continuation
  without appending a duplicate turn;
- `packages/llm` typecheck: **passed**;
- `packages/opencode` typecheck: **passed**;
- OpenAI Responses native protocol suite after GPT-5.6 cache controls +
  Responses-only diagnostics: **59 passed / 0 failed**;
- OpenAI Chat native protocol suite including rejection of Responses-only
  diagnostics: **29 passed / 0 failed**;
- deterministic provider request-shape/cache-domain lab: **9 passed / 0 failed**;
- GPT-5.6+ normalized cache-economics model: **7 passed / 0 failed**;
- `packages/llm` typecheck after all of the above: **passed**.

Context Epoch exact-surface cutover closure, re-run against the live dirty tree on
2026-09-18:

- `packages/core/test/system-context/index.test.ts`: **10 passed / 0 failed**;
- `packages/core/test/system-surface.test.ts`: **20 passed / 0 failed**;
- `packages/core/test/system-projection.test.ts`: **8 passed / 0 failed**;
- `packages/core/test/session-context-epoch.test.ts`: **4 passed / 0 failed**,
  **18 assertions**;
- focused `session-runner.test.ts` capability/context matrix: **9 passed /
  0 failed**;
- `packages/llm/test/native-system-message-capability.test.ts`: **4 passed /
  0 failed**;
- focused Anthropic chronological-System authority placement: **7 passed /
  0 failed** across the seven targeted cases;
- package-native `packages/llm` `tsgo --noEmit`: **passed**.

The dedicated Context Epoch proof verifies aggregate-scoped `replace-complete`
history, exact complete latest System text, retained original baseline,
no-op deduplication/checkpoint stability, lazy legacy migration to a freshly
observed surface, advancement to the **current durable frontier**, incompatible
required-unavailability blocking, and corrupt-state fail-closed behavior.

A full `packages/core/test/session-runner.test.ts` run was also performed:
**87 passed / 6 failed**. The six failures are concurrent non-cache/context work
(global application-tool registration, correlation headers, child-session prompt
policy, question-dismissal timing, and two provenance-qualified worker-root
stream-error cases). The focused 9/9 Context Epoch/capability matrix is green;
none of the six broad-suite failures originates in SystemSurface/ContextEpoch
projection.

Package-native Core typecheck remains globally non-green because of unrelated
dirty-worktree diagnostics already owned by other campaigns (DB `readDb` test
mocks, branded paths/model IDs, LLM mocks missing `compile`, provenance/session
harness additions, and similar active work). A campaign-owned branded-key
assertion in the SystemContext proof was corrected; the rerun contains no
diagnostic in the campaign source files or that proof.

These tests prove the new pure capability vocabulary keeps provider semantics
(`cumulative-privileged` versus `replace-complete`) separate from encoder
support, fails closed for unsupported Sonnet 5, does not let Claude-looking model
IDs behind unaudited API routes inherit direct Anthropic semantics, and keeps
turn-scoped support disabled until an adapter actually implements the provider's
exact lifetime encoding.

The earlier Goal request-count failure was diagnostic rather than a cache result:
the old harness counted Goal Auditor streaming requests in the worker request lane.
After separating those request classes, the run exposed a second real defect:
automatic-cycle auditing omitted the claimed reservation ID, so
`GoalAutomation.beginAudit()` correctly rejected the unrelated audit. Both issues
are now corrected in the focused integration path.

Interpretation:

The basic mechanics already have meaningful coverage. The audit's highest-value missing tests are mostly **owner-change and mutation-boundary invariants**: server switch, account/credential switch, provider/model/tool-manifest change, reload invalidation, and in-flight invalidation races.

Do not re-run broad test suites from repo root: the repository intentionally rejects that path. Use package-scoped focused tests in the eventual patch phase.

---

## 19. Research-phase negative invariant

Until this ledger is converted into patch plans:

> **Do not “fix” cache misses by widening lifetime, suppressing invalidation, adding more global memoization, or removing correctness checks. First prove the authoritative owner, exact identity, mutation boundary, and stale-data semantics.**

The desired end state is not maximum hit rate. It is **maximum safe reuse under explicit ownership and observable invalidation**.
