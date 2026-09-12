# Custom Runtime - critical review and revised architecture

> Companion to `docs/architecture/custom-runtime.md` (committed in `a0a1d3eb0b`).
> That document remains the reference for the parts it gets right. This one records what
> changed after (a) verifying its claims against the current tree and (b) reviewing the
> 2025-2026 frontier evidence, including evidence that argues *against* the feature's
> headline premise.
>
> Status: proposal. Nothing here is implemented.

## 0. Summary of the delta

Seven changes to the prior design, in descending order of importance:

| # | Change | Why |
|---|---|---|
| C1 | Invert the emphasis: the **runtime** is the product, the **library** is a gated experiment | Every measured win at the frontier comes from code-as-orchestration; the measured evidence for agent-authored skill libraries is currently ~zero |
| C2 | Collapse the action surface from 10 actions to 4 | The proposed create -> write -> validate -> publish flow is *more* ceremony than Code Mode, which is the thing being fixed |
| C3 | Add **tail injection** for discovery | The prior design forbids catalog-in-prefix (correct) but leaves no mechanism for the model to ever know the library exists |
| C4 | Trust is keyed to a **content hash**, not a function name | A name-keyed permission grant is a persistent write-once/execute-forever backdoor |
| C5 | Treat persistence itself as a new attack surface (provenance + git propagation) | Not covered at all in the prior doc |
| C6 | **Python kernel first**; TS gets cold invocation only in P0 | The JS/TS REPL is the one genuinely hard part and it is not on the critical path |
| C7 | Static tool description, enforced by test | The *existing* Code Mode already violates this; do not inherit the bug || C8 | Agent-authored lazy tool promotion (new section 9, still gated at P2) | The `exposure: "lazy"`   `tool` broker machinery now exists in-tree; this supersedes C3's tail-injection-only plan |

---

## 1. Verified ground truth

Claims in the prior doc that were checked against the tree, plus what was found that it missed.

**Confirmed.** `ToolRegistry` state is a `Ref` with `refreshCustom()` atomic swap (`tool/registry.ts`).
`tool/custom.ts` scans `{tool,tools}/*.{js,ts}` and converts exports into top-level `Tool.Def`s, so
`.opencode/custom/` is genuinely a free namespace. `SessionTools.resolve` (`session/tools.ts:120-`)
is where permission/cancellation/plugin-hook/attachment semantics actually live, and it wraps
whatever `registry.tools()` returns - so the "extract a gateway" recommendation is correctly placed.

**Missed, and material:**

1. **The tool catalog is ~100 definitions and effectively unfiltered.** `packages/opencode/src/tool/`
   holds 104 files. `registry.tools()` filters only for websearch provider availability and
   patch-vs-edit, then `session/tools.ts:120-127` turns every survivor into a provider tool. There is
   no per-agent allowlist in that path. The prefix cost this fork already pays is the strongest
   argument for the feature - and the strongest argument that the feature must not add to it.

2. **Code Mode already busts the prompt prefix.** `registry.ts:475` appends `codeModeDescription` to
   the `execute` tool's description, and `describeCodeMode` builds it from
   `CodeMode.make({tools}).instructions()` - the *entire* MCP catalog, recomputed per request. The
   feature that exists to save context currently injects a dynamic catalog into the cached prefix.
   This is a concrete bug to fix and, more importantly, the exact failure the new tool must be
   tested against.

3. **Skills are in the system prefix.** `session/system.ts:115` calls `Skill.fmt(list, {verbose:true})`,
   emitting `<available_skills>` with name + description + location for every skill
   (`skill/index.ts:422-432`). So this fork *already* has an agent-adjacent capability library, and it
   already pays full prefix cost for it. Custom Runtime must not become a second one, and the
   tail-injection mechanism in C3 is a candidate fix for skills later.

4. **Reusable infrastructure the prior doc did not name:**
   - `background/shell-job.ts` + `background/job.ts` - long-lived supervised child processes with kill
     (`forceKillAfter`), status tracking, and an output delivery pipeline. This is most of a kernel
     supervisor.
   - `ChildProcessSpawner` / `CrossSpawnSpawner` - the spawn abstraction, already fake-able in tests.
   - `tool/sympy.ts:80` `PYTHON_CANDIDATES = ["python","python3","py"]` plus `tool/sympy/core.ts:319`'s
     actionable missing-interpreter diagnostic, and `tool/project.ts:281`. Python resolution is solved;
     do not write a fourth resolver - extract this one.
   - `core/src/memory/anchors.ts` - code-aware lexical normalization, explicitly documented as giving
     "lexical retrieval most of the reach of an embedding without a model call (INV-10)". This is the
     retrieval substrate for the catalog. The fork has already made the no-embeddings decision; honor it.
   - `Tool.DynamicDescription` exists in `tool/tool.ts:16` and is annotated `TODO: remove this hack`.
     The `custom` tool must never use it.

---

## 2. Frontier evidence, including the part that argues against this feature

### 2.1 What supports the design

- **Cloudflare Code Mode** - one tool that executes TypeScript against a generated typed API over MCP
  servers; the model loops/branches/filters locally and only the final result returns. The claim is an
  entire API in ~1,000 tokens. The transferable idea is *code as the orchestration layer over
  capabilities*, not sandboxing.
- **Anthropic programmatic tool calling** (GA Nov 2025) - tools opt in via
  `allowed_callers: ["code_execution_20250825"]`; Claude writes Python in a sandbox that calls them;
  only stdout enters context. Reported: a 150k-token workflow in ~2k tokens (98.7% reduction), and
  20-40% typical savings for tool arrays of 10-49 definitions. **This fork has ~100.**
- **Tool Search** - on-demand tool discovery rather than upfront loading, ~85% token reduction on MCP
  evals. This is the progressive-disclosure precedent for the catalog.
- **Voyager** (arXiv 2305.16291) - the canonical agent-authored skill library: JavaScript functions
  indexed by an **embedding of the description**, top-5 retrieved and injected per new task, and code
  added to the library **only after self-verification passes**. Two mechanisms worth stealing:
  automatic retrieval (not model-initiated search) and verification-as-admission-gate.

### 2.2 What argues against it - and must change the plan

- **SkillsBench**: human-authored skills improve pass rates by **16.2 points**; LLM-authored skills
  provide **no measurable gain**. That is a direct measurement of this feature's headline premise,
  and it is negative.
- **"Beyond Task Completion: A Verification-vs.-Conformance Gap in Tool-Evolving Agents"**
  (arXiv 2604.00392): agent-created tools pass functional verification while violating specification
  conformance - implementation shortcuts that optimize for the immediate task, semantic violations,
  and quality degradation masked by high task-success rates. Recommended mitigations are auditability
  and dual evaluation (completion *and* conformance).
- **"SoK: Agentic Skills"** (arXiv 2602.20867) names the lifecycle (creation, verification, storage,
  retrieval, reuse, **deprecation**) and the failure modes: skill hallucination, context misalignment,
  composition failure, and **drift through repeated use**. The prior doc has no deprecation story at
  all beyond a manual `remove` action.
- **Check Point, "When Agentic Glue Melts"** (2026): five memory-corruption bugs in workerd, including
  a `node:zlib` use-after-free chained **from a prompt injection to native code execution on the host**,
  and a URLPattern OOB read enabling cross-tenant secret theft. Their conclusion: language-runtime
  isolation without an OS boundary is an incomplete model, and *agent-generated code should be
  threat-modeled as intentional code execution, not an exceptional case*.

The honest reading: **the runtime is well-evidenced, the library is not.** Cloudflare and Anthropic both
demonstrate large, repeatable wins from letting a model write code that calls tools. Nobody has yet
demonstrated a win from letting a model keep the code. That asymmetry should be reflected in what gets
built first and in what has to prove itself.

---

