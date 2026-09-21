# Tool Output Projection / Truncation Research Ledger

**Status:** architecture converged; implementation and validation campaign closed for the current V1/V2 output-projection scope  
**Date:** 2026-09-18  
**Normative design:** [tool-output-projection-architecture.md](./tool-output-projection-architecture.md)

This file is the empirical decision record for the tool-output campaign. The
architecture document defines the intended contract; this ledger records the
failure modes that motivated it, experiments, external prior art, rejected
approaches, performance measurements, implementation slices, and validation
state.

## 1. Starting diagnosis

The original V1 truncator treated truncation as presentation-time string
slicing. That model hid several independent responsibilities behind one boolean:

1. a producer may intentionally page/cap a semantic result;
2. the harness must impose a final provider-facing context envelope;
3. a streaming producer must keep resident memory bounded while output is still
   arriving;
4. complete output may be retained as a recovery artifact;
5. historical compaction has a separate, much smaller information budget.

Concrete pre-campaign failure modes:

- V1 eagerly split on newline, allocating an array proportional to complete
  output before deciding what to retain.
- Default head-only truncation discarded the region where shell/test/build
  commands commonly report final failure and exit summaries.
- A single line larger than the byte budget could produce an empty source
  preview because only complete lines were admitted.
- Recovery prose was appended after budgeting, so the returned value could
  itself exceed the advertised byte/line limits.
- Presence of producer metadata.truncated caused Tool.wrap() to bypass central
  truncation entirely. Producer pagination was accidentally authority to waive
  the provider safety envelope.
- V1 retained raw files while V2 already used Brotli artifacts; recovery
  behavior drifted between stacks.
- shell kept a tail-only in-memory window; the beginning could be destroyed
  before the generic truncator ever saw the output.
- the shell chunk window could retain one arbitrarily large chunk and still
  report cut=false.
- shell's first compressed spill plus plaintext sidecar required a full
  decompress + concatenate + recompress pass at completion.
- V1 and Core historical compaction independently used fixed prefix-only JS
  character slicing.
- monitor delivery maintained a third UTF-8 clipping implementation.

The conclusion was that increasing a character constant would preserve the
wrong ownership model. The system needed an explicit output pipeline.

## 2. Canonical ownership model

The converged model is:

    producer raw result
      -> durable retention (when needed/possible)
      -> producer/domain projection (optional pagination/capping)
      -> unconditional provider projection
      -> provider/model serialization budget
      -> historical compaction projection

The stages have distinct semantics.

### 2.1 Producer/domain truncation

Examples: grep result cap, SQLite maxRows, file pagination, test-summary
selection. This is part of the producer's domain contract and is represented as
producerTruncated.

It does not waive the final provider envelope.

### 2.2 Provider projection

The harness owns the final deterministic line/UTF-8-byte envelope. Builtin V1
tools, custom/plugin tools, built-in MCP resource tools, and arbitrary MCP tools
all converge on the same metadata algebra through Truncate.mergeMetadata().

Important fields:

- truncated: compatibility aggregate; some information was omitted;
- producerTruncated: producer/domain result was intentionally incomplete;
- providerTruncated: provider-facing text was projected by the harness;
- outputPath: existing producer recovery authority is preserved;
- providerOutputPath: artifact created by provider projection when distinct;
- outputProjection: exact original/retained/omitted bytes, strategy, and source
  byte ranges.

### 2.3 Retention

Retention is recovery, not semantic tool success. Once the producer succeeds, a
disk/compression failure must not rewrite that success into a failed tool call.

If retention succeeds, the projection marker identifies the Brotli artifact and
the archive recovery surface. If retention fails, the bounded result is still
returned, explicitly marked as lossy and unrecoverable from managed storage.

### 2.4 Historical compaction

Historical compaction deliberately uses much smaller independent budgets:

- Core/V2: 500 UTF-8 bytes per serialized tool result;
- V1: 2,000 UTF-8 bytes.

It reuses the same balanced projection kernel, but does not create another
retention artifact because the durable session/tool record is already the source
of truth.

### 2.5 Live monitor delivery

