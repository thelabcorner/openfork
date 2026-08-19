# Handoff: SPAD-R repetition-loop detection/recovery → opencode

**Status:** Design + verified integration points ready. No production code written yet.
**Audience:** An implementation agent picking this up cold.
**Source material:** `C:\Users\slooshied\Downloads\spad-r-prototype.zip` (standalone Node/TS prototype, zero opencode dependency). Extract it before starting — everything below assumes you have it open.

---

## 1. What this is, in one paragraph

SPAD-R ("Streaming Periodic Attractor Detection + Recovery") is a small, dependency-free streaming algorithm that detects when an LLM's output has fallen into an exact repetition loop (`x_i = x_{i-p}` for a sustained interval), and a recovery state machine that truncates the bad tail, injects a hidden "re-anchor" instruction, and retries — hard-aborting after a second relapse of the *same* motif. It runs on raw UTF-16 code units with fixed-size typed-array buffers: no regex, no tokenizer, no allocations on the hot path, ~192 KiB/active generation, ~56 ns/char. It is a narrow, well-scoped fix for a real degeneration mode (see Holtzman et al. 2019, Xu et al. 2022 — full citations in the prototype's `README.md`), not a general text-quality classifier.

The prototype ships its own `integration/OPENCODE-INTEGRATION.md` written against opencode's `dev` branch. **I independently verified every file/line claim in that doc against the actual code in this working tree (branch `openfork`) on 2026-08-17 — all of it checked out.** This handoff supersedes the prototype's doc only in that it adds exact current line numbers, one corrected detail (import extensions), and a phased execution plan. Where they agree, trust both; where this doc gives a line number, that's the current source of truth, not the prototype's.

**Read `spad-r-prototype/README.md` and `spad-r-prototype/VALIDATION.md` in full before writing code.** They contain the threshold rationale, the asymmetric raw/canonical policy, and — importantly — a list of what is *not yet validated* (below in §8). Do not silently "improve" the thresholds; they were tuned against a 24M-char real-code corpus and a 40M-char synthetic negative corpus to get 0 false positives. Changing them is a calibration exercise, not a code-review nit.

---

## 2. Why opencode is a good fit (verified)

The prototype's integration doc claims opencode already has the exact primitives needed. Confirmed:

