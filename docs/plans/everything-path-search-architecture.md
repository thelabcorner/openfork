# Everything 1.5 / SDK3 Path Search Architecture Plan

> **Plan date:** 2026-10-04  
> **Status:** Architecture plan; no production Everything integration implemented yet  
> **Scope:** Unify OpenFork's high-performance workspace path discovery/search around a shared candidate substrate, with Voidtools Everything 1.5 + SDK3 as the preferred Windows accelerator and existing OpenFork search/index machinery as the portable fallback.  
> **Primary product surfaces:** `@` mention / Spotlight file search, command palette and file pickers, Project Explorer search, `/find/file` / `/find/search`, and workspace-local model/OXP path search.  
> **Explicitly retained owners:** `FileSystemSearch` for workspace search semantics, `FileIndex` for bounded/lazy Explorer directory caching, ripgrep for content search, and existing tool/OXP authority boundaries.  
> **Everything target:** Everything 1.5 + SDK3. Everything 1.4/SDK2 is not a first implementation target; absence/incompatibility must degrade to existing OpenFork behavior.
>
> This document is intentionally an architecture + execution ledger. It should be
> updated as transport experiments and implementation phases land rather than replaced
> by an unrelated second design document.

---

## 1. Executive decision

OpenFork should **not** bolt `es.exe` onto the `find` tool and should **not** let
Everything become a second public search API.

The target is one OpenFork-owned search architecture:

```text
                           OpenFork consumers
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        │                         │                         │
     @mention                Explorer search          model/tool search
        │                         │                         │
        └──────────── existing semantic/authority facades ─┘
                                  │
                         FileSystemSearch / shared
                         path-search internals
                                  │
                       OpenFork policy + ranker
                                  │
                         candidate source
                    ┌─────────────┴─────────────┐
                    │                           │
             Everything 1.5               native fallback
              SDK3 provider              SearchIndex / rg
                    │
              Everything index
```

The ownership rule is:

> **Everything owns fast Windows candidate discovery. OpenFork owns query meaning,
> workspace policy, security, ranking, highlighting, pagination, symbol merging,
> consumer contracts, and fallback.**

Consequences:

1. `FileSystemSearch.Service` remains the canonical workspace-search facade.
2. Everything sits **below** that facade as an optional path-candidate provider.
3. OpenFork does not expose raw Everything syntax to renderers, HTTP callers, agents,
   plugins, or model tools.
4. Content grep remains ripgrep.
5. `FileIndex` remains the bounded/lazy Project Explorer directory cache in the
   initial implementation.
6. The model/OXP `find` family may share the lower-level candidate engine, but keeps
   its own authority, external-path, absolute-path, truncation, cancellation, and
   projection contracts.
7. The current persistent `SearchIndex` remains the portable fallback until
   Everything-backed parity is proven. Only then may eligible Windows roots stop
   duplicating the full path corpus.

---

## 2. Why this work exists

OpenFork currently has several strong pieces, but path discovery/search is still split
across different owners.

### 2.1 Current workspace search path

`packages/core/src/filesystem/search.ts` owns `FileSystemSearch.Service`:

```ts
find()
glob()
grep()
searchMentions()
```

The default indexed route currently composes:

```text
FileSystemSearch
  -> SearchIndex
  -> persisted front-coded ChunkStore corpus
  -> OpenFork matcher/ranker
```

`SearchIndex` in `packages/core/src/search/index-service.ts` currently owns work
that an Everything-backed Windows installation can perform more efficiently:

- full-repository path enumeration during cold seed/reconcile;
- persisted path chunks;
- machine-wide cold-seed election;
- tombstones;
- watcher-fed additions/removals;
- empty-ancestor synthesis/pruning;
- compaction;
- path snapshot materialization;
- background size/mtime metadata hydration.

This is good portable infrastructure. It should not remain mandatory duplicate
infrastructure on a Windows machine that already maintains a much faster filesystem
index.

### 2.2 Current @mention / Spotlight path

The V2 prompt already uses the correct high-level shape:

```text
Prompt @ search
  -> app FileProvider.searchMentions()
  -> GET /find/search
  -> FileSystem.searchMentions()
  -> FileSystemSearch.searchMentions()
```

Relevant files:

- `packages/app/src/context/file.tsx`
- `packages/app/src/components/prompt-input/at-mention-search.ts`
- `packages/opencode/src/server/routes/instance/httpapi/handlers/file.ts`
- `packages/core/src/filesystem/search.ts`
- `packages/core/src/search/mention-fast.ts`

This surface should receive Everything acceleration with minimal app-level churn.

### 2.3 Current Project Explorer search path

Project Explorer search currently scans the client-side tree corpus:

```text
file.tree.allNodes()
  -> startProjectExplorerSearch()
  -> renderer-side substring scan
  -> match/ancestor sets
  -> filtered visible rows
```

Relevant files:

- `packages/app/src/components/project-explorer-tree.tsx`
- `packages/app/src/components/project-explorer-search-runner.ts`
- `packages/app/src/components/project-explorer-search.ts`
- `packages/app/src/context/file/tree-store.ts`

This has two limitations:

1. search cost is renderer-side O(N) over the materialized tree;
2. the searchable corpus is coupled to tree materialization instead of the full
   workspace path catalog.

The target behavior is intentionally better: Project Explorer search should become a
true workspace search while retaining Explorer-owned expansion/collapse and row
presentation semantics.

### 2.4 Current model-facing path search

`packages/opencode/src/tool/find.ts` delegates to `glob` or `grep`.
`GlobTool` currently reaches `packages/opencode/src/search/filesystem.ts`, which
uses `Ripgrep.find()`; `GrepTool` uses ripgrep content search.

That path has contracts that workspace UI search does not:

- permission prompts;
- external-directory authority;
- absolute path output;
- OXP virtual-root projection;
- hidden-file behavior;
- abort propagation;
- truncation and result-budget behavior.

Therefore the tool path may consume a shared lower-level path candidate engine, but
must **not** be rewritten as a blind call to the workspace `/find/search` facade.

---

## 3. Live baseline at plan creation

Live repository baseline inspected on 2026-10-04:

- branch: `main`
- HEAD: `1d96902911`
- worktree: intentionally highly dirty with legitimate concurrent work;
- no Everything integration present;
- search-specific dirty work includes ignore-aware backend selection and stronger
  `SearchIndex` deletion/tombstone/empty-ancestor pruning.

The main-worktree safety invariant applies throughout implementation:

> **Never reset, stash, clean, broad-checkout, rebase, mass-format, or overwrite
> unrelated bytes. Inspect the current diff of every target file immediately before
> editing it.**

### 3.1 Current local mention benchmark

The existing reproducible benchmark
`packages/core/test/bench-mention-fast.ts` was run against the live tree while
creating this plan:

| corpus | paths | prepared matcher build | prepared hot median | fast scan cold | fast scan hot median | fast scan worst |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| OpenFork real | 8,077 | 262.02 ms | 2.448 ms | 13.364 ms | **1.225 ms** | 2.092 ms |
| synthetic | 100,000 | 3,011.69 ms | 1.984 ms | 27.189 ms | **24.007 ms** | 45.533 ms |
| synthetic | 250,000 | 7,819.94 ms | 1.931 ms | 125.860 ms | **80.186 ms** | 138.319 ms |

These numbers define the performance problem:

- small repositories already have an excellent in-process hot path;
- whole-corpus scan latency grows materially at 100k–250k paths;
- the rich prepared matcher is extremely fast once warm but too expensive to build
  eagerly on large repositories;
- therefore the optimal architecture is **adaptive**, not “always Everything” and
  not “always scan/build locally.”

---

## 4. Everything 1.5 / SDK3 decision

### 4.1 Target 1.5, not SDK2

The first implementation should target Everything 1.5 + SDK3.

Reasons:

- SDK3 is explicitly the Everything 1.5 API generation;
- SDK3 uses Windows named-pipe IPC;
- pipe connections may be kept open;
- SDK3 has continued to receive correctness fixes around overlapped reads/writes;
- SDK3 includes Index Journal support on sufficiently recent 1.5 builds;
- Everything 1.5 adds property indexing, faster searching, weighted searches,
  result omissions, and the Index Journal.

Everything 1.4 remains a valid user installation, but OpenFork should treat it like
“Everything acceleration unavailable” and use its existing native path rather than
carry a second production SDK integration immediately.

### 4.2 Development-machine upgrade policy

Do not make the first experiment destructive.

Preferred initial setup:

```text
Everything 1.4 stable
  -> retain as known-good reference initially

Everything 1.5 beta
  -> install/run side-by-side using a named instance
  -> use as the SDK3 development target
```

SDK3 pipe naming supports an instance-qualified form. The provider contract must
therefore support a configured/discovered instance name instead of hard-coding only
the default pipe.

After transport/query/freshness/restart benchmarks are green, the development
machine may promote 1.5 to the normal/default installation.

### 4.3 External source baseline

Primary upstream references:

- Everything 1.5 downloads / current beta:
  <https://www.voidtools.com/everything-1.5/>
- Everything 1.5 SDK3 discussion and release notes:
  <https://www.voidtools.com/forum/viewtopic.php?t=15853>
- Everything Index Journal:
  <https://www.voidtools.com/support/everything/index_journal/>
- Everything CLI reference:
  <https://www.voidtools.com/support/everything/command_line_interface/>
- Everything search syntax:
  <https://www.voidtools.com/support/everything/searching/>

The plan must be updated if SDK3 behavior materially changes before implementation.

---

## 5. Runtime constraint: OpenFork is Bun **and** Node

This feature cannot assume a Bun-only runtime.

OpenFork has:

- Bun-native CLI/server paths;
- a Node-targeted Desktop sidecar built by
  `packages/opencode/script/build-node.ts`.

Core already demonstrates runtime-conditional seams in
`packages/core/package.json`:

```text
#sqlite -> bun / node
#pty    -> bun / node
#fff    -> bun / node
```

However, Everything is most valuable in Desktop too. A design equivalent to the
current `#fff` Node stub would fail the product objective.

The Everything transport must therefore work equivalently from Bun and Node.

---

## 6. Transport architecture: benchmark before freezing implementation

SDK3 makes two serious production transports possible.

### Option A — direct TypeScript SDK3 named-pipe client

```text
Bun server ───┐
              ├─ EverythingBridge (TS)
Node sidecar ─┘        │
                       ▼
             \\.\pipe\Everything IPC
                       │
                 Everything 1.5
```

Advantages:

- one implementation for Bun and Node;
- no DLL FFI;
- no native addon;
- no helper executable;
- persistent low-overhead IPC connection;
- easiest packaging if Node/Bun named-pipe semantics are sufficiently compatible.

Risks:

- OpenFork becomes responsible for faithfully implementing the SDK3 wire protocol;
- framing/version/property encoding errors become our bugs;
- cancellation/reconnect/overlapped behavior must be reproduced correctly;
- protocol evolution must be tracked.

### Option B — tiny native helper wrapping the official SDK3 implementation

```text
Bun server ───┐
              ├─ framed local pipe/stdin IPC
Node sidecar ─┘          │
                         ▼
                everything-bridge.exe
                         │
                   official SDK3
                         │
                   Everything 1.5
```

Advantages:

- official SDK3 client code owns protocol details;
- same helper is shared by Bun and Node;
- native faults/hangs are isolated from OpenFork;
- helper can be killed/restarted independently;
- protocol presented to OpenFork can be deliberately tiny and stable.

Costs:

- one additional packaged binary;
- one extra local IPC hop;
- helper lifecycle/packaging/signing;
- a little more operational machinery.

### Rejected production hot paths

Do **not** ship these without new evidence:

- spawning `es.exe` for every query;
- Bun-only FFI;
- separate unrelated Bun and Node implementations;
- renderer-side Everything IPC;
- raw Everything HTTP/ETP access as the local hot path.

`es.exe` remains useful as a development oracle, parity checker, and manual
diagnostic.

### 6.1 Transport bakeoff gate

Before production Core code depends on Everything, build isolated prototypes for A
and B and measure:

1. first connection latency;
2. persistent hot-query latency;
3. result windows of 30 / 200 / 1,000;
4. full project enumeration;
5. filename + full-path only;
6. optional indexed size/mtime requests;
7. two and four concurrent callers;
8. query supersession;
9. Everything restart during an in-flight query;
10. OpenFork-side cancellation;
11. named-instance connection;
12. malformed/truncated reply handling;
13. 10+ minute idle connection then reuse;
14. helper/client crash recovery;
15. Bun and Node parity.

Choose the transport from measurements and failure behavior, not implementation
aesthetics.

---

## 7. Core ownership model

### 7.1 Keep `FileSystemSearch.Service` as the public workspace owner

Do not introduce another top-level `WorkspaceSearch.Service`.

The current `FileSystemSearch.Service` is already the correct product seam and
exposes:

```ts
find(input)
glob(input)
grep(input)
searchMentions(input)
```

Everything should be an implementation capability under that owner.

### 7.2 Add a machine-scoped Everything bridge

Conceptual contract:

```ts
EverythingBridge {
  health()
  capabilities()
  query(request, signal?)
  enumerate(request, signal?)
  journal?(cursor, signal?)
}
```

Important properties:

- process/machine scoped, not renderer scoped;
- lazy;
- reconnectable;
- generation/version aware;
- never assumes existence == readiness;
- never returns global machine results to callers without root fencing.

Do not necessarily expose this as another Effect location service. Everything is
machine-global while `FileSystemSearch` is location scoped.

### 7.3 Add an internal path-candidate abstraction

Conceptual request:

```ts
PathCandidateRequest {
  root
  query
  tokens
  kind: "file" | "directory" | "mixed"
  limit
  cursor?
  purpose
  metadata
}
```

Conceptual result:

```ts
PathCandidatePage {
  rows: Array<{
    path
    type
    size?
    mtime?
    providerScore?
  }>
  cursor?
  exhausted
  totalHint?
  provider
  generation
}
```

This type is **not** a public protocol schema.

The Everything implementation compiles structured requests into Everything syntax;
the native implementation uses the existing SearchIndex/ripgrep mechanisms.

### 7.4 Add a shared path-search planner/ranker

The planner owns:

- candidate-source selection;
- query/token normalization;
- candidate width;
- pagination/overfetch;
- workspace ignore filtering;
- deduplication;
- OpenFork scoring;
- match highlight reconstruction;
- deterministic tie breaking;
- optional metadata enrichment;
- stale-generation suppression.

The provider does not own these semantics.

---

## 8. Provider readiness and capability model

Never infer readiness from `Everything.exe` existing on disk.

A provider state should be explicit, roughly:

```text
unsupported
disconnected
connecting
loading
ready
not-covered
degraded
unavailable
```

A root may use Everything only when all required predicates hold:

```text
Windows
AND SDK3 transport supported
AND Everything IPC reachable
AND compatible Everything build
AND database/index ready
AND workspace root covered
AND requested operation supported safely
```

Otherwise the caller falls back automatically.

### 8.1 Capability granularity

Do not model “Everything available” as a boolean.

Track capabilities such as:

- filename/path query;
- file/directory distinction;
- result count/offset;
- requested sorting;
- indexed size;
- indexed mtime;
- attributes/reparse information;
- named-instance connectivity;
- Index Journal;
- journal retention window / cursor validity if discoverable.

Request only properties that are known to be cheaply indexed. An unindexed property
must never silently turn an interactive query into filesystem-wide disk I/O.

---

## 9. Security and authority invariants

Everything indexes more of the machine than the current project. It is therefore a
**candidate source, never an authority source**.

Hard invariants:

1. no raw Everything query strings from models, plugins, renderer code, HTTP clients,
   or OXP;
2. every query is root-scoped by OpenFork;
3. returned paths are normalized before they enter product semantics;
4. paths outside the authorized root are discarded even if Everything returns them;
5. model/OXP tool authority checks remain in their existing owners;
6. external-path access still requires existing authorization;
7. no global machine path corpus may leak through diagnostics or errors;
8. symlink/junction/reparse behavior must be parity-tested before an
   Everything-backed result is accepted for tool search;
9. path lookup/search never grants permission to read/write/execute the result.

### 9.1 Windows containment

Tests must cover:

- drive-root casing;
- path separator normalization;
- UNC paths;
- junctions;
- symlinks;
- reparse points;
- workspace roots containing spaces/unicode;
- files whose names contain Everything metacharacters;
- case-insensitive duplicate spellings.

For model-facing paths, preserve the existing tool/OXP post-search authority
projection instead of treating the Everything prefix query as sufficient confinement.

---

## 10. Ignore and visibility semantics

This is one of the highest-risk differences between Everything and current OpenFork
enumeration.

Current ripgrep discovery naturally interacts with:

- `.gitignore`;
- `.ignore`;
- hidden files;
- explicit `.git` exclusion;
- OpenFork workspace watcher-ignore configuration.

Everything's global index does not automatically mean “the same candidate set.”

Therefore visibility policy belongs **above provider selection**.

Conceptual policies may include:

```text
mention
file-picker
project-explorer
workspace-find
tool-glob
```

Each policy defines:

- gitignored visibility;
- hidden-file visibility;
- `.git` visibility;
- configured watcher-ignore visibility;
- file/directory allowance;
- product config/protected paths;
- external-path rules.

### 10.1 Overfetch after filtering

Never do:

```text
ask Everything for K
filter ignored rows
return fewer than K
```

Instead:

```text
fetch page
  -> filter
  -> if accepted < K and provider not exhausted
       fetch next page
  -> repeat
```

This prevents ignored high-ranking paths from starving valid results.

---

## 11. Query planning and fuzzy-search semantics

Everything should eliminate impossible candidates; OpenFork should decide final rank.

### 11.1 Preserve OpenFork's ranker

The current fast mention engine contains product semantics such as:

- basename preference;
- exact/prefix/stem bonuses;
- word/camel/separator boundaries;
- ordered subsequence matching;
- gap penalties;
- directory depth effects;
- multi-token AND behavior;
- directory-completion behavior;
- deterministic top-K;
- highlight positions.

Do not replace those semantics with Everything's result order.

### 11.2 Everything as a high-recall prefilter

For a token like:

```text
dsm
```

OpenFork's broad match shape is ordered subsequence:

```text
d ... s ... m
```

A candidate compiler can ask Everything for a high-recall superset and then run the
existing OpenFork scorer only over that set.

For multiple tokens, every token remains required before final ranking.

The exact Everything expression is an implementation detail and must be tested
against an oracle. Do not freeze a wildcard/regex translation in this architecture
document before the transport/query bakeoff.

### 11.3 Adaptive candidate width

A fixed `max=200` is insufficient as an architectural rule.

Use staged retrieval:

1. request a bounded candidate page;
2. filter policy;
3. score with OpenFork;
4. determine whether enough candidate/ranking coverage exists;
5. request another page/channel if needed;
6. stop on proof of exhaustion or a correctness-preserving bound.

Potential candidate channels:

- exact basename/stem;
- basename prefix;
- basename subsequence;
- full-path subsequence;
- directory-focused query;
- extension-aware query.

The planner may merge/dedupe these channels before scoring.

### 11.4 Small-repository bypass

The live 8k benchmark is already ~1.2 ms hot.

Do not make a fast local query slower just to say it used Everything.

The planner should support a measured crossover:

```text
small/hot corpus
  -> existing in-process matcher

large corpus
  -> Everything candidate acceleration

Everything unavailable
  -> native fallback
```

The crossover threshold must come from benchmark data on the production build, not a
hard-coded number chosen during design.

---

## 12. Metadata strategy

Everything 1.5 can expose indexed properties, but OpenFork should remain conservative.

Initial interactive provider requests should prefer only:

- path/name;
- file vs directory;
- only metadata demonstrated to be indexed/cheap.

Do not make line count part of Everything's required contract.

Current `SearchIndex` metadata includes size, mtime, and optional lineCount. A
migration may instead use:

1. Everything size/mtime where capability-proven;
2. `FileIndex.lookup()` for already-known rows;
3. lazy stat/read only for top-K displayed rows;
4. line-count computation only when the UI actually needs it.

This can remove the current bulk metadata hydration cost from eligible
Everything-backed roots rather than merely relocating it.

---

## 13. Cancellation, supersession, and concurrency

Interactive file search is a keystream workload. Old queries should not accumulate.

Required behavior:

```text
q1 running
q2 queued
q3 arrives

=> q2 may be discarded
=> q1 result is generation-stale and ignored
=> q3 becomes next useful work
```

The bridge/planner must support:

- caller AbortSignal;
- generation fencing;
- latest-query wins per interactive consumer;
- bounded background work;
- no unbounded provider queue;
- hard timeout;
- connection/helper restart on a wedged transport;
- immediate native fallback when provider health degrades.

Do not conflate “transport cannot cancel an already-issued native request” with
“OpenFork must wait for and render it.” Results can be generation-discarded even when
the underlying request cannot be physically cancelled.

---

## 14. Consumer migration plan

### 14.1 @mention / Spotlight — first production consumer

This is the safest first cut because the public path already converges through
`/find/search`.

Target:

```text
Prompt @
  -> /find/search
  -> FileSystemSearch.searchMentions()
  -> PathSearch planner
  -> Everything candidates OR native fallback
  -> OpenFork ranking
```

Preserve:

- request debounce;
- AbortSignal;
- pagination;
- file/directory result shapes;
- match positions;
- baseOffset handling;
- metadata normalization;
- symbol-enabled behavior.

### 14.2 Command palette / file pickers

Consumers already using `searchMentions` benefit automatically.

Legacy consumers using `file.find()` should be audited and migrated only where
their result semantics are compatible.

Do not create a second Everything-specific app context.

### 14.3 Project Explorer search

Intentional product change:

> Project Explorer search should become full-workspace search rather than only a
> substring scan over the currently materialized client tree.

New shape:

```text
Explorer search input
  -> server path search
  -> ranked paths
  -> derive match + ancestor closure
  -> existing Explorer row/expansion presentation
```

Retain Explorer-owned behavior:

- owned search expansion lifecycle;
- user expansion state preservation;
- collapse restoration;
- virtualized row rendering;
- creation/selection behavior.

Remove or demote the renderer O(N) candidate scan once server search is proven.

The current `startProjectExplorerSearch` machinery may still be useful for
presentation projection; do not mechanically delete it before separating
“candidate discovery” from “tree projection.”

### 14.4 Model/OXP `find glob`

Share the lower-level candidate engine, **not** the UI facade.

Target shape:

```text
GlobTool / OXP find glob
  -> existing authority validation
  -> shared path candidate engine where eligible
  -> exact glob-semantic validation
  -> existing absolute/virtual-root projection
  -> existing truncation contract
```

If exact ripgrep-glob parity cannot be proven cheaply, keep ripgrep for that query
class. Everything acceleration is optional; semantic regressions are not.

### 14.5 `find grep`

Keep ripgrep.

Everything is not the primary code-content search engine for this project.

---

## 15. FileIndex is not SearchIndex

Do not remove `packages/core/src/filesystem/index.ts` merely because Everything
exists.

`FileIndex` is intentionally:

- directory-oriented;
- bounded;
- lazy;
- hot-subtree focused;
- used for Explorer listings and metadata.

That is a different responsibility from a full-project path-search corpus.

Initial rule:

```text
SearchIndex
  -> candidate for eventual bypass on Everything-backed Windows roots

FileIndex
  -> retained
```

A later benchmark may test Everything direct-parent queries as a `FileIndex.list()`
cold-miss source, but that is explicitly a separate optimization.

---

## 16. SearchIndex migration and eventual deduplication

### Stage A — unchanged authority

Everything runs in shadow mode only.

```text
existing SearchIndex/native result = production
Everything result                 = measured comparison
```

Collect:

- candidate recall;
- final top-K parity;
- latency;
- result counts;
- policy filtering;
- provider failures.

### Stage B — Everything primary, SearchIndex fallback

For eligible roots/query classes:

```text
Everything candidate source
  -> OpenFork ranker
  -> production result

SearchIndex
  -> fallback / parity oracle
```

### Stage C — stop duplicating full path persistence on eligible roots

Only after sustained parity:

- skip SearchIndex cold `rg --files` seed;
- skip reopen reconciliation;
- skip path chunk persistence;
- skip tombstone accumulation/compaction;
- avoid bulk metadata hydration now supplied elsewhere.

Keep `SearchIndex` intact for:

- macOS;
- Linux;
- Windows without Everything 1.5;
- unavailable/loading/incompatible Everything;
- roots not covered by the Everything index;
- query classes that intentionally fall back.

Do not delete portable infrastructure just because the primary development machine
has Everything installed.

---

## 17. Index Journal: later freshness optimization, not phase-one dependency

Everything 1.5's Index Journal records index changes and SDK3 exposes journal APIs on
sufficiently recent builds.

This is strategically interesting because it could eventually provide a low-cost
Windows change feed for:

- transient local ranking caches;
- FileIndex invalidation;
- search-result refresh;
- watcher-storm reduction.

But phase one must **not** replace OpenFork's Parcel watcher.

The existing watcher also drives unrelated application behavior and has cross-platform
semantics.

Treat journal integration as a separate experiment after Everything search is
production-green.

If eventually adopted:

```text
Everything journal
  -> Windows path-index delta source

Parcel watcher
  -> retained for responsibilities not safely subsumed
```

Only remove duplicate watcher work after explicit ownership analysis.

---

## 18. Caching model

Avoid building another durable whole-project mirror.

Allowed caches:

### 18.1 bridge capability cache

Small machine-scoped cache:

- connected instance;
- Everything version;
- SDK/protocol version;
- readiness;
- property capabilities;
- provider generation.

Invalidate on reconnect/restart.

### 18.2 query-result cache

Optional, bounded, short-lived:

key includes:

- root identity;
- normalized query;
- result kind;
- policy revision;
- provider generation.

Use only after benchmarks show value; Everything may already be faster than the cache
management overhead for many queries.

### 18.3 transient rank accelerator

If a query class genuinely benefits from the existing prepared matcher:

- seed from Everything rather than `rg --files`;
- build lazily/background;
- scope it to one root/provider generation;
- never require it for first result;
- discard/rebuild on structural generation change.

Do not persist another duplicate corpus merely to make this cache durable.

---

## 19. Observability

The provider should be diagnosable without exposing machine-wide paths.

Recommended structured fields:

```text
provider=everything|search-index|ripgrep|fff
provider_state
provider_generation
query_class
candidate_pages
candidate_count
accepted_count
filtered_count
ranked_count
duration_provider_ms
duration_policy_ms
duration_rank_ms
duration_total_ms
fallback_reason
result_truncated
```

Do not log raw user paths/queries at high-volume informational levels unless the
existing search logging contract already permits it.

A diagnostic/status surface may expose:

- Everything detected version;
- instance name;
- connection state;
- root coverage;
- capabilities;
- current fallback reason.

It must not dump the global Everything index.

---

## 20. Configuration

Default behavior should be automatic and fail-soft.

Conceptual settings:

```text
search.everything.enabled = auto | true | false
search.everything.instance = optional string
search.everything.transport = auto | direct | helper   # developer/diagnostic initially
search.everything.shadow = boolean                     # development only
```

Rules:

- `auto`: use when proven healthy/covered;
- `false`: never connect;
- `true`: prefer provider but still fail safely to native behavior unless an
  explicit diagnostic mode requests hard failure;
- no query-semantic differences should require a user setting.