Monitor delivery remains a different transport policy: 16 KiB per line,
32-line/32-KiB batches, debounce, rate limiting, binary filtering, and no full
retention. It reuses only the shared UTF-8 prefix primitive. Similar mechanics do
not imply identical policy.

## 3. Shared mechanisms

### 3.1 ToolOutputProjection

packages/core/src/tool-output-projection.ts is the pure selection/projection
kernel used by V1 and V2.

Current invariants:

- hard maxLines and UTF-8 maxBytes;
- recovery marker is inside the budget;
- balanced beginning + end is the generic default;
- explicit head / tail strategies remain available;
- cuts preserve UTF-8/surrogate boundaries;
- giant single-line output still yields useful source text;
- no newline-array allocation is required;
- exact original, retained, and omitted byte accounting;
- exact retained source byte ranges (PreviewSegment);
- tail provenance is O(1) from originalBytes - tailBytes, avoiding a second
  omitted-prefix scan/allocation.

### 3.2 ToolOutputRetention

packages/core/src/tool-output-retention.ts owns the shared Brotli policy:

- text mode;
- quality 4;
- asynchronous one-shot compression;
- one-pass streaming compressor for streaming producers;
- create-only target;
- ordered writes;
- each write resolves after zlib accepts/processes the chunk;
- close waits for compressor and file sink completion.

V1 Truncate, V2 ToolOutputStore, and foreground shell use the same retention
policy instead of carrying independent zlib recipes.

### 3.3 Shell reservoir

makeChunkWindow() is now a bounded head+tail reservoir rather than a tail ring.

It tracks:

- contiguous UTF-8-safe beginning;
- bounded rolling UTF-8-safe end;
- exact total source bytes;
- exact total source lines;
- whether source bytes have been omitted.

Source memory remains bounded even when one decoder chunk is larger than the
entire reservoir.

## 4. Bugs found by adversarial validation

### 4.1 Marker separator reclamation could violate the hard bound

The first shared projector reclaimed a separator byte when clipping made a
source segment empty. Giving that byte back could make the segment non-empty,
which required the separator again. Randomized testing produced an exact
maxBytes + 1 result.

Resolution: separator bytes are not reclaimed after clipping. At most two bytes
of theoretical capacity may remain unused; the hard envelope is mechanically
strict.

### 4.2 Streaming prefix could become non-contiguous

If one byte remained in the shell head budget and the next source code point
required two bytes, the reservoir rejected that character but later allowed a
one-byte character to fill the hole. The result was no longer a source prefix.

Resolution: the head is permanently sealed at the first source code point that
cannot fit.

### 4.3 One huge shell chunk violated the old memory contract

The old ring evicted whole chunks only while more than one chunk existed. One
oversized chunk could therefore exceed the configured bound indefinitely and
still report cut=false.

Resolution: both head and tail support UTF-8-safe partial-chunk clipping.

### 4.4 Shell retention had duplicate whole-output work

The prior migration path compressed an initial base, wrote later text to a
plaintext sidecar, then decompressed the base and recompressed base + sidecar at
close.

Resolution: one streaming Brotli owner receives the threshold-crossing prefix
and every later chunk exactly once.

### 4.5 Provider safety was bypassable by producer metadata

The old V1 wrapper treated the mere presence of metadata.truncated as proof that
the result was already safe for the model.

Resolution: every provider result crosses the final provider projection
boundary. Producer and provider loss are represented independently.

### 4.6 Streaming retention initialization could terminate output draining

Completed-output retention already degraded safely when storage failed, and an
established streaming writer already degraded safely after a write/finalization
failure. One earlier boundary remained unsafe: creating the streaming retention
directory/writer itself could defect inside shell's stdout-consumer fiber.
Terminating that consumer can stop draining the child pipe, so a storage failure
could indirectly stall or change the process being observed.

Resolution: Truncate.writer() now treats ordinary initialization/creation
failure as unavailable recovery and returns a disabled no-op writer. The
reservoir and stdout drain continue unchanged, healthy() is false, and no
outputPath is authoritative. Fiber interruption is not converted into a storage
fallback. A dedicated failing-filesystem regression proves initialization,
subsequent writes, and close remain non-failing at the tool-output layer.

