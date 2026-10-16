# AX Pareto experiment: action-aware capability discovery

**Status (2026-10-09):** Source implementation and source-level integration verified. Connected external OXP host still exposes an older connector fingerprint and has not been redeployed. This document is not a statement of real LLM agent-task win rates.

## Problem and baseline observation

OXP has approximately 33 OpenFork capability identities behind a compact discover/describe/call broker. The previous query filter split natural-language queries into terms, then accepted an entry **only if every term** occurred as a substring in its short `id + description`. Because descriptions have a separate 180-character cap, they intentionally omit many operation names. In the live old host, `capability.list(query="batch workers",load="all")` and `capability.list(query="JSON patches",load="all")` each returned **zero candidates**.

A zero result can trigger broad repeated searches, indiscriminate tool loading, mistaken fallback to `process`, or abandonment despite appropriate tools being available. Conversely, eagerly loading every complete schema may spend tens of thousands of input bytes and still leave the model uncertain which operation to select.

**Objective:** Improve relevant-tool retrieval and verified task success subject to context/latency/permission limits. Do not maximize retrieval recall at the cost of flooding prompts or exposing unauthorized execution.

For a fixed agent-task distribution, a useful vector objective is:

```text
maximize: P(verified end-to-end completion)
minimize: E[input tokens + output tokens], E[tool retries],
          E[wall time], E[monetary cost], P[unauthorized side effect]
subject to: execution grant and root/session/egress invariants unchanged;
            cached and source schemas preserve native executable semantics.
```

There is no single scalar 'AX score' and we have not assigned one without an evaluated workload.

## Implemented retrieval path

`packages/opencode/src/exchange/capability-search.ts` contains the single deterministic, no-inference, bounded lexical ranker, reused by OXP broker and External Code Mode. The OXP-local import is a compatibility re-export, not a second implementation. It uses four fields without expanding JSON schemas:

1. Capability ID tokens (highest weight).
2. Operation/action tokens from the capability's **reviewed `focusActions` mapping**, when present.
3. Bounded existing capability description tokens.
4. A small, manually reviewed table of task-language synonyms, explicitly non-authoritative.

Its normalization handles punctuation (`task.batch`, `JSON/JSONC`), camel-case boundaries, common plurals, and irrelevant stop words. Queries are bounded to 4,096 characters and the first 12 unique informative terms, with no inference call. Input text never flows into tool execution.

Each query term receives its strongest match weight (ID 12, operation 12, description 5, synonyms 3). An exact, reviewed operation is as strong a lexical signal as a capability identity. The score is:

```text
R(t, capability) = 12 [ID] OR 12 [operation] OR 5 [description] OR 3 [synonym] OR 0
S(q,capability) = sum_t R(t,capability) + 16 * (number_of_matched_query_terms)^2
```

where `OR` means **first match in precedence order**, not arithmetic addition. Multi-term coverage is primary; score breaks coverage ties. Results retain deterministic ID tie-breaking. For multi-term requests, return candidates matching at least two distinct terms if available; otherwise **fall back to partial matches**, rather than silently returning no plausible tools. Unknown unmatched queries still return empty. An omitted or blank query preserves the exact complete alphabetical catalog; an explicit nonblank query reduced entirely to stopwords/punctuation now returns **zero** rather than dumping all 33 descriptions.

**Security:** The ordinary authority-limited `visible()` catalog and requested `load` tier are filtered **before** ranker execution. Synonyms, descriptions, and operation names never introduce capabilities not granted discoverability. A matching operation name is a *retrieval hint*, not a permission, validated call, or model authority. No tool executes during search.

**Context:** The output shape stays `CatalogRow[]`, without adding model-visible ranking/debug metadata, operation schemas, embedding vectors, or hidden tokens. The full action-local schema remains available later through `describe(focusAction, guidanceMode)`. We intentionally did not add a hard top-N limit, which could accidentally conceal a required tool for legitimate comprehensive searches.

## Reproducible retrieval measurement

