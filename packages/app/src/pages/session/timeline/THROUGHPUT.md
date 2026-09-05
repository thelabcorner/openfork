# Turn throughput (`tok/s` footer chip)

Fork-native reimplementation of the idea behind upstream PR #45265 (formula,
all-or-nothing guards, separate-sums aggregation, response-body boundary) with
the correction from PR #47125. Upstream's code lives in `packages/tui`, which
this fork does not carry, so nothing is cherry-picked: only the semantics
transfer. Ownership is recorded in `FORK.md` (`Throughput` row); a future
`take upstream` merge conflict in `session-event.ts` or `message-updater.ts`
must keep the fork hunks.

## One step, four instants

For one assistant step the sidecar stamps up to four wall-clock instants,
all from the sidecar clock (never the renderer clock):

| Instant | Field | Capture site |
|---|---|---|
| `t0` dispatch | `time.requestSentAt` | V1: `processor.ts` before `llm.stream` is consumed; V2: `DateTime.now` in `core/.../runner/llm.ts`, carried on `Step.Started` |
| `t1` first token | `time.firstTokenAt` | V1: `processor.ts` on text/reasoning-start; V2: projector applies `Text/Reasoning.Started` timestamps |
| `t2` body end | `time.streamedAt` | V1: `processor.ts` after stream drain, before `cleanup()`; V2: durable `session.next.step.streamed` event |
| `t3` settled | `time.completed` | after local tool settlement (`cleanup()` / `Step.Ended`) |

`t2` is the whole feature: without it any rate divides by `t3` and absorbs
every shell call, file write, and permission prompt into the denominator.

## The three metrics (`packages/core/src/session/throughput.ts`)

`turnThroughput(messages, turnID)` walks forward from the turn's user message
and aggregates per step. Single pass, no intermediate arrays.

- **Request rate** (footer chip): `Σ output / Σ(t2 − t0)`. Visible output
  only: the window contains reasoning time, so folding reasoning tokens in
  would mix populations. Answers "how fast did this provider serve this
  turn, queueing and prefill included" — the provider-comparison question.
- **Decode rate**: `Σ(output + reasoning) / Σ(t2 − t1)`. Present only when
  every step has `firstTokenAt`.
- **TTFT**: `Σ(t1 − t0)` in ms. Same availability condition as decode rate.

## Guards (all must hold, else no chip — never zero, never NaN)

Upstream's: ≥1 assistant step; every step stamped; `Σ output > 0`;
`Σ duration > 0`. Fork additions: inverted or zero-length windows bail the
whole turn (a clock step is a stamp failure, not a fast generation —
clamping to zero would keep the tokens and drop the time); mid-turn
`model-switched` or mixed served models suppress (blended rates mislead);
failed/aborted steps suppress (partial usage is unreliable); the walk
terminates on `user` / `synthetic` / `compaction` / `shell` / `system`
(compaction is a turn boundary upstream's walk lacks).

Deliberately absent: no minimum-elapsed floor (a correct `t0` needs none —
the #47125 fixture, 12 tokens after 2,690 ms of prefill, reports ≈4.4
tok/s) and no finish-reason filter (agentic turns mostly end in tool
calls; that generation is real).

## Surfaces (distinct quantities, one function per quantity)

- **Footer chip** (the request rate above): computed once per message-list
  identity in `message-timeline.tsx` (`turnThroughputByMessage`, mirroring
  `turnDurationByMessage`) and rendered in `message-part.tsx` footer meta
  (`ui.message.throughput`). `session-ui`'s `SessionTurn` wires the same
  single calculator for its own (currently story-only) path. Shown only
  when measurable; historical messages render nothing.
- **Context tab** (`session-context-model-metrics.ts`): session-wide
  aggregate over part-level streaming spans with a plausibility ceiling —
  a different question (aggregate estimate), intentionally kept.
- **Live tickers** (`live-generation-rate-math.ts`, sidebar `chats.metric.rate`):
  explicitly approximate (`~`), converge on settlement to the exact number.
- **Usage dashboard** (`usage-model-groups.ts`): server-side aggregates.

## Clock provenance and retry rules

Retries reset `requestSentAt` / `firstTokenAt` / `streamedAt` per physical
attempt (V1) or start a fresh assistant row (V2), so failed attempts and
backoff never enter a successful attempt's window. `streamedAt` is
first-write-wins (`??=`). History is never backfilled: unstamped messages
cannot be reconstructed.

## Delivery path to the desktop timeline

The timeline reads the V1 `MessageTable` path: processor stamps →
`session.updateMessage` → `message.updated` SSE (whole-object replace,
`event-reducer.ts` passes `time` through untouched) → `session_message`
store → `normalizeSessionMessages` (`time` passthrough) →
`message-timeline.tsx` (`turnThroughputByMessage`, recomputed on
message-list identity, i.e. step boundaries — never per token delta) →
`MessagePart` (`turnThroughputRate`, raw number, formatted once at the
leaf) → footer meta. No `session.next.*` reducer case is needed: the
desktop live path runs on V1 `message.updated` / `message.part.updated`,
and the whole-object `message.updated` replace carries the new stamps.
The vendored
`@opencode-ai/client` (1.17.13) types the V1 transport; its types need not
declare the new keys because every hop passes the `time` object through at
runtime and the UI reads workspace `@opencode-ai/sdk/v2` types (regenerated:
`bun run generate` in `packages/client`, `bun run build` in
`packages/sdk/js` — never hand-edit generated output).

## Open questions / manual verification

- Upstream `#45265`'s base ref was never verified (needs `upstream-sync`
  skill before any upstream fetch): the working assumption is that no
  `v1.18.x` tag merge will deliver this code, so this stays fork-owned.
- Before merge, verify live: streaming text, tool-heavy turn (rate must not
  move when tool duration is inflated), reasoning model, buffered provider,
  user abort (no chip + "Interrupted"), short reply, model switch mid-turn
  (no chip), compaction boundary, session reload (identical number), second
  window.
- `fork:prune` safety is by construction: every file touched is in a KEEP
  package (`schema`, `core`, `opencode`, `client`, `sdk/js`, `session-ui`,
  `ui`).