A follow-up invalid-sink probe found the lower stream owner also needed to
observe destination errors immediately. A createWriteStream/open failure can
unpipe the Brotli transform; if the implementation then waits for
finished(compressor), the readable side can wait forever because its consumer is
gone. ToolOutputRetention now installs compressor/sink error observers at
construction, records the first failure, tears down the peer stream, and makes
close() rethrow the recorded failure only after both owners settle. This both
prevents an unhandled stream error and bounds failure-path finalization.

## 5. External prior art / comparison

These sources were reviewed as architecture evidence, not copied as product
requirements.

### OpenAI Codex

Current Codex source has an explicit distinction between raw exec bytes,
collection omission, and model-facing truncation:

- https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/context.rs
- https://github.com/openai/codex/blob/main/codex-rs/tools/src/tool_output.rs
- https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/mod.rs

This supports the same core ownership separation: authoritative/raw output is
not identical to the deliberately lossy model representation.

Codex issue #6426 documents a 256-line / 10-KiB head+tail policy and reports the
known weakness that important middle failures can be hidden:
https://github.com/openai/codex/issues/6426

Codex issue #14206 argues for auto-spilling oversized tool results so lossy
inline previews remain recoverable:
https://github.com/openai/codex/issues/14206

Codex issue #42367 is an especially close ownership failure analogue. Its
function-mode exec path clamps a caller-requested max output against the
harness truncation policy, while a code-mode path honored the caller's
max_output_tokens without the harness clamp. The report measured a ~497-KB
result reaching the model as roughly 138K output tokens. This independently
supports the invariant that a producer/request-specific budget may tighten, but
never waive, the harness-owned ceiling:
https://github.com/openai/codex/issues/42367

Codex issue #37121 reports recoverable tool state becoming unavailable after
function-output truncation followed by compaction. That is the same ownership
boundary behind OpenFork's decision to keep retention provenance and historical
compaction projection distinct:
https://github.com/openai/codex/issues/37121

OpenFork's current baseline therefore intentionally combines two useful ideas:
bounded beginning+end model projection and managed recoverability. The
head+tail selector is still considered a baseline, not the semantic endpoint.

### Gemini CLI

Current Gemini CLI exposes both a tool-output truncation threshold (40,000
characters by default) and a recoverable full-output file. Its shared formatter
keeps 20% of the character preview from the beginning and 80% from the end:

- https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/fileUtils.ts
- https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md

More importantly, Gemini's newer context-management settings separately model
per-turn retained token limits, head ratio, tool-output distillation output
tokens, and an LLM summarization threshold. This independently supports the
layering used here: deterministic tool transport projection first; model/token
aware context management later.

### Claude Code

Claude Code issue #77112 reports a separate but relevant streaming reliability
failure: a large stdout write to a pipe could lose the tail when process exit
occurred before queued output drained:
https://github.com/anthropics/claude-code/issues/77112

This reinforces the requirement that stream finalization/backpressure is part of
correctness, not merely a throughput optimization.

### Aider

Aider issue #5624 reports roughly 60x overhead from one-character-at-a-time
subprocess consumption compared with bulk reads:
https://github.com/Aider-AI/aider/issues/5624

This supports chunk-oriented streaming and argues against per-character
selection/ranking logic in the hot path.

## 6. Performance campaign

Host: Windows development workstation. Measurements are mechanism benchmarks,
not end-to-end model latency.

Provider projection limits were 2,000 lines / 50 KiB. The legacy comparator was
the prior V1 newline-splitting head slicer. Measurements were warmed before
timing.

| Workload | Legacy mean | Current mean | Relative | Legacy preview | Current preview |
|---|---:|---:|---:|---:|---:|
| dense log, 1 MiB | 0.458 ms | 0.348 ms | **1.32x faster** | 51,169 B | 51,200 B |
| dense log, 10 MiB | 4.587 ms | 2.661 ms | **1.72x faster** | 51,169 B | 51,200 B |
| one Unicode line, 10 MiB | 1.168 ms | 2.189 ms | 0.53x legacy speed | **0 B** | 51,198 B |