| Claim | Verified at |
|---|---|
| `processor.ts` has an existing doom-loop guard (`DOOM_LOOP_THRESHOLD = 3`) for identical repeated tool calls | `packages/opencode/src/session/processor.ts:30` |
| Stream termination already uses `Stream.takeUntil(...)` | `packages/opencode/src/session/processor.ts:654` (currently `Stream.takeUntil(() => ctx.needsCompaction)`) |
| `runLoop` owns the generation loop and already has a `"compact" \| "stop" \| "continue"` result contract | `packages/opencode/src/session/processor.ts:31`, consumed at `packages/opencode/src/session/prompt.ts:1505-1515` |
| Synthetic hidden user-message injection is an **existing, repeated pattern** — not something to invent | `packages/opencode/src/session/compaction.ts:519-547` (auto-compaction continuation) and `packages/opencode/src/session/prompt.ts:611-627` (task summarize) both do: create a `User` message via `session.updateMessage`, then a `TextPart` with `synthetic: true` via `session.updatePart`, then the outer loop just `continue`s. **SPAD recovery injection should copy this exact recipe**, not `prompt.noReply`/`createUserMessage` (that helper exists too, at `prompt.ts:814`, and works, but the compaction/summarize pattern is simpler and is what's already idiomatic in this file). |
| `synthetic` and `ignored` exist on the schema | `packages/core/src/v1/config/config.ts` is config, not this — schema is in `packages/schema/src/v1/session.ts:106-107` (message-level) and `:401-402` (part-level, `TextPartInput`) |
| Assistant text replay does not currently check `part.ignored` (user text does) | `packages/opencode/src/session/message-v2.ts:206` — `if (part.type === "text" && !part.ignored && part.text !== "")` is the *user*-side check; grep confirmed there is no equivalent gate on the assistant side. This is **why the prototype truncates the part instead of trying to mark a suffix `ignored`** — `ignored` is whole-part and not honored for assistant parts anyway. |
| `text-delta` handling happens before persistence, in a single switch | `packages/opencode/src/session/processor.ts:509-520` |
| `reasoning-delta` handling, same shape | `packages/opencode/src/session/processor.ts:296-308` |
| Config has a precedent `experimental.*` struct for exactly this kind of opt-in behavior flag (`continue_loop_on_deny`) | `packages/core/src/v1/config/config.ts:172-184` |

So: the architectural fit described in the prototype's integration doc is real and current, not stale. Proceed with confidence on placement; the actual coding is the remaining work.

---

## 3. Recommended ownership boundary

Do **not** put the detector in `packages/app` (Solid) or `packages/session-ui`. Those are UI consumers of recovery *telemetry* only. The hot-path owner must be `packages/opencode/src/session/processor.ts`, because it sees provider deltas before persistence and can stop upstream inference (`Stream.takeUntil`) with no UI round-trip.

```
provider stream
    |
    v
SessionProcessor.handleEvent (processor.ts:280)
    |
    +-- text-delta / reasoning-delta --> SpadSupervisor.push(delta)
    |                                        |
    |                                    no attractor / observe
    |                                        |
    |                                        v
    |                                  normal persistence (unchanged)
    |
    +---------------------------- action.type === "recover" | "abort"
                                             |
                                             v
                                full-replace current part to healthy prefix
                                             |
                                             v
                                   ctx.needsRecovery = true
                                             |
                                             v
                          Stream.takeUntil(() => ctx.needsCompaction || ctx.needsRecovery)
                                             |
                                             v
                                 SessionProcessor.cleanup() (unchanged, existing)
                                             |
                                             v
                       runLoop: new Result "recover" -> synthetic user msg -> continue
                                (or "abort" -> dedicated recovery error -> break)
```

`SpadSupervisor` must live for **one genuine user turn**, i.e. constructed once per `runLoop` iteration-group in `prompt.ts`, not once per `SessionProcessor.create()` call — because recovery attempt #1 and #2 are separate provider requests (separate `processor.create()` calls), and the supervisor must retain attempt count, the failed motif, and the relapse watchdog across them. This is the single most important structural constraint; getting it wrong (e.g. a new supervisor per `process()` call) silently disables the relapse watchdog and the two-strikes-then-abort budget.

---

## 4. File-by-file port plan

The prototype (`spad-r-prototype/src/*.ts`) is standalone TypeScript with **zero external dependencies** and no opencode imports. Port it near-verbatim into a new directory:

```
packages/opencode/src/session/spad/
  types.ts
  config.ts
  canonical.ts
  format-tracker.ts
  period-lane.ts
  detector.ts
  motif-watchdog.ts
  shingle-verifier.ts
  intent.ts
  recovery.ts
  supervisor.ts
  index.ts
```

**One required mechanical change on port:** the prototype uses `NodeNext`-style relative imports with explicit `.js` extensions (e.g. `import { DEFAULT_SPAD_CONFIG } from "./config.js"`, see `spad-r-prototype/src/detector.ts:1-5`). This repo's `packages/opencode` does **not** use extensioned relative imports (confirmed by grepping `processor.ts`'s import block — plain `"./session"`, `"@/image/image"` style, no `.js`). Strip the `.js` suffixes on every relative import when porting, or the build will fail/behave inconsistently with the rest of the package. Do not port `tsconfig.json` / `package.json` — this becomes a subdirectory of the existing `packages/opencode` package, not a new workspace package (no other consumer justifies a separate package yet).

Do **not** port `bench/`, `test/run.ts`'s harness scaffolding, or `dist/` — those are prototype-repo tooling. Do port the *test cases* (the 17 deterministic/adversarial cases enumerated in `VALIDATION.md` §"Unit/adversarial suite") as real tests under `packages/opencode/src/session/spad/spad.test.ts` (or wherever this package's test convention lives — check an existing sibling test like `packages/opencode/src/session/*.test.ts` for the runner/assertion style in use, e.g. bun:test vs vitest, before writing).

No changes are needed to the algorithm files themselves (`detector.ts`, `period-lane.ts`, `canonical.ts`, `motif-watchdog.ts`, `format-tracker.ts`, `shingle-verifier.ts`, `intent.ts`, `recovery.ts`) beyond the import fix — they have no opencode coupling. `supervisor.ts` and `types.ts` are also opencode-agnostic and can port as-is. All opencode-specific glue is new code in `processor.ts` and `prompt.ts`, described next.

---

## 5. Wiring into `processor.ts`

### 5.1 Context

Add to `ProcessorContext` (`processor.ts:68-76`):

