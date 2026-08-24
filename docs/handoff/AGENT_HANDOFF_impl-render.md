# impl-render handoff — Tier 0 render-side quick wins

Author: tui-renderer (analysis phase) → impl-render (implementation phase)

## DONE — Q3: per-session delta coalescing (verified green)

**Files changed (only these two):**
- `../../packages/app/src/context/server-sdk.tsx` — `coalesceServerEvents`
- `../../packages/app/src/context/server-sdk.test.ts` — updated 1 test + added 2 barrier tests

**What changed:** `coalesceServerEvents` previously merged only ADJACENT `message.part.delta`
events for the same part/field. Now it merges deltas for the same (directory, messageID,
partID, field) even when interleaved with deltas for OTHER parts/sessions, using a pending
map keyed by that tuple. Any non-delta event (`message.part.updated` snapshot,
`message.part.removed`, `message.updated`, `message.removed`, `session.status`, etc.) is a
**barrier** that clears the pending map — so a delta never merges across a state-changing
event that could alter its base. This is wire-invariant (client-side only) and preserves the
final store state exactly (each part's field is an independent append-only string).

**Verification:**
- `bun test --conditions=solid --preload ./happydom.ts src/context/server-sdk.test.ts` → 12 pass / 0 fail
- `bun run typecheck` → no errors in server-sdk.tsx (the HostedBrowserWebview/browserHostClient
  errors are pre-existing in files I did not touch)

**Why the test change is safe:** the old test "preserves event ID order across interleaved
deltas" asserted the conservative adjacent-only behavior. The new behavior produces the same
final store state (part "part" = "ac", part "other" = "b") with fewer events — a strict
improvement, not a regression. Barrier tests added to prove snapshots/statuses still split.

## REMAINING — Q2: active-session timeline projection memoize per-turn

**Not started.** This is the higher-value but higher-risk change. Root cause:
`packages/app/src/pages/session/timeline/projection.ts:34-44` → `rows.ts:38-101` rebuilds the
ENTIRE row model O(M+P) on every streamed part change, because `constructSessionMessageRows`
reads `getMessageParts(message.id)` for every message.

**Recommended approach (safe):** split the projection so each turn's rows are memoized
separately, keyed by that turn's message+part identities, so only the active turn's rows
recompute on a delta. Row identity is already preserved by `reuseTimelineRows`
(`row-reconciliation.ts:6-29`), so unchanged rows won't remount. Must keep `status` as a
dependency (it gates Thinking/Retry/DiffSummary rows). Existing tests to keep green:
`projection.test.ts`, `rows-current.test.ts`, `model.test.ts`.

**Caveat:** a full per-turn memoization is a substantial refactor of heavily-tested code.
Given the strict no-regression mandate, consider a conservative first step: memoize the parts
accessor so the projection only re-reads parts that changed, or bound the 5× O(R) index memos
(`projection.ts:49-83`) to the visible range. Only land the full per-turn split if the
equivalence tests stay green.

## Notes
- Do NOT commit unless the coordinator explicitly asks.
- Tests run ONLY from package dirs: `bun test --conditions=solid --preload ./happydom.ts <file>` in `../../packages/app`.
- The worktree has many pre-existing uncommitted changes from other workstreams — only touch
  the files in your lane.
