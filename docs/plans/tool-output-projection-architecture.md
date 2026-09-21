# Tool Output Projection Architecture

Empirical results, prior-art notes, implementation decisions, and validation
evidence are tracked in
[tool-output-truncation-research-ledger.md](./tool-output-truncation-research-ledger.md).

## Problem statement

Tool truncation is not fundamentally a string-slicing problem. It is a bounded
**model-view projection** problem with three separate concerns:

1. the producer owns the complete semantic result and any domain pagination;
2. the harness owns the hard model-facing byte/line envelope;
3. retained full output is a recovery artifact, not part of the provider budget.

Conflating those concerns creates two dangerous failure modes: producer
`metadata.truncated` can accidentally bypass the provider bound, and a generic
head-only slice can erase the terminal evidence that explains whether a command,
test, search, or diagnostic operation actually succeeded.

## Canonical boundary

The shared Core `ToolOutputProjection` is the deterministic projection kernel.
V1 `Truncate` and V2 `ToolOutputStore` use it rather than maintaining
independent slicing algorithms.

The current contract is:

- hard `maxLines` and UTF-8 `maxBytes` limits include the recovery marker;
- default projection is balanced head + tail;
- explicit head/tail remain available when a producer has stronger semantics;
- UTF-8 boundaries are preserved, including surrogate pairs;
- the full output is retained separately when the provider view is truncated;
- retention failure never rewrites a successful tool operation into a failed
  operation; the provider receives an explicitly lossy bounded settlement;
- projection metadata reports original/retained/omitted bytes and exact retained
  source byte ranges;
- producer/domain truncation and provider/harness truncation are distinct facts.

Every ordinary V1 `Tool.define` result crosses the provider projection boundary
even when its producer already declares `metadata.truncated`. Producer
pagination/caps are not authority to exceed the model envelope. If a producer
already owns an `outputPath`, the provider spill is recorded separately rather
than replacing producer recovery authority.

## Why balanced is the generic default

For arbitrary tool text, neither head nor tail dominates universally. The head
usually carries identity, headers, setup, and the first diagnostic; the tail
usually carries exit state, summaries, final failures, and continuation hints.
Balanced retention minimizes the worst-case loss without pretending to
understand producer semantics.

This is deliberately a baseline rather than the endpoint. Structured producers
should eventually supply semantic projection hints instead of forcing the
generic layer to parse arbitrary prose.

## Next frontier: salience-aware projection

The next useful abstraction is a producer-supplied **projection plan**, not a
larger pile of regexes in the truncator. Candidate segments should carry:

- source byte range;
- semantic role (header, error, warning, summary, continuation, tail, etc.);
- priority / must-retain status;
- optional atomicity boundary so JSON/XML/code records are not cut mid-unit.

The shared projector can then solve a small deterministic budget-allocation
problem: reserve recovery/control bytes, admit mandatory segments, maximize
weighted semantic coverage under byte/line constraints, and fill remaining
budget with contextual neighborhoods. Exact byte ranges make the decision
auditable and allow later archive reads to request only omitted gaps.

This separates **selection** from **storage** and from **provider token
budgeting**. Token-aware budgeting belongs at provider serialization, where the
actual tokenizer/model is known; the tool layer should remain deterministic in
bytes/lines and must not add a tokenizer to every tool call.

## Streaming outputs

Shell/test/build output should not materialize unbounded text merely to decide
what to show. Streaming producers should maintain bounded candidate windows and
spill the full stream once. The final projector should consume those windows or
producer-selected segments. Avoid repeated full-string concatenation, repeated
UTF-8 scans, synchronous compression, and per-chunk global re-ranking.

The target invariant is O(retained-preview + bounded candidate state) resident
memory after spill, with O(total input bytes) single-pass ingestion.

## Recovery artifacts

Large retained outputs are Brotli-compressed asynchronously at quality 4. The
archive/read surfaces provide bounded paging/search over the artifact. A
truncation marker must therefore describe:

- what was omitted;
- what part is currently shown;
- where the full artifact lives;
- how to inspect it without injecting the entire artifact back into context.

Recovery metadata is control information and receives budget before source
samples. If the configured budget is pathologically small, retaining a valid
recovery marker is more useful than returning an unmarked fragment.

Retention is deliberately **best effort after semantic tool success**. Disk
full, permissions, compressor failure, or stream-finalization failure must not
turn a completed command/query/tool operation into a different semantic result.
When retention fails, the hard-bounded preview remains the durable settlement
and explicitly says that omitted bytes are unavailable. Streaming shell
retention follows the same rule: a broken spill disables recovery while output
capture and process completion continue. Streaming retention observes source
and destination stream failures from construction time and tears down the peer
owner on failure so a broken sink cannot become either an unhandled error or a
finalization deadlock.