## 3. C1 - Invert the emphasis

The prior doc treats the persistent library as the point and the interactive runtime as its on-ramp.
Reverse it.

**The runtime is the product.** One tool, one action, that executes code with access to the host
capability surface. This alone captures the Cloudflare/Anthropic win, is independently valuable, has
no persistence risk, and is the smallest thing worth shipping.

**The library is a hypothesis with a kill switch.** It is cheap to add on top of a working runtime
(a directory, a manifest, a resolver) and the design should still be right - but it ships behind its
own flag, with reuse telemetry from day one, and an explicit criterion for removal.

Kill criterion, stated in advance:

```text
after 4 weeks of dogfooding
  if  (functions called more than once) / (functions created)  <  0.30
  or  median calls per surviving function                      <  3
then the library is not earning its complexity; keep the runtime, cut the library
```

The prior doc already proposes exactly this metric in section 25 but treats it as a ranking input.
Promote it to a go/no-go gate. This is the discipline SkillsBench's result demands.

---

## 4. C2 - Collapse the action surface

The prior section 8.2 proposes ten actions, and its note that `create` "should not accept a giant
source blob" forces this flow for a 20-line helper:

```text
custom create -> write -> write -> custom validate -> custom publish -> custom call
```

Six round trips. `shell` does it in one. The stated motivation for the whole feature was that Code
Mode's ceremony is pointless; this is worse. Adoption will not survive it.

**Revised surface - four actions:**

```ts
custom({ code, runtime?, save? })          // run code now; optionally keep it
custom({ call, input? })                   // invoke a saved function
custom({ find })                           // retrieve saved functions
custom({ manage: { ... } })                // status/restart/disable/remove - rare, mostly human-driven
```

Key moves:

- **`create` is deleted.** To build a multi-file function the agent uses `write`/`edit` on
  `.opencode/custom/<name>/` - the tools already optimized for source editing. Nothing about a
  directory of files needs a bespoke scaffolding action.
- **Save is a flag on a successful run, not a lifecycle.** `save` is *only* honored when the run
  returned without error. That is Voyager's admission gate, expressed as one parameter instead of a
  `draft -> validate -> ready` state machine. The state machine still exists internally; the model
  never has to drive it.
- **`validate` and `publish` collapse into `save`.** Saving runs the cold-start check (the gates in
  prior section 17.3) because the code must be proven to work without warm kernel globals. If the cold
  check fails, the save is refused with the diagnostic and the source is left on disk as a draft.
  Ceremony: zero extra calls on the happy path, one honest failure on the unhappy one.
- **`inspect` folds into `find`**, which returns compact entries plus full schema for an exact-name hit.

This answers the prior doc's **Q5** (publication ceremony): validation auto-publishes, because
validation is a real cold-start execution and passing it *is* the evidence. Accidental publication of
scratch code is handled by requiring an explicit `save` name - code without `save` is never persisted.

---

## 5. C3 - Discovery bootstrapping (the missing mechanism)

The prior section 8.1 correctly forbids putting function names in the tool description, a JSON-Schema
enum, the system prompt, or a dynamic registry. It then relies on the model calling `search` before
"guessing a function name." In practice a model does not search for a library it has no evidence
exists. Left as-is, the library is written to and never read from - which is precisely the SkillsBench
failure mode.

**Mechanism: tail injection.** Retrieve the top-k relevant custom functions per turn and inject them
at the *tail* of the request, not the prefix.

```text
[ system prompt ]        stable, cached          <- catalog must NEVER go here
[ tool definitions ]     stable, cached          <- exactly one `custom` definition
[ conversation ... ]     cached prefix grows normally
[ retrieved catalog ]    tail, uncached anyway   <- k compact entries, ~40 tokens each
[ current user turn ]
```

The tail is re-sent every request regardless, so k entries cost k entries and **zero cache
invalidation**. This is Voyager's top-5 retrieval, adapted to a prefix-caching world.