```ts
interface ProcessorContext extends Input {
  // ...existing fields...
  needsRecovery: boolean
  spadAction: SpadAction | undefined
}
```

`SpadSupervisor` itself is **not** stored on `ProcessorContext` — it's owned one level up by `runLoop` and passed into `Input`/`create()` (see §6). Add `spad: SpadSupervisor` to the `Input` type (`processor.ts:51-55`) and thread it through `create()`.

### 5.2 `text-start` (processor.ts:496-507)

Call `ctx.spad.startPart("text")` alongside the existing part-creation. Same for `reasoning-start` (`processor.ts:282-294`) with `ctx.spad.startPart("reasoning")`.

### 5.3 `text-delta` (processor.ts:509-520) — SPAD must run before persistence

Current:
```ts
case "text-delta":
  if (!ctx.currentText) return
  ctx.currentText.text += value.text
  if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
  yield* session.updatePartDelta({ ... })
  return
```

New:
```ts
case "text-delta": {
  if (!ctx.currentText) return
  const action = ctx.spad.push(value.text)
  if (!action || action.type === "observe") {
    ctx.currentText.text += value.text
    if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
    yield* session.updatePartDelta({ ... })  // unchanged
    return
  }
  // recover or abort: full-replace, not delta — prior chunks of this part may
  // already be persisted/rendered, and quarantineFrom addresses the FULL text.
  const full = ctx.currentText.text + value.text
  const cut = action.type === "recover" ? action.quarantineFrom : 0
  ctx.currentText.text = full.slice(0, Math.max(0, Math.min(full.length, cut)))
  yield* session.updatePart(ctx.currentText)
  ctx.spadAction = action
  ctx.needsRecovery = true
  return
}
```

Mirror this in the `reasoning-delta` branch (`processor.ts:296-308`), **gated by the signed-reasoning check in §7** — do not blanket-apply to reasoning yet.

### 5.4 Stream termination (processor.ts:654)

```ts
Stream.takeUntil(() => ctx.needsCompaction || ctx.needsRecovery),
```

### 5.5 `cleanup()` (processor.ts:549 onward)

No changes required. It already finalizes `ctx.currentText` (which was already full-replaced to the healthy prefix by 5.3) and already normalizes interrupted/pending tool calls. **This is the tool-state invariant**: SPAD must never inspect or rewrite tool parts; if recovery fires while a tool call is pending, `cleanup()`'s existing logic (lines ~581-589 onward, synthesizing interrupted tool results) is authoritative. Do not duplicate it.

### 5.6 New `Result` variant

`processor.ts:31` currently: `export type Result = "compact" | "stop" | "continue"`. Change to include the recovery outcome, e.g.:

```ts
export type Result = "compact" | "stop" | "continue" | { readonly type: "recover"; readonly prompt: string } | "abort-recovery"
```

(Naming/shape is your call — keep it a discriminated addition, not a breaking change to the three existing string literals, since `prompt.ts:1505-1506` does `if (result === "stop")` / `if (result === "compact")` string comparisons that must keep working unmodified.) Set this from `process()` (`processor.ts:637` onward) by checking `ctx.needsRecovery`/`ctx.spadAction` analogous to the existing `if (ctx.needsCompaction) return "compact"` at `processor.ts:689`.

---

## 6. Wiring into `prompt.ts` — `runLoop`

### 6.1 Supervisor lifetime

At the top of the per-turn setup in `runLoop` (`prompt.ts:1263` onward) — specifically once you have `lastUser` resolved (around `prompt.ts:1282-1284`) and are about to enter the step loop — construct one `SpadSupervisor` per genuine user turn and call `beginTurn`:

```ts
const spad = new SpadSupervisor(spadConfigFromAppConfig)
spad.beginTurn(makeTurnPolicy(genuineUserText, lastUser.format?.type === "json_schema"))
```

`genuineUserText` = the plain-text content of `lastUser`'s parts (needed for the `repetitionExpected` intent gate in `intent.ts` — e.g. a user asking "print this 500 times" must disable intervention). `lastUser.format?.type === "json_schema"` already exists as a field you can read directly (see its use at `prompt.ts:1429` and `:1456-1457`) — pass it straight into `observeOnly`.

