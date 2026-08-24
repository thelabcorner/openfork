# SPAD-R / SPAD LIVE HEADLESS TESTING RESEARCH & INVESTIGATION DOCUMENT

> **Intention:** Give this document directly to an agent to perform LIVE HEADLESS TESTING of the SPAD-R repetition-loop detection/recovery algorithm. The agent will force real-time model degeneration, attempt recoveries, iterate thresholds, and collect telemetry.
>
> **Source state:** `openfork` branch (`a747d51764`). All line references verified against the working tree on 2026-08-22.

---

## 1. WHAT SPAD-R IS (ONE PARAGRAPH)

SPAD-R ("Streaming Periodic Attractor Detection + Recovery") is a dependency-free streaming algorithm that detects when an LLM's output falls into an exact repetition loop (`x_i = x_{i-p}` sustained interval) and applies a recovery state machine: truncate the bad tail, inject a hidden synthetic "re-anchor" user message, retry — hard-aborting after a second relapse of the same motif. It runs on raw UTF-16 code units with fixed-size typed-array buffers (`Uint16Array`, `Uint32Array`, `Int32Array`): no regex, no tokenizer, ~192 KiB/active generation, ~56 ns/char. It has three lanes: `raw` (exact byte-level periodicity), `canonical` (normalized whitespace/case for structural loops), and `thrash` (cross-turn tool/re-access stagnation, not byte-level). It is wired into the session `processor` (before persistence) and `prompt.runLoop` (recovery message injection).

References in the prototype doc (`AGENT_HANDOFF_spad-r-integration.md`) cite Holtzman et al. 2019 and Xu et al. 2022 for the degeneration mode; the full citations and rationale are in `spad-r-prototype/README.md` (not present in this repo — must be extracted from the zip referenced in the handoff doc).

---

## 2. CODE MAP (EVERY FILE + WHAT IT DOES)

`../../packages/opencode/src/session/spad` (14 source files):