`packages/opencode/test/oxp/capability-search-ax.test.ts` stores a **predeclared, curated** 14-capability/12-query fixture with expected tools. It executes the former all-terms filter and the candidate retrieval algorithm on the **same catalog** and computes:

```text
Recall@3 = (queries where expected tool appears in first 3) / query count
MRR      = (1 / query count) * sum_query (1 / rank(expected tool)),
           treating an absent tool as zero.
```

Observed on October 9, 2026:

| Metric | Old filter | New ranked retrieval |
| --- | ---: | ---: |
| Recall@3 | 2/12 = 16.67% | 12/12 = 100% |
| MRR | 0.1667 | 1.0000 |
| Unknown query | empty | empty |
| No-query listing | full, alphabetic | full, alphabetic |

These are **in-sample test-fixture retrieval measurements**, not an independent holdout, benchmark against semantic embeddings, inference-token usage, genuine user distributions, or task completion. The cases are intentionally focused on known failure modes; their measured relative improvement must not be generalized.

The integration case in `packages/opencode/test/oxp/capability.test.ts` calls the *actual* OXP `OxpCapability.Service.list` with six natural queries, verifies relevant IDs among the first three, and checks that `load=default` never leaks a lazy `openfork_swarm` result even when the query strongly matches its actions.

### CPU cost

Run `bun packages/opencode/script/measure-ax-discovery.ts` from repository root. It uses the 33 canonical source descriptions (not a synthetic corpus) and reviewed Swarm action names, warms up 1,000 calls **per implementation**, then measures 10,000 in-process rank operations for five queries. The candidate now uses a WeakMap index for catalog entries whose identities are stable, refreshing when description or reviewed action names change, plus a small static synonym-token index. Weak keys do not retain untrusted remote MCP metadata globally after the caller discards the catalog.

One observed Windows/Bun run after indexing (results vary with concurrent host load):

| Warm source-level CPU metric | Legacy all-term filter | Ranked discovery |
| --- | ---: | ---: |
| Median | 0.0496 ms | **0.0330 ms** |
| p95 | 0.1094 ms | **0.0649 ms** |
| Mean | 0.0605 ms | **0.0392 ms** |

Thus the same tested retrieval improvement now also avoids measurable ranking-CPU regression **on this warm reused-source-catalog workload**. This is not a model task Pareto frontier claim; Code Mode may create ephemeral wrapper identities, other CPUs can differ, and these numbers exclude IPC, network latency, startup, serialization and LLM/tool reasoning cost. Independent holdout and end-task A/B evidence remain necessary.

## Research foundation and discarded alternatives

- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling) recommends concrete names and parameter descriptions, and **tool search** to defer rarely used tools when large catalogs inflate context. We use the same general retrieval-before-expansion principle without requiring a provider-specific hosted tool-search implementation.
- [Anthropic tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools) emphasizes descriptions that distinguish when to use a tool and how arguments behave. The new lexical search complements, rather than replaces, good descriptions.
- [MCP tools specification, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) gives schema and metadata conventions and stresses that tool annotations are **not** authorization. Our source-of-truth permissions still gate invocation after discovery.

Alternatives considered: eagerly expand the entire schema catalog (more context, poor scalability); embed every user query (network/model cost, privacy and reproducibility concerns, unavailable locally without a new inference dependency); unbounded fuzzy substring matching (false positives); exact all-term filtering (observed zero-result failure). The deterministic lexical index is intentionally a **cheap first stage**, not the final frontier of retrieval science. A later measured hybrid with reranking may earn its complexity.

## Evaluation gaps and next gates

### Exploratory transfer/abstention development probe (added October 9, 2026)

`bun packages/opencode/script/measure-ax-transfer.ts` runs 28 independently worded **source-authored** scenarios against the actual 33-item capability prose catalog: 23 answerable queries and 5 explicit no-tool cases. The no-tool cases include creative writing (not a repository mutation) and provider quota (the public `models` catalog explicitly declares it host-private). After reviewing the initial misses, synonyms and an abstention rule were improved, so the *final* numbers are **development-set results, not an untouched holdout**:

| Metric | Original all-term filter | Updated lexical ranker |
| --- | ---: | ---: |
| Answerable Recall@3 (23 cases) | 8.70% | 100% |
| Mean reciprocal rank | 0.087 | 0.978 |
| Correct abstention (5 cases) | 80% | 100% |
| Mean candidates returned (all 28) | 1.25 | 1.50 |

The shared ranker now suppresses only carefully reviewed domain-owned negative capability terms (the `models` quota claim, gated by its actual host-private source prose), and can abstain on long conversational searches with only one generic verb match. This is a **discovery confidence heuristic**, not a substitute for authorization or a natural-language intent classifier. It intentionally cannot disambiguate every task, and future tests must include queries where all tools are irrelevant. A separate MCP `models` tool with genuinely supported quota retains its match; tests prevent OpenFork's domain exclusion from shadowing it.

The first development-set run before adjustment was Recall@3 79.17% and negative accuracy 75% under its original qrels; it uncovered `symbols`, `read`, `find` and unsupported-quota errors. The curated 12-query suite still reports Recall@3 100%, but neither suite predicts real agent task success. **Reserve a new third corpus before making further alias/threshold changes**; do not relabel this tuned corpus as a blind holdout.

### Untuned follow-up transfer probe: residual errors matter

The separate `bun packages/opencode/script/measure-ax-untuned.ts` includes **22 new source-authored requests** written after the preceding development work. We deliberately did **not** optimize retrieval weights or aliases against these requests. The result was **13/18 = 72.22% Recall@3, MRR 0.639, and 4/4 = 100% correct abstentions**. This is still neither a blind human-labeled evaluation nor a real agent success test, but the lower retrieval estimate is useful counterevidence to claims of perfect generalization.

The five misses were: (1) find all callers of a named function; (2) find TODO comments; (3) show uncommitted source changes; (4) explore repository packages/scripts; (5) safely rename a function. The benchmark preserved these failures instead of post-hoc relabeling or adjusting aliases. These examples highlight the gap between matching words and accurately inferring a task's semantic operation. A follow-on candidate could combine a low-cost role/category expansion, learned reranking when available, or explicit domain-owned affordance metadata, but **must beat the frozen follow-up set on a new independent set** rather than train and test on the same examples.