**Do not** reconstruct `spad` on every loop iteration (`while (true)` at `prompt.ts:1274`) — only once per turn, before the loop, or on the specific transition where a genuinely new user message starts a new turn (this codebase's loop reuses `runLoop` across multi-step agent turns, tool calls, subtasks, and compactions within one user turn — check the loop's step/task branching around `prompt.ts:1330-1355` to confirm where "new turn" boundaries actually are; the compaction and subtask branches `continue` without necessarily meaning "new user turn"). If in doubt, err toward: one `SpadSupervisor` alive for as long as `lastUser.id` is unchanged.

### 6.2 Passing into `processor.create()`

At `prompt.ts:1399-1405`:
```ts
const handle = yield* processor
  .create({
    assistantMessage: msg,
    sessionID,
    model,
    spad,   // new
  })
  .pipe(Effect.onInterrupt(() => finalizeInterruptedAssistant))
```

### 6.3 Handling the new `Result`

At `prompt.ts:1505-1515`, alongside the existing `"stop"`/`"compact"` checks, add the recovery branch **using the exact synthetic-message recipe already used for auto-compaction** (`compaction.ts:519-547`) — do not use `createUserMessage`/`noReply` here, it's more machinery than needed and diverges from the established local pattern:

```ts
if (typeof result === "object" && result.type === "recover") {
  const recoverMsg = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    time: { created: Date.now() },
    agent: lastUser.agent,
    model: lastUser.model,
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: recoverMsg.id,
    sessionID,
    type: "text",
    text: result.prompt,
    synthetic: true,
    metadata: { spad_recovery: true },  // mirror compaction_continue precedent for downstream filtering
    time: { start: Date.now(), end: Date.now() },
  })
  return "continue" as const
}

if (result === "abort-recovery") {
  handle.message.error = new SessionV1.SpadRecoveryError({
    message: "Generation repeatedly entered a repetition loop and could not recover",
  }).toObject()
  yield* sessions.updateMessage(handle.message)
  yield* events.publish(Session.Event.Error, { sessionID, error: handle.message.error })
  return "break" as const
}
```

You'll need to add `SpadRecoveryError` (or reuse a generic `NamedError`) to `packages/schema` alongside `ContentFilterError`/`StructuredOutputError` (search `packages/schema/src/v1/session.ts` for those two to match the existing error-class pattern).

---

## 7. Reasoning / signed-block safety — do not skip this

opencode preserves **signed** reasoning blocks (Anthropic extended thinking with a `signature` in `providerMetadata.anthropic`) for provider-side replay validation. Truncating the *text* of a signed thinking block while keeping its original signature is very likely to break replay on the next request to that provider (undefined/rejected behavior, not just cosmetic).