Do not expose provider-specific tuning knobs until real benchmark evidence warrants
them.

---

## 21. Performance and correctness gates

These are provisional gates; refine them with the SDK3 transport bakeoff.

### 21.1 Hard architectural gates

Production Everything search must have:

- zero `es.exe` process spawn per query;
- zero full-repository `rg --files` seed on an eligible Everything-backed root once
  Stage C is enabled;
- zero O(N) renderer path scan as the primary Project Explorer search mechanism;
- no eager multi-second `Matcher.prepare` on first keystroke;
- no provider result accepted outside the authorized root;
- no raw Everything syntax crossing a public API boundary.

### 21.2 Candidate correctness

Use full native OpenFork search as the oracle.

For supported Everything candidate-query classes:

- 100% match recall for the mandatory semantic/golden suite;
- exact top-K order after OpenFork scoring for golden cases;
- no missing basename/camel/separator/acronym/subsequence cases;
- deterministic pagination with no duplicates;
- correct directory completion;
- ignore-policy parity.

If probabilistic/adaptive candidate limiting is ever used, establish an explicit
measured recall SLO in addition to the exact golden suite. Do not silently accept
“looks good.”

### 21.3 Latency

Minimum relative requirement:

- small repos: routing must preserve the existing local fast path when that is faster;
- 100k and 250k corpora: Everything-backed total search must materially beat the
  current full scan at p50 and p95;
- first query must not depend on a full-corpus JS index build.

Initial aspirational server-compute targets:

- 100k paths: p95 <= 16 ms for a 200-result interactive query;
- 250k paths: p95 <= 25 ms;
- query supersession should prevent stale work from producing visible latency.

Do not declare these targets achieved from synthetic provider-only numbers. Measure
the full OpenFork planner + policy + rank path.

### 21.4 Startup

Eligible Everything-backed location construction should not perform work
proportional to repository file count.

Provider connection/probe should be lazy and bounded.

---

## 22. Benchmark corpus

The benchmark suite should include:

1. current OpenFork repo;
2. deterministic 100k synthetic corpus;
3. deterministic 250k synthetic corpus;
4. pathologically deep paths;
5. unicode paths;
6. mixed separators/casing;
7. many identical basenames in different directories;
8. generated/dependency-heavy trees;
9. ignored directories dominating lexical matches;
10. very short queries (`s`, `a`);
11. acronym queries (`dsm`);
12. multi-token queries;
13. trailing slash/directory-completion queries;
14. extension-heavy queries;
15. renamed/deleted files during a keystream.

Record:

- p50/p95/p99;
- cold/hot;
- candidate count;
- accepted count;
- IPC bytes;
- CPU;
- memory;
- top-K parity.

---

## 23. Test plan

### 23.1 Pure unit tests

Candidate-query compiler:

- escaping;
- metacharacters;
- unicode;
- path-root scoping;
- token AND semantics;
- file/directory mode;
- result pagination;
- no raw query injection.

Policy layer:

- gitignore;
- hidden files;
- `.git`;
- watcher ignore;
- root containment;
- reparse policy;
- overfetch after filtering.

Rank integration:

- exact existing mention golden cases;
- highlight positions;
- basename offsets;
- deterministic ordering;
- metadata merge.

### 23.2 Transport tests

Use a fake SDK3/named-pipe server or protocol fixture where practical.

Test:

- framing;
- partial reads;
- partial writes;
- invalid reply;
- disconnect;
- reconnect;
- timeout;
- named instance;
- concurrent requests;
- stale generation;
- process/helper exit.

### 23.3 Optional live Everything tests

Gate behind an explicit environment capability.

Never make ordinary CI require Everything.

Live tests should verify:

- detected version;
- known fixture root;
- exact filename query;
- directory query;
- offset/limit;
- metadata;
- create/rename/delete freshness;
- Everything restart/reconnect;
- journal if enabled.

### 23.4 Existing regression suites that must remain green

At minimum:

- `packages/core/test/search-mention-fast.test.ts`
- `packages/core/test/search-index-service.test.ts`
- `packages/core/test/filesystem/search.test.ts`
- `packages/core/test/filesystem/search-watcher.test.ts`
- `packages/core/test/filesystem/search-ranking.test.ts`
- Project Explorer search tests;
- prompt @mention tests;
- OXP/find and tool glob/grep tests touched by the migration.

---

## 24. Implementation phases and ledger

### Phase 0 — plan + controlled 1.5 development environment

- [x] Establish architecture direction.
- [x] Capture current search benchmark.
- [x] Install/run Everything 1.5 side-by-side as a named development instance.
- [x] Record exact build, instance, pipe, index coverage, indexed properties.
- [x] Preserve 1.4 until 1.5 development gates are green.

Evidence (2026-10-04): stable Everything 1.4.1.1032 remains intact; isolated
Everything 1.5.0.1423b / SDK3 3.0.0.9 runs as instance OpenFork-SDK3 on
\\.\PIPE\Everything IPC (OpenFork-SDK3). Official SDK3 reports DB_LOADED=1.
The live OpenFork checkout is a normal C: directory. W: ReFS was explicitly
added for coverage/freshness validation; observed create/rename/delete visibility
was approximately 36/29/90 ms.

**Exit:** repeatable SDK3 target exists without losing the stable reference install.

### Phase 1 — SDK3 transport bakeoff

- [x] Pull/vendor only the minimum official SDK3 reference material needed for the
  experiment, preserving license/provenance.
- [x] Prototype direct TS named-pipe client.
- [x] Prototype official-SDK3 helper.
- [x] Build one benchmark driver used against both.
- [x] Compare Bun and Node.
- [x] Test named-instance and timeout/reconnect behavior.
- [x] Choose transport in this document and record evidence.

Decision: adopt direct TypeScript SDK3 named-pipe transport for the initial
production shadow bridge; do not ship the native helper initially.

Shared-driver p50 evidence on the same root/query:

| runtime | transport | 30 | 200 | 1000 | 4x200 pool |
| --- | --- | ---: | ---: | ---: | ---: |
| Node 24.21 | direct TS | 152.0 ms | 130.0 ms | 133.5 ms | 493.2 ms |
| Node 24.21 | helper | 136.7 ms | 122.4 ms | 114.2 ms | 382.5 ms |
| Bun 1.4.2 | direct TS | 119.8 ms | 117.9 ms | 114.8 ms | 467.6 ms |
| Bun 1.4.2 | helper | 113.6 ms | 115.4 ms | 113.4 ms | 442.4 ms |

Both returned identical result counts and passed normalized root confinement.
The helper wins steady-state throughput, but direct TS avoids binary
packaging/signing/update complexity and recovered faster after a hard timeout:
~118 ms vs ~328 ms on Node, ~153 ms vs ~350 ms on Bun.

**Exit:** one transport selected with measured latency, correctness, and failure
behavior.

### Phase 2 — EverythingBridge

- [x] Add machine-scoped lazy bridge.
- [ ] Add provider state machine.
- [ ] Add version/capability discovery.
- [x] Add named-instance support.
- [x] Add hard timeout/reconnect.
- [ ] Add structured diagnostics.
- [x] No user-visible production consumer yet; current invocation is shadow-only.

**Exit:** Core can safely query a fixture Everything instance from Bun and Node.

### Phase 3 — shared candidate planner in shadow mode

- [x] Define internal candidate request/page types.
- [x] Compile normalized OpenFork query to Everything candidate query.
- [x] Implement root fencing.
- [ ] Implement visibility policy/overfetch.
- [x] Feed candidates through existing OpenFork ranker in the parity harness.
- [x] Invoke alongside the current native path without affecting user output.
- [x] Build parity/recall benchmark for file-only mention candidates.

120k materialized-corpus evidence (2026-10-05):

- corpus: 120,120 indexed entries;
- file-only top-K recall reached 100% for ordinary token, multi-token,
  basename, path-prefix, short acronym, hyphen-boundary acronym, and camel-case
  acronym queries in the current matrix;
- representative green queries include `search`, `server session`,
  `project explorer`, `sis`, `abg`, `vlccsc`, `file-0999`,
  `search candidate`, and `proj exp`;
- `pkg-119` measured 95-98% only because the native top-K also contained the
  directory row `pkg-119`, while the current Everything shadow provider is
  intentionally file-only. File rows under that directory were covered.

The fuzzy compiler was subsequently widened again after the heterogeneous W:
oracle exposed valid high-scoring basename subsequences that were not word
boundary acronyms. The current shadow supplement uses a basename-only
case-insensitive subsequence regex for bounded 2-8 character single tokens:

`case:regex:name:"(?i:a.*?b.*?c)"`

This source is useful only when it is itself exhausted. The provider records
`basenameSubsequenceComplete`, and the OpenFork scorer supplies a conservative
upper bound for any omitted match that must consume at least one directory
character. A candidate page is therefore certifiable only when its returned
score floor strictly dominates that omitted-match bound.

This is sufficient to mark the materialized-corpus recall/rerank harness green,
but not the entire Phase 3 exit: visibility-policy parity and a provably safe,
beneficial large-root eligibility rule still require explicit proof.

Additional Phase 3 evidence (2026-10-05, superseding the earlier intermediate probes):

- the live compiler is now an exact path-aware branch plus a bounded file-only
  acronym/fuzzy expansion, then dedupe and OpenFork reranking;
- the 120,120-entry ordered-parity harness is exact for all current cases,
  including `search`, `sis`, `abg`, `vlccsc`, `server session`,
  `project explorer`, `file-0999`, `pkg-119`, `search candidate`, and
  `proj exp`, plus offsets 20/40/100/250 where exercised;
- nested-directory cases `src/s`, `src/se`, and `packages/c` reproduce native
  directory/file ordering on the current compiler bytes;
- a 512-candidate minimum fully materializes the common selective sets in one
  pass (`search`/`sis`: 360 rows; acronym/basename fixtures: 120) without a
  material latency penalty versus 160, while broad `f`, `file`, and `ts`
  queries remain explicitly `complete:false` and therefore stay native;
- shadow scheduling is bounded to one running request plus one latest pending
  generation; intermediate generations resolve as `stale`. The provider
  scheduler is now the single generation source; duplicate per-layer fences were
  removed so staleness cannot drift between the bridge and FileSystemSearch;
- focused search verification is green and scoped typecheck reports zero
  diagnostics in the touched production files.

Safety closeout evidence after independent review:

- the live socket `data` handler is identity-guarded, matching the error/close
  handlers, so late bytes from a destroyed/replaced pipe are discarded;
- foreground and shadow queries use separate SDK3 clients; detached telemetry
  cannot hold the future foreground client busy;
- provider results preserve `measured`, `busy`, and structured
  `unavailable` states (`unsupported`, `database-loading`, `transport`,
  `protocol`) instead of collapsing failures into a successful empty page;
- shadow logs now retain provider reason/detail for transport or protocol
  regressions;
- candidate normalization rejects non-absolute SDK paths before root fencing;
- ripgrep shadow candidates are intersected with the exact known
  file/directory snapshot, and SearchIndex shadow candidates are intersected
  with the query-time SearchIndex snapshot. SearchIndex shadowing is skipped
  when configured watcher ignores exist;
- focused verification is 35/35 green after adding explicit root-rejection,
  provider-state, true-empty-vs-unavailable, exhaustive-page, and latest
  generation coverage. Production-file typecheck has zero target diagnostics.

Adversarial overfetch result:

- a fixture containing 6,000 provider-favored decoys plus
  `zzzz/search.ts` proves that fixed overfetch is unsound: the native #1 is
  absent at 160/320/640/1280/2560/5000 candidates and first appears at provider
  index 6000;
- the completeness contract catches this correctly: the query is
  `complete:false` until the 6,001-row source is fully materialized;
- broad 120k-corpus queries such as `f`, `file`, and `ts` report
  `requiredCount:10000`, `exhaustible:false`, and must remain native.

Real large-root evidence (W:, approximately 1.03M visible rows after native
visibility filtering) shows that routing is query-shape dependent:

| query | native scan p50 | proven/selective provider evidence | decision |
| --- | ---: | ---: | --- |
| `search` | ~1282 ms | basename-prefix proof ~386 ms | promising |
| `src` | ~913 ms | basename-prefix proof ~267 ms | promising |
| `readme` | ~960 ms | basename-prefix proof ~298 ms | promising |
| `json` | ~371 ms | basename-prefix proof ~486 ms | keep native |
| `sis` | ~1323 ms | current exact+boundary set not order-complete | keep native |
| `vlccsc` | ~2882 ms (measured full scan) | exhaustive basename subsequence ~896 ms, exact | promising |

The prefix proof is mathematical, not heuristic: when an exhaustive basename
prefix source yields at least the requested top-K and its reranked floor exceeds
the maximum possible score of every non-prefix match, the top-K is final. A
general basename-subsequence source has a separate directory-only omitted-score
bound and is usable only when that source is exhaustible.

Synthetic Bun and Node scale benchmarks reinforce that **corpus size alone is
not an eligibility signal**. Mask-selective queries can remain single-digit
milliseconds at million-scale while difficult subsequence/acronym shapes rise
into hundreds of milliseconds.

FFF also cannot be treated as a universal comparator: its native binding
explicitly refuses filesystem-root/home-root indexing, while Everything can
cover those roots. Conversely, ordinary project roots where FFF is available
must retain FFF unless a separate apples-to-apples benchmark proves a benefit.

Remaining Phase 3 blockers are now narrower:

1. keep FFF-owned Bun search unchanged until it has its own parity/performance
   proof; current Everything shadow evidence applies to ripgrep/SearchIndex
   ownership paths;
2. prototype the staged proof planner (exhaustive basename prefix first, then
   exhaustible basename subsequence only when needed) and preserve exact
   offset/limit/positions/baseOffset semantics;