This progression aligns with established IR/evaluation work rather than an invented AX scoring scheme: Robertson and Zaragoza's [probabilistic relevance framework/BM25 survey](https://doi.org/10.1561/1500000019) offers a rigorous multi-field lexical scoring baseline; [SPLADE v2](https://arxiv.org/abs/2109.10086) shows sparse document/query expansion as a possible second-stage research direction but requires inference and independent measurement before adoption; and [Berkeley's BFCL](https://proceedings.mlr.press/v267/patil25a.html) explicitly tests tool relevance, abstention, executable calls and stateful multi-turn behavior. Our small hand-authored corpora are **not** comparable to BFCL model results. The next valid experiment should use blind, task-level labels, include irrelevant calls, verify the invoked owner's actual result and measure additional tokens/latency, not just improve an in-sample retrieval rank.

The source catalog is currently 33 capabilities. One additional correctness boundary was independently tested: `models` states configured quota is host-private, so this catalog must not present it as a quota reader. A differently owned, independently authorized MCP `models` capability that genuinely supports quota must **not** be excluded by this source-specific negative rule.

1. **Hard holdout:** independently sample real agent requests and label multiple acceptable capabilities; compare precision@k, recall@k, MRR, zero-result recovery, candidate volume and false positives. Do not alter aliases based on holdout observations before reserving another clean set.
2. **Downstream agent A/B:** with identical agents/models, prompts, grants and roots, measure successful native/broker invocation, verified goal completion, retries, wall time, input/output tokens, money and authorization violations. Test ambiguous queries, long-tail actions, nested projects and abusive search probes.
3. **Safety and parity:** ensure native/Code/OXP/OFXP/ACP/MCP entry points still invoke the same leaf; discovery may differ across products but never imply privileges. The OXP parity gate is a source-level release check only.
4. **Deploy coherently:** the running ChatGPT OXP host still cannot hot-refresh; a reproducible deployed-host action fingerprint and actual live `batch workers` query must be checked after a supported deployment.

Deployment identity caveat: the static `OxpSurface.FINGERPRINT` only fingerprints advertised MCP tools and instructions. On-demand search and retry behavior can change without changing that value. The status handshake now also returns `implementation.ax` from `src/oxp/ax-revisions.ts`; a missing field conclusively indicates the old host. After upgrading, verify both the behavior revision and actual scoped results, rather than trusting an unchanged manifest hash. Activity reliability and safe SQL error reporting are detailed in `docs/architecture/ax-activity-reliability.md`.

### Operation-versus-explanation boundary (October 9, 2026)

The first 54-query, source-authored prospective challenge at
`packages/opencode/script/measure-ax-adversarial.ts` began at 25/42 positive
Recall@3 with 12/12 abstentions, then became development data as action
vocabulary was tuned. It now reaches 42/42 positives and 12/12 abstentions.
The earlier 22-question transfer probe likewise became development evidence
after its misses were used. **Neither is an untouched generalization sample.**

Tool retrieval must also avoid treating **mentioning the subject of a tool**
as an instruction to use that tool. We froze
`packages/opencode/script/measure-ax-intent-boundary.ts` (40 operational,
32 explanation/creative/non-tool cases) before modifying the ranker:

| Intent-boundary test | Before | Latest |
| --- | ---: | ---: |
| Positive Recall@3 | 37/40 (92.5%) | 40/40 (100%) |
| Correct no-tool abstention | 8/32 (25%) | 32/32 (100%) |
| Mean returned candidates | 1.96 | approximately 1.26 |

**Counterexample:** a first attempt that rejected any question beginning
with `what`, `how`, or `explain` passed the 72 development examples but
incorrectly rejected actual state reads. We therefore wrote a separate,
fixed-label `measure-ax-practical-questions.ts` probe with 28 practical
interrogatives. The first broad gate scored 4/28 (14.29%) Recall@3. We
replaced it with a conservative high-specificity conceptual/creative cue:
explicit operational artifacts and deictics such as `my current diff`,
`these diagnostics`, `this ZIP archive` and `running workers` remain
discoverable. Narrow vocabulary repairs address evidence-backed collisions
(`usage` accounting vs symbol usage sites, `schedule` vs create, workers,
Git worktrees and test failures). After repair, 28/28 practical questions
retrieve an acceptable tool in the first three results.

The combined 40+32+28+54 scripts are **all now development/regression sets**.
In-sample perfect accuracy is not a real-user success forecast. The
interrogative collapse was evidence against simple rule-based abstention;
the current conservative gate is a bounded heuristic and may miss both
non-tool phrasings and tools invoked through unfamiliar language. Real task
success, randomized/independently labeled requests, and a future untouched
holdout remain mandatory. Tool selection and no-tool abstention must be
reported separately, not averaged away.

### Politeness-wrapper metamorphic invariance

We then froze `packages/opencode/script/measure-ax-paraphrase-robustness.ts`:
12 operational and 12 explanation/non-tool seeds, each transformed by six
fixed wrappers (including identity and uppercase), for **72 positives + 72
negatives**. Before adjustment, task retrieval was 71/72 (98.61%), but
correct abstention deteriorated to 48/72 (66.67%) merely because the user
said `Please`, `Could you`, `I'd like you to`, or `If possible`.
One positive failure was `If possible, show me the README file contents`.
The ranker now strips at most three strictly enumerated *leading politeness
scaffolds* before tokenization and intent classification, while leaving
the original query untouched for Code Mode cursor identity. The unchanged
144-case synthetic transform probe then reached **72/72 positive Recall@3
and 72/72 correct abstentions**; the 72-case intent and 28-case practical
question probes still passed. This is **metamorphic development evidence**,
not naturalistic intent-classification accuracy. Arbitrary scaffolds and
mixed natural-language requests remain out of scope for the finite rules.

The OXP deployment handshake advertises
`capabilitySearch=ranked-shared-v6-intent-scaffolding-abstention`; the
Code Mode cursor generator advances to `ax-search-v5-intent-scaffolding` so
saved offsets from the previous ranking cannot silently cross the change.
Neither changes authority or execution, and the connected external host
remains older until a supported deployment. Research foundations include
[Robertson and Zaragoza's BM25/BM25F framework](https://doi.org/10.1561/1500000019)
and [query-expansion tradeoffs](https://doi.org/10.1016/j.ipm.2019.05.009).
We have not adopted an embedding service or inferred that a lexical
abstention heuristic solves general language understanding.

Focused regression evidence for this iteration: **20/20 AX search and
Exchange Code tests passed (185 assertions)**. The selected OXP release
verifier passed **4 core projection + 102 OXP broker/shared-domain tests
(106/106, zero failures; broker suite 1,398 assertions)**. The initial
combined, raw `bun test` run hit the separate Effect harness's 5-second
semantic deadline in the browser/Swarm schema test, even with Bun's
`--timeout` flag; the identical test passed in isolation (362 assertions)
when the documented `OPENCODE_EFFECT_TEST_TIMEOUT_MS=30000` environment
variable was set. This is a test-harness timeout, not evidence that the
retrieval algorithm failed; the targeted regression suites passed.
The later package-wide `bun run typecheck` exited 2 with diagnostics in
concurrently modified CLI, server, script and compatibility-test files;
none of the returned TypeScript diagnostics identified the AX search,
Exchange Code, deployment revision, AX test or AX measurement sources.
Thus package typecheck is **not clean**, even though source AX tests passed.
The final warm source-catalog CPU check used 10,000 mixed queries with the
33-capability catalog. On one loaded Windows/Bun run, the previous literal
all-term filter had median 0.0383 ms and p95 0.0920 ms, while the current
ranker with intent handling measured median 0.0359 ms and p95 0.0697 ms.
These are in-process microbenchmark timings and depend on host load, cache
warmth, and query distribution. They exclude end-to-end latency, schema
materialization, model tokens, IPC and verified task success.

## Validation

Reproduce:

```sh
cd packages/opencode
bun test test/oxp/capability-search-ax.test.ts
bun test test/oxp/capability.test.ts --test-name-pattern "recovers relevant capabilities"
bun test test/exchange/code.test.ts
cd ../..
bun packages/opencode/script/measure-ax-discovery.ts
bun packages/opencode/script/measure-ax-intent-boundary.ts
bun packages/opencode/script/measure-ax-practical-questions.ts
bun packages/opencode/script/measure-ax-paraphrase-robustness.ts
bun packages/opencode/script/verify-oxp-native-parity.ts --quick
```

The shared Code Mode search at `packages/opencode/src/exchange/code.ts` now consumes this exact ranker instead of maintaining a competing score function. In OpenFork's Code host, an optional internal `rank` callback supplies **reviewed local action names** without exposing them in the paginated `{ref,description}` model payload. Other Exchange clients use the same ranker with their normal summary fields. Host-ranked results are reconciled against canonical, actually-listed ref/description pairs; forged refs, replacement prose and duplicate refs cannot enter search output. A `rankVersion` value is hashed into the Code search cursor generation, so changed ranking or operation maps invalidate previous page offsets instead of silently skipping/duplicating items.

Updated verification after the shared Exchange refactor and weak-index optimization: **64/64 focused tests passed** across Code, capability search, schema projection and OXP capability suites (1,023 assertions). The **full four-stage OXP parity verifier passed**: Core context (4), OXP broker/shared domains (102), native project tool (19), app context (10), for **135 passing tests**. The native project stage was unusually slow in this run (~155 seconds). Actual OXP Code broker execution with action-aware `batch workers` search passed in isolation. An earlier combined AX batch had **one internal 5-second harness timeout** during concurrent typechecking/parity runs; rerunning that exact case in isolation passed. Keep this intermittent resource contention distinct from failures in the new retrieval semantics. The latest package-wide TypeScript check still reports 39 diagnostics in concurrently modified unrelated sources; **none referenced AX-modified source or tests**.