The single-line case is intentionally not described as a performance win: the
new algorithm does more UTF-8 work. The old algorithm is faster because it
returns no useful source content at all. This is a correctness/utility trade,
not a regression to optimize blindly.

The exact tail-provenance O(n) prefix scan was removed after these measurements,
so the balanced-projection measurements above are conservative.

### Streaming reservoir

10 MiB dense log ingested as 8-KiB chunks:

- mean: 18.43 ms;
- median: 19.15 ms;
- mean throughput: **~542.7 MiB/s**.

Projection/reservoir CPU is therefore not the binding large-output cost.

### Completed retention

Seeded varied diagnostic-log corpus (chosen instead of an unrealistically
repetitive line):

| Input | Mean | Throughput | Compressed size |
|---|---:|---:|---:|
| 1 MiB | 18.65 ms | ~53.6 MiB/s | 253,428 B (24.17%) |
| 10 MiB | 166.34 ms | ~60.1 MiB/s | 2,576,333 B (24.57%) |

### Streaming retention

10 MiB varied log, 8-KiB writes, including Brotli + filesystem writes but
excluding verification decompression:

- mean: 251.61 ms;
- median: 255.61 ms;
- mean throughput: **~39.7 MiB/s**;
- compressed: 2,815,265 B (26.85%).

The streaming path is slower and slightly less compact than one-shot
compression, but bounds resident output and removes the old full
decompress/recompress completion pass. That is the correct trade for
unbounded/streaming producers.

A follow-up write-granularity probe confirmed that most of the small-chunk cost
is callback/backpressure granularity rather than Brotli itself. On a repetitive
~10-MiB text stream, awaited 4-KiB writes measured ~114 MiB/s while ~64-KiB
writes measured ~368 MiB/s. A deterministic harder-to-compress ~10-MiB text
corpus measured ~73.7 MiB/s for one-shot q4 compression at a ~0.63 compressed /
input ratio. No additional coalescing queue was added: it would introduce a
second buffer/finalization owner to optimize a cost that naturally amortizes as
process chunks grow.

The first compression benchmark mistakenly timed verification decompression and
was discarded; only the corrected production-operation measurements above are
retained.

## 7. Validation ledger

Final relevant results at closure:

### Core

- projection + randomized UTF-8 invariants + retention + V2 store + Core
  compaction: **27 passed, 0 failed, 1,581 assertions**.

### V1 core projection surfaces

- truncation facade + provider wrapper + shell reservoir + monitor line
  projection: **40 passed, 0 failed, 183 assertions**;
- SessionTools/MCP adapter surface: **9 passed, 0 failed, 21 assertions**;
- Goal test with the current Truncate.Writer contract: **1 passed**.

### Broad runtime regression

- shell full matrix: **125 passed, 0 failed, 349 assertions**;
- background full matrix: **23 passed, 0 failed, 81 assertions**;
- registry/custom/plugin full matrix: **30 passed, 0 failed, 127 assertions**;
- grep: **7 passed, 0 failed**;
- read: **54 passed, 0 failed**;
- SQLite: **29 passed, 0 failed**.

### Known concurrent-tree failures

These are recorded so campaign closure does not misrepresent package health:

- V1 compaction full suite: **57 pass / 1 skip / 2 fail**. Both failures are in
  the concurrent provenance migration:
  "Host turn source compaction requires a canonical sourceMessageID".
  The new output-projection compaction regression passes.
- test.test.ts: **18 pass / 7 fail**. Each failing integration test stops before
  tool execution at "test tool not found", reflecting concurrent tool
  registry/lazy-capability work rather than projection behavior.
- Core native typecheck remains red on unrelated database readDb test fakes,
  branded paths, LLM compile test fakes, session harness/API/provenance work,
  and other concurrent changes. No production projection/retention/store/Core
  compaction file is reported.
- OpenCode native typecheck remains red on concurrent SPAD, provenance,
  scheduled-task/API, branded-ID, and LLM-test changes. After fixing the two
  stale Truncate.Writer test doubles, no production
  projection/retention/truncate/custom/MCP/monitor/shell file is reported.