3. define a benefit predictor from real keystream telemetry. A fixed
   `corpus >= N` threshold is explicitly rejected by the Bun/Node scale data;
4. preserve `total`/`hasMore` semantics when a proof establishes top-K
   ordering but does not enumerate every lower-ranked match;
5. retain hard native fallback for every non-proven/incomplete/provider-fault
   case and add transport cancellation only if bounded latest scheduling proves
   insufficient in UI E2E.

#### Real-corpus cutover gate (2026-10-05)

The 120k fixture is necessary but not sufficient. A second oracle was built from
the isolated Everything instance over W:, yielding 1,032,081 visible
non-dot-segment entries after OpenFork normalization. This exposed semantic and
performance cases that the synthetic corpus does not contain.

- native `searchFileMentionsFast` remains extremely fast for ordinary and
  multi-token queries even at large scale: synthetic 1.5M-path p50 was
  ~16.8 ms for `search` and ~11.3 ms for `proj exp`;
- expensive fuzzy shapes scale differently: at 1.5M paths p50 was ~425.6 ms
  for `sis` and ~277.8 ms for `file-0999`;
- on the 1.03M-entry W: oracle, Everything was faster than native for some
  expensive shapes (`sis`: ~506.7 ms provider vs ~1512.6 ms native;
  `abg`: ~350.2 ms vs ~476.8 ms), but the reranked candidate set was not
  exactly equal to native;
- `vlccsc` is a decisive counterexample: native subsequence ranking found
  high-scoring long filenames while the exact + boundary-acronym Everything
  union returned zero candidates;
- a broad `json` query reproduced the exact native top-K in the measured W:
  run, but Everything was slower (~434.7 ms provider + ~13.9 ms rerank vs
  ~271.0 ms native);
- an adversarial 120k corpus can hide the native top result beyond 5,000
  Everything candidates, so a fixed overfetch multiplier or large fixed cap is
  not a correctness proof;
- therefore `complete:true` means the compiled Everything source queries were
  exhausted, **not** that all paths matchable by OpenFork's richer subsequence
  scorer were enumerated.

The first rigorous safe-and-faster query-shape case now exists, but it is not
yet a production eligibility policy. On the current 1,032,082-entry W: oracle,
`vlccsc` produced 945 normalized candidates from an exhausted 1,278-result
basename-subsequence source, reproduced the native ordered top-20 exactly, and
returned a score floor of 469 versus a conservative omitted-match upper bound
of 245. The live `compareShadow` gate therefore reported
`provenTopK:true`. Provider latency was ~405-519 ms in the latest runs versus
~642 ms native in the directly comparable current-provider run; an earlier
isolated run measured ~494 ms provider + ~2.5 ms rerank versus ~1434 ms native.

The same widened compiler correctly refuses to certify broad short acronyms:
`sis` was incomplete/non-exhaustible with 0.5 top-K recall, floor 62 versus
bound 107, and `provenTopK:false`; `abg` was likewise incomplete with 0.1
recall, floor 30 versus bound 107, and `provenTopK:false`. Broad ordinary
queries such as `json`, `search`, and multi-token `proj exp` also remain
incomplete and/or slower than native on this oracle.

A 9-sample warm stability run on the same 1,032,082-entry oracle kept
`vlccsc` complete, ordered-exact, and `provenTopK:true` on every sample.
Native p50/p95 were ~643.1/~792.5 ms; SDK3 provider p50/p95 were
~416.1/~510.3 ms, about 35% faster at both percentiles. The proof remained
floor 469 versus omitted-score bound 245 throughout. This is sufficient to
establish a repeatable beneficial query-shape example, but it is not yet a UI
eligibility policy.

A three-sample keystream-tail probe reinforces that separation between
correctness and benefit. On the same oracle, `vlc` was incomplete/unproven
and slower (~349 vs ~307 ms p50); `vlcc` was proven and ordered-exact but
still slower (~328 vs ~300 ms); `vlccs` was proven and faster (~320 vs
~463 ms); and `vlccsc` was proven and faster (~261 vs ~519 ms). Therefore
`provenTopK` is a correctness gate, not an eligibility classifier. Any
production policy must independently predict a performance win from query
shape/corpus evidence and keep native behavior for proof-positive but
non-beneficial shapes.

A heterogeneous 5-6 character sample confirmed the proof gate is conservative:
`vbcnt` and `vncac` were complete, ordered-exact, and proven; `sisbk`,
`slvab`, and `srchgo` were complete but failed ordered parity and remained
unproven; `lbtag` happened to be ordered-exact but still remained unproven
because its score floor (105) did not dominate the conservative bound (199).
Provider/native single-run timings also varied from marginal (~206/~215 ms for
`vbcnt`) to material (~224/~321 ms for `vncac`), reinforcing that token
length alone is not a sufficient performance classifier.

Do not promote merely because a source set is exhausted. Production
eligibility must require the semantic proof gate **and** repeated evidence that
the query shape benefits from SDK3 at interactive p50/p95/p99.

**Phase 4 promotion status: HOLD.** One certifiable query-shape case is now
measured, but the shadow bridge remains the only production use because
interactive eligibility and latency stability are not yet proven. It is retained because
it is root-fenced, visibility-intersected, latest-generation bounded, fault
isolated, and useful for continued measurement. It must not become the
authoritative @mention candidate source on the current evidence. The next
optimization iteration should benchmark repeated expensive single-token
keystreams and derive a conservative eligibility classifier from proof status,
query shape, corpus size, and measured latency; ordinary and multi-token
queries already favor the native scan by a wide margin.