Retrieval uses `core/src/memory/anchors.ts` - code-aware lexical normalization with identifier
decomposition - matched against function name, description, tags, and input property names. No
embedding model, consistent with INV-10 and with the fork's existing decision. `find` remains
available for explicit lookup; tail injection is what makes it get used.

Suggested `k = 5`, suppressed entirely when the library is empty, and suppressed for agents whose
permission denies `custom`.

---

## 6. C4 / C5 - Security: persistence is the new attack surface

The prior section 21 is right that a native process is not a sandbox, and right to refuse to market it
as one. Check Point's result strengthens that: a prompt injection escaped *workerd*, a purpose-built V8
isolate sandbox with a much larger security budget than this fork has. The correct posture is not
"build a weaker sandbox" - it is "treat this as intentional code execution and control it with
permission and provenance."

But the prior doc misses the failure mode that is unique to *persistence*:

> Ordinary tool execution is a transient act the user is present for. A saved custom function is
> written once and executed on every future session, in every future project if promoted globally,
> and - because `.opencode/` is committed - on every teammate's machine after a `git pull`.

An injected instruction in a fetched web page, an MCP result, or a repo README needs to win **once** to
obtain indefinite, propagating code execution. Nothing else in the tool surface has this property.
Three requirements follow.

**R1 - Trust binds to content, not to name.** The prior section 21.2 proposes permission patterns like
`project:python:sqlite-analyzer`. A name-keyed grant is a backdoor: approve `sqlite-analyzer` once, and
any later edit to its body executes under the old grant. Key the grant to the revision hash the design
already computes in section 17.1:

```text
permission: custom_execute
pattern:    project:python:sqlite-analyzer@sha256:abc123...
```

Any content change produces a new pattern and therefore a new decision. The UI shows a diff against the
last-approved revision rather than re-reading the whole file. This is the single most important control
in the feature and it costs almost nothing, because the revision hash is already required for in-flight
immutability.

**R2 - Provenance is part of the manifest.** Record, at save time: authoring session ID, message ID,
model, timestamp, and - critically - whether the authoring context contained untrusted external content
(a `webfetch` result, an MCP tool result, or a file outside the worktree). A function authored in a
session that ingested untrusted content is flagged in `find`, in the permission prompt, and in the UI.
This is the auditability mitigation arXiv 2604.00392 asks for, and it is only possible if it is
designed in from the start.

**R3 - Global scope never auto-executes in a new project.** The prior section 14.2 makes global
promotion explicit, which is good, but promotion is not the dangerous moment - *first execution in an
unrelated project* is. First call of any global function in a project that has not seen it requires a
decision regardless of prior grants elsewhere.

Two supporting positions: keep `.opencode/custom/` **committed** (source review is the real defense, and
it matches "filesystem is authoritative"), and keep the prior doc's rule that dependency installation is
never automatic - an agent-authored `package.json` that pulls a typosquatted package is the same attack
with a shorter path.

---

## 7. C6 - Python first, and what "entry point" means

The prior doc makes JS/TS and Python co-equal first-class runtimes and then admits in section 11.3 that
JS/TS warm-cell semantics - persistent lexical state + ESM imports + top-level await + TypeScript
transpile + interruption - is "materially harder" and needs a spike. That is correct, and it is also the
reason not to put it on the critical path.

Split the problem along the axis that actually matters, which is **warm vs cold**, not JS vs Python:

| | Cold invocation (spawn, run entry, exit) | Warm kernel (persistent namespace) |
|---|---|---|
| **Python** | easy | **easy** - `exec(code, ns)` against a dict that outlives the call |
| **JS/TS** | easy - `bun run` the entry | **hard** - the section 11.3 spike |

So P0 ships: Python cold + **Python warm** + JS/TS cold. JS/TS warm is deferred until the rest is
proven. This gives a complete, useful feature without the one component that could sink the schedule,
and it lands the interactive/Jupyter behaviour the request specifically asked for. Python is also the
better first choice on merit: it is the language of the motivating example (parsing a SQLite database),
it has the data-analysis ecosystem, and the fork already resolves the interpreter (`tool/sympy.ts:80`)
and already has an actionable missing-interpreter diagnostic to reuse.

