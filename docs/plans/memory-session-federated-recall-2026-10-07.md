# Federated memory + Session recall (2026-10-07)

## Goal

Make OpenFork's intentionally *dumb* first-class memory more useful by asking an
existing smarter indexed tool for corroborating historical context. Memory stays
SQLite/FTS lexical, local-first, deterministic, evidence-backed, and
human/agent-inspectable. No embeddings, vector database, learned ranker, graph
store, automatic Session-to-memory writes, or always-on context injection.

Design lineage: `opencode-first-class-memory-architecture.md` (August 2026;
original author research, retained in the ChatGPT file Library), the current
`packages/core/src/memory/{index,anchors,projection,store}.ts`, and the
Core `SessionRecall` / `SessionSearch` / producer-owned exact-tool sidecar.

## Why memory alone missed good evidence

Memory is a curated domain of **durable lessons**. A conversation might contain
a crucial progress report, user correction, implementation result, or failed
approach before any memory entry was deliberately created. Searching only
`memory_entry_fts` is therefore not proof that the conversation never happened.
Nor should an ephemeral Session mention be automatically upgraded to an active
memory: that would bypass evidence, quarantine, and supersession contracts.

## The two-owner design

```text
memory.search (one agent-facing call)
  |-- Memory.Service.search      -> scoped curated FTS + exact anchors
  |-- SessionRecall.recall       -> scoped indexed historical evidence
       [one focused query, optional one lexical relaxation if no hits]
  v
separate labeled routing sections, timestamps, coverage, stable IDs
  |-- open/get memory by ID/topic for durable decision + evidence
  |-- session messages by Session/message ID to inspect past discussion
  '-- live repository/runtime revalidation for mutable facts
```

The orchestrator lives at `packages/opencode/src/exchange/memory.ts`.
This intentionally does **not** alter either Core producer or persistence
schema. `memory-session.ts` projects historical Session results to at most five
compact rows (ten absolute cap at the helper). It requests no full transcript,
never opens an Instance per hit, and never downloads message/part JSON.
It also omits native directories from the model-facing Session routing results.

The `sources` search parameter has three modes:

- `both` (default): curated memory and recent matching Sessions.
- `fallback`: Session query only when curated memory has no hits.
- `memory`: curated memory only, with zero Session requests.

`sessionRanking:"recent"` (default) gives conversation-event recency priority;
`sessionRanking:"relevance"` preserves Core's historical/FTS relevance ordering
for intentional older-context research. This setting never changes the curated
memory's own scoring. A matching Session event newer than a lexically related
memory's update clock may carry `newer-than-memory-ids`; this is a **review
prompt**, never automatic supersession or evidence of contradiction.

The database/session read is capped to the caller's bounded limit (maximum
five Session results). The secondary lexical relaxation occurs *only when*
the focused query has no Session matches. It preserves compound code
identifiers instead of decomposing camelCase as the memory-anchor index
does; the Session FTS query uses implicit AND and has different tokenization
semantics. `queryUsed` and `broadened` disclose this change.

The native memory tool binds its Session read to the current project. OXP and
OFXP constrain it to the explicit canonical approved root. Scope filters are
enforced in the database **before** ranking. No unscoped default exists.

Critically, **external Session privilege is independent from memory privilege**:

- OXP `memory.read` is augmentation/read, while `session.search` requires
  a separate supervision grant, revalidated before result egress.
- OFXP peer `read` does not imply `sessionSupervision`; it independently
  authorizes/revalidates the latter against the same root/revision.
- A memory-only result still works without Session permission. Session status
  is `not_authorized`, not a false claim of zero matching history.

Other statuses: `ok`, `skipped`, `not_connected`, or `unavailable`.
An incomplete historical index is explicitly reported as incomplete rather
than an exhaustive negative. Each hit has an event or session-record clock:
`message_created` is conversation evidence; `session_record_updated` is
metadata mutation and is weaker evidence of conversational currentness.

Exact lexical anchor overlap may associate a Session hit with up to three
curated memory IDs. The association is only navigation, **not** proof of
corroboration, semantic equivalence, or current truth. All memory/source
content remains untrusted contextual evidence, not instructions.

## Independent designs researched

1. Claude memory tool: client-owned file store and on-demand scoped reads;
   progressive disclosure instead of always shipping memory into context.
   https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
2. Letta/MemFS: a useful precedent for separating editable durable memory
   from separate historical search; semantic extras need not define the base.
   https://github.com/letta-ai/letta-docs-md/blob/main/concepts/memfs/index.md
3. OpenHands project memory and guidance: concise indexed memory documents,
   deeper material inspected when needed.
   https://github.com/OpenHands/extensions/blob/main/skills/agent-memory/README.md
4. LangGraph: durable namespace-scoped memory and per-thread checkpoints are
   separate concerns, even if higher-level retrieval is layered over them.
   https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/persistence.mdx
5. SQLite FTS5: finite lexical search with explicit phrase/prefix syntax,
   scope before ranking, and no mandatory embedding runtime.
   https://sqlite.org/fts5.html

The implementation borrows **separate evidence stores + just-in-time routing**,
not these products' heavier optional semantic retrieval subsystems.

## Validation and negative invariants

- A Memory call with `sources:"memory"` performs **zero** Session queries.
- `fallback` never invokes Session lookup when curated memory already hits.
- An index failure preserves memory results, marked `unavailable`.
- Missing independent Session supervision cannot return Session evidence.
- Out-of-root newer Session events cannot win ranking, and native paths do not
  leak in the Session projection.
- Natural-language scaffolding removal and one-step fallback are deterministic.
- Hostile XML attribute quotes are encoded before provider-visible output.
- Session hits do not change Memory.Entry state or become source-of-truth facts.
- No embeddings, vector DBs, full-history scans, Session-per-row bootstraps,
  automatic per-turn retrieval, or new database migration.

## Existing debt deliberately not conflated with this change

`ExchangeMemory.executeRuntime` already enters a V1 Instance for OXP/OFXP
memory work. The federation reuses that already-open read context; it does not
create another one, but the pre-existing memory runtime entry itself is more
expensive than a pure Tier-0/1 metadata read. A follow-up owner-level
refactor should make **all** memory reads bootstrap-free after proving canonical
project/workspace attribution and preserving write-authority behavior.

Likewise, the older curated Memory FTS search has its own matching heuristics;
federation avoids changing them in this campaign. No claim of exhaustive
recall is made when indexed history is incomplete.