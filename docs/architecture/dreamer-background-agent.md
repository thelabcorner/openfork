# Dreamer: read-only background historical investigation

Status: source implementation and focused regression tests, **not a production
deployment or certified end-to-end provider run** (October 11, 2026, updated
for the special-agent reclassification).

Measured source-gate result for this change: Core memory **29 passed**;
filtered Dreamer agent/topology suites **all Dreamer + special-agent tests
passed** (one unrelated reference-directory case needed a relaxed 30s guard
after a 5s host-pace timeout); `test/tool/task.test.ts` **66 passed / 0 fail**;
Session bounds **5 passed**, children+delete **23 passed**; the registry
Dreamer capability test passed while one pre-existing Swarm-facade schema-size
assertion fails in files owned by a concurrent swarm campaign (not touched
here). Package typecheck shows **zero diagnostics in any file this change
owns**; whole-package runs still carry unrelated pre-existing CLI/server/compat
and concurrent-campaign diagnostics. Neither a source test nor a passing
coverage entry proves that the currently attached OXP binary has been rebuilt
or refreshed.

## Intent and ownership

Dreamer answers historical questions by investigating authorized Session
evidence and existing durable memory. It is not a coding agent and does not
automatically save its findings. Preserve the canonical `memory` tool for
deterministic cheap recall, explicit remember/forget, and the existing memory
store. Do not clone history indexes, prompt runners, or databases.

Dreamer is classified as a **host-owned special agent**, not an ordinary
catalogued subagent. The shared built-in contract
(`@opencode-ai/schema/agent`, `BuiltInTopology`) ships `dreamer` with
`special: true` in the hidden-primary shape it shares with `compaction`,
`title`, `prompt-revisor`, and `summary`, and `isSpecialAgentID` is the
canonical classification lookup.

The `dream` tool dispatches through
`packages/opencode/src/special-agent/dreamer-runtime.ts`, which invokes the
host-only `SubagentDelegation.executeSpecialAgent` entry point. That entry
point reuses the authoritative Task `BackgroundJob` and child Session
lifecycle owner, so the execution shape is deliberately unchanged: detached
worker Session, `task` permission admission, depth/model/attachment
boundaries, persisted transcript, completion notifications, and owned
cancellation. This avoids introducing a second provider loop, scheduler, or
worker-termination mechanism. Unlike the Title/Goal Auditor/Prompt Revisor
`SpecialAgentSession` transcripts, a Dreamer child remains a resumable
promptable worker Session and therefore intentionally carries no
`specialAgent` transcript metadata. The generic Task path
(`SubagentDelegation.execute`) and the Task tool's `subagent_type` catalog
now exclude the special-agent class by built-in id, so
`task(subagent_type="dreamer")` fails closed in every mode even if a
misconfiguration changed `mode`/`hidden`; the `dream` tool remains the only
launch entry point. The BackgroundJob registry itself is process-local, not
durable across process restart; absence of its record cannot establish
worker completion.

The first-stage feature runs **on demand**. It does not implement ChatGPT's
proprietary memory synthesis, autonomous periodic ingestion, or automatic
memory promotion. The model returns proposed memories as uncommitted text.

### Historical-read budgets and strict inspection (October 9 continuation)

Dreamer's `session.messages` leaf has model-facing **serialized UTF-8** budgets,
not just a number-of-messages ceiling. Each selected text costs at most 6,000
JSON-encoded UTF-8 bytes; text in one response costs at most 24,000 such bytes.
The tool returns at most 12 messages, with a 200-row role/synthetic fallback
scan rather than the ordinary 2,000-row ceiling. Session list/search discovery
is separately capped at 20 results to constrain candidate fetches independently
of transcript hydration. Requested limits above these ceilings are explicitly
projected as `limitCapped` rather than silently discarding the caller's intent.
are preserved first, then returned in original chronological order. Excerpts
retain their original message IDs/timestamps and carry `textTruncated` and
`omittedCharacters`; the outer result records `truncated`, `excerpted`,
`omittedMessages` and the budget. Both the beginning and end of an excerpt are
retained, with a conspicuous omitted-middle marker. Non-Dreamer callers retain
their normal message semantics.
If a caller requests more than 12 messages, the response reports `limitCapped`
and both the requested and effective limit. This is not a claim that any
additional historical messages actually exist. Historical `messages` reports
`status.type="unobserved"`, and historical `get` reports status `unobserved`;
neither performs a live Session-status lookup in a potentially different
worktree. The dedicated live `session.status` operation is denied to Dreamer.