**Unified execution model.** The request framed a function as "just the entry point." Make that literal
and let it collapse the two personalities into one code path:

```text
every execution = ( module root , entry file , export name , input ) -> value

saved function:  root = .opencode/custom/<name>/   entry = manifest.entry   export = manifest.export
ad-hoc code:     root = <session scratch root>/    entry = synthesized      export = default
```

An ad-hoc `custom({ code })` cell is compiled into a synthesized module in a per-session scratch root
that shares the kernel's persistent namespace. Because the scratch root is a real directory, ad-hoc code
can already use relative imports and can already be promoted by `save` without rewriting it - the
workbench and the library are the same machine with a different root. Multi-file is therefore the
default capability rather than a feature, which is what was asked for.

---

## 8. C7 - The cache invariant, enforced

The `custom` tool's `description` and `jsonSchema` must be byte-identical regardless of library
contents. Given that Code Mode's `execute` already fails this (`registry.ts:475`), the invariant needs a
test that would have caught it:

```text
snapshot registry.tools({agent, model, provider}) for the `custom` entry
  -> save 100 functions
  -> snapshot again
  -> assert byte equality of description + jsonSchema
  -> assert registry.ids() is unchanged
```

Run the same assertion across save, edit, disable, and remove. The prior section 34.5 proposes this; it
should be written before the tool ships, not after.

---

## 9. Revised phasing

```text
P0  Runtime, no persistence                                    <- ships alone, useful alone
    - custom({ code }) with runtime: "python"
    - session-local Python kernel over ChildProcessSpawner, supervised with the
      background/shell-job.ts kill + status patterns
    - framed JSON-lines RPC over stdio, versioned, cancellable
    - permission-gated execution; static tool description + the C7 test
    - JS/TS cold invocation of a module root (bun run), no REPL

P1  Capability gateway                                         <- the real multiplier
    - extract ToolInvocationGateway from session/tools.ts
    - move Code Mode onto it unchanged (and fix its dynamic-description bug)
    - reverse RPC: kernel -> gateway, permissions re-evaluated per child call
    - depth/cycle limits, abort propagation

P2  Library, behind its own flag                               <- the hypothesis
    - .opencode/custom/<name>/ + manifest + revision hash
    - save with cold-start validation as the admission gate
    - find + tail injection over memory/anchors.ts
    - hash-keyed custom_execute; provenance fields; global-scope first-call gate
    - reuse telemetry wired from the first commit

P3  Measure, then decide                                       <- the gate
    - evaluate against the C1 kill criterion
    - only if it passes: dependency management, global promotion UX, JS/TS warm kernel,
      deprecation/drift handling per the SoK lifecycle
```

The prior doc's P0B (library) and P0C (workbench) are swapped, and its P1 (gateway) moves up, because
the gateway is what makes the runtime worth more than `shell` - without it, `custom({code})` is a worse
`shell`.

---

## 10. Resolved open questions

**Q1 - JS/TS Workbench semantics.** Deferred out of P0 entirely (C6). When it returns, the ranked
options in prior section 11.3 stand, with one addition that doc did not consider: because the scratch
root is a real directory (C6), a "warm" JS kernel can be approximated by re-importing an accumulating
scratch module and keeping only explicitly-exported bindings alive. Weaker than true REPL semantics, far
cheaper, and possibly sufficient.

**Q2 - Immutable revision staging.** Option A (content-addressed staging), with one correction the prior
doc's "avoid enormous copies" caveat gestures at but does not resolve: **stage source only**.
Dependencies stay in the shared project environment and are referenced, never copied. The revision hash
covers manifest + source tree + a fingerprint of the resolved dependency set, so a dependency change
still produces a new revision (and, per R1, a new trust decision) without duplicating `node_modules`.