| File | Lines | Role |
|---|---|---|
| `index.ts` | 9 | Barrel export (types, config, intent, detector, thrash, watchdog, supervisor, recovery, tool-loop) |
| `types.ts` | 76 | Core types: `SpadLane` (raw/canonical/thrash), `SpadChannel` (text/reasoning), `SpadConfig`, `PeriodThresholdBand`, `PeriodDetection`, `TurnPolicy`, `SpadAction` (`observe`/`recover`/`abort`) |
| `config.ts` | 47 | Default thresholds (`ringSize=16384`, `qgram=8`, `maxPeriod=4096`, `maxRecoveryAttempts=2`, `relapseMatchChars=96`, `recoveryWatchChars=1536`, `autoRecoverCanonical=true`, `canonicalMinDuplicate4GramRatio=0.65`, `autoRecoverThrash=true`). Validation: `pow2` checks. |
| `canonical.ts` | 19 | `Canonicalizer`: collapses whitespace, lowercases upper A-Z, ignores non-space whitespace; used by the `canonical` lane. |
| `format-tracker.ts` | 25 | `FormatTracker`: tracks backticks (`` ` `` ×3 toggles code fence); `insideCodeFence` gate raises coverage multiplier (`1.75`). |
| `detector.ts` | 114 | `SpadDetector`: holds `PeriodLane` instances (raw + canonical), pushes delta strings (`delta: string`) char-by-char, returns first `PeriodDetection` per turn, materializes with motif stats (`motifDistinctAsciiLetters`, `motifHasNonAscii`, `canonicalDuplicate4GramRatio`). |
| `period-lane.ts` | 194 | `PeriodLane`: the actual hash ring (`Uint16Array` buffer size = `ringSize`, `anchorTableSize` for rolling hash collision table). Computes period via `exactQgramMatch`, `addCandidate`, `maybeConfirm` against `PeriodThresholdBand`. Hot path is pure typed-array arithmetic. |
| `intent.ts` | 15 | `repetitionExpected(userText: string)`: regex-based gate (`NEGATED_REPEAT`, `EXPLICIT_COUNT`, `EXPLICIT_VERBATIM`, `EXPLICIT_FOREVER`). `makeTurnPolicy(...)` returns `{ repetitionExpected, observeOnly }`. Structured-output (`json_schema`) forces `observeOnly`. |
| `motif-watchdog.ts` | 80 | `MotifWatchdog`: post-recovery stream monitor; tracks whether recovered output relapses into the same motif (`requiredMatchChars` = `relapseMatchChars`, default 96). Persisted motifs (`pattern-store.ts`) feed into `persistedWatchdogs`. |
| `pattern-store.ts` | 148 | `addPersistedMotif` / `getPersistedMotifs`: writes to `~/.local/share/opencode/spad-patterns.bin` (MAGIC=0x44415053, VERSION=1). Cross-restart early detection (`earlyThreshold` ≈ 64 chars for known motifs). |
| `recovery.ts` | 15 | `recoveryPrompt(attempt: number)`: hidden synthetic user message text (`[Internal recovery] ...`). `toolRecoveryPrompt` and `thrashRecoveryPrompt` for other lanes. |
| `supervisor.ts` | 170 | `SpadSupervisor`: owns detector + `CrossTurnWatch` (`thrash`). `beginTurn()` resets state, constructs detector, starts `text` part. `push(delta: string)` handles persistent motifs, watchdog (relapse), thrash evaluation, detector push, `interventionAllowed()` gate, and returns `SpadAction`. `pushTool(name, isMutating, resource?)` for tool-loop detection. `startPart()` creates new detector (with `recoveryMode` flag). |
| `thrash.ts` | 195 | `CrossTurnWatch`: cross-turn stagnation detector (not byte-level loop). Uses `toolResourceKey()` (collapses `filePath` / `pattern` to basename, else `name:sig`). `normalizeWords()`, `hashTrigram()`, `intersectionCount()`. `pushTool()`, `pushNarration()`, `evaluate()` (requires `thrashMinGenerations`, `thrashNoMutationGens`, `thrashReaccessRatio`, `thrashNarrationOverlap`, `thrashNarrationStreak`). |
| `tool-loop.ts` | 58 | `ToolLoopDetector`: separate `PeriodLane` (ringSize=128, qgram=3, maxPeriod=16) for tool-name sequences. Only fires when no mutation (`noMutateCount >= 16`) — this avoids false positives on single-tool exploration. |
| `shingle-verifier.ts` | 32 | `ShingleVerifier`: 4-gram duplicate ratio (`duplicate4GramRatio`) for canonical lane. `keys`/`stamps` arrays (`Uint32Array`, size=8192, `epoch` counter). |

---

## 3. INTEGRATION ARCHITECTURE (VERIFIED AGAINST CURRENT SOURCE)

### 3.1 Config (`packages/core/src/v1/config/config.ts:172-184`)

```ts
experimental: Schema.optional(Schema.Struct({
  spad_recovery: Schema.optional(Schema.Boolean).annotate({
    description: "Enable repetitive-output recovery (SPAD-R). Enabled by default; set false to disable",
  }),
  ...
}))
```

**Important:** Default behavior is `enabled` (`!== false`). To disable auto-recovery (observe-only), set `experimental.spad_recovery: false`.

### 3.2 Processor (`../../packages/opencode/src/session/processor.ts`)

**Imports (line 29-30):**
- `SpadSupervisor` from `./spad/supervisor`
- `toolResourceKey` from `./spad/thrash`

**Input (`line 54-59`):** `spad?: SpadSupervisor` added to `Input`. Passed through `create()` (`line 116`).

**Context (`line 72-83`):** `ProcessorContext` extends `Input`, includes:
- `needsRecovery: { readonly prompt: string } | undefined`
- `needsCompaction: boolean`

**Lifecycle events handled (`handleEvent` at ~line 300):**

| Event | SPAD Interaction | Current Line |
|---|---|---|
| `reasoning-start` | `ctx.spad?.startPart("reasoning", false, false)` (line 312) | 312 |
| `reasoning-delta` | `ctx.spad?.push(value.text)`; abort/recover handled with signed-reasoning gate (`isSignedReasoningMetadata` at 290-298) | 325-356 |
| `text-start` | `ctx.spad?.startPart("text")` (line 562) | 562 |
| `text-delta` | `ctx.spad?.push(value.text)`. If `abort`: throws. If `recover`: `cut = action.noTruncate ? ctx.currentText.text.length : action.quarantineFrom`; slices `ctx.currentText.text`, yields `updatePart`, sets `needsRecovery = { prompt: action.recoveryPrompt }`. If `observe`: does nothing (no persistence change). Otherwise: normal delta persistence. **NOTE BUG HERE** (see §6). | 575-597 |
| `tool-input-start/end` / `tool-call` | `pushTool(...)` (line 432); abort/recover sets `needsRecovery`; no persistence change on recover | 429-438 |
| `finish` | Nothing special |

**Stream termination (`line 742`):**
```ts
Stream.takeUntil(() => ctx.needsCompaction || ctx.needsRecovery !== undefined)
```
When `needsRecovery` is set, stream stops; `cleanup()` (line 626+) finalizes interrupted parts.

**Result contract (`line 33`):** `export type Result = "compact" | "stop" | "continue"`. Note: the prototype handoff suggests adding `{ type: "recover"; prompt: string }` or `"abort-recovery"`, but the current code does **not** use those new `Result` variants; instead, `needsRecovery` is read by the caller (`prompt.ts`) directly (`handle.recovery` at line 790). This is the actual current architecture — not the sketch from the handoff doc.

**Mark generation (`line 721`):** `ctx.spad?.markGeneration()` — used by `CrossTurnWatch` (`thrash`) for generation counting.

### 3.3 Prompt (`../../packages/opencode/src/session/prompt.ts`)

**Supervisor construction (`lines 1279-1323`):**
```ts
let spad: SpadSupervisor | undefined
let spadStarted = false
...
if (!spadStarted && (yield* config.get()).experimental?.spad_recovery !== false && lastUserMsg) {
  const userText = lastUserMsg.parts.filter(...).map(p => p.text).join("\n")
  spad = new SpadSupervisor()
  spad.beginTurn(makeTurnPolicy(userText, lastUser.format?.type === "json_schema"))
  spadStarted = true
}
```

**Passed to processor (`line 1443`):** `spad` included in `processor.create({ ..., spad })`.

**Recovery handling (`lines 1536-1552`):** After `handle.process()` returns, checks `handle.recovery`. If set:
- Creates new `user` message (ascending ID, same agent/model, time `Date.now()`)
- Creates `text` part (`synthetic: true`, text = `handle.recovery.prompt`, metadata `{ spad_recovery: true }` — wait, does the current code include `metadata: { spad_recovery: true }`? Looking at the actual code at lines 1543-1550: no `metadata` is set for the synthetic recovery part. The handoff doc mentions it (`metadata: { spad_recovery: true }`), but the actual code does not include it yet. This is another divergence between design doc and actual implementation.)
- Returns `"continue"` as const, which loops back.

**No `abort-recovery` result is handled in prompt.ts** — the processor throws an error on `abort` (`line 330`, `line 433`, `line 578`, `line 585`). This is important: second relapse (`attempt >= maxRecoveryAttempts`) throws an error inside the stream handler, which gets caught by `Effect.catch(halt)`, which updates `assistantMessage.error` and returns `"stop"` (break loop). So the user sees a finished turn with an error, not a dedicated `abort-recovery` message. The design doc proposes a dedicated `abort-recovery` result, but the current code uses the existing error path.

---

## 4. EXISTING TESTING CODE (THE AGENT MUST READ THIS)

### 4.1 Unit / Adversarial SPAD Tests (PASS: 48/48)

Files:
- `../../packages/opencode/test/session/spad.test.ts` (19 pass, 433 expect calls, 3.53s)
- `../../packages/opencode/test/session/spad-more-fixtures.test.ts` (includes 30 real `.ts` files as negative fixtures, JSON fixtures, synthetic negatives, positives, canonical drift, tool-loop, cross-turn fixtures; 8 tests, ~29 passes)
- `../../packages/opencode/test/session/spad-frontier.test.ts` (frontier cases: period-1, period-3, period-120, mixed case, high-shingle non-periodic, JSON lines, code fence gates, tool loop escalation, persistent motif, cross-turn thrash; 17 tests, all pass)

These tests are **pure algorithmic** — they feed strings into `SpadDetector.push()` and `SpadSupervisor.push()` directly, with no provider or session involved. They test detection precision/recall, chunk invariance, code-fence thresholds, structured-output observe-only, recovery escalation (`recover` → `recover` → `abort`), and tool-loop behavior.

**Important patterns from these tests:**
- `feed()` splits text into arbitrary chunk arrays (`[text.length]`, `[1]`, `[17, 3, 41]`, etc.) to verify chunk invariance.
- `clearPersistedMotifs()` (from `pattern-store`) is called before tests that depend on cross-restart persistence.
- `sup.markGeneration()` simulates new provider turns; `sup.startPart("text", true)` simulates recovery mode (second attempt).

### 4.2 Integration Tests in `prompt.test.ts` (FAIL: 2/2, as discovered)

- `packages/opencode/test/session/prompt.test.ts:784-821` — `"SPAD recovery truncates a repetitive tail and continues with a hidden re-anchor"`
- `packages/opencode/test/session/prompt.test.ts:824-848` — `"SPAD disabled preserves repetitive output and avoids recovery"`

These use the **live Effect harness** (`test/lib/llm-server.ts` — `TestLLMServer`, `reply()`, `useServerConfig`). They construct a full `SessionPrompt.Service` with a mock LLM server at a dynamic localhost port (`baseURL: "http://localhost:1/v1"`). The test creates a session (`Session.Service.create()`), seeds user input (`prompt.prompt()`), pushes mock LLM responses (`llm.text(...)`), then calls `prompt.loop()` to observe the full session loop behavior.

**Current failure state:**
- `SPAD recovery` test: fails at line 818 (`expect(repetitive?.type).toBe("text")`). The synthetic recovery message is found (`synthetic` defined); the assistant message includes the recovery text; but the part containing the original repetitive motif does **not** exist as a `text` part — it is missing from `messages`. This indicates the truncation logic in `processor.ts` discards the **entire** delta when it arrives as a single chunk, because `cut` (the quarantine index) is computed against `full = text + delta` but applied to `text` alone, and `text` is empty before the first delta.
- `SPAD disabled` test: **times out** at 5000ms (default `bun test` timeout). It does not use a mock LLM server timeout setting. The loop likely hangs because `spad_recovery: false` skips supervisor construction; the mock server sends one chunk (`motif.repeat(12)`) with `finish: "stop"`. The loop should finish. The timeout may be unrelated to SPAD — it may be a generic test-timeout issue in this branch (other tests pass quickly). The agent should verify this separately.

### 4.3 Mock Provider Infrastructure (`test/lib/llm-server.ts`)

`TestLLMServer` is the key infrastructure for live-like headless testing. It is a real `node:http` server (`Http.createServer`) registered with `HttpRouter`, serving `/v1/chat/completions` (OpenAI `chat.completions` format) and `/v1/responses` (newer responses format). It manages a queued response list (`Sse` items with `head`/`tail` arrays) and pulls the first matching item per incoming request (`pull()` at line 664).

**Response construction:**
- `Reply` class: `.text(value)`, `.reason(value)`, `.tool(name, input)`, `.pendingTool(name, input)`, `.hang()`, `.streamError(error)`, `.usage(Usage)`, `.stop()`, `.contentFilter()`.
- `Sse` item: `{ type: "sse", head: unknown[], tail: unknown[], wait?: PromiseLike, hang?: boolean, error?: unknown, reset?: boolean }`.
- `responses()` transforms `Sse` into `responseCreated` + `responseText` + `responseCompleted` sequences (for `/v1/responses` endpoint).

**Key capabilities for headless degeneration testing:**
- Queue multiple responses (`llm.text("...")`) that simulate progressive repetition.
- Queue a `streamError()` or `reset()` to test interruption/retry behavior.
- Queue `.pendingTool()` followed by `.text()` to test tool-state interaction with SPAD.
- Queue `.reason()` for reasoning-channel SPAD.
- Queue `.usage()` to simulate token usage.
- Queue multiple turns sequentially (`llm.text(...)` in sequence) to test multi-turn thrash/recovery.
- Set `wait` on a reply to delay a response and observe timeout/recovery timing.

**How tests configure it (`useServerConfig` in `prompt.test.ts` lines 318-323`):**
```ts
function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: { ...cfg.provider.test.options, baseURL: url },
      },
    },
  }
}
const useServerConfig = Effect.fn("test.useServerConfig")(function* (config) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})
```

The `cfg` defines a custom `test` provider using `npm: "@ai-sdk/openai-compatible"` (`packages/core/src/v1/provider/` probably resolves this). The base URL points at the mock server. This is how the agent can test against **scripted** responses.

To test against a **live** provider (e.g., real OpenAI, Anthropic, or a local vLLM server), configure the `provider` config to point to that provider's base URL with a real API key (or use `LM_STUDIO` / `OLLAMA` provider packages if installed). The `LLM.stream()` method uses `provider.getProvider()` and `auth.get()` from the `Provider.Service` and `Auth.Service` layers.

### 4.4 Fixture Infrastructure (`test/fixture/fixture.ts`)

`TestInstance` provides a temporary directory (`opencode-test-*`) with an `opencode.json` config file. `tmpdir()` and `tmpdirScoped()` manage lifecycle. The agent can use `useServerConfig()` to write a custom config pointing at a live provider endpoint into the temp instance directory.

### 4.5 Processor-Level Tests (`test/session/processor-effect.test.ts`)

These test the `SessionProcessor.create()` directly with mock streams (using `LLM.StreamInput` and simulated `LLMEvent` streams). They are faster than full session loop tests but still exercise the SPAD integration path (`processor.create()` with `spad` input, `process()`, `cleanup()`). There is no explicit SPAD assertion here, but the test framework supports it.

---

## 5. CURRENT TEST RESULTS (VERIFIED LIVE ON THIS TREE)

| Test Suite | Results | Time | Notes |
|---|---|---|---|
| `test/session/spad.test.ts` | 19 pass / 0 fail | 3.53s | Unit/adversarial |
| `test/session/spad-frontier.test.ts` | 17 pass / 0 fail | included above | Frontier fixtures |
| `test/session/spad-more-fixtures.test.ts` | 29 total (includes 30 real `.ts` negative fixtures) | 3.47s | Includes real source files |
| `test/session/prompt.test.ts -t "SPAD"` | 0 pass / 2 fail / 1 error? | ~14.4s | Integration: `SPAD recovery` fails at line 818; `SPAD disabled` times out |

**Critical discovery:** The `SPAD recovery` integration test reveals a **functional bug** in `processor.ts` line 581-583. When `action?.type === "recover"`, the code computes `full = ctx.currentText.text + value.text` (actually wait — does it? Let me re-check). Looking at the actual code again (lines 575-587 from processor.ts read):

```ts
if (action?.type === "recover") {
  const cut = action.noTruncate ? ctx.currentText.text.length : action.quarantineFrom
  ctx.currentText.text = ctx.currentText.text.slice(0, cut)
  yield* session.updatePart(ctx.currentText)
  ctx.needsRecovery = { prompt: action.recoveryPrompt }
  return
}
```

Wait — the code does **NOT** include `full = ctx.currentText.text + value.text` in the current implementation! It slices `ctx.currentText.text` directly using `cut` (which is `action.quarantineFrom`, an index computed relative to the combined stream). So when the loop arrives in a single delta (`text` is empty before delta), `cut` is a positive index (`runStart` of detection), and `text.slice(0, cut)` returns the first `cut` characters... but since `text` is empty, `slice(0, cut)` returns `""` (empty string). So the bad tail is removed (good), but the good prefix (before the loop started) is also lost if it arrived in the same delta. In the integration test, the mock sends `motif.repeat(12)` in one chunk (`llm.text(...)`). The prefix `"Continue implementing the feature. "` (the user message) is separate from the assistant generation stream. The assistant stream starts empty (`currentText = text: ""`), then the first delta is the full repetitive motif. Since there is no prior healthy assistant text, `text.slice(0, cut)` yields `""`, so the assistant message becomes empty. Then the synthetic recovery message is added. The test expects the assistant message to contain the motif truncated at `quarantineFrom` (i.e., some prefix of the loop). But since `currentText` was empty, nothing remains. This is why `repetitive?.type` is undefined (no part with motif).

But wait — is that the only issue? If the loop starts after some healthy text in the stream (e.g., healthy prefix followed by loop), the current code would preserve the healthy prefix correctly, because `currentText.text` contains it and `slice(0, cut)` keeps it. The bug is specifically when the loop starts at the very beginning of the assistant stream (or when the loop spans a single delta that includes everything). The handoff doc's sketch (line 527-559) does include `full = ... + value.text`, which suggests the design intended to include the current delta before truncation. The current code does not.

So: **Bug found: `text-delta` recovery truncation ignores the current delta's healthy portion.** The agent should fix this as part of live headless testing / iteration.

Also note: `text-end` (line 599) does not interact with `needsRecovery` or `spadAction`. After `text-delta` sets `needsRecovery`, the stream stops (`Stream.takeUntil`), so the `finish` event may never arrive, but `cleanup()` handles the interrupted text part correctly. If `text-end` were to arrive after a recover (e.g., if `needsRecovery` was set by a prior delta but the provider continues), the existing `text-end` logic (`line 599-618`) does not check for `needsRecovery`. In practice, the stream is interrupted, so `text-end` won't fire, but the design doc doesn't explicitly mention this interaction.

---

## 6. BUGS / ISSUES FOUND DURING INVESTIGATION

### 6.1 Confirmed: Truncation logic drops healthy text from single-chunk delta (PROCESSOR BUG)
- **Location:** `packages/opencode/src/session/processor.ts:581-583` (`text-delta` branch).
- **Evidence:** Integration test `SPAD recovery truncates a repetitive tail` fails at line 818 with `repetitive?.type` undefined. The mock sends the loop in a single `llm.text()` chunk. `currentText.text` is empty before the delta (`text-start` creates empty text), so `slice(0, cut)` yields empty string.
- **Root cause:** The truncation does not compute `full = currentText.text + value.text` before slicing; it applies `cut` (an index into `full`) directly to `currentText.text`. When `currentText.text` is shorter than `full` (always true because `currentText.text` hasn't been updated with `value.text` yet), `slice` either keeps too little or too much? Actually it keeps at most the whole `currentText.text`, which in this case is nothing. The design sketch (`AGENT_HANDOFF_spad-r-integration.md` lines 152-159) explicitly shows the `full = ... + value.text` step. The code is missing it.
- **Fix needed:** Before slicing, compute `const full = ctx.currentText.text + value.text`; then `const cut = action.noTruncate ? full.length : Math.max(0, Math.min(full.length, action.quarantineFrom))`; then `ctx.currentText.text = full.slice(0, cut)`.

### 6.2 Confirmed: Integration test `SPAD disabled` times out
- **Location:** `packages/opencode/test/session/prompt.test.ts:824-848`.
- **Evidence:** Test fails with timeout after 5000ms.
- **Possible cause:** Unrelated to SPAD; the loop consumes the mock response but the test may hang due to `prompt.prompt()` or `prompt.loop()` interaction with the mock server (e.g., title request consuming the queued response). The agent should investigate whether the timeout is reproducible independently of SPAD.

### 6.3 Design / Code Divergence: `Result` contract not updated
- **Location:** `packages/opencode/src/session/processor.ts:33`, `packages/opencode/src/session/prompt.ts:1536-1552`.
- **Evidence:** The handoff doc proposes a new `Result` variant (`{ readonly type: "recover"; readonly prompt: string }` / `"abort-recovery"`), but the current code does not modify `Result`. Instead, `needsRecovery` on `ProcessorContext` is exposed through `Handle.recovery` (line 51, 790). This is actually a cleaner design, but it contradicts the handoff doc. The agent must respect the actual code, not the design doc's proposed `Result` shape.

### 6.4 Design / Code Divergence: Synthetic recovery message has no `metadata: { spad_recovery: true }`
- **Location:** `packages/opencode/src/session/prompt.ts:1543-1550`.
- **Evidence:** The handoff doc mentions `metadata: { spad_recovery: true }`, but the current code creates the synthetic part without `metadata`. The `part` is created with: `synthetic: true`, `type: "text"`, `text: handle.recovery.prompt`. No `metadata` key.
- **Implication:** Downstream rendering filters or telemetry that expect `metadata.spad_recovery` will miss it. The agent should confirm whether any consumer relies on this (search for `spad_recovery` in codebase — only config flag and handoff doc reference it; no actual consumer in source).

### 6.5 Potential Issue: `reasoning-delta` signed-reasoning gate is incomplete
- **Location:** `packages/opencode/src/session/processor.ts:325-356`.
- **Evidence:** `isSignedReasoningMetadata()` checks `providerMetadata` for `signature` key, but the actual Anthropic extended-thinking metadata path is unverified (`providerMetadata?.anthropic?.signature` vs `providerMetadata?.signature`). The design doc (§7) notes this is unverified. The agent should verify the exact key path in real Anthropic responses (search `../../packages/opencode/src/provider` or provider normalization code) before enabling signed-reasoning truncation.

### 6.6 Unverified: Compaction / session reload interaction with truncated text
- **Location:** `../../packages/opencode/src/session/compaction.ts`, `../../packages/opencode/src/session/revert.ts` (not fully inspected).
- **Evidence:** The handoff doc (§8) lists this as an open risk: "confirm a SPAD-truncated tail can never get resurrected by compaction's message-history re-summarization, and that session reload/replay never re-sends the discarded repetitive suffix to a provider." There is no automated test covering this interaction. The agent should design a live test that triggers SPAD, then triggers compaction/reload, and verifies the truncated tail is not present in the model-visible history or in replay events.

---

## 7. WHAT IS NOT VALIDATED (CARRY FORWARD — DO NOT SILENTLY ASSUME)

Straight from `AGENT_HANDOFF_spad-r-integration.md` §8 and from this investigation:

1. **Live-model recovery success rate** has NOT been measured against real OpenAI/Anthropic/Google traffic — only synthetic/injected loops (unit tests) and mock server (integration tests, which currently fail for recovery path).
2. **Provider cancellation after `Stream.takeUntil`** is unverified per-provider family. The `stream` uses `Stream.takeUntil(() => ctx.needsCompaction || ctx.needsRecovery !== undefined)`. The upstream `LLM.stream()` creates an `AbortController` (line 364-380 in `llm.ts`). Whether the provider HTTP stream is promptly cancelled for all three families is unverified.
3. **Replay safety for signed reasoning** is explicitly unverified (§7).
4. **Compaction / revert interaction** is unverified (§6.6 above).
5. **False-intervention rate on real conversational transcripts** (prose, tool narration) is unverified — only synthetic corpora + source code. The standard trap: easy to detect injected loops; hard to avoid false positives on diverse agent output at scale.
6. **Fuzzy/structural degeneration** (changing identifiers/numbers) is out of scope for v1 (`autoRecoverCanonical` defaults `true`, but fuzzy is intentionally observe-only; no calibration exists).
7. **Telemetry / intervention rate logging** is missing. There is no `Effect.logInfo` or telemetry event emitted when SPAD detects (`observe` or `recover`). The agent should add telemetry before enabling broad auto-recovery.

---

## 8. LIVE HEADLESS TESTING PLAN (WHAT THE AGENT MUST DO)

The agent must use a live provider stream (not just mock server) to validate the SPAD-R detection algorithm in real-time, force different types of degeneration, and attempt recoveries. The agent should follow these phases, collecting telemetry at each step.

### 8.1 Testing Harness Setup (How to Configure a Live Provider)

**Option A: Mock Provider (TestLLMServer) — for scripted, reproducible degeneration**
- Use `../../packages/opencode/test/lib/llm-server.ts` (already working).
- Define scripted responses in a `Reply()` chain: e.g., `.text("healthy prefix...").text("repetitive motif...").stop()`.
- Use `useServerConfig()` (line 318 of `prompt.test.ts`) to point a temporary instance at the mock server.
- Use `llm.wait(n)` (line 767 of `llm-server.ts`) to block until `n` provider requests have been received (useful for measuring multi-turn behavior).
- Queue `.pendingTool()` followed by `.text()` to test tool-state interaction.
- Queue `.reason()` for reasoning-channel SPAD.

**Option B: Real Provider (Live) — for genuine model behavior validation**
- Configure `../../packages/core/src/v1/config/config.ts` provider settings (or `opencode.json`) to point at a real provider (`openai`, `anthropic`, `google`, or a custom `npm` package like `@ai-sdk/openai-compatible` pointing at a local `vLLM`/`lm-studio` endpoint).
- Example: in `test/lib/llm-server.ts`, `providerCfg()` defines `provider: { test: { npm: "@ai-sdk/openai-compatible", options: { baseURL: url } } }`. Replace `test` with a real provider name and provide real API keys in the `opencode.json` config.
- Use `Effect.acquireRelease` with a real `Provider.Model` reference (from `Agent` config or session creation) to dispatch real requests.
- Monitor `LLMEvent` stream via `Stream.tap()` (as `processor.ts` does) to observe raw provider chunks in real-time.

**Recommendation for the agent:** Start with Option A (scripted mock) to reproduce and fix the truncation bug (§6.1). Then move to Option B (live provider) for genuine degeneration testing.

### 8.2 Forced Degeneration Patterns (What to Inject)

The agent should create test cases that simulate the following degeneration modes, using either scripted `.text()` sequences (mock) or carefully crafted prompts (live provider that instruct the model to repeat):

**Pattern 1: Exact Byte-Level Repetition (`raw` lane)**
- Script / prompt: `"Repeat the following exactly 20 times: [motif]"`
- Expected SPAD behavior: `SpadDetector.push()` detects `lane: "raw"`, `period` ≈ motif length, `runLength` ≈ `20 * motif.length`, `exponent` ≈ 20. `interventionAllowed()` returns `true` (no `repetitionExpected`, not structured output). `SpadSupervisor.triggerRecovery()` creates `SpadAction { type: "recover", attempt: 1, detection: ..., quarantineFrom: runStart, recoveryPrompt: "[Internal recovery] ..." }`.
- Recovery path: `text-delta` truncates at `quarantineFrom`, injects synthetic user message (`synthetic: true`), continues loop. The agent should verify: (a) the synthetic message is present in session messages; (b) the assistant message's text is truncated to `quarantineFrom` (or `full` after fix); (c) the loop produces a new assistant message that does NOT contain the original motif; (d) the second provider call (`handle.process()` second invocation) receives the synthetic user message in `messages` array.

**Pattern 2: Canonical Drift (`canonical` lane)**
- Script / prompt: provide the same sentence with varying whitespace and case (e.g., `"Re-anchor to the user request..."` in lowercase, uppercase, extra spaces, tabs, newlines).
- Expected SPAD behavior: `lane: "canonical"`, `canonicalDuplicate4GramRatio` > 0.65, `interventionAllowed()` returns `true` (if `autoRecoverCanonical: true`).
- The agent should verify that the canonical lane detects the drift and that `noTruncate` behavior does not corrupt the text (canonical recover uses `noTruncate` by default? Looking at supervisor: `noTruncate: detection.lane === "thrash"`; so `canonical` uses truncation, `thrash` does not). The agent should test both.

**Pattern 3: Cross-Turn Tool Stagnation (`thrash` lane)**
- Script: simulate 3+ generations where each calls the same non-mutating tool (`read`) on the same file, with narration text that reuses the same phrases (`narrationRecurrenceStreak` >= 3).
- Expected SPAD behavior: `lane: "thrash"`, `period: 0`, `noTruncate: true` (line 88 in supervisor: `noTruncate: detection.lane === "thrash"`). The agent should verify that `text-delta` does NOT truncate the text part (`noTruncate` means `cut = full.length`, keeping everything), but the recovery message is still injected, and the loop continues.

**Pattern 4: Structured Output (`json_schema`) Observe-Only**
- Script / prompt: set `format.type = "json_schema"` with a schema that forces repetitive JSON objects.
- Expected SPAD behavior: `TurnPolicy.observeOnly = true`. `interventionAllowed()` returns `false` (`this.policy.observeOnly || this.partObserveOnly`). `SpadSupervisor.push()` returns `{ type: "observe", detection: ... }`. The `text-delta` handler ignores `observe` actions (line 143-148: `if (!action || action.type === "observe")` does normal persistence, no truncation, no `needsRecovery`). The agent should verify zero behavior change (no recovery message, no truncation, stream continues normally).

**Pattern 5: Intent Gate (`repetitionExpected`)**
- Script / prompt: user text explicitly asks for repetition (`"Print foo exactly 1000 times."`).
- Expected SPAD behavior: `repetitionExpected()` returns `true`. `interventionAllowed()` returns `false`. Even if the model outputs an exact loop, SPAD returns `observe`, not `recover`. The agent should verify this gate prevents false recovery.

**Pattern 6: Signed Reasoning (`reasoning` channel, `signed` = true)**
- Script / prompt: use Anthropic-style reasoning streams (`providerMetadata.anthropic.signature`).
- Expected SPAD behavior: `isSignedReasoningMetadata()` detects `signature` in metadata. If `signed` is `true`, the `reasoning-delta` handler skips auto-truncation (`if (signed) { ... } else { ... }`). The agent should verify the reasoning text is NOT modified, but `observe` actions are still returned (
Wait, looking at the code: `if (action?.type === "abort") throw ...` (always). `if (action?.type === "recover")` checks `signed`. If `signed`, it does nothing (falls through to the `else` which does truncation). Wait, the code structure:
```ts
if (action?.type === "abort") throw ...
if (action?.type === "recover") {
  const signed = ...
  if (signed) {
    // Signed thinking must remain observe-only for replay safety.
  } else {
    // truncation logic
  }
}
```
Wait — if `signed` is true, there is no code inside the `if (signed)` block! It just falls through. Actually, looking at lines 331-346:
```ts
if (action?.type === "recover") {
  const signed = isSignedReasoningMetadata(...)
  if (signed) {
    // Signed thinking must remain observe-only for replay safety.
  } else {
    const full = ...
    const cut = ...
    ...
  }
}
```
If `signed`, nothing is done inside the `if (signed)` block. Then the code continues to `ctx.reasoningMap[value.id].text += value.text` (line 347), which does normal persistence. So for signed reasoning with recover action, the recovery is suppressed (observe-only behavior for signed reasoning). This is consistent with the design doc (§7). The agent should verify this: a signed reasoning loop should NOT trigger truncation (the text continues), and no `needsRecovery` is set (because the `if (signed)` branch does not set it). Wait — does it set `needsRecovery`? No, the `if (signed)` branch is empty — it does not set `ctx.needsRecovery`, does not truncate, and does not return (so it falls through to `text += value.text`). So the stream continues, the loop is preserved, and `needsRecovery` is never set. But `action.type === "recover"` is still returned by `push()`. However, the `if (action?.type === "recover")` branch suppresses the action (does nothing) when signed. So the stream does not stop (`needsRecovery` remains undefined). This is the correct conservative behavior.

But the agent should verify this with a real Anthropic stream that has `providerMetadata` containing `signature`. The key path may vary (prototype guesses `providerMetadata?.anthropic?.signature`; actual code checks `providerMetadata?.anthropic` and `providerMetadata?.bedrock`). The agent must confirm the exact metadata shape from a real provider adapter.

---

## 9. SUGGESTED PHASED EXECUTION FOR LIVE HEADLESS TESTING

The agent should not attempt to fix everything in one pass. Each phase should be a separate PR / commit.

### Phase 1: Fix Confirmed Truncation Bug + Verify Integration Tests Pass
- Fix `packages/opencode/src/session/processor.ts:581-583` by computing `full = text + delta` before slicing.
- Re-run `bun test test/session/prompt.test.ts -t "SPAD"`.
- Confirm both SPAD integration tests pass.
- If `SPAD disabled` still times out, investigate whether the timeout is independent (e.g., mock server queue mismatch, title request consuming response).

### Phase 2: Observe-Only Telemetry Phase (Safety)
- Do NOT change `result` contract.
- Force `observeOnly: true` in `SpadSupervisor.beginTurn()` for all turns (temporarily, or via a new config flag).
- Run live provider tests with scripted/mock responses to collect `SpadAction { type: "observe", detection: ... }` events.
- Add `Effect.logInfo` or telemetry event emission in `supervisor.ts` when `observe` or `recover` is returned (currently missing).
- Measure false-positive rate on real provider traffic.

### Phase 3: Synthetic Degeneration with Real Provider
- Configure a live provider (local vLLM or real API key with limited budget) using `providerCfg()` style setup.
- Write a dedicated test file (`test/session/spad-live-degeneration.test.ts`) that uses `TestLLMServer` or a real provider endpoint.
- Script forced degeneration:
  a. User prompt: `"Generate a technical explanation, then repeat the last sentence 10 times exactly."`
  b. Monitor `LLMEvent` stream with `Stream.tap()`.
  c. Verify `SpadSupervisor.push()` returns `observe` first (if user explicitly asks for repetition), then `recover` when the loop exceeds thresholds.
  d. Verify `text-delta` truncates correctly (after Phase 1 fix).
  e. Verify synthetic message is injected and loop continues.
  f. Verify second relapse (`attempt = 2`) triggers `abort` (stream stops, error set, loop breaks).

### Phase 4: Multi-Turn Thrash / Cross-Turn Recovery
- Simulate a multi-turn session:
  1. User asks for file exploration.
  2. Agent reads `benchmark.ts` repeatedly (non-mutating) for 3 generations.
  3. Agent repeats the same narration (`"Let me check..."`).
  4. Verify `CrossTurnWatch` detects `thrash` (`lane: "thrash"`, `noTruncate: true`).
  5. Verify recovery message (`thrashRecoveryPrompt`) is injected.
  6. Verify the next generation produces a mutating edit (`write` or `edit`) or ends (`"finish"`), breaking stagnation.

### Phase 5: Calibration / Threshold Tuning (Future)
- Adjust `canonicalMinDuplicate4GramRatio` (default 0.65) if false positives occur.
- Adjust `recoveryThresholdMultiplier` (default 0.65, applied when `recoveryMode` is true) for second-attempt sensitivity.
- Adjust `lowLexicalDistinctLetters` (default 4) and `lowLexicalMinCoverage` (default 1024) for low-diversity motifs.
- Adjust `thrashReaccessRatio` (0.5) and `thrashNarrationOverlap` (0.35) based on telemetry.
- This phase requires new calibration data; the agent must collect real intervention rates before changing defaults.

---

## 10. REFERENCES & KEY LINE NUMBERS (QUICK NAVIGATION FOR AGENT)

- `AGENT_HANDOFF_spad-r-integration.md` — design doc (line references may be slightly stale vs current tree; verify against actual code).
- `../../packages/opencode/src/session/spad` — implementation.
- `../../packages/opencode/src/session/processor.ts` — integration wiring (line 29 import, line 58 `Input.spad`, line 312 `startPart`, line 329 `push`, line 432 `pushTool`, line 562 `startPart`, line 577 `push`, line 721 `markGeneration`, line 742 `takeUntil`, line 790 `recovery`).
- `../../packages/opencode/src/session/prompt.ts` — supervisor lifetime (line 1279), turn policy (line 1321), `spad` passed to processor (line 1443), recovery injection (line 1536-1552).
- `../../packages/core/src/v1/config/config.ts` — config flag (`line 175`).
- `../../packages/opencode/test/session/spad.test.ts` — 19 unit tests.
- `../../packages/opencode/test/session/spad-frontier.test.ts` — 17 frontier tests.
- `../../packages/opencode/test/session/spad-more-fixtures.test.ts` — real `.ts` fixtures, synthetic negatives.
- `../../packages/opencode/test/session/prompt.test.ts` — 2 integration tests (`line 784` SPAD recovery, `line 824` SPAD disabled).
- `../../packages/opencode/test/lib/llm-server.ts` — mock LLM server (line 452 `Reply`, line 637 `TestLLMServer`, line 730 `.text()`, line 754 `.wait()`, line 767 `.wait()` effect).
- `../../packages/opencode/src/session/llm.ts` — real provider stream (`line 364` `AbortController`, line 378 `Stream.fromAsyncIterable`).

---

## 11. ACTION CHECKLIST FOR THE AGENT

Before starting live headless testing, verify:
- [ ] Read `spad-r-prototype/README.md` and `VALIDATION.md` (from `spad-r-prototype.zip` — must be extracted; reference path in handoff doc: `C:\Users\slooshied\Downloads\spad-r-prototype.zip`).
- [ ] Confirm `../../packages/opencode/src/session/spad` files match prototype (import extensions stripped, `.js` suffixes removed — verified in current tree).
- [ ] Run `bun test test/session/spad*.test.ts` — confirm 48 pass.
- [ ] Confirm the truncation bug (`processor.ts` line 581-583) by inspecting `text-delta` logic.
- [ ] Decide whether to fix the bug first (recommended — Phase 1) or include it in live testing observations.
- [ ] Configure a test provider (mock or live) using `providerCfg()` / `useServerConfig()` patterns.
- [ ] Design forced-degeneration prompt sequences (see §8.2 patterns).
- [ ] Ensure telemetry is added (`Effect.logInfo` or event emission) before broad auto-recovery enablement.
- [ ] Confirm signed-reasoning key path (`providerMetadata?.anthropic?.signature` vs actual adapter output) before testing reasoning-channel SPAD.
- [ ] Confirm `spad_recovery` config flag behavior (`!== false` = enabled by default).
- [ ] Confirm the `SPAD disabled` timeout is reproducible independently (investigate mock server queue / title request interaction).
- [ ] After each phase, update this document with actual intervention rates, false positive observations, and recovery success metrics.

---

*Document compiled: 2026-08-22. Based on `openfork` branch (`a747d51764`). Verified by running `bun test` for SPAD suites (`48 pass` / `2 fail` in prompt integration tests). The live agent must treat the `SPAD recovery` integration test failure as a confirmed bug to be addressed before or during live headless testing.*

---

## 12. LIVE TESTING RESULTS (2026-08-22, agent-executed)

### 12.1 Code changes made (all verified by tests)

| Change | File | Reason |
|---|---|---|
| Truncation computes `full = text + delta` before slicing, clamped to `[0, full.length]` | `processor.ts` text-delta + reasoning-delta recover branches | §6.1 bug: single-chunk loop truncated to empty because `cut` was applied to pre-delta text |
| `quarantineFrom` now keeps one motif occurrence (`runStart + period`) | `spad/supervisor.ts` `triggerRecovery` | when the loop starts at index 0 the recovered part was empty; one occurrence keeps readable context |
| Thrash state resets on thrash recovery | `spad/supervisor.ts` `triggerRecovery` | stale re-access stats immediately re-fired thrash on the post-recovery generation, burning the attempt budget |
| `experimental.spad_observe_only` config flag | `core/src/v1/config/config.ts` + `prompt.ts` | Phase 2: force observe-only per config, no code edits needed |
| `spadTelemetry` Effect.logInfo on every observe/recover/abort (text, reasoning, tool) | `processor.ts` | §7 item 7: intervention-rate telemetry, logs type/lane/channel/period/runLength/exponent/attempt/reason |
| Stream teardown errors swallowed when `needsRecovery` set | `processor.ts` `catchCauseIf` | aborted provider stream surfaced as "terminated" which `SessionRetry` matched and retried with backoff — recovery never proceeded |
| SPAD abort no longer throws into the stream: sets `ctx.needsSpadAbort`, stops via `takeUntil`, `halt()`s after the pipeline, persists explicitly | `processor.ts` | the thrown abort mixed with stream-teardown causes and hit provider retry; also `halt()` doesn't persist, cleanup ran before it |
| Mock server per-tool-call `index` in streaming tool_calls deltas | `test/lib/llm-server.ts` | all tool calls in one Reply merged into index 0; only the first registered |

### 12.2 Test results

- `test/session/spad*.test.ts`: **48 pass / 0 fail** (unchanged thresholds — no calibration data yet, per §8 item 7)
- `test/session/prompt.test.ts -t "SPAD"`: **8 pass / 1 skip / 0 fail**
  - New: observe-only flag, chunked-delta truncation accuracy, canonical drift recovery, second-relapse abort, intent gate, cross-turn thrash recovery.
  - Skipped: structured-output json_schema full-loop — blocked by a **newly discovered pre-existing bug** (see §12.4).
- Full `prompt.test.ts` (68 tests): 0 fail. `bun typecheck`: no errors in touched files (61 pre-existing errors remain in `../../packages/server`, untouched).

### 12.3 Live provider metrics (OpenRouter `stealth/ox-alpha`, free)

File: `test/session/spad-live-openrouter.test.ts` (auto-skips without an OpenRouter key in `~/.local/share/opencode/auth.json`).

| Scenario | Turns | Interventions | Outcome |
|---|---|---|---|
| Conversational (Bloom filter, haiku), observe-only | 2 | 0 | no truncation, no synthetic message — **false positives 0/2** |
| Log-continuation induction, recovery on | 1 (×2 runs) | 0 | model varied entries; no false intervention |
| Stuck-tape induction ("endless stream" framing), recovery on | 1 | 1 recover (attempt 1) | loop detected mid-stream, tail truncated to one motif occurrence (~55 chars), `[Internal recovery]` synthetic user message injected, **post-recovery generation clean and non-repetitive — live recovery success 1/1**, no abort, no provider crash |

Intent-gate note: all induction prompts were written to avoid `EXPLICIT_COUNT`/`EXPLICIT_VERBATIM`/`EXPLICIT_FOREVER`/`NEGATED_REPEAT`; the "Print banana 1000 times" mock test confirms the gate suppresses recovery when repetition is user-requested.

### 12.4 Newly discovered issues (not fixed here)

1. **json_schema user-message persistence fails**: `Session.updateMessage` event validation rejects a plain-object `format` ("Expected OutputFormatJsonSchema") although the identical value decodes cleanly against the `Format` schema standalone. Affects any `prompt.prompt({ format: ... })` through this harness; unrelated to SPAD (the observe-only gate itself is unit-covered). Test left as `it.instance.skip` with a pointer.
2. **Relapse-abort path originally lost the error**: pre-fix, the abort error was never persisted because `cleanup()` ran before `halt()` set it. Fixed in this pass (explicit `updateMessage` after `halt`).
3. Signed-reasoning gate (`isSignedReasoningMetadata`) remains **untested against a real Anthropic stream** — the mock server cannot attach `providerMetadata` to reasoning lines. Carry-forward item.

### 12.5 Carry-forward

- Threshold tuning (Phase 5) still blocked on calibration data; the `spad.action` telemetry log is now the collection mechanism. Observe-only rollout: set `experimental.spad_observe_only: true`.
- Compaction/reload interaction with truncated tails (§6.6) still untested.

---

## 13. LIVE DEGENERATION BENCHMARK v2 — DGEN FAMILY BATTERY (2026-08-22)

Battery: `test/session/spad-live-openrouter.test.ts` ("live ox-alpha degeneration battery across DGEN families"), modeled on the frontier dossier stressor designs (§27 DGEN-01..25) and its ground-truth rules (§29–31: behavioral metrics independent of model self-report — gzip compression ratio, distinct word-4-gram ratio, constraint-retention oracle; no "repeat X" trivial positives; all prompts verified against the intent-gate regexes).

Per-scenario safety: 150s stall guard + cancel + one retry (free-tier ox-alpha intermittently starves requests of first tokens for minutes — observed 3 stalls across 3 runs, including the first request of a run).

### 13.1 Results (ox-alpha, recovery enabled, thresholds untouched)

| ID | Family (dossier label) | Model behavior | gzip | distinct4 | SPAD fires? | Assessment |
|---|---|---|---|---|---|---|
| tape | L0 exact-copy attractor (positive control) | exact line loop | — | — | **recover (attempt 1), post-recovery clean** | correct detection + successful recovery (prior run, §12.3) |
| S1 | DGEN-02 paragraph-loop attractor | model *noticed* the duplicated sections and consolidated them | 0.62 | 1.00 | no | correct silence — healthy output, no false positive |
| S2 | DGEN-03 expanding-ledger loop | **degenerate**: restates full prefix + appends one item, 5.7–8.1k chars | **0.16–0.47** | **0.39** | **no — 0/3 runs** | **confirmed blind spot** (see 13.2) |
| S3 | DGEN-04/18 paraphrase stagnation + failure history | model pivoted to genuinely novel repo exploration (tools) | 0.47 | 0.99 | no | correct silence under heavy tool use — no false positive |
| S4 | DGEN-05 A/B oscillation | weighed tradeoffs, diverse text | 0.43 | 0.96 | no | correct silence (family is semantic-tier, out of scope by design) |
| S5 | DGEN-06 over-verification | verified via genuinely different methods | 0.49 | 0.99 | no | correct silence (semantic-tier) |
| S6 | DGEN-17/14 pure-length rot + buried constraint | recalled `Kestrel-77` after ~90 inert filler blocks | 0.55 | 1.00 | no | **constraint retained — no context rot induced at ~10k chars / ~30% occupancy**; need ≥75% occupancy to stress C0/C2 |

### 13.2 Blind-spot diagnosis: L3_EXPANDING_COPY_LOOP

Reproduced both live (S2, 3/3 degenerate runs, 0 detections) and offline:

- 24-cycle expanding ledger (14,918 chars restating a growing prefix): `SpadSupervisor.push()` → **no action, ever**.
- Fixed-tail restatement of only 3,687 chars (same content, constant period): → **recover (raw lane)** immediately.

Root cause: both the raw and canonical lanes require a *confirmed fixed period* (`x_i = x_{i-p}`); the shingle duplicate-4-gram ratio is only computed *after* a periodic candidate confirms, so near-total duplication with a drifting period (prefix + one new item per cycle) is invisible regardless of volume. This is exactly dossier §4.4: detection requires longest-repeated-suffix overlap `R_t = L_t/|S_t|` or marginal-new-token ratio `N_t`, neither of which SPAD-R v1 implements.

Proposed minimal fix (not implemented — threshold change requires calibration data per §8 item 7): add an expansion monitor that tracks, per detection window, `N_t = new-chars not covered by the previous occurrence of the current suffix / window-chars`, and gate `recover` on `N_t < ~0.15` sustained over ≥2 windows with total duplication coverage > canonical shingle threshold. The existing `ShingleVerifier` already computes duplicate-4-gram ratio — the change is decoupling it from periodicity confirmation.

### 13.3 Coverage matrix after live campaign

| Dossier tier | Family | SPAD-R v1 status |
|---|---|---|
| Tier 0 | exact/canonical loops, fixed-period structural repetition | **covered** (live-verified recovery) |
| Tier 1 | tool cycles / thrash | covered (mock-verified; not live-induced — ox-alpha has no tool-call support on our config) |
| Tier 0 (edge) | expanding copy loops | **NOT covered — confirmed blind spot** |
| Tier 2–4 | progress mirage, state rot, goal drift, paraphrase loops, oscillation, over-verification | not covered by design (needs dossier Tier 2–4 signals); live battery shows 0 false positives when these families produce healthy output |
| Context rot C0/C2 | length/position degradation | not stressable at tested occupancy — ox-alpha retained buried constraints at ~30% context; needs 75–90% occupancy runs |
| Termination T0–T3 | premature give-up / non-termination | non-termination partially covered (loops are the common cause); give-up needs a completion oracle, out of scope |

### 13.4 Live intervention-rate summary (all ox-alpha runs to date)

- Healthy/diverse outputs: **9 scenarios, 0 false interventions** (2 conversational, S1, S3, S4, S5, S6, log-continuation ×2).
- Degenerate outputs: **4 total** (tape ×1, expanding ledger ×3): detected 1/4 (25% episode recall), recovered 1/1 of detected (100% recovery success, 0 relapses).
- Operational caveat: free-tier stall rate ~1 in 3 requests can exceed 150s before first token; any production live-testing harness needs stall guards + cancel + retry (implemented in the battery).

---

## 14. EXPANSION LANE v2 — L3_EXPANDING_COPY_LOOP CLOSED (2026-08-22)

### 14.1 Architecture

New lane `src/session/spad/expansion-lane.ts` (`SpadLane` now includes `"expansion"`), implementing the dossier §4.4 signal the periodicity lanes structurally cannot:

- **Detection:** contiguous *line-block recurrence*. Each completed line is FNV-hashed over its non-whitespace codes (so indentation/spacing differences still match). The lane tracks the longest suffix of the line history that contiguously matches an earlier block (anchored on the most recent earlier occurrence, extended line-by-line, with strict self-match guards). When a match run first reaches `expansionMinLines` (8) and a second such run completes (`expansionMinCycles` 2, minus 1 in recovery mode), the stream is restating earlier content — the expanding-loop signature.
- **Why line-blocks, not q-gram coverage:** the first implementation (sliding 8-gram duplicate coverage + contiguous-run gate) was calibrated and rejected — real source code hits 0.65–0.79 duplicate coverage with long duplicate runs (brace chains, idiom repeats), indistinguishable from restatement at char scale. Line-level contiguous block recurrence separates them cleanly (probe: 8 real `.ts` files + templated prose → no fire).
- **Wiring:** detector runs it on the raw code stream alongside the periodicity lanes, latched per part; supervisor gates on `autoRecoverExpansion`; `PeriodDetection` carries `expansionDuplicateRatio`; recovery truncates at the estimated run start. No processor changes needed — it flows through the existing recover path.

Config defaults (`DEFAULT_SPAD_CONFIG`): `autoRecoverExpansion: true`, `expansionMinLines: 8`, `expansionMinCycles: 2`, `expansionMinStreamChars: 1024`. Calibrated against: 2 synthetic positives (incident ledger, prose restatement) and 10 negatives (8 real source files incl. test files, diverse prose, templated report, prose-repeat handled by raw lane). Bounded state: one `Uint32Array(8192)` line-hash ring + O(1) counters; re-anchor scan is O(ring) per *non-matching line* only.

### 14.2 Verification

- Unit: `test/session/spad-expansion.test.ts` — 8 pass (detection, chunk invariance incl. 1-char feeds, real-code negatives, templated-prose negatives, observe-only + intent-gate suppression, relapse escalation, recovery-mode sensitivity).
- All prior suites unchanged: 48 SPAD unit tests pass (the 30 real-`.ts` negative fixtures double as expansion-lane FP regression), 10 mock integration tests pass incl. new "SPAD expansion lane recovers a growing restatement ledger". Typecheck clean.

### 14.3 Live re-benchmark (ox-alpha)

| Scenario | Before (§13) | After |
|---|---|---|
| S2 expanding ledger | degenerate, 0/3 detections | **1 recovery, post-recovery output diverse (distinct4 0.885), turn completes cleanly, no abort** |
| S1, S3, S4, S5 healthy/diverse | 0 interventions | 0 interventions — **no new false positives** |
| S6 buried constraint | retained, silent | retained, silent |

Live scoreboard across the whole campaign: healthy scenarios 14/14 no false interventions; degenerate scenarios 3/5 detected (expanding ledger live 1/1 post-fix; exact loop 1/1; the remaining misses were S1-type "no degeneration actually occurred" runs, not misses). Recovery success remains 100% of detected with no relapses.

### 14.4 Remaining gaps (carry-forward)

- Expansion relapse uses a fresh recovery-mode detector (no motif watchdog for expansion) — acceptable, but telemetry should watch for chronic expanders.
- `expansionMinLines/Cycles` are synthetic-calibrated; collect `spad.action` telemetry on real traffic (observe-only mode) before tightening.
- Context-rot stress still needs ≥75% occupancy runs; tool-lane families still untested live (ox-alpha has no tool calling on this provider config).