The check uses JSON-encoded UTF-8 bytes, not JS `string.length`; escaped control
characters and multibyte Unicode cannot bypass its budget. This is an **output
and bounded-row-read guarantee**, not a claim of bounded pre-decoding source
byte size or an end-to-end performance improvement; the underlying Session
message reader can still decode a large selected message. Dreamer also refuses
`session.list(withStatus:true)` (potential per-directory live status bootstrap)
and `session.messages(wait:true)` (potential multi-hour wait). Read-only leaf
denial happens before any of those costly paths execute.

Executable proof: `test/tool/session-dreamer-bounds.test.ts` tests the byte
accounting, ordering, omission metadata, Unicode and JSON control escapes.
`test/tool/session-children.test.ts` executes the real native Session leaf on an
oversized durable V1 message; `test/tool/session-delete.test.ts` executes the
guard denials using real tool initialization and Sessions. The initial integrated
regression intentionally exposed the generic Tool output-projection 50 KiB
limit for ordinary oversized reads; the corrected test does not misrepresent
that generic projection as a Session-domain behavioral regression.

## Native invocation contract

`dream({action:"start",focus:"What decisions led to ...?"})` starts an
independent background investigation, returning the existing Task child
Session ID and background receipt. `dream({action:"resume",task_id,focus})`
enqueues an investigation continuation on that child. A resume with no focus
inspects/re-attaches to existing state and may return its prior completed
result; it does not guarantee that new work was scheduled.
The `status` action inspects an owned child without scheduling a provider turn.
Missing process-local BackgroundJob data is reported as `not_in_process` and
must not be mistaken for proof that the child completed successfully.
`dream({action:"status",task_id})` is a read-only, zero-provider-turn
inspection of an existing child. The host verifies parent ownership and agent
identity. It reports running/completed/error/cancelled when the process-local
job is present and `not_in_process` when only the persisted child remains.
No inference of success is made from a missing in-process job.
The status/cancel receipt includes producer-owned `persistedSession` creation
and last-record-update timestamps for crash/restart reconciliation without
bootstrapping or hydrating the transcript; record-update time is explicitly not
a heartbeat or an execution outcome.
`dream({action:"cancel",task_id})` is an owned-child, zero-provider-turn
request through the existing atomic BackgroundJob cancellation owner; it does
not introduce a scheduler or a second worker termination mechanism. The
host first verifies the persisted parent/project/workspace/agent identity and
the live task job metadata. `cancellation:"cancelled"` means the local job
accepted a cancellation, not that a remote provider has finished teardown.
Missing local state reports `not_in_process` and `not_cancelled`, never a
fabricated cancellation success. Completed jobs are not retroactively cancelled.

`dream` is lazy and accessible by the existing native tool-access descriptor
contract. It is excluded from the ordinary provider hot manifest. No new
permission-free direct background channel is introduced: Task admission and
existing parent Session/model/depth/attachment boundaries remain authoritative.
The alias respects `task` denial in the provider registry.
The host-wide `tool/exposure.ts` lazy list also includes `dream`; merely setting
`exposure="lazy"` in the tool definition is not enough for shared OXP/Code discovery.
The detached receipt has a typed child `sessionId` and `background:true` invariant,
validated after delegation. `dream` rejects calls made by Dreamer itself even
through a direct leaf invocation, avoiding recursive historical investigations.

There is no `parallel:true` switch. Independent focus areas use separate
Dream invocations (optionally in the same model turn) and inherit existing
background concurrency. First-stage operations do not coalesce duplicate
questions or impose a feature-specific concurrency cap; callers should avoid
duplicate focuses. Neither behavior may be advertised as implemented.
An executable native test starts two independently focused Dreamer calls with
`Effect.all(..., { concurrency: 2 })` and deliberately nonterminating child
providers; both calls return distinct Session IDs while both jobs remain
`running`. This verifies actual concurrent admission/nonjoining behavior,
not an invented throughput gain or a model-provider concurrency guarantee.

## Read-only guardrails

The built-in `dreamer` identity is a hidden host-owned special agent, never a
delegatable subagent. After project agent configuration merges, its name,
prompt, permission allowlist, mode and hidden status are reset to host-owned
values; `mode`/`hidden` are re-read from the shared built-in contract, so a
project config can never re-open Task delegatability. Effective agent tool
permissions allow only `session` and `memory`; bash, file edits, subprocesses,
git, Code broker, task recursion, external connectors and Dream recursion are
denied. Task rejects every requested Dreamer delegation - foreground,
background or supervisor - at the special-agent class fence before any Session
exists, and the background worker entry point admits nothing outside the
special class.