Required v1 policy (from the prototype's own recommendation, which is conservative and correct):

- **Unsigned reasoning**: SPAD may use the same truncate/recover path as text, after dedicated tests.
- **Signed reasoning** (`providerMetadata.anthropic.signature` present): detect and log via the `observe` action, but **do not** auto-truncate/recover in v1. Gate this with a boolean (e.g. `signedReasoningReplaySafe`, defaulting `false`) so it's a deliberate, tested opt-in later, not an accidental blanket-enable.

Check for the signature the same way the prototype sketches it (`spad-r-prototype/integration/processor-hook-sketch.ts:50-57`):
```ts
const anthropic = providerMetadata?.["anthropic"]
const signed = !!anthropic && typeof anthropic === "object" && "signature" in anthropic
```
Find where `providerMetadata` for reasoning parts actually flows in this codebase (`processor.ts:291`, `:300`, `:311-313` reference `value.providerMetadata` and `ctx.reasoningMap[value.id].metadata`) and confirm the Anthropic signature's actual key path before wiring the gate — don't assume the prototype's guess is exact; verify against a real Anthropic extended-thinking response in this codebase (search for `"signature"` in the Anthropic provider adapter, likely under `packages/opencode/src/provider/` or wherever `packages/llm` normalizes provider metadata).

---

## 8. What is *not* validated yet — carry this forward, don't silently assume it away

Straight from `spad-r-prototype/VALIDATION.md`, "Known unvalidated areas" — these are real open risks, not boilerplate disclaimers:

- Live-model recovery success rate has **not** been measured against real OpenAI/Anthropic/Google traffic — only synthetic/injected loops.
- Provider cancellation behavior after `Stream.takeUntil` fires mid-generation has not been verified per-provider in this repo (does the upstream HTTP/SSE request actually get cancelled promptly for all three provider families, or does it keep streaming into a dead sink?).
- Replay safety for signed reasoning is explicitly unverified (§7 above exists because of this).
- Interaction with **every** opencode compaction/revert path is unverified — in particular, confirm a SPAD-truncated tail can never get resurrected by compaction's message-history re-summarization, and that session reload/replay never re-sends the discarded repetitive suffix to a provider.
- False-intervention rate has only been measured on synthetic corpora + real source code, not on real assistant *conversational* transcripts (prose, tool narration, etc.) — this is the standard trap for a repetition detector: recall on injected loops is easy, precision on real diverse agent output at scale is the actual bar.
- Fuzzy/structural degeneration (repeating structure with changing identifiers/numbers) is out of scope for v1 — that's why canonical/fuzzy lane defaults to observe-only (`autoRecoverCanonical: false` in `config.ts`). Do not flip that default without new calibration data.

Practical implication: **ship this behind a config/feature flag, default off, wired through telemetry first.** The `experimental.*` struct precedent at `packages/core/src/v1/config/config.ts:172-184` is the right home — add e.g. `experimental.spad_recovery: Schema.optional(Schema.Boolean)` there, mirroring `continue_loop_on_deny`'s doc comment style. Read it in `runLoop` before constructing a live `SpadSupervisor`; if off, either skip SPAD entirely or run it in "detect + log only, never truncate" mode (i.e. force `observeOnly: true` in the turn policy) so you can collect real intervention-rate telemetry safely before enabling auto-recovery broadly.

---

## 9. Required tests before merge (from the prototype's own checklist, `OPENCODE-INTEGRATION.md` §"Integration tests required before merge" — verified relevant, keep all 10)

1. Text loop truncates prior streamed deltas and hidden recovery continues successfully.
2. Synthetic recovery message is model-visible but not rendered as a normal user bubble (check `packages/app` / `packages/session-ui` rendering filters — they likely already skip `synthetic: true` parts given the existing compaction-continue precedent; confirm, don't assume).
3. First retry reproducing the failed motif triggers the fast watchdog near `relapseMatchChars` (96 chars in `config.ts` default).
4. Second relapse hard-stops; no third synthetic message is created (`maxRecoveryAttempts: 2` in default config).
5. Tool-use/result pairing remains valid when SPAD stops a request near pending tool activity — exercise via `cleanup()`'s existing interrupted-tool synthesis path.
6. Anthropic signed reasoning is not modified in the v1 auto path (§7).
7. OpenAI/Anthropic/Google-compatible providers all actually cancel the upstream request when `takeUntil` fires (this is the one item in this list most likely to surface a real bug — test against real or recorded provider streams, not mocks, if at all possible).
8. Compaction never resurrects a discarded repetitive suffix.
9. Session reload/replay does not contain the truncated tail in model-visible context.
10. Structured-output (`json_schema` format) generations are observe-only by default — verify `observeOnly` actually threads from `lastUser.format?.type === "json_schema"` through to `TurnPolicy` and that it disables truncation, not just detection.

Add an 11th: verify the `experimental.spad_recovery` flag actually gates the feature end-to-end (off = zero behavior change, including zero CPU cost — don't even construct the detector if disabled).

---

## 10. Suggested phased execution order

1. **Port** `spad-r-prototype/src/*` into `packages/opencode/src/session/spad/`, fix imports, port the 17 unit/adversarial tests, get `bun test` (or whatever runner this package uses) green in isolation with no opencode wiring yet.
2. **Config flag** — add `experimental.spad_recovery` (or your preferred name) to `packages/core/src/v1/config/config.ts`, default unset/false, threaded through to `runLoop`.
3. **Observe-only wiring** — wire `SpadSupervisor` into `processor.ts`/`prompt.ts` per §5–6, but force `observeOnly: true` regardless of detection result (i.e. detections log/telemetry but the `"recover"`/`"abort"` actions are never surfaced as real `Result` values yet). Ship this, gather real intervention-rate data.
4. **Enable text-channel auto-recovery** behind the flag, reasoning channel still observe-only, once step 3's telemetry shows an acceptably low false-positive rate on real traffic.
5. **Reasoning channel** — only after §7's signature-key verification and dedicated replay tests pass.
6. **Canonical/fuzzy auto-recovery** — not in scope for this handoff; requires new calibration data per §8, treat as a separate follow-up project.

Each phase should be its own PR. Do not attempt to land steps 1–4 in one changeset — the config flag and observe-only telemetry phase is the safety valve that makes the rest reviewable and revertable independently.