## External implementation evidence

The architecture was cross-checked against current coding-agent implementations
and failure reports rather than derived only from this repository:

- current OpenAI Codex separates tool-owned lossy diagnostic representation
  from an additional history/configurable output budget; its history serializer
  also reserves room for warning/omission metadata rather than appending an
  unbudgeted marker afterward;
- Codex issue #14206 independently argues for managed full-output spill plus a
  compact recoverable envelope instead of irreversible inline truncation;
- Codex issue #6426 documents the known weakness of fixed head+tail when build
  failures or test failures occur in the middle. This supports treating balanced
  head+tail as a safe generic baseline, not as the final semantic selector;
- Codex issue #42367 demonstrates why a producer/requested output budget cannot
  be allowed to waive the harness ceiling: a code-mode path honored its own
  max-output request without the function-mode truncation-policy clamp and
  admitted an approximately 138K-token shell result;
- Codex issue #37121 reports recoverable tool state becoming unavailable after
  tool-output truncation followed by compaction, reinforcing that recovery
  provenance and historical compaction are separate owners;
- current Gemini CLI independently combines recoverable full-output spill with
  asymmetric head/tail preview (20% / 80%), while its newer context-management
  layer separately exposes per-message token retention and tool-output
  distillation/summarization budgets. This supports keeping deterministic
  byte/line projection below provider/model token budgeting;
- OpenCode issue #35661 demonstrates why MCP/design payloads need recoverability
  and producer-aware structure rather than a larger arbitrary fixed cap;
- OpenCode issue #33650 reports exactly the tail-loss failure class addressed by
  the bounded head+tail shell reservoir;
- Claude Code issue #77112 is a useful transport-level warning: large-output
  correctness also depends on draining/closing the output owner, not merely on
  choosing a better truncation algorithm.

The convergent principle is that **capture, retention, semantic selection,
provider projection, and history budgeting are different owners**. A robust
agent harness may optimize each independently, but must not let one layer's
loss declaration waive another layer's hard safety envelope.

## Performance baseline

On the Windows development host, the current campaign measured the projection
kernel against the former V1 split/head implementation. These are warm
microbenchmarks; the 10 MiB cases use fewer iterations to keep the benchmark
bounded.

| Input | Size | Legacy mean | Current mean | Relative |
|---|---:|---:|---:|---:|
| dense line log | 1 MiB | 0.402 ms | 0.327 ms | 1.23x faster |
| dense line log | 10 MiB | 4.457 ms | 2.627 ms | 1.70x faster |
| giant Unicode line | 10 MiB | 1.351 ms | 1.977 ms | 0.68x legacy speed |

The giant-line case is intentionally more expensive because the old
implementation returned **zero source bytes** for a line larger than the byte
budget, while the new implementation returns a useful UTF-8-safe ~50 KiB
head+tail projection. It is therefore not equivalent work.

Additional measured hot paths:

| Mechanism | Workload | Mean |
|---|---|---:|
| streaming head+tail reservoir | 10 MiB, 8 KiB chunks | 18.82 ms / 531 MiB/s |
| async Brotli q4 retention | varied 1 MiB | 18.28 ms / 54.7 MiB/s |
| async Brotli q4 retention | varied 10 MiB | 155.45 ms / 64.3 MiB/s |
| one-pass streaming Brotli | varied 10 MiB, 8 KiB chunks | 237.04 ms / 42.2 MiB/s |

These are mechanism measurements, not end-to-end latency claims. Async Brotli
is deliberately off the synchronous event-loop path. Streaming compression is
slower than one-shot compression at 8 KiB write granularity, but avoids
unbounded resident output and the former decompress + concatenate + recompress
close path.

## Closure invariants

Any future truncation change should preserve these negative invariants:

- no producer `truncated` flag bypasses the final provider envelope;
- no returned preview exceeds either configured hard limit;
- no UTF-8 replacement character is introduced by byte clipping;
- no generic truncation silently destroys an existing producer recovery path;
- no large-output compression blocks the event loop synchronously;
- no managed-retention failure changes an already-successful tool result into a
  failed tool operation;
- no streaming-retention initialization failure can terminate or stop draining
  the producer output stream;
- no streaming producer requires unbounded resident output after spill;
- no semantic selection policy is inferred from tool prose when the producer can
  state that structure directly.