The current certification compiler now uses exhaustive basename-subsequence
coverage rather than the earlier boundary-only regex. The certifying source is
merged before opportunistic exact-path rows, and shadow reranking restores the
authoritative native corpus order so \`mention-fast\`'s final corpus-ID tie-break
is preserved. A shadow invariant now requires every claimed proof observed
against the native oracle to also have exact ordered parity.

W: prefix-keystream evidence over ~1.03M visible entries further narrows the
future eligibility shape:

- \`v\`, \`vl\`, and \`vlc\` were not certifiable;
- \`vlcc\`, \`vlccs\`, and \`vlccsc\` were certifiable and ordered-exact, with
  provider latency below native in the same loaded run;
- \`s\`, \`se\`, \`sea\`, \`sear\`, and \`searc\` were not certifiable;
- full \`search\` became certifiable and ordered-exact once its basename source
  was exhaustive, and again beat native on this slow heterogeneous root;
- \`sis\` and \`json\` remained correctly unproven and mismatched.

This rules out corpus size alone as the foreground switch: the synthetic 1.5M
corpus can scan ordinary \`search\` in single-digit hot milliseconds while W:
takes hundreds of milliseconds for the same text. Recent-query latency alone is
also insufficient: on the synthetic 1.5M keystream, \`se\` measured ~283 ms p50
but the immediately longer \`sea\` dropped to ~8 ms and full \`search\` to
~6.7 ms. A future foreground planner therefore needs semantic certification
plus a query-specific native-cost predictor. The next experiment should exploit
the character-presence masks already built by \`mention-fast\` (for example a
compact inverted bitset/selectivity estimate) rather than guessing from corpus
size or the previous keystroke. Until that classifier is independently
validated, Phase 4 remains HOLD.

Native-baseline correction: the ripgrep backend previously rebuilt a fresh
\`PathEntry[]\` for every mention query, defeating \`mention-fast\`'s WeakMap
prepared-corpus cache. It now reuses a revision-stable candidate array and
invalidates it on structural watcher/seed revisions. On the 120,120-entry
materialized corpus this changed p50 from ~12.55 -> 0.48 ms for \`search\`,
~11.16 -> 0.38 ms for \`proj exp\`, ~19.2 -> 8.59 ms for \`file-0999\`, and
~32.57 -> 17.92 ms for \`sis\`. All future SDK3 crossover claims must therefore
compare against this cached native baseline rather than the earlier
per-keystroke cold-preparation path.

Visibility ownership is considered demonstrated for the current shadow
backends: ripgrep-layer candidates are intersected with its exact live
`known`/directory snapshot, SearchIndex candidates with its query-time
snapshot, configured watcher-ignore workspaces are routed to the ignore-aware
backend, and provider normalization independently rejects dot-segment and
out-of-root paths. A dedicated fixture confirmed that a broader Everything
result containing ignored/hidden rows was reduced to the sole
native-authoritative visible row.

**Exit:** shadow results meet correctness and large-corpus performance gates.

### Phase 4 — @mention / `/find/search` primary cutover

- [ ] Route eligible file-only mention queries through planner.
- [ ] Keep symbols on existing owner and merge correctly.
- [ ] Preserve offset/limit/positions/baseOffset.
- [ ] Keep native fallback on any provider fault.
- [ ] Add generation/cancellation tests.
- [ ] Measure real UI keystream.

**Exit:** @mention is faster on large roots with no golden-result regression.

### Phase 5 — remaining workspace file search consumers

- [ ] Audit `file.find`, command palette, select-file and tab pickers.
- [ ] Converge semantically compatible consumers.
- [ ] Preserve consumer-specific result limits and types.
- [ ] Avoid duplicate app-side search implementations.

**Exit:** common workspace file lookup uses one Core planner.

### Phase 6 — Project Explorer workspace search

- [x] Separate candidate discovery from tree projection.
- [x] Fetch ranked workspace paths server-side as an additive unloaded-path channel.
- [x] Build match/ancestor closure without recursively materializing the workspace.
- [x] Preserve owned expansion lifecycle.
- [ ] Remove/demote renderer O(N) scan after parity.
- [ ] Add large-tree E2E/performance coverage.

Current vertical slice (2026-10-05):

- the existing loaded-tree substring scan remains authoritative and publishes
  immediately;
- Project Explorer concurrently calls the existing cancellable
  `/find/search` client with `symbols:false` and a bounded 1,000-row page;
- because that endpoint is fuzzy, only returned paths that also satisfy the
  Explorer's existing case-insensitive substring rule are admitted, so this
  channel can add unloaded matches but cannot broaden current semantics;
- server paths are merged into match/ancestor sets and the existing
  search-owned expansion controller lists those ancestors without taking
  ownership of user-expanded branches;
- row projection is now against the live tree after expansion instead of a
  frozen search-start row array, allowing unloaded matches to appear as their
  branches load;
- the local node corpus is snapshotted once per query generation. Search-owned
  expansion no longer feeds `nodeVersion` back into the same search effect and
  repeatedly aborts/restarts it;
- newly loaded visible rows are still checked against the substring query
  during projection, so ordinary watcher/tree updates inside visible branches
  remain responsive without a whole-corpus rescan;
- generation cancellation aborts both the cooperative local runner and the
  in-flight server request;
- server discovery can publish before a very large local scan completes, while
  the eventual local result is merged back in rather than replacing it;
- one-character queries remain local-only to avoid spending a full-workspace
  interactive request on extremely low-selectivity input;
- the server channel is intentionally **additive and bounded**, not yet a claim
  of exhaustive full-workspace result enumeration. The local O(N) scan remains
  until server-result pagination/coverage and E2E parity are proven.

Verification on current bytes:

- focused Explorer search/expansion tests: 11/11 passing;
- new coverage proves candidate-set mode avoids static projection and unloaded
  server paths derive the complete ancestor closure;
- a live-projection regression test proves an unloaded server-discovered file
  appears automatically as its ancestor rows and final file row load, without
  rerunning candidate discovery;
- the app's native `tsgo -b` typecheck passes.

Renderer microbenchmark (same runner, monolithic timing to isolate CPU work):

| loaded nodes | old scan + static projection | candidate sets only | speedup |
| ---: | ---: | ---: | ---: |
| 50k | ~77.5 ms | ~37.8 ms | ~2.05x |
| 250k | ~426.5 ms | ~179.5 ms | ~2.38x |

This validates the separation of candidate discovery from tree projection, but
the remaining local scan is still O(N). It must not be removed until the
server-side channel can prove exhaustive Explorer-substring coverage (or an
equivalent no-regression rule) rather than only returning a bounded fuzzy-ranked
page.

**Exit:** Explorer search covers unloaded workspace paths and remains responsive.

### Phase 7 — tool/OXP path-search integration

- [ ] Re-audit current `find`/glob/OXP authority contract immediately before edits.
- [ ] Reuse candidate engine only after permission/root authorization.
- [ ] Prove glob semantic parity or retain ripgrep for unsupported patterns.
- [ ] Preserve absolute path and virtual-root projection.
- [ ] Preserve cancellation and truncation.
- [ ] Keep grep on ripgrep.

**Exit:** eligible path/glob searches benefit without authority/schema regression.

### Phase 8 — SearchIndex de-duplication on eligible Windows roots

- [ ] Collect production/shadow evidence over multiple restart/rename/delete cycles.
- [ ] Stop cold seed for eligible Everything roots.
- [ ] Stop duplicate path persistence.
- [ ] Stop reconcile/tombstone/compaction work where Everything is authoritative.
- [ ] Preserve portable fallback unchanged.
- [ ] Verify switching Everything off immediately restores native behavior.

**Exit:** Windows no longer maintains two whole-workspace path indexes unnecessarily.

### Phase 9 — optional Index Journal experiment

- [ ] Benchmark journal read/seek latency.
- [ ] Define durable/ephemeral cursor semantics.
- [ ] Compare with Parcel watcher storm behavior.
- [ ] Decide whether any Windows path-index invalidation may move to the journal.
- [ ] Do not alter unrelated watcher ownership without separate evidence.

**Exit:** explicit keep/reject decision; not required for base feature.

### Phase 10 — optional FileIndex cold-miss experiment

- [ ] Benchmark `FileIndex` hot hit vs cold readdir/stat vs Everything direct-parent.
- [ ] Verify metadata/order/ignore parity.
- [ ] Adopt only if measurable and simpler.

**Exit:** explicit keep/reject decision.

---

## 25. Likely file map

This is a forecast, **not permission to edit stale bytes without reinspection**.

Core candidates:

- `packages/core/src/filesystem/search.ts`
- `packages/core/src/filesystem/search-policy.ts`
- `packages/core/src/search/mention-fast.ts`
- `packages/core/src/search/index-service.ts` — later-stage bypass only
- new internal Everything bridge / path candidate modules under
  `packages/core/src/search/**` or `packages/core/src/filesystem/**`
- `packages/core/package.json` only if runtime import mapping is actually needed

Server/API:

- `packages/opencode/src/server/routes/instance/httpapi/handlers/file.ts` only if
  planner metadata/diagnostics require handler changes;
- public `/find/search` schema should ideally remain unchanged for initial cutover.

App:

- `packages/app/src/context/file.tsx`
- `packages/app/src/components/project-explorer-tree.tsx`
- `packages/app/src/components/project-explorer-search-runner.ts`
- related tests.

Tool path:

- `packages/opencode/src/search/filesystem.ts`
- `packages/opencode/src/tool/glob.ts`
- `packages/opencode/src/tool/find.ts`
- corresponding OXP/tool tests.

Desktop/build:

- only if the selected transport requires packaging a helper or new runtime asset;
- `packages/opencode/script/build-node.ts` must remain Node-compatible.

---

## 26. Explicit non-goals

Initial implementation does **not**:

- replace ripgrep content search;
- replace the entire OpenFork filesystem abstraction;
- require Everything on non-Windows systems;
- require Everything for OpenFork to function on Windows;
- expose global machine search to agents;
- add raw Everything syntax to a public API;
- make Project Explorer listing depend on Everything;
- replace Parcel watcher;
- index file contents in Everything for OpenFork;
- maintain SDK2/Everything 1.4 acceleration;
- eagerly materialize the Everything global index into JS memory;
- blindly trust Everything result ordering as OpenFork relevance.

---

## 27. Rollback design

Every implementation phase must preserve a single runtime escape hatch:

```text
Everything disabled/unhealthy
  -> existing native OpenFork behavior
```

Rollback must not require:

- rebuilding a lost SearchIndex schema;
- restarting the desktop app solely to recover correctness;
- clearing user repositories;
- deleting Everything data;
- changing public SDK schemas.

Before Stage C SearchIndex de-duplication, rollback is immediate provider selection.

After Stage C, native SearchIndex may cold-seed again; this is slower but correct.

---

## 28. Open questions that require measurement

Do not answer these by preference:

1. direct TypeScript SDK3 vs native helper?
2. exact SDK3 minimum Everything build for OpenFork's required query/property subset?
3. whether indexed size/mtime can be requested with zero material latency on the
   supported configuration?
4. ideal candidate page size by corpus/query shape?
5. exact small-repo crossover where local scan beats IPC?
6. whether candidate-channel union is necessary or one compiled high-recall query is
   sufficient?
7. whether a transient prepared matcher is ever worth building after Everything exists?
8. whether Everything direct-parent queries beat `FileIndex` cold misses enough to
   justify integration?
9. whether the Index Journal can safely reduce any current Windows watcher work?
10. whether reparse-point filtering can be implemented entirely from indexed
    attributes without filesystem stats?

Each answer belongs back in this plan with benchmark evidence.

---

## 29. Definition of done

The feature is architecturally complete when all of the following are true:

1. Everything 1.5 is an optional, first-party Windows path-index provider.
2. Bun server and Node Desktop use the same semantic provider behavior.
3. No hot query spawns `es.exe`.
4. @mention uses Everything acceleration on eligible large roots and preserves
   OpenFork ranking semantics.
5. Project Explorer can search unloaded/full-workspace paths without renderer O(N)
   scanning as its primary search engine.
6. Common file pickers converge on the same Core search planner where semantics match.
7. Model/OXP path search can reuse the substrate without weakening existing authority.
8. Content grep remains deterministic ripgrep.
9. Unsupported/unavailable Everything falls back automatically.
10. Eligible Windows roots no longer need duplicate whole-project SearchIndex
    persistence once parity is proven.
11. Small repos are not made slower merely to route through Everything.
12. Search latency, recall, memory, startup, and failure behavior have reproducible
    benchmark gates.
13. Disabling Everything restores native behavior without data repair.
14. The architecture remains portable: Everything is an acceleration provider, not an
    OpenFork platform dependency.

---

## 30. Immediate next action

Phase 0/1 is complete and the direct SDK3 transport is now present behind a
behavior-preserving shadow hook. The next action is **not** user-visible cutover.

1. complete visibility-policy parity across every eligible FileSystemSearch
   backend/consumer mode, including configured watcher-ignore cases;
2. formalize the production eligibility gate around `complete:true`, provider
   health, supported query shape, and measured native-vs-provider cost;
3. run real UI keystream p50/p95/p99 benchmarks on very large roots, especially
   acronym/basename-heavy queries where the native scan actually becomes costly;
4. keep the 100,000-path value as shadow telemetry only; do not use corpus size
   alone as the provider selector;
5. retain current+latest generation fencing, hard timeout/reconnect, and
   immediate native fallback as non-negotiable cutover invariants;
6. only after visibility and performance gates pass, permit Everything
   candidates to replace native candidate enumeration for eligible mention
   queries.

Until then, shadow calls must not change user-visible ordering or results.

Update (2026-10-05, current bytes):

- ripgrep shadow candidates are now intersected with the backend's live
  `known` file set and derived directory set, so Git-ignore, hidden-path, and
  configured watcher-ignore semantics remain owned by the native backend;
- SearchIndex shadow candidates are intersected with the query-time
  authoritative snapshot (built lazily inside detached shadow work);
- the OpenFork scorer now exposes a conservative single-token omitted-score
  upper bound, and shadow telemetry reranks candidates through
  `searchFileMentionsFast` to report `orderedExact`, the top-K score floor,
  the omission bound, and `provenTopK`;
- the 120k proof smoke correctly distinguishes measured parity from proof:
  `search` was both exact and proven (`948 > 647`), while `sis`, `abg`,
  and `vlccsc` remained unproven despite exact measured parity;
- a real 1.03M-path W: experiment showed that exhaustive basename-subsequence
  coverage can make a long fuzzy token safe and faster (`vlccsc`: exact
  parity, ~627 ms provider + ~1.7 ms rerank vs ~1.43 s native, top-K floor 469
  above the directory-only omission bound 245);
- that strategy is **not** enabled unconditionally: doing so made common long
  terms such as `readme` non-exhaustible and materially slower, so production
  query compilation remains conservative until an adaptive eligibility rule
  can choose the extra source without regressing broad terms;
- FFF on the 120k materialized project scans ready in ~596 ms and hot mixed
  search ranges from ~8 ms (`search`) to ~184 ms (`proj exp`) on the sampled
  shapes. FFF intentionally refuses filesystem-root scopes such as W:, where
  Everything retains a unique coverage advantage.

**Phase 4 verdict remains closed:** there is still no general @mention rule that
is simultaneously proven safe and faster than the backend users actually run.
Do not force a primary-picker cutover. Continue collecting shadow proof data,
but shift active Everything adoption work toward consumers that need unloaded
workspace or machine/global path discovery.

### 30.1 Materialized 120k shadow evidence

The first real indexed-corpus parity run used 120,000 materialized files
(120,120 entries including directories) rather than synthetic path strings.
The corpus intentionally included basename, multi-token, acronym, camel-case,
and directory-token cases.

Findings:

- exact / ordinary multi-token queries such as `search`, `server session`,
  `project explorer`, `file-0999`, `search candidate`, and `proj exp`
  achieved 100% native top-K coverage in the sampled 20/50 windows;
- raw Everything syntax produced 0% coverage for acronym/camel queries such as
  `sis`, `abg`, and `vlccsc`;
- staged character expansion restored 100% sampled coverage for `abg` and
  `vlccsc`, but `sis` remained 0% because the expanded query was too broad
  and the desired rows were not inside the bounded candidate viewport;
- a directory-token query (`pkg-119`) returned the directory itself rather
  than its descendants, yielding only 2-5% sampled top-K coverage.

Follow-up with SDK3 MATCH_PATH (0x00000004) confirmed that path-aware matching
is required for directory-segment queries:

- `pkg-119` improved to 100% sampled top-K coverage;
- ordinary exact/multi-token cases remained at 100%;
- however, broad acronym/camel candidate ordering changed enough that
  `vlccsc` regressed to 0% sampled coverage while `sis` remained 0%.

Conclusion: one monolithic Everything query/flag strategy is insufficient.
Future cutover work must union multiple bounded candidate strategies before
OpenFork ranking, then dedupe and measure recall on that union.

Performance on this same 120k real corpus also rejects a 100k cutover:

- native OpenFork scan: roughly 1-25 ms across the sampled query classes;
- Everything shadow provider: roughly 80-210 ms depending on query/fallback;
- current reproducible native benchmark on this machine: 100k hot median
  ~20.7 ms, 250k hot median ~57.7 ms.

Therefore the provisional 100,000-path value is a **shadow telemetry threshold
only**, not an acceleration crossover. Any production cutover must use a
materially higher, measured crossover and must exclude query classes whose
candidate recall has not reached the parity gate.

The shadow provider was also hardened after independent verification:

- single-flight state is acquired before async connect to prevent cross-wired
  concurrent responses;
- receive-buffer state is cleared on hard timeout;
- a live IS_DB_LOADED readiness probe runs before search;
- shadow comparison is detached from the interactive mention request, so SDK3
  latency cannot delay user-visible results;
- focused provider/search verification is 33/33 passing;
- scoped typecheck reports zero diagnostics in the touched production files
  (three unrelated transitive diagnostics remain elsewhere in the repository).

### 30.2 Current ordered-parity and crossover evidence

The current-byte ordered-parity harness feeds Everything candidates back through
`searchFileMentionsFast`. Every case in the current 120,120-entry matrix is an
exact ordered match after OpenFork reranking, including directory rows and the
tested offsets through 250.

The 512-candidate floor was useful for ordinary fixture coverage but is **not a
correctness boundary**. An adversarial corpus with 3,000 path-level
`search-decoy-*` matches and a native #1 basename-exact
`zzzz/search.ts` demonstrated that fixed overfetch is unsound:

- candidate counts 160, 320, 640, 1,280, 2,560, and 5,000 all omitted the native
  #1 result;
- the target did not appear until candidate index 6,000;
- fetching 7,000 returned the complete 6,001-result candidate universe and only
  then made exact OpenFork reranking possible.

The provider now reports `complete`, `requiredCount`, and `exhaustible`.
When the per-source result-count upper bound is <= the 10,000 hard safety cap,
`searchCandidatesExhaustive` performs at most one exact-size retry; otherwise
the request remains incomplete and must fall back to native search. Fixed
`8x`, 512, or any other static viewport is never sufficient evidence for
cutover.

Performance rejects a corpus-size-only crossover. On this machine the synthetic
native hot-scan sweep measured approximately:

| paths | `search` p50 | `sis` p50 | `file-0999` p50 | `proj exp` p50 |
| ---: | ---: | ---: | ---: | ---: |
| 100k | 0.38 ms | 23.1 ms | 15.8 ms | 0.42 ms |
| 250k | 0.81 ms | 42.1 ms | 33.0 ms | 0.80 ms |
| 500k | 2.79 ms | 79.7 ms | 60.3 ms | 1.94 ms |
| 1.0M | 5.62 ms | 165.0 ms | 121.9 ms | 4.07 ms |
| 1.5M | 6.96 ms | 231.5 ms | 163.1 ms | 6.13 ms |

By comparison, current Everything candidate retrieval on the 120k materialized
corpus is roughly 85-260 ms depending on query shape. Therefore production
selection must consider both query cost and candidate completeness/selectivity;
cheap substring/multi-token searches should stay native even on very large
roots, while expensive acronym/basename shapes may cross over near the million-
path scale and require real UI confirmation before cutover.

### 30.3 Exact large-root evidence and current cutover verdict

The isolated Everything instance currently reports 1,350,879 entries on W:.
After applying OpenFork's current dot-segment visibility rule, the exact
materialized corpus used by the native scorer contains 1,032,073 paths.

Measured native `searchFileMentionsFast` hot p50 on that exact corpus:

| query | p50 |
| --- | ---: |
| `sis` | ~453 ms |
| `search` | ~575 ms |
| `test` | ~560 ms |
| `src` | ~398 ms |
| `file` | ~447 ms |
| `json` | ~159 ms |
| `readme` | ~450 ms |
| `proj exp` | ~93 ms |

This proves that a candidate accelerator can be worthwhile at million-path
scale, but the same run also rejects generic Everything cutover:

- the current full-path candidate query is non-exhaustible under the 10,000
  safety cap for broad real queries such as `search`, `sis`, `test`,
  `src`, `file`, `json`, and `proj exp`;
- a selective basename-literal + boundary-acronym union reduced W: `sis` to
  about 5.9k unique candidates and was materially faster than the native scan,
  but full ordered top-20 parity still failed because lower-ranked native rows
  can be generic full-path subsequences;
- `abg` and `vlccsc` likewise demonstrated that basename/acronym sources do
  not cover the complete native scoring domain;
- `json` happened to reproduce the exact top-20 under a conservative omitted
  score bound, but the provider path was slower than native on the same corpus.

Directory-acronym fixtures reinforce the same point: the boundary-regex source
finds an acronym-matching directory itself, while native OpenFork can also rank
child files whose *full relative path* satisfies the generic subsequence matcher.

**Current verdict:** no user-visible Everything cutover is justified yet.
Corpus size alone is not an eligibility rule, fixed overfetch is rejected, and
basename/acronym completeness is not equivalent to OpenFork path-score
completeness. A future accelerated query must prove top-K safety either by
exhausting every relevant candidate source or by a conservative score-dominance
proof for all omitted match classes, and it must still beat the native scorer
after provider IPC plus OpenFork reranking.

---

## 31. Perf-freshness evidence (2026-10-06, perf-freshness lane)

> Lane: native baselines + Everything end-to-end across small/medium/~1M
> corpora, NTFS-vs-ReFS freshness, classifier with wins AND native-faster
> failures, adversarial challenge to proof-router profitability.
> Harnesses (NEW, no production code, `bench-*.ts` not collected by `bun test`):
> `packages/core/test/bench-everything-endtoend.ts`,
> `packages/core/test/bench-freshness-ntfs-refs.ts`.
> This section is append-only; earlier sections are not rewritten by this lane.

### 31.0 Method and environment (FACT)

- Runtimes: Bun 1.4.2, Node v24.21.0. Provider: isolated
  `Everything IPC (OpenFork-SDK3)`, Everything 1.5.0.1423b, DB_LOADED=1,
  direct TypeScript SDK3 transport (no `es.exe` anywhere).
- Volumes (out-of-band `Get-Volume`): C: NTFS, W: ReFS, H:/D:/E: NTFS.
- Reproducible commands (workdir `packages/core`; never repo root):
  `bun test/bench-everything-endtoend.ts synthetic|live|live-medium|live-big`
  and `bun test/bench-freshness-ntfs-refs.ts`.
- Stage model is harness-visible only (public APIs; zero production timers,
  per coordinator/ipc-runtime answers): **fetch+decode+fence combined** in
  `searchCandidatesExhaustive` wall time (TS-client `parse()` and
  `normalizeCandidate`+ignore run inside it — inseparable without
  ipc-runtime/keystream-lifecycle hooks); **rerank+highlights combined** in
  `searchFileMentionsFast` (scores AND positions/baseOffset recomputed for
  surviving top-K in one pass); **proof separate** (`certifyCandidateTopK`
  pure call). Fence unit cost separately microbenched via
  `normalizeCandidate`: p50 ~5.0 µs/row, p95 ~7.4-8.1 µs/row (5,000 rows,
  2,000 iterations, two runs). IPC bytes/pages are NOT exposed by the current
  API; candidateCount/requiredCount/exhaustible reported instead.
- Classifier decisions: `WIN` (provenTopK AND provider-E2E < native p50),
  `NATIVE_FASTER_PROVEN`, `UNPROVEN_KEEP_NATIVE`, `INCOMPLETE_KEEP_NATIVE`,
  `TIMEOUT_CENSORED` (any fetch p95 within 10% of 1,500 ms `TIMEOUT_MS`),
  `PROVIDER_FAULT_KEEP_NATIVE`. Top-K = 20, offset 0, initialCount 512.
- Native oracle is `searchFileMentionsFast` fast-only (no recency post-pass).
  §31.4 quantifies the recency gap against the production index-layer page.

### 31.1 Native baselines remeasured (FACT)

Deterministic synthetic corpus
(`packages/pkg{i%300}/src/components/feature-{i%1000}/dialog-select-model-{i}.tsx`),
per-query p50/p95 ms over 10-15 hot samples (3 warmup discarded), TOP_K 20:

| corpus | `s` | `se` | `search` | `sis` | `abg` | `vlccsc` | `srv sess` | `proj exp` | `json` | `file-0999` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| real 8,187 | 0.92/3.47 | 1.29/2.49 | 0.76/1.72 | 1.00/1.09 | 0.52/0.61 | 0.80/0.81 | 1.11/1.19 | 0.14/0.14 | 0.20/0.23 | 0.04/0.04 |
| synth 100k | 6.70/8.60 | 10.99/12.85 | 0.32/0.47 | 18.85/21.85 | 0.30/0.32 | 0.31/0.32 | 0.33/0.36 | 0.34/0.52 | 0.31/0.33 | 5.76/8.15 |
| synth 250k | 20.15/24.74 | 32.17/40.33 | 0.74/0.84 | 46.49/54.38 | 0.73/0.77 | 0.73/0.77 | 0.73/0.74 | 0.78/0.92 | 0.73/0.79 | 15.39/16.21 |
| synth 1M | 69.15/70.06 | 116.47/130.18 | 4.38/6.32 | 185.42/203.73 | 3.42/4.00 | 3.97/5.86 | 3.61/4.70 | 3.57/4.67 | 3.52/4.43 | 78.82/84.35 |

Memory/CPU: 100k heap 22.7 MB / rss 167 MB / 1.03 s user; 250k heap
45.7 MB / rss 272 MB / 1.95 s; 1M heap 160 MB / rss 747 MB / 7.84 s user
(whole-sweep totals). CPU per query is ~100% user, ~0 sys: the scan is
compute-bound, so IPC offload is the only available speedup axis.

Classifier-grade finding (FACT): native cost follows mask-hit selectivity,
not corpus size. A non-matching query at 1M paths (`abg` 3.42 ms) is ~5.5x
CHEAPER than a matching query at 100k (`sis` 18.85 ms). Any eligibility rule
of the form `corpus >= N` is therefore rejected with fresh numbers, in
addition to the historical synthetic evidence in §30.2. The expensive native
shapes are short/broad subsequence queries (`s`, `se`, `sis`, `file-0999`
when matching); exact/multi-token/rare queries stay single-digit ms to 1M.

Live repo root (NTFS, C:, 8,188-8,191 paths by `rg --files`, dot-segments
dropped, 5 samples): native p50 0.04 (`file-0999`, `pkg-119`) to 1.97 ms
(`src`); p95 worst 5.95 ms (`sis`). Whole-sweep CPU 0.2 s user, rss ~100 MB.

### 31.2 Small-root end-to-end classifier (FACT, clean run)

Repo root, 12 queries x 5 samples, pre-refactor transport (see §31.6 for why
only this run is clean). Native p50 0.04-1.57 ms. Provider fetch+decode+fence
p50 101.5-514.0 ms; rerank+highlights 0.016-0.40 ms; proof 0.009-0.27 ms.
Result: **0 WIN, 0 NATIVE_FASTER_PROVEN, 12 unproven-or-incomplete — every
row keep-native, provider 100-800x slower than native.** Per-row:

| query | native | fetch | candidates/required | complete | orderedExact | floor/bound | proven | decision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `search` | 0.73 | 434.3 | 176/5667 | true | false | 636/245 (+391) | false | UNPROVEN |
| `sis` | 1.38 | 201.4 | 13/10000 | false | false | -/107 | false | INCOMPLETE |
| `abg` | 0.61 | 514.0 | 458/8052 | true | false | 27/107 (-80) | false | UNPROVEN |
| `vlccsc` | 0.92 | 221.1 | 5/20 | true | false | -/245 | false | UNPROVEN |
| `server session` | 1.57 | 135.5 | 31/178 | true | false | 662/- | false | UNPROVEN |
| `proj exp` | 0.26 | 250.3 | 131/4616 | true | false | 610/- | false | UNPROVEN |
| `json` | 0.26 | 191.9 | 3/10000 | false | false | -/153 | false | INCOMPLETE |
| `readme` | 1.00 | 195.5 | 22/10000 | false | false | 416/245 | false | INCOMPLETE |
| `src` | 1.30 | 201.8 | 4/10000 | false | false | -/107 | false | INCOMPLETE |
| `file-0999` | 0.04 | 199.7 | 0/0 | true | true | -/- | false | UNPROVEN |
| `pkg-119` | 0.04 | 183.5 | 0/0 | true | false | -/- | false | UNPROVEN |
| `f` | 0.54 | 101.5 | 0/10000 | false | false | -/- | false | INCOMPLETE |

(`search` +391 margin yet unproven ⇒ discard gate, confirmed post-fix in
§31.3-style rows: `vlccsc` discardedCount 15, discardedCoverageSafe false;
`server session` discardedCount 147 but safe, unproven on bound-undefined
multi-token shape instead. `f`: 512 discards, unsafe.)

Small-repo bypass verdict (FACT): on an 8k root the provider never beats
native on any of 12 shapes, complete or not. This is the measured basis for
§30 outstanding question 5 (small-repo crossover): the crossover, if it
exists, is far above 8k paths for every shape tested.

### 31.3 Adversarial classifier rows (FACT — the required native-faster failures and coverage holes)

1. `pkg-119` (complete-but-uncovered): both provider sources total 0
   (requiredCount 0, candidateCount 0, complete:true) yet native top-K is
   NON-empty (nativeTopK 1, recallTopK 0, missingSample
   `packages/ui/src/assets/favicon/web-app-manifest-192x192.png` — a
   directory-spanning subsequence p,k,g,-,1,1,9 the basename-subsequence
   source cannot enumerate). Proof correctly refuses (short page, no floor),
   but the refusal comes from page length, NOT from the omitted-score bound.
   Lesson recorded for proof-router/semantic-parity: `complete:true` certifies
   source exhaustion, never coverage of OpenFork's richer subsequence domain.
2. `server session` (multi-token, bound-undefined): complete:true,
   31 candidates, discardedCoverageSafe TRUE (147 discards all covered),
   recallTopK 0.5, missingSample
   `docs/handoff/session-tool-stop-recovery.md`, omittedBound undefined ⇒
   UNPROVEN. Discard-safety and completeness are both satisfied and the row
   still must stay native.
3. `vlccsc` (discard-blocked): complete:true, basenameSubsequenceComplete
   true, 5 candidates, 15 discarded rows, discardedCoverageSafe FALSE ⇒
   UNPROVEN. The per-row discard gate is load-bearing on real roots.
4. `f` (non-exhaustible): requiredCount 10000 (cap), exhaustible false,
   512 discards unsafe, recallTopK 0 ⇒ INCOMPLETE. Fixed overfetch would have
   certified nothing here at any multiplier.
5. `json`/`readme`/`src`/`sis`: exhaustible false under the 10k cap on an 8k
   root — non-exhaustibility is a query-shape property, not a corpus-size
   property.

### 31.4 Recency-gap counterevidence vs proof-router (FACT + one open question)

`rankFileMentionResults` (+0..6 by file age, `filesystem/search.ts:619`,
`mention-ranking.ts:23-44` verified read) applies AFTER the fast scorer on
the production index path, while the proof reranks fast-only. Bounded probe
(real mtimes via stat over the 8,190-path root, fast top-20 vs
recency-adjusted top-20 per query, verdict-flip check), identical across two
runs: **9 of 12 queries reorder, 0 verdict flips** (floors mostly unchanged;
`search` 628→632, still proven; `json`/`readme` proven both ways).
Implication (challenge, for proof-router's ruling): fast-only `orderedExact`
does NOT equal the user-visible index-page order in 75% of sampled queries,
so a fast-only certificate cannot be read as an index-page certificate
without a scope restriction (ripgrep-layer only, where no recency applies) or
an explicit margin. No verdict flip was observed here, but absence on one
8k root is not a bound. Review of the proof region itself
(`certifyCandidateTopK` 629-658 at 780-line rev + bound/precondition in
`mention-fast.ts`): SOUND as stated — bound arithmetic hand-verified
(L=2→68, L=8→337), strict `>` with reachable equality, per-row discard
precondition mirrors the scorer. Two challenges sent to proof-router
(recency scope; file-only proof vs mixed file+directory pages); ruling
pending. The `orderedExact`-plus-proof shadow invariant holds fast-vs-fast
only.

### 31.5 Freshness remeasured, NTFS vs ReFS separately (FACT; historical numbers RETIRED)

Harness polls `searchCandidatePage` for a unique name (create→visible,
rename→new-visible, delete→disappearance), 5 rounds per op per fs, 30 s
deadline, tight loop with 5 ms sleep. Roots prechecked COVERED by the
isolated instance (NTFS precheck 104.6 ms/1 poll; ReFS 188.9 ms/2 polls).

| fs | root | create med | rename med | delete med | samples | faults |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| NTFS (C:) | `...\Temp\openfork-fresh-ntfs` | 95.8 ms | 96.0 ms | 96.7 ms | 5/5/5 | 0 |
| ReFS (W:) | `W:\Temp\openfork-fresh-refs` | 131.1 ms | 129.6 ms | 127.2 ms | 5/5/5 | 0 |

Round detail NTFS create: 88.8/95.8/127.2/188.0/90.2; rename:
88.9/96.0/99.2/88.3/111.1; delete: 94.7/121.0/89.2/96.7/118.0. ReFS create:
132.8/241.7/117.6/131.1/124.6; rename: 255.9/129.6/109.4/252.3/118.1;
delete: 106.5/264.1/127.2/103.0/258.2.

RETIRED: the historical ReFS figures (~36 ms create, ~29-30 ms rename,
~90 ms delete, §24) are one-environment only and are HEREBY RETIRED, not
remeasured-equal. Reason beyond environment drift: METHOD RESOLUTION. Each
poll is a full SDK3 round trip (~100-250 ms observed), so API-polling
measures an UPPER BOUND dominated by poll latency; sub-poll precision (e.g.
~29 ms) is unresolvable through the public provider API and would need
ipc-runtime-internal per-frame hooks. The retired figures must not be cited
as current.

REMEASURED REPLACEMENT (both filesystems, this harness): NTFS create 95.8 /
rename 96.0 / delete 96.7 ms; ReFS create 131.1 / rename 129.6 / delete
127.2 ms. ReFS is ~1.35x NTFS on medians with higher variance. The bimodal
round pattern (e.g. ReFS rename 255.9/129.6/109.4/252.3/118.1) is consistent
with poll-phase aliasing rather than filesystem bimodality — HYPOTHESIS,
needs finer hooks to confirm. Caveat: these are WARM-PIPE numbers; with
ipc-runtime's `READY_TTL_MS = 5000` a cold pipe can add up to 5 s of
readiness re-ask, which this harness did not isolate.

### 31.6 Transport regression found by measurement (FACT, fix owned by ipc-runtime)

Between the clean E2E run (§31.2, 780-line transport, 0/12 faults) and the
next two runs, `everything.ts` grew to 1360 lines with a chunk-buffer
refactor (`rxChunks`/`rxPrefix`/`rxDrop`). Runs 2 and 3 faulted on the SAME 7
of 12 queries (`search`, `sis`, `abg`, `proj exp`, `json`, `readme`, `src`)
with `transport: "undefined is not an object (evaluating 'first.length')"`;
the same 5 measured (`vlccsc`, `server session`, `file-0999`, `pkg-119`,
`f`). Deterministic per query, not contention. Static cause (read-only,
lines refer to the 1360-line rev): `rxBytes` is incremented on receive (356)
and reset on fail/timeout (316/414/439/558) but never decremented on consume
— `rxDrop` (341-352) drains `rxChunks` without touching it — so stale
`rxBytes >= want` with drained chunks makes `rxChunks[0]!` undefined at line
327 (`first.length`). Reported to ipc-runtime with line refs; keystream-lifecycle
independently derived the same cause from a `compareShadow` repro (plus a
secondary short-merge note on `rxPrefix`). All post-refactor provider latency
numbers are therefore QUARANTINED until the fix lands; native, fence-unit,
recency, and freshness numbers are unaffected (freshness ran pre-refactor;
the rest never touch the transport). Medium (~120k fixture,
`.../everything-sdk3-dev/corpus-120k`, 120,000 files verified) and ~1M
(`W:\`, 1,295,479 files by `rg --files`) E2E remeasurement, plus a post-fix
small-root re-run, are queued as §31 part 2 — not in this section.

### 31.7 FACT vs HYPOTHESIS ledger (binding on this section)

FACT (remeasured 2026-10-06, commands in §31.0): all of §31.1, §31.2 tables,
§31.3 rows, §31.4 probe, §31.5 medians, §31.6 fault pattern + static cause.
HYPOTHESIS (cited history, NOT remeasured, must not gate routing): W:
`vlc/vlcc/vlccs/vlccsc` keystream tail (though `vlccsc` at 1.3M is now
independently measured in §31.11 and is directionally consistent);
`vbcnt/vncac/sisbk/slvab/srchgo/lbtag` heterogeneous sample; 1,032,082-entry
oracle numbers; 120,120-entry ordered-parity matrix; 9-sample warm stability;
prefix-proof timings (`search` ~386 ms etc.); 1.5M synthetic keystream
(`se` 283 ms → `sea` 8 ms → `search` 6.7 ms); native-baseline correction
deltas (12.55→0.48 ms etc.); §30.2 crossover table; Explorer renderer
microbenchmark (77.5→37.8 ms, 426.5→179.5 ms). These remain plausible and
useful as priors, but Phase 4 needs them remeasured against current bytes.

PARTIALLY CONFIRMED (remeasured, different magnitude): the claim that
Everything beats native on expensive shapes at million-path scale is
CONFIRMED in direction at 1,295,422 paths (§31.11: provider faster on 11 of
12, up to ~5.2x). The specific ~35% figure is superseded by this
measurement. The claim remains unusable for routing because the same rows
are complete:false / recall 0.0 — the win was measured in a regime the
provider cannot legally serve.
Oracle helper (`es.exe`) was not used and is diagnostic-only per lane rules.

### 31.8 Peer review record (criterion: review ≥1 other lane — done, three ways)

- proof-router: reviewed `certifyCandidateTopK` + bound/precondition (verdict:
  sound; challenges §31.4 sent direct; ruling pending). No edit to 629-658.
- semantic-parity: reviewed announce + plan; harnesses complementary
  (offline-simulated vs live-measured), zero file overlap; shared §31.3
  specimens + recency-ordering note direct. Their 56-pass no-live-hole result
  is consistent with this section's keep-native rows.
- ipc-runtime: ACKed their region-E timer proposal (readyMs/searchMs/parseMs —
  welcome, enables future fetch/decode split); confirmed file-placement
  non-overlap (`script/everything-bench/` vs `test/bench-*`); filed §31.6
  defect with line refs (fix theirs).
- keystream-lifecycle: confirmed no bench-file overlap (they use
  `search-everything-generation.test.ts`); will adopt their per-stage hooks
  when available; corroborated §31.6 independently.
- coordination rule kept: zero production edits by this lane; contested
  `everything.ts` opened read-only.

### 31.9 Part 2 — post-transport-fix small-root re-run (FACT)

ipc-runtime landed the fix; verified on disk (`rxDrop` decrements `rxBytes`
354-355, `rxPrefix` guards `!first` 332 and short merge 346, `onData` fails
closed on desync 385). Re-ran `bun test/bench-everything-endtoend.ts live`:
**0 provider faults, 12/12 rows measured** (was 7/12 faults). Same verdict,
now uncontaminated: **0 WIN, 0 NATIVE_FASTER_PROVEN, 12 keep-native.**

Post-fix per-row (repo root 8,192 paths, 5 samples, TOP_K 20). Native p50
0.08-1.91 ms; provider fetch+decode+fence 112.2-511.8 ms; rerank+hl
0.019-0.358 ms; proof 0.016-0.256 ms.

| query | native | fetch | cand | recallTopK | missingSample | discards/safe | complete | floor/bound | decision |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- |
| `search` | 0.75 | 461.5 | 177 | 1.0 | - | 3450/unsafe | true | 636/245 (+391) | UNPROVEN |
| `sis` | 1.65 | 265.2 | 13 | 0.0 | `shingle-test.ts` | 499/unsafe | false | -/107 | INCOMPLETE |
| `abg` | 0.53 | 511.8 | 458 | 0.15 | `packages/tui/src/component/bg-pulse.tsx` | 8083/unsafe | true | 27/107 (-80) | UNPROVEN |
| `vlccsc` | 0.87 | 236.3 | 5 | 1.0 | - | 15/unsafe | true | -/245 | UNPROVEN |
| `server session` | 1.18 | 112.2 | 31 | 0.5 | `docs/handoff/session-tool-stop-recovery.md` | 147/**safe** | true | 662/- | UNPROVEN |
| `proj exp` | 0.19 | 274.2 | 131 | 0.65 | `packages/opencode/test/oxp/project.test.ts` | 4991/**safe** | true | 610/- | UNPROVEN |
| `json` | 0.22 | 232.9 | 3 | 0.0 | `packages/opencode/src/oxp/json.ts` | 509/unsafe | false | -/153 | INCOMPLETE |
| `readme` | 1.12 | 249.8 | 22 | 0.5 | `packages/app/README.md` | 490/unsafe | false | 416/245 | INCOMPLETE |
| `src` | 1.91 | 263.7 | 4 | 0.0 | `research.md` | 508/unsafe | false | -/107 | INCOMPLETE |
| `file-0999` | 0.08 | 284.4 | 0 | 1.0 | - | 0/safe | true | -/- | UNPROVEN |
| `pkg-119` | 0.08 | 232.0 | 0 | 0.0 | `packages/ui/.../web-app-manifest-192x192.png` | 0/safe | true | -/- | UNPROVEN |
| `f` | 1.03 | 121.4 | 0 | 0.0 | `packages/protocol/src/groups/fs.ts` | 512/unsafe | false | -/- | INCOMPLETE |

New in the post-fix data: `recallTopK` is now visible on every row and it is
poor on most shapes — 0.0 on `sis`/`json`/`src`/`f`/`pkg-119`, 0.15 on `abg`,
0.5 on `server session`/`readme`, 0.65 on `proj exp`. Only `search`,
`vlccsc`, `file-0999` reach 1.0 (and `vlccsc`/`file-0999` have nativeTopK 0).
`orderedExact` is false on 11 of 12. So even leaving latency aside, the
provider would need a coverage fix before it could serve these shapes.
`server session` and `proj exp` are the two rows where discard-safety holds
and recall is partial-but-real: they fail on the bound being undefined
(multi-token), not on evidence.

### 31.10 Medium corpus E2E — 120,000-path fixture (FACT)

Command `bun test/bench-everything-endtoend.ts live-medium`; root
`...\everything-sdk3-dev\corpus-120k` (120,000 files verified); 12 queries x
5 samples; 0 provider faults.

Result: **0 WIN, 5 NATIVE_FASTER_PROVEN, 7 unproven-or-incomplete.** A
regime where the provider is SAFE now exists at this scale, and native still
wins all five of them by 12x-405x.

| query | native p50 | fetch | cand | recall | floor/bound | margin | proven | decision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| `search` | 0.83 | 271.5 | 360 | 1.0 | 948/245 | +703 | true | NATIVE_FASTER_PROVEN |
| `sis` | 26.51 | 325.5 | 360 | 1.0 | 479/107 | +372 | true | NATIVE_FASTER_PROVEN |
| `abg` | 0.71 | 281.2 | 120 | 1.0 | 481/107 | +374 | true | NATIVE_FASTER_PROVEN |
| `vlccsc` | 0.65 | 263.0 | 120 | 1.0 | 526/245 | +281 | true | NATIVE_FASTER_PROVEN |
| `src` | 0.78 | 234.4 | 360 | 1.0 | 474/107 | +367 | true | NATIVE_FASTER_PROVEN |
| `server session` | 0.81 | 130.5 | 120 | 1.0 | 1555/- | - | false | UNPROVEN |
| `proj exp` | 0.74 | 136.9 | 120 | 1.0 | 1018/- | - | false | UNPROVEN |
| `json` | 0.70 | 244.1 | 0 | 1.0 | -/153 | - | false | UNPROVEN |
| `readme` | 1.03 | 244.9 | 0 | 1.0 | -/245 | - | false | UNPROVEN |
| `file-0999` | 15.30 | 233.6 | 120 | 1.0 | 1350/- | - | false | UNPROVEN |
| `pkg-119` | 4.81 | 432.1 | 1120 | 1.0 | 156/- | - | false | UNPROVEN |
| `f` | 14.49 | 119.6 | 512 | 0.0 | 822/- | - | false | INCOMPLETE |

Native at 120k (5 samples): `search` 0.449, `sis` 24.29, `abg` 1.09,
`vlccsc` 0.73, `server session` 0.99, `proj exp` 0.42, `json` 0.37,
`readme` 0.55, `src` 0.46, `file-0999` 8.67, `pkg-119` 7.37, `f` 11.94 ms;
heap 20-25 MB, rss 160 MB, 0.66 s user CPU for the whole sweep.
Fence unit here: p50 ~6.8 µs/row, p95 ~14.6 µs/row.

Two structural observations:

1. Provider fetch+decode+fence is **~120-650 ms and roughly corpus-
   independent** across 8k → 120k (pipe round trips dominate). Native is
   0.65-26.51 ms at 120k. For the provider to win, native must exceed the
   ~120-230 ms provider band. Nothing at 8k or 120k does.
2. The medium fixture is a CLEAN corpus: 0 discarded rows on every query and
   recallTopK 1.0 on 11 of 12. The real 8k repo root instead discards
   3450-8083 rows and often reaches recallTopK 0.0. **Coverage failure is
   driven by real-worktree noise (ignore/hidden/out-of-root rows), not by
   corpus size.**

### 31.11 Large corpus E2E — W: ~1.3M paths, ReFS (FACT)

Command `bun test/bench-everything-endtoend.ts live-big`; root `W:\`
(1,295,422 paths after dot-segment drop, ReFS); 12 queries x 5 samples;
0 provider faults.

Result: **0 WIN, 0 NATIVE_FASTER_PROVEN, 12 keep-native** — but for a
completely different reason than the small root. Here the provider IS faster
on 11 of 12 queries; it simply cannot prove or cover anything.

| query | native p50 | fetch | e2e | cand | recall | floor/bound | discards/safe | complete | decision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `search` | 823.80 | 318.0 | 318.3 | 183 | 0.0 | 827/245 (+582) | 329/unsafe | false | INCOMPLETE |
| `sis` | 338.70 | 293.1 | 293.3 | 141 | 0.0 | 1/107 (-106) | 371/unsafe | false | INCOMPLETE |
| `abg` | 240.46 | 278.6 | 278.8 | 117 | 0.0 | 27/107 (-80) | 395/unsafe | false | INCOMPLETE |
| `vlccsc` | 747.35 | 566.5 | 568.3 | 956 | **1.0** | 472/245 (+227) | 601/unsafe | **true** | UNPROVEN |
| `server session` | 786.76 | 150.7 | 151.3 | 233 | 0.55 | 641/- | 214/**safe** | true | UNPROVEN |
| `proj exp` | 93.62 | 148.8 | 149.0 | 28 | 0.0 | 6/- | 484/safe | false | INCOMPLETE |
| `json` | 550.08 | 263.8 | 264.4 | 309 | 0.0 | 1175/153 (+1022) | 203/unsafe | false | INCOMPLETE |
| `readme` | 834.21 | 339.2 | 339.7 | 232 | 0.0 | 380/245 (+135) | 280/unsafe | false | INCOMPLETE |
| `src` | 362.71 | 347.5 | 347.8 | 114 | 0.0 | 6/107 (-101) | 398/unsafe | false | INCOMPLETE |
| `file-0999` | 452.28 | 341.8 | 343.2 | 364 | 0.1 | -/- | 7/unsafe | true | UNPROVEN |
| `pkg-119` | 33.20 | 258.1 | 258.2 | 13 | 0.0 | -/- | 1/unsafe | true | UNPROVEN |
| `f` | 245.90 | 124.8 | 124.8 | 1 | 0.0 | -/- | 511/unsafe | false | INCOMPLETE |

Native at 1.3M (5 samples): `search` 943.9, `sis` 324.9, `abg` 254.7,
`vlccsc` 788.0, `server session` 680.7, `proj exp` 74.2, `json` 521.9,
`readme` 784.8, `src` 370.1, `file-0999` 472.8, `pkg-119` 38.1, `f` 214.7 ms.
Memory/CPU: heap 301-370 MB, rss 1,916 MB, 52.78 s user CPU for the sweep —
native is now genuinely expensive and CPU-bound at scale.

**THE CROSSOVER REGIME DOES EXIST, AND IT IS NOT A WIN.** This is the
decisive answer to outstanding question 5 and to the handoff's ~35% claim.
At 1.3M paths native degrades into the hundreds of ms (`search` 823.8,
`readme` 834.2, `vlccsc` 747.4, `server session` 786.8) while the provider
stays at 124.8-566.5 ms, so the provider is **faster on 11 of 12 queries** —
roughly 1.6x-5.2x on the expensive ones. The historical ~35% win is
therefore directionally real at this scale, not invented.

But not one of those 11 can be used:

1. `requiredCount` 10000 (the `MAX_VIEWPORT` cap) on 8 of 12 ⇒
   `exhaustible:false`, `complete:false`. The source cannot be exhausted at
   this corpus size, so the proof gate has nothing to certify. On a
   million-path root the cap is the binding constraint, exactly as predicted
   for `f`/`json`-class breadth.
2. `recallTopK` is **0.0 on 9 of 12**. The native top-20 rows simply are not
   in the candidate set — e.g. `search` misses
   `Toolchains/Zig/0.16.0/lib/c/search.zig`; `json` misses
   `Toolchains/Zig/0.16.0/lib/std/json.zig`; `readme` misses
   `Dev/emsdk/README.md`. These are not exotic cases; they are the ordinary
   best matches on a real tree.
3. `discardedCoverageSafe` is false on 10 of 12 (203-601 discarded rows each).
   The one row that is BOTH complete and has real recall — `vlccsc`
   (recallTopK 1.0, floor 472 vs bound 245, **margin +227**) — is blocked by
   the discard gate alone. It is the single nearest-miss in the whole matrix
   and the narrowest evidence-backed path remaining in this campaign:
   the same query as the historical `vlccsc` win claim, now vindicated in
   shape — coverage 1.0, complete, and a margin that ABSORBS the required
   +6 recency margin (§31.4, outstanding item (a) from the coordinator) with
   room to spare — and stopped by exactly one unsolved gate: 601 discarded
   rows whose basenames are not proven to lack the query subsequence.
   Note the margin arithmetic: 472 - 245 = 227 >> 6, so landing the recency
   margin does NOT change this row's verdict either way. The discard gate is
   the only thing between it and the campaign's first genuine WIN.

   CAVEAT ON THE RECENCY MARGIN, stated so it is not over-read: on this row
   (and on all 12 rows at both 8k and 120k) the recency margin changes no
   verdict — 0 flips observed everywhere. That does NOT mean the margin is
   unnecessary. The margin fixes the SCOPE claim (that a fast-only
   certificate describes the user-visible index page), which is false
   whenever recency reorders the page — observed in 9 of 12 queries at the
   8k root. A gate can be simultaneously necessary for correctness and
   non-load-bearing on a given sample; both are true here.

So the campaign's headline is: **the regime where Everything is faster than
native is real and measured; the provider is disqualified inside that regime
by completeness and coverage, not by latency.** The handoff's ~35% win is
neither refuted nor confirmed — it was measured in a regime the provider
cannot legally serve today.

Corollary for the ledger: a `MAX_VIEWPORT` of 10,000 is the hard ceiling that
makes million-path roots unservable for broad queries. Raising it is a
completeness decision with a latency cost, and must be evidence-driven, not
assumed.

DO NOT raise `MAX_VIEWPORT` on the strength of this section alone. The
arithmetic cuts against it: a wider cap adds IPC bytes in exactly the regime
where the provider's advantage is only 1.3x-5.2x, so the cap increase spends
the margin it is trying to buy. It also would not fix the two things that
actually block the 1.3M rows — the discard gate (10 of 12) and the
zero-candidate coverage holes. A cap change needs its own measurement: bytes
per page at the new cap, latency at the new cap, and the resulting
`exhaustible` rate, measured on this same 1.3M root.

### 31.12 Pending (part 3 of this section)

All three corpus tiers are now measured (8k / 120k / 1.3M). Remaining:
(a) fetch/decode split if ipc-runtime's `readyMs`/`searchMs`/`parseMs` timers
land; (b) per-stage hooks if keystream-lifecycle hooks land; (c) a re-run
after any `MAX_VIEWPORT` or completeness decision, since §31.11 shows the
10,000 cap is the binding constraint at million-path scale.
Phase 4 stays HOLD; nothing in this section promotes routing.

### 31.13 Summary verdict across all three corpora (FACT)

| corpus | native p50 range | provider fetch | WIN | NATIVE_FASTER_PROVEN | keep-native | binding reason |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| repo root 8.2k (NTFS) | 0.04-1.91 ms | 112-514 ms | 0 | 0 | 12/12 | latency (provider 100-800x slower) |
| fixture 120k (NTFS) | 0.37-26.51 ms | 120-432 ms | 0 | 5 | 12/12 | latency (native 12-405x faster even when proven) |
| W: 1.30M (ReFS) | 33.2-834.2 ms | 125-566 ms | 0 | 0 | 12/12 | completeness + coverage (cap 10k, recall 0.0 on 9/12) |

Zero WINs anywhere. The provider is never simultaneously safe and faster.
Where it is safe (120k), native is far faster. Where it is faster (1.3M), it
is neither complete nor covering. This is the measured basis for keeping
Phase 4 on HOLD, and it is stronger than "unproven": the disqualifying
reason differs by regime, so no single fix (faster IPC, a wider cap, or a
better bound) addresses both.

### 31.11 Coordinator-promoted finding (verbatim, per request)

> **complete:true certifies SOURCE EXHAUSTION, never coverage.**

`pkg-119` is the specimen: complete:true, `requiredCount` 0, 0 candidates
returned, native top-K NON-empty (missing
`packages/ui/src/assets/favicon/web-app-manifest-192x192.png`, a
directory-spanning subsequence a name-only source never enumerates). It was
refused via short-page-no-floor, **not** via the omitted-score bound, because
the bound structurally cannot see this class. Consequence for the taxonomy:
a "complete" provider result that yields zero candidates while native returns
rows is its own divergence class, not a proof-caught case.

Related (also promoted by the coordinator): `exhaustible=false` under the
10,000 `MAX_VIEWPORT` cap on an 8,190-path root means the cap truncates SMALL
roots too — non-exhaustibility is query-shape driven, not corpus-size driven.
And because native cost is selectivity-driven, the existing shadow gate at
`filesystem/search.ts:560` (fires at >=100k paths) is a corpus-size gate, not
a cost gate, and must never be read as one.

### 31.12 Methodological finding: the retired ReFS numbers were never measurable

The historical ReFS create/rename/delete figures (~36 / ~29-30 / ~90 ms) are
retired permanently, and the reason is stronger than a discrepancy: the
public provider API's poll resolution is one full SDK3 round trip (observed
~100-250 ms on this machine), so those figures were BELOW the measurement
floor. They could not have been measured through this API in the first place.
Generalize: treat any historical latency or freshness figure produced by
API-polling as HYPOTHESIS unless remeasured on current code with a stated
resolution floor.

## 32. Why Everything is not enabled (coordinator close-out, 2026-10-06)

**DECISION: Everything is not routed. It is compiled, tested, and shipped as an
optional candidate-discovery engine, but it never supplies a result a user can
see. Phase 4 remains HOLD.**

This section exists so the negative decision is auditable later without
re-deriving it. It is a decision record, not a status update.

### 32.1 It cannot reach a user today — structural, not policy (FACT)

Independently verified against live source, not inferred from the HOLD:

- The shadow's result is **discarded**. `Effect.ignore` + `Effect.forkDetach`
  at `filesystem/search.ts:331-332` (ripgrep backend) and `:609-610` (index
  backend). Fire-and-forget; no return path.
- Both backends return **native**: `return page` (`:335`) and
  `return { ...page, results: rankFileMentionResults(...) }` (`:619`).
- `provenTopK` appears at exactly two places — `:320` and `:598` — both inside
  `Effect.logDebug(...)` payloads. It is an observability field and has never
  been a return value.
- The shadow does not fire on this repository at all: the gate is
  `paths.length >= 100_000` (`:288`, `:560`) and this tree has **16,977**
  paths. On this project the Everything path is runtime dead code.

Consequence: the two open soundness defects in §32.3 have **zero** user impact
today. The HOLD is what keeps them behind a gate nothing crosses.

### 32.2 Measured basis (FACT — see §31.13 for the full tables)

Zero wins across all three corpus tiers. The disqualifying reason *differs by
regime*, which is the load-bearing part of the verdict:

| corpus | binding reason | single fix? |
| --- | --- | --- |
| 8.2k | latency — provider 100-800x slower | no |
| 120k | latency — native 12-405x faster even when proven | no |
| 1.3M | completeness + coverage — not latency | no |

The handoff's "~35% win" is **neither refuted nor confirmed**: it is
directionally real at 1.3M (provider faster on 11 of 12 by 1.3x-5.2x) and was
measured in a regime the provider cannot legally serve. Reporting it as
"refuted" would be wrong; reporting it as a win would also be wrong.

Explicitly **not** the reason: latency at 1.3M. The provider wins there. It is
disqualified by `MAX_VIEWPORT`, `recallTopK`, and the discard gate.

### 32.3 Open soundness gates (BLOCKING, not advisory)

Both are red **by design** and must not be made green by deleting a test.

1. **Recency margin** — `search-differential-parity.test.ts:855`
   `MARGIN GATE (RED until the +MAX_RECENCY_BOOST margin lands)`. Production
   orders by `fastScore + recency(0..6)`; the proof bounds fast-only scores. A
   constructed counterexample (floor `aB/aa` fast=68, omitted `aBa/x` fast=67,
   `bound=68`, `floor=bound+1=69`) shows the pre-recency bound certifying a page
   production ordering contradicts. Requires
   `proofFloor > omittedScoreUpperBound + maxMentionRecencyBoost`, STRICT, with
   the boost derived from `mention-ranking` — the accessor does not exist yet
   (`MENTION_RECENCY_BY_DAY` is a non-exported `const`). `orderedExact` is also
   fast-vs-fast and must be relabeled or excluded from any gate.
2. **Discard veto membership** — tests `(A)` and `(B)` in the same file.
   `discardedPaths` conflates two disjoint populations and vetoes on both. The
   correct invariant is **corpus membership**, not branch identity: the
   ripgrep backend's `ignore` callback
   (`isConfiguredIgnored(rel) || (!known.has(rel) && ...)`) can fire on a
   *tracked* file, which is exactly what `Ignore.coverage` exists to handle.

Review rule adopted from `ipc-runtime`: `:406` ("one uncovered discarded row
vetoes") is the only test exercising the in-corpus veto and **must survive any
fix**. Deleting it to get green is a failed review, not a fix.

### 32.4 What would change the answer to yes

Exactly two conditions, in order — not more work in the current direction:

1. `proof-router` lands both fixes above, including per-row reason/membership
   on `discardedPaths` instead of a bare path list.
2. All three tiers are **re-measured**. Pre-fix numbers are not a valid
   post-fix baseline: kept-candidate counts change materially and so does fence
   cost.

The narrowest route is `vlccsc` at 1.3M — `complete:true`, `recallTopK 1.0`,
floor 472 vs bound 245 (margin +227 absorbs the required +6), native 747.4 ms
vs provider 566.5 ms, blocked **only** by 601 unsafe discards. If a material
share of those are out-of-corpus rows the veto is spurious and this becomes the
campaign's first genuine win. That is one gate, not a redesign.

`MAX_VIEWPORT` is deliberately **not** authorized to rise: it spends IPC bytes
in the only regime where the provider leads by just 1.3x-5.2x, and it would not
fix the discard gate or the zero-candidate holes.

### 32.5 Commit provenance — what is included and what is not (FACT)

This feature was previously untracked with no git history. The first commit
includes exactly the Everything-scoped surface:

- `packages/core/src/search/everything.ts` (never previously committed)
- `packages/core/src/filesystem/search-policy.ts` (imported by `search.ts:25`)
- `packages/core/src/filesystem/search.ts` (shadow integration + ignore
  callbacks; verified to reference no symbol from the excluded files)
- `packages/core/src/search/mention-fast.ts` (proof scoring bounds:
  `basenameContainsQuerySubsequence`, `omittedSingleTokenScoreUpperBound`)
- the four `packages/core/test/search-*` test files

Deliberately **excluded** — these are other campaigns' uncommitted work with no
connection to Everything, verified by reading each diff rather than assuming:

- `filesystem/ignore.ts` — `projectedIgnored`, `boundedProjection`,
  `MAX_GIT_IGNORED_PATHS` (git `ls-files` projection)
- `filesystem/watcher.ts` — `isFilesystemRoot`, `gitIgnored`,
  `rootSubscription`, parcel subscription changes
- `search/index-service.ts` — `directoriesToPrune` / tombstone ancestor pruning

The commit is self-consistent: `search.ts` references none of those symbols, and
`search-policy.ts` imports only `Glob` and `path`.

Suite state at commit: **124 pass / 3 fail / 5734 expect** across the five
search files; the three failures are the intentional REDs of §32.3, no
accidental failures.

Related but out of scope for this section: a separate commit carries
`packages/opencode` broker-validation fixes found while working here — the
`tool` broker leaking a raw `SchemaError(Missing key at ["action"])` to the
model, and `normalizeBrokerArgs` discarding the `JSON.parse` detail so a genuine
JSON syntax error was reported as "do not pass placeholder strings". Those are
tool-routing defects, not Everything defects, and are documented by their tests.