### Production build

bun run build --single --skip-install --skip-embed-web-ui succeeded for
opencode-windows-x64.

- packaged opencode --version smoke passed;
- ChunkDB capability smoke passed (user_version 4).

## 8. Rejected / superseded approaches

### Increase the byte/line constants

Rejected. It delays context overflow but does not repair ownership, giant-line
behavior, recoverability, streaming memory, or producer/provider ambiguity.

### Keep head-only as the generic policy

Rejected. It systematically discards terminal status and failure summaries.

### Tail-only for shell

Rejected as generic shell settlement. Tail remains useful for some live UI
surfaces, but destroying startup context before the final projector makes
subsequent selection impossible.

### Generic regex-based "error salience"

Deferred/rejected as the architecture owner. A central regex pile will be
language/tool fragile and will eventually reconstruct semantics that producers
already know.

### Tokenizer in every tool call

Rejected. The tool layer needs deterministic transport bounds independent of a
specific model. Token-aware tightening belongs at provider serialization where
the actual model/tokenizer and remaining context are known.

### Synchronous compression

Rejected. Large diagnostic payloads would block the event loop.

### Plaintext streaming sidecar + final recompression

Superseded by the one-pass Brotli writer.

### Make retention failure fail the tool

Rejected. Retention is a recovery optimization after producer success.

## 9. Negative invariants

Future changes must preserve:

1. no producer truncated flag can bypass the provider envelope;
2. the complete returned model-facing projection never exceeds either hard
   configured limit;
3. recovery/control text is counted inside the same envelope;
4. UTF-8 clipping never introduces replacement characters;
5. retained head ranges are contiguous source prefixes;
6. generic projection preserves both beginning and end unless a stronger
   producer policy explicitly chooses otherwise;
7. an existing producer recovery path is never silently replaced by provider
   retention;
8. storage failure cannot rewrite a successful tool execution into failure;
9. streaming producers do not require unbounded resident output after spill;
10. the authoritative streaming artifact is not published as healthy until
    finalization succeeds;
11. historical compaction remains a distinct small-budget projection;
12. monitor/live-event rate and batching policy remains distinct from tool
    settlement;
13. token-aware budgeting cannot weaken the deterministic byte/line ceiling;
14. semantic selection is not inferred centrally from arbitrary prose when the
    producer can state its structure.
15. streaming-retention initialization failure cannot terminate or stop
    draining the producer output stream.
16. compressor/sink failures are observed from stream construction time and
    cannot leave finalization waiting on an unconsumed peer stream.

## 10. Frontier: semantic projection plans

Balanced head+tail is the correct generic fallback, but external reports and
our own reasoning agree that important evidence can occur in the middle.

The next architecture should be producer-supplied projection plans, not larger
generic heuristics.

A candidate segment can carry:

- exact source byte range;
- semantic role (header, error, warning, summary, continuation, terminal, etc.);
- priority / must-retain status;
- optional atomicity boundary (JSON object, diagnostic block, test case, stack
  frame group, table row group);
- optional neighborhood/context radius.

The shared projector can then solve a deterministic bounded allocation:

1. reserve recovery/control bytes;
2. admit must-retain segments;
3. maximize weighted semantic coverage under byte/line limits;
4. preserve beginning/terminal fallback coverage;
5. spend spare budget on neighborhoods around selected anchors;
6. merge overlapping source ranges;
7. emit exact provenance for every retained range.

This creates a clean separation:

    producer knows meaning
    projector knows budgets
    retention knows bytes
    provider knows tokens/context

Potential follow-on research:

- compiler/test adapters emitting diagnostic anchors directly;
- structured JSON/XML record atomicity instead of cutting syntax arbitrarily;
- archive ranged reads driven by omitted-gap provenance;
- provider-layer adaptive token budget based on remaining context;
- content-addressed/deduplicated retention only if measured storage pressure
  justifies its complexity;
- evaluation corpus measuring answer/task success from head-only vs balanced vs
  semantic-anchor projection rather than optimizing byte utilization alone.

The scientific target should be information retained per model-context token
under deterministic safety constraints, not simply the number of bytes kept.