ToolRegistry applies a second immutable allowlist at BOTH normal provider
tool resolution and capability inventory creation, even if a resumed Session
records a permissive permission ruleset. For Dreamer it returns only native
`memory` and `session`; custom/plugin registrations, MCP tools, resource
tools and saved Code capabilities are absent. The leaf fences below still
validate individual actions, including direct calls bypassing manifest shape.

Leaf guards provide defense in depth against directly constructed tool calls
or incorrectly widened tool manifests:

- `memory`: Dreamer may use `search`, `get`, and `timeline`; never
  `map`/`open` (projection writes) or `remember`/`forget`.
- `memory` `search/get`: Core's access accounting (`use_count`, last-used) is
  suppressed for Dreamer with a **host-internal** `trackAccess:false` hook;
  ordinary callers keep usage accounting. `get` now exposes safely escaped
  message/part evidence IDs, hash and observation time for source tracing,
  but those pointers are **not independently authenticated** by this rendering.
- `session`: Dreamer may use `list`, `search`, `get`,
  `messages` scoped to current/project. Live `status`, `global` scope,
  repairIndex, children/oxp inspection and delete are rejected. Session-id
  reads additionally compare the target's project to the calling child's
  persisted project before any transcript is read.

These fences do not make historical content authoritative. A retrieved
message or tool output is untrusted evidence, not executable instruction.
Prompt rules require the distinction between user statements, assistant
claims, tool observations, and actually verified outcomes.
Dreamer's prompt explicitly requests `scope="project"` for history list/search
so the default current-directory scope does not silently omit other worktrees.

## Memory admission fixes done before launching Dreamer

`MemoryStore.findByHash` now compares scope **plus** project and workspace,
not just scope and hash. Keyed supersession uses the same scoped identity,
preventing another project's matching stable key from being altered.

`MemoryStore.insert` now checks `memory_suppression` under the existing
immediate insertion transaction, including the same project/workspace
identity and content hash. An attempted suppressed insert fails before
supersession or entry creation. This prevents exact-hash resurrection by
ingestion, including races with a concurrent forget.

Limits: suppressions are keyed by exact content hashes rather than semantic
equivalence; changed wording can evade that specific tombstone. Memory
 evidence pointers are not universally resolved against real authorized
 message/file/commit records at admission. Thus **model-proposed memories
 must not be promoted automatically** in this stage.

### Native and exchange Session-evidence admission guard (continuation)

`exchange/memory-evidence.ts` now verifies real Session-backed references
for native `memory.remember` and the remote exchange runtime before a write.
It resolves cited Sessions in the authorized project, enforces workspace
identity for workspace-scoped entries, resolves cited messages in that exact
Session, distinguishes user/assistant message types, and verifies V1 tool
part ownership for `tool_output` claims. Missing references, role mismatches,
forged parts, and cross-project/workspace references fail closed. Verification
is bounded to 32 submitted references, uses indexed point reads only, and
does not run a model or perform database writes.
The evidence verifier now memoizes **positive scoped Session authorization**
within one invocation; it never shares this cache across requests or principals.
For `n` submitted references spanning `u` distinct Sessions (`n <= 32`),
Session ownership point queries fall from `n` to `u` (worst case unchanged,
best case 32 to 1). Message/part ownership is still checked per reference,
not assumed from a sibling reference. This is an analytical statement/query
count, **not** a measured wall-time speedup. The 32-reference bound and
cross-project denial are covered by executable regressions.

**Further provenance hardening:** a stored `role:"user"` is only a provider
encoding, not proof of a human-owned turn. V1 evidence is checked against the
shared `SessionTurnProvenance` classifier; legacy unmarked user-role turns are
considered ambiguous and cannot assert `user_message` evidence. Current/V2
evidence uses its separate semantic provenance classifier; explicitly host-owned
user-shaped turns fail. This protects memory admissions through the common
exchange verifier, not a Dreamer-only prompt constraint. Ambiguous legacy turns
remain citable as `session` history rather than authenticated user corrections.

**Not established:** content entailment; certainty of user authorship for old
unattributed Session histories; authenticity of file/git/test references; universal
enforcement for direct Core memory-service callers. A citation's existence is
only referential integrity, never grounds for automatic promotion by itself.