**Q3 - Dependency environment scope.** Start shared per project, as proposed. Add the conflict
diagnostic before adding isolation; content-addressed environments only if measured conflicts justify
them.

**Q4 - Workbench persistence beyond session.** No, as proposed. The reasoning in prior section 10.1 is
sound and nothing found here weakens it.

**Q5 - Publication ceremony.** Resolved by C2: validation auto-publishes, because validation is a real
cold-start execution and passing it is the evidence. Accidental publication is prevented by requiring an
explicit `save` name rather than by a separate promotion step.

**Q6 - Custom code direct OS access.** Native, shell-equivalent trust, honestly labelled - as proposed,
and reinforced by the Check Point result. The prior doc's `executionProfile: native | confined` should
stay in the manifest schema as a reserved field so adding confinement later is not a breaking change,
but no confinement work in P0-P3.

**New question introduced here - Q7: how does this relate to Skills?** The fork now has two overlapping
capability-library concepts: `<available_skills>` (prefix-injected, human-authored, markdown + scripts)
and the custom library (tail-injected, agent-authored, manifest + code). They differ on authorship and
injection strategy, not on purpose. Before P2 ships, decide whether the custom library is a distinct
concept or whether it is "agent-authored skills" and should reuse `Skill.Info`, the skill permission
namespace, and the `skill` tool's `list`/`search` modes. Shipping two libraries with two retrieval
systems and two permission models is the outcome to avoid.

---

## 11. What to measure

The prior section 35's performance targets are fine. Add the three that decide whether the feature is
real:

```text
context bytes avoided   = (tokens for the equivalent tool-call sequence)
                        - (tokens for the custom call + its result)
                        per representative pipeline

reuse rate              = functions called more than once / functions created
                        target > 0.30

shell displacement      = custom calls that should have been shell calls
                        measured by sampling transcripts, target near zero
```

The third guards the boundary the request was explicit about. The prior section 22's shell-vs-custom
guidance is good prose but prose is not a control; the anti-pattern list belongs in the static tool
description *and* in a sampled eval, because the failure it describes (custom becoming a worse `shell`)
is the most likely way this feature goes wrong in practice.

---

## 12. Decisions still open for the product owner

1. **Model-facing name.** `custom` is what was requested and it reads well against the library. But a
   tool name is a retrieval cue, and `custom` is semantically empty at the moment the model is deciding
   whether to reach for it - while the P0 tool's actual job is "run code." `code` or `run` would be
   picked up more reliably; `custom` describes the P2 library better. Recommendation: keep `custom`,
   with the first line of the description carrying the verb.
2. **Does the library ship at all**, or does P0+P1 (runtime + gateway) stand as the finished feature?
   The frontier evidence would support stopping there.
3. **Q7 above** - one capability library or two.

---

## 13. References

- Cloudflare, "Code Mode: the better way to use MCP" - https://blog.cloudflare.com/code-mode/
- Cloudflare, "Code Mode: give agents an entire API in 1,000 tokens" - https://blog.cloudflare.com/code-mode-mcp/
- Anthropic, "Introducing advanced tool use on the Claude Developer Platform" - https://www.anthropic.com/engineering/advanced-tool-use
- Anthropic, "Programmatic tool calling" - https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling
- Wang et al., "Voyager: An Open-Ended Embodied Agent with Large Language Models" - https://arxiv.org/abs/2305.16291
- "SoK: Agentic Skills - Beyond Tool Use in LLM Agents" - https://arxiv.org/pdf/2602.20867
- "Beyond Task Completion: A Verification-vs.-Conformance Gap in Tool-Evolving Agents" - https://arxiv.org/pdf/2604.00392
- Check Point Research, "When Agentic Glue Melts: Exploiting Cloudflare Code Mode and Workers" - https://research.checkpoint.com/2026/when-agentic-glue-melts/
- Jupyter kernel architecture - https://docs.jupyter.org/en/stable/projects/kernels.html