## Executable surface matrix

| Surface | Route | Status/limitation |
| --- | --- | --- |
| Native normal/worker Session | V1 ToolRegistry lazy `dream` -> `DreamerRuntime` -> `SubagentDelegation.executeSpecialAgent` -> shared BackgroundJob owner; status/cancel -> BackgroundJob | Built and focus-tested, including owned cancellation; actual model-run smoke still needed |
| Native Task | `task(subagent_type="dreamer", any mode)` | Rejected by the special-agent class fence before child creation; `dream` is the only launcher |
| Lazy `@dream` and Code | Native descriptor, Session `Tool.Context` | Registered; Code's invocation must preserve real `promptOps`; no fabricated context or certified Code run yet |
| OXP | No Dreamer-aware dispatch implemented | Generic `openfork_worker` delegation of `dreamer` now fails closed at the class fence; the native `dream` leaf remains Session-bound and is not direct OXP dispatch; live host model-executed run unverified |
| OFXP | No Dreamer-aware dispatch implemented | Same class-fence closure applies to remote generic worker delegation; executable peer Dreamer cancellation E2E unverified |
| ACP | Native parent Session tool invocation | Adapter-level Dreamer run unverified |
| Inbound MCP serving | No implicit Dreamer export | Reviewed no-export boundary; use explicit authorized worker delegation where supported |

Not all cells are certified; see `tool-surface-parity.md`.

## Tests and gates

Run:

- `cd packages/core && bun test test/memory/memory.test.ts`
- `cd packages/opencode && bun test test/agent/agent.test.ts --test-name-pattern Dreamer`
- `cd packages/opencode && bun test test/agent/agent-topology.test.ts`
- `cd packages/opencode && bun test test/tool/session-delete.test.ts --test-name-pattern Dreamer`
- `cd packages/opencode && bun test test/tool/registry.test.ts --test-name-pattern Dreamer`
- `cd packages/opencode && bun test test/tool/task.test.ts --test-name-pattern Dreamer`
- `cd packages/opencode && bun test test/exchange/memory-recall.test.ts`
- `cd packages/opencode && bun test test/exchange/memory-evidence.test.ts`
- `bun packages/opencode/script/verify-oxp-native-parity.ts --quick`

Tests cover native agent immutability despite hostile config (including name
spoofing), the provider/Code inventory allowlist despite permissive Session
grants, denial of
arbitrary memory writes through a direct registry leaf, Session deletion
denial through actual tool execution, lazy registration and external semantic
disposition, project/workspace hash isolation, scoped supersession, and
transactional suppression after forget.
The additional Dreamer tests execute the actual lazy facade over the host-owned
special-agent entry point on the shared native Task/BackgroundJob owner with a
deliberately never-finishing provider stub:
the tool returns a running child receipt without waiting; resumption reuses
that child after the first result; every generic `subagent_type="dreamer"`
Task attempt fails before creating Sessions; the delegatable subagent catalog
omits Dreamer; and a Dreamer caller cannot recursively create another
Dreamer. Topology/catalog tests prove `dreamer` resolves as a `special: true`
hidden-primary built-in whose delegation exposure is false. Core tests prove
strictly read-only access counters; exchange tests prove exact
message/part pointer projection and hostile-markup escaping.
An additional native test checks live cancellation, repeated cancellation,
cross-parent denial, and no false success for a persisted orphan child.
Evidence regressions cover explicitly host-owned V1/current messages that
have the provider `user` role and legacy ambiguous messages with no provenance.

Release blockers and next high-leverage slices:

1. Establish a model-executed background start -> receipt -> child history ->
   notification -> resume integration test on the rebuilt runtime.
2. Provide a host-owned read-only history gateway with per-action scope
   validation, rejecting all caller-provided authorizations and eliminating
   mutable read-path projections if strict zero-DB-write semantics are needed.
3. Implement explicit, immutable evidence reference verification and safe
   memory proposal admission; test fabricated citations, contradictory evidence,
   deleted source Sessions and cross-project IDs.
4. Add durable idempotent consolidation runs, checkpoints, bounded concurrency,
   cross-process cancellation recovery, cost budgets, evaluation corpus and shadow mode before any
   automated memory promotion.
5. Certify real execution through Code, OXP, OFXP, ACP and authorized MCP
   routes; do not equate mapping with transport parity or source tests with
   live connector deployment.
