# OpenFork Prompt Autocorrection — Implementation Ledger
Date: 2026-10-10
Checkout: C:\Users\slooshied\WebstormProjects\opencode
Companions:
- docs/plans/prompt-autocorrection-architecture-2026-10-10.md
- docs/plans/prompt-autocorrection-harness-architecture-v2-2026-10-10.md

## Status
Opt-in first-party composer implementation exists in the checkout. Feature is **off by default**. First-party Chromium request-admission, settings persistence, keyboard-triggered exact send, failed-send original restoration, and Goal-objective parity have passing browser evidence. **Not certified:** full production desktop/PWA behavior, provider-visible post-plugin parity, representative false-positive rates, or coding-agent outcome uplift. Many unrelated files in the checkout are concurrently modified by other work: do not reset/restore their changes or commit a wholesale worktree diff.

## Implemented source changes (local checkout, not published)
- packages/app/src/components/prompt-input/correction.ts
  - 40-ish curated, versioned misspelling rules (not a full spellchecker), with dangerous ambiguous terms such as gaol explicitly excluded.
  - Conservative code-fence/inline-code/literal/path/URL/command protection, source-part topology and UTF-16 offset validation.
  - Deterministic immutable text patching, preserving file/agent/tool/skill/external-path parts and images. Fails open on invalid bounds.
  - Strict prompt-size and patch-count ceilings; no LLM provider, network, subprocess, or new package dependency.
  - Avoids inherited JavaScript Object.prototype dictionary keys.
  - Title-case corrections limited to beginning of prompt/line; uncertain names preserved.
- packages/app/src/components/prompt-input/submit.ts
  - First-party caller can explicitly supply correctBeforeSubmit accessor, absent by default for programmatic callers.
  - Stable correction applied immediately after structured draft capture and before downstream Goal/queue/session request construction.
  - Original authored snapshot retained in prompt history and failed-send restoration; same effective snapshot feeds queued drafts, Goal objectives, optimistic message and network request builder.
  - Feedback toast only upon accepted send or queue. Explicit optional skipCorrection argument.
- packages/app/src/components/prompt-input-v2.tsx
  - Opt-in accessor based on General Settings with existing auto-revisor taking priority; revised text bypasses a second correction pass.
  - "Send exactly as written" menu action bypasses both prompt revision and spelling correction.
- packages/app/src/components/prompt-input.tsx
  - Legacy composer opts into the same shared correction implementation behind identical settings.
- packages/app/src/context/settings.tsx and packages/app/src/components/settings-v2/general.tsx
  - Independent persisted General > Safe prompt autocorrection switch; absent means disabled.
- packages/app/src/i18n/en-prompt-revision.ts and packages/app/src/i18n/en-settings-general.ts
  - Localized settings/menu/toast strings.
- benchmarks/prompt-correction.ts
  - Reproducible synthetic warm-path benchmark.

## Source boundaries
- Existing HTML native autocorrect and spellcheck remain unchanged. The first-party normalization only sees the editor snapshot at send time, not keystroke history.
- No server/global plugin hook. OXP, OFXP, ACP, TUI/CLI, agent-generated text, scheduled tasks, browser annotations and direct SDK/API submissions do not implicitly invoke autocorrection.
- Shell mode and slash-leading commands bypass. Pending question response controller bypasses normal submission. Existing Prompt Revisor takes precedence.
- Non-text structured content identity, paths, file selections and images must remain unchanged; only plain-text part contents are eligible.
- A later plugin could still mutate persisted/model-facing text. Do not claim end-to-end provider-visible fidelity without dedicated downstream instrumentation.

## Observed verification
Command from packages/app:
\`bun test --conditions=solid --preload ./happydom.ts ./src/components/prompt-input/correction.test.ts ./src/components/prompt-input/correction.integration.test.ts\`
- PASS: 15 tests, 8,491 assertions (2026-10-10), including 400 deterministic fuzz rounds over random part splits and typed references.
- PASS: correction -> buildRequestParts -> optimistic message equality and shifted file mention offsets.
- PASS: malformed ranges, repeated correction/idempotency, skip conditions, unclosed fences, quote/code preservation, Unicode astral offsets and image identity.
- Typechecking \`bunx tsgo -p tsconfig.json --noEmit\` was green on an earlier pass after initial integration; a subsequent run reported unrelated concurrent errors in \`settings-v2/telegram.tsx\`: \`TelegramHubStatus.subscriptions\` missing and \`sub\` implicit any. A final independent rerun subsequently passed with no TypeScript errors (the Telegram work was concurrently updated).
- Existing \`submit.test.ts\` could not execute in this run because its Bun/Solid JSX runtime reported \`Export named 'jsxDEV' not found in module solid-js/dist/solid.js\`. The direct send-flow E2E certification remains pending.
- Targeted \`git diff --check\` for the touched pre-existing app files passed during implementation.

## Observed microbenchmark
Run: \`bun benchmarks/prompt-correction.ts\`
- Windows checkout, Bun 1.4.3, synthetic warm path.
- Latest 1,000 chars, 3,000 iterations: median 0.0480 ms, p95 0.0739 ms, p99 0.1024 ms; two corrections per sample.
- Latest 10,000 chars, 1,000 iterations: median 0.4480 ms, p95 0.6552 ms, p99 3.6909 ms; two corrections per sample.
- An earlier run showed p95 0.1264 ms (1k) and 1.7543 ms (10k). Variation is expected in short microbenchmarks; these are not cold-start or browser p95 guarantees.
- Not production workload percentiles, confidence intervals, browser rendering/UI latency, agent throughput, or proof of improved model correctness.
- Zero provider/network calls by implementation inspection (no dynamic API invocation in correction engine).

## Risks requiring follow-through
1. Core **first-party composer → API request** Chromium E2E is now certified for opt-in correction, default off, user dictionary/exclusions and send-exact. Broader lifecycle remains **uncertified**: queued turn, worktree creation, Goal objective, failure restoration, replay and Prompt Revisor precedence.
2. Accuracy and coverage: no held-out representative clean/noisy corpus yet. Do not enable default-on solely due to a dozen local tests; prioritize false positive rates in technical language.
3. Native OS/browser replacement may occur *before* this engine sees editor content; desktop/macOS/Linux/mobile behavior requires explicit comparative tests.
4. Lexical protector is conservative and intentionally incomplete for arbitrary programming languages, markup and quotation syntax. It should abstain if unsafe. No security/prompt-injection defense claim.
5. User-specific Ignore and explicitly approved word-pair rules are now implemented in General Settings, with safety vetoes and caps. Per-project scope, suggestion review, and audited rule editing are **not** implemented. Valid real-word "gaol" is not globally changed; only a personal, opt-in exact mapping can change it.
6. No provider-visible post-plugin provenance trace has been added.
7. Dictionary version currently a constant; updated rules need fixture review plus release/build version bump. No plugin-managed dictionary packs.
8. The Send exactly as written rising-tab button was clicked successfully in Chromium using the exposed tab and its pointer-visible geometry; keyboard-only accessibility still needs a focused test.
9. Long untrusted text/pasted logs are not processed above 20k UTF-16 code units. This is a deliberate hard safety/performance ceiling, not a coverage bug.
10. Browser-side safe autocorrection is not a generic V1 Session runtime admission hook. A future host-side feature requires trusted source classification and owner-side durable idempotency.

## Next validation gates
- Monitor whole-app TypeScript while independent changes land. The latest \`tsgo\` run was green.
- Establish Bun JSX runtime test setup or browser-based E2E for existing \`submit.test.ts\` (avoid invasive changes to unrelated test infrastructure).
- Extend detached-snapshot coverage to full asynchronous worktree/queue/retry lifecycle. Pure snapshot integrity against later editing and file selection mutation is now tested.
- First-party Chromium UI and API-admission checks completed (5/5). Expand to desktop shell/PWA devices, keyboard-only send-exact action, queued/Goal/revisor and failure restoration.
- Extend negative corpus with unusual project identifiers, chemistry names, technical logs, RTL/IME, and real user input after explicit review.
- Paired code-agent evaluation on identical repos and model settings: clean vs noisy vs safe-normalized vs existing Prompt Revisor with objective tests and token/cost reports.
- Follow bench improvements if genuine p95 regression and report actual low-overhead opt-in adoption.

## Closeout honesty
This phase creates and wires a usable *opt-in* implementation, rather than only a design. It does NOT establish statistically calibrated precision, full UI certification, or guaranteed downstream coding-agent gains.

## October 10 continuation — integration and hardening
- Added a pure `packages/app/src/context/prompt-snapshot.ts` that detaches the composer draft and mutable typed reference metadata (including file selection/source and image blob descriptors) before any asynchronous session/worktree setup. The existing prompt-state clone path now reuses the shared snapshot helper; no renderer-to-Core implementation dependency added.
- Explicit `shouldCorrectPromptSubmission` admission gate: opt-in first-party ordinary-language prompts only. Shell, command, revision, exact-send override, and delegated human-interjection paths remain excluded.
- Added English-locale gating; non-English UI locales bypass this English-only dictionary.
- Expanded protected syntax/negative fixtures: YAML/TOML/JSON, Markdown tables, fenced and unterminated code, shell/log lines, punctuation, URL and markdown destinations, Unicode identifier boundaries, unseen directional/zero-width control characters, quoted and Unicode-delimited literals.
- Added two opt-in Settings rows: **Never autocorrect these words** and **Personal spelling corrections** (e.g. `gaol=goal`). Personal rules are restricted to exact alphabetic word pairs, length/cap constraints, and protected-span/polarity vetoes. Exclusions take precedence. No automatic word learning.
- Added a frozen-send race/structured-reference test verifying that edits to the live composer and file selection after snapshot capture cannot change the already captured payload.
- Latest focused checks after interval linearization: `27 pass, 0 fail`, `11,049 assertions`; `bunx tsgo -p tsconfig.json --noEmit` exit 0; targeted `git diff --check` exit 0.
- The Chromium E2E suite is **enabled and passes 5/5** on a fresh isolated-port Vite server. Earlier unexplained failed or inconclusive runs were confounded by reuse of an already-running Vite server: do not trust a local run against a different code revision. Add `PLAYWRIGHT_REUSE_EXISTING_SERVER=0` and an unused `PLAYWRIGHT_PORT` for deterministic local runs. An explicit `Playwright` config escape hatch has been added without changing CI behavior. The checks cover correction, unchanged default, custom/excluded dictionary precedence, send-exact UI, and General Settings persistence after reload.
- Rising send-menu geometry is verified by Chromium after hovering its group and clicking its exposed tab area; the exact-text submission network request passed. Keyboard-only navigation is still untested. The added Settings E2E exposed the mock missing `/pty/shells` and a real potential crash on non-array shell list responses; mock now returns `[]`, and the controller validates `Array.isArray` before presenting options.
- Existing Bun/Solid JSX tests (`submit.test.ts`, `prompt-state.test.ts`) still fail to load due the JSX runtime named export (`jsxDEV`/`jsx`) mismatch. Their failure is not evidence about the pure engine.
- All temporary source instrumentation (`prompt-correction-debug` and `prompt-composer-action`) was removed before closeout. Keep input bodies out of general telemetry.
- Status: **opt-in local implementation hardening + five first-party Chromium E2E checks accomplished**. Still open: post-plugin/provider-visible truth, production desktop shell/PWA, coding-agent paired outcomes, multi-session lifecycle/Goal/revision, and precision calibration.

## Second continuation — browser cert, complexity and repeatable benchmarks
- Definitive stale-Vite cause eliminated: the browser E2E test invokes an isolated Vite server rather than reusing whatever port 3000 happens to serve. `PLAYWRIGHT_REUSE_EXISTING_SERVER=0` is a supported, opt-in local harness switch. On an isolated port the **four original Chromium scenarios passed immediately**, showing that previous inconsistent results were harness contamination, not a confirmed product bug.
- Added and passed the **fifth Chromium scenario** for General Settings toggle, exact ignore list, personal pairs and persistence across full page reload. Modern OpenFork navigates to a Settings tab instead of the deprecated Settings dialog, so the test uses the General tabpanel and Back-to-app control.
- The new settings route first revealed a `createShellOptions` crash from the generic V1 mock returning `{}` for the shells endpoint. The shared Playwright mock now correctly answers `GET /pty/shells` with `[]`; production `createShellSettingsController` also defensively validates `Array.isArray(result)` before rendering options.
- Expanded the regex-offset property coverage to **27 passing focused tests, 11,049 assertions**, including 1,000 interleaved quoted literals and 840 structured prompt parts with 60 corrections. The dictionary engine now sorts/merges overlapping protected intervals and scans text/protected ranges with monotonic cursors. Application and E2E TypeScript checks passed.
- Replaced the single-shape benchmark with four checked-output cases at `benchmarks/prompt-correction.ts`; the assertions guarantee the optimizer did not improve throughput by dropping patches. Latest warm synthetic single-thread measurements:

| Workload | p50 | p95 | p99 |
| --- | ---: | ---: | ---: |
| 1,000 characters, two patches | 0.0337 ms | 0.0613 ms | 0.0801 ms |
| 10,000 characters, two patches | 0.3227 ms | 0.5544 ms | 2.4202 ms |
| 12,080 characters, 1,000 quoted spans, 120 patches | 0.7482 ms | 1.8399 ms | 2.2410 ms |
| 6,000 characters, 840 parts, 60 patches | 0.4226 ms | 1.2543 ms | 3.3782 ms |

- The full five-scenario Chromium suite was re-run after the engine's interval-index refactor and passed: **5/5** (34.7 seconds inclusive of browser boot, navigation and dev-server startup; **not** a prompt-send latency benchmark).
- Added accessible labels to personal spelling and ignored-word settings fields.
- Targeted `git diff --check` passed; `oxlint` on new autocorrection files reported **0 errors, 28 warnings** (mostly unnecessary assertion/style warnings in new tests and engine). Do not call this lint-clean yet.
- These checks do not provide a calibrated real-world false-positive rate, editor-native IME parity, plugin-mutated provider-visible payload proof, or a causally measured agent-success uplift.

## Third continuation — failure recovery, Goal ordering, and corpus evidence

### New live integration cases
- General Chromium suite now **9/9 green** on a fresh dev server (`PLAYWRIGHT_PORT=11751`, `PLAYWRIGHT_REUSE_EXISTING_SERVER=0`; ~47 seconds inclusive of setup). New cases establish:
  1. protected inline code, quoted literals, filesystem paths and CLI switches are preserved at the outgoing request boundary;
  2. slash commands pass through the first-party composer unmodified;
  3. a synthetic HTTP 500 during prompt admission restores the **original authored** draft, not the corrected text;
  4. Send exactly as written can also be **keyboard-activated once its trigger is focused**. This is not a complete Tab-sequence accessibility certification.
- Added one independent first-party **Goal Mode Chromium E2E** to `e2e/regression/goal-mode-lifecycle.spec.ts`: opt-in typo correction is reflected **identically** in the prepared durable Goal objective and outgoing worker request, while verifying `goal.prepare` precedes `worker.prompt`. This test **passed 1/1** against an isolated server, after the fixture correctly distinguished missing usage-limit recovery state (`null`) and successful permission-policy sync. It does not prove an LLM provider's post-plugin input is identical.
- Existing Goal Mode cases are unchanged behaviorally; the shared helper accepts an optional `settingsGeneral` and `normalAdmission` fixture setup, so tests can explicitly opt into the corrected-prompt contract.
- `createPromptSubmissionState` continues to restore the captured authored prompt on failure, and corrected content is not persisted over the original history source.
- The old `followup=queue` preference currently normalizes to `steer` in settings, so queue-submit certification would exercise an intentionally disabled legacy branch. No claim of queued-turn proof is made.

### Source-level regression and runtime
- New small, explicitly synthetic `correction.corpus.test.ts`: 40 correctly spelled technical prompts plus 19 known typo examples, one personal-map quoted-literal case. These are engineering fixtures **not sampled production data** and cannot support statistical false-positive claims.
- Final local pure-engine suite: **88 tests passed, 0 failed, 11,111 assertions** across three files; covers UTF-16 structured-offset and image identity, random boundaries, malformed syntax, 840 structured prompt parts, 1,000 quoted spans, linear cursor mapping, and capitalized line-start typos.
- Removed a quadratic title-case prefix scan: capitalization safety now uses a cursor tracking current line boundaries rather than slicing the prompt from the beginning for each candidate. All targeted tests remain green.
- `bunx tsgo -p tsconfig.json --noEmit` and `bunx tsgo -p e2e/tsconfig.json --noEmit` both returned exit 0. Whitespace-diff validation passed on changed existing files.
- Final targeted `oxlint` on the new correction engine, precision corpus, unit tests, source-snapshot module, and browser spec is **0 warnings / 0 errors**. Scoped source assertions and Unicode boundary protections were corrected without weakening the tests; this does **not** claim full-repository lint cleanliness.
- Repeated microbenchmarks vary under concurrent Playwright and TS compilations. One concurrent run measured p95 **0.1074 ms at 1k** and **0.696 ms at 10k**; representative runtime latency requires isolated, repeated workstation benchmarking. Don't compare adjacent measurements as causal throughput gains.

### Unresolved/explicitly not certified
- A **provider-visible post-plugin** digest or trace; the Playwright suite only inspects the first-party outbound HTTP admission payload and local Goal prepare request.
- End-to-end desktop Electron/webview and iOS/Android/PWA native autocorrect / IME behavior; production default-on policy; representative field precision / clean-text regressions; paired coding-agent outcomes and compute cost.
- Prompt Revisor model-powered ordering, recovery after revisions and true multi-session/worktree stress.
- Legacy `submit.test.ts` and related Solid JSX Bun tests remain blocked by the existing Bun JSX automatic-runtime import mismatch (`jsxDEV`); the new pure and browser suites do not depend on this issue.

**Final validation after last source changes:** deterministic correctness **88/88 tests, 11,111 assertions**; fresh-server Chromium composer **9/9**, fresh-server Goal-mode parity **1/1**; application + E2E TypeScript passed, scoped oxlint **0 warnings / 0 errors**, targeted existing-file Git whitespace validation exit 0. A refactor momentarily regressed the Unicode-adjacent identifier guard; an existing negative test caught it, the guard was restored, and all checks above were rerun after the fix. Last Chromium runs are against the restored source revision.

**Current disposition:** opt-in, locally deterministic implementation with a tested direct-submission and Goal-mode browser boundary. Do not widen origin scope or enable by default until remaining validation gates are met.

## Fourth continuation — no-inference precision and performance

The following work was performed using **only** local source editing, deterministic test execution and mocked transport/browser fixtures. **No model inference or external provider requests were made.**

### Architecture decisions (process of elimination)

| Choice | Rationale and guardrail |
| --- | --- |
| Cheap deterministic typo candidate filter **before** syntax protection | Most prompts contain no known mistake. Validation still precedes the shortcut, and the conservative substring filter cannot skip an otherwise-correctable built-in or valid personal rule. |
| Keep all correction in the opt-in first-party composer | Prevent changes to API callers, tools, agent-written worker prompts, shell commands, or delegated-human-interjection messages. No broad mutable runtime hook. |
| Strict literal protection, no fuzzy matching | Source code, exact quotes, URLs and structured reference identities outrank a speculative spelling improvement. Abstain rather than guess. |
| Preserve the original authored draft | History, failed-admission restoration, manual send-exact, and explicit opt-out remain possible. |
| One-pass reconstruction of corrected spans | Replaces repeated per-patch full-string rebuilding with a forward scan and one join; rejects stale/overlapping spans atomically. |
| Bounded inputs and edits | At most 20,000 visible UTF-16 code units, 4,096 parts and 128 corrections. Oversized/ambiguous drafts are passed through without mutation. |
| Personal rules remain exact and safety-vetoed | No automatic learning. Disallow substitutions whose source or target is an action/permission/polarity-critical verb such as approve/reject, permit/forbid, execute/stop or public/private. |

### Bugs and edge cases repaired

1. An unclosed **single-quoted literal** could be mistaken for ordinary prose; quote handling now distinguishes contractions from delimiters and protects incomplete quotes to the line end.
2. An apparent typo used as a **function call** (e.g. `contienu()`) previously became a renamed identifier. Call syntax is now protected while natural-language `contienu (later)` remains eligible.
3. Standalone carriage returns do not match the Markdown line grammar. The engine explicitly **abstains** on these ambiguous line breaks while continuing to handle CRLF correctly.
4. The corrected draft's embedded `file.source.text` metadata previously retained **stale original UTF-16 offsets**, even though `buildRequestParts` later reconstructed correct network offsets. This was reproduced by a failing regression, then repaired by immutably rewriting the embedded source's value/start/end along with the shifted part.
5. Inputs exceeding the bounds now bypass **before** allocation of a concatenated prompt, preventing needless processing of oversized pasted drafts.
6. If there is no typo candidate in any editable text part, the engine exits before scanning dozens of protected syntax patterns. Typos occurring only in structured agent/file tokens do not trigger correction.

### Verification evidence
- Deterministic engine, corpus and integration tests: **94 passed, 0 failed, 11,128 assertions**.
- The newly created negative and boundary tests cover function-call symbols, contractions and unmatched single quotes, lone CR vs CRLF, excessive part topology, invalid spans in otherwise clean text, purely structured typo names, and file-source metadata synchronization.
- Scoped oxlint: **0 warnings / 0 errors** on correction engine, corpus, unit and integration tests.
- Latest app and E2E `tsgo`: both exited **0** (source checkout has other concurrent work; repeat if it changes).
- First-party Chromium tests use a freshly launched local Vite server and **mocked HTTP**: 9 composer cases and 1 Goal-mode objective/request parity case have passed after the core changes. Browser coverage does not imply actual provider/model execution.

### Measured warm synthetic optimization (not end-user latency)

A 10,000-character, typo-free prompt measured median **0.3631 ms** before the candidate shortcut and **0.0449 ms** afterward (approximately **8.1×**; two single-thread synthetic runs, not an A/B device trial). A later run measured **0.0428 ms** median. These figures are not a statistically controlled production benchmark; CPU contention and background dev-server tasks change tail latencies. The one-pass patch path further reduces unnecessary copying on dense typo workloads, but the existing run-to-run variation precludes precise causal attribution of an isolated percentage.

### Explicitly deferred
- No LLM evaluator, provider rewriting, inference fallback, grammar paraphraser, telemetry of user prompts or server-side mutation path.
- No globally enabled autocorrect; retain the Settings opt-in, per-word exclusions, personal exact mappings and one-shot exact send.
- Future possible deterministic improvements: preview/approve individual patches before send, independent source-parsed syntax masks for large code snippets, per-project **user-managed** glossaries, granular opt-out surfaces, and standardized precision/recovery/fidelity gates. All require opt-in UI and negative regression proofs before activation.

## Fifth continuation — immutable image admission, linear Markdown scanning, shared rule policy

This continuation explicitly **made no LLM/model inference calls**. All tests use local deterministic functions or mocked HTTP.

### Implemented changes
- **Single snapshot for image and text:** `createPromptSubmit` now derives its image descriptors using `draftImages(submission.prompt)`, the same immutable captured draft used by text, file metadata and the Goal objective. Previously it independently read `input.imageAttachments().slice()` from a live composer accessor. Removed the now redundant `PromptSubmitInput.imageAttachments` argument from the legacy and V2 composer adapters and the twelve affected mock callsites; UI attachment previews still use their existing reactive memo.
- New integration regression mutates and removes the original live image, plus changes its nested `blob.id` and `blob.url`, after the snapshot. Verified the corrected outgoing draft continues referencing the original filename, MIME and immutable blob descriptor.
- **Linear Markdown-link protection:** replaced the suffix-backtracking `/\\[[^\\]\\n]+\\]\\([^)]+\\)/g` regex with a stateful `protectMarkdownLinks()` forward scanner, including conservative masking of malformed/unterminated destinations and nested link labels. Added two correctness tests for valid and invalid links and repeated unmatched Markdown syntax.
- A synthetic adversarial one-off probe of 12,009 characters with unmatched `[` openers took **38.127 ms before** and **2.151 ms after** the scanner change. This is an observed single-run reduction (approximately 17.7×), **not a controlled performance claim**. The repeatable `benchmarks/prompt-correction-adversarial.ts` runs 121 warm iterations per workload with checked expected patch counts. The same class of input measured **p50 0.0773 ms, p95 0.1275 ms**, and malformed label fragments measured **p50 1.1542 ms, p95 2.6426 ms**. All runs are synthetic and CPU-load-dependent.
- **Canonical personal-rule policy:** added `src/utils/prompt-correction-policy.ts` with `normalizePromptCorrectionRule` and `normalizePromptCorrectionRules`. Both Settings and the runtime engine use the same source/destination limits and protected-action word veto. Settings now refuses to persist forbidden custom rules (e.g. `approve=reject`, `public=private`), and normalizes older persisted rule maps before displaying or applying them. Updated the Settings description to make these restrictions explicit.
- New pure policy regression cases cover canonical lowercasing, malformed/oversized rule pairs, negation, permissions, dangerous verbs, and stale persisted maps. The settings Playwright scenario now verifies invalid pair rejection while retaining a legitimate `gaol=goal` mapping.

### Latest deterministic certification (post-shared-policy revision)
- **101 pass, 0 fail, 11,167 assertions** across four focused files (including image mutation, Markdown scanner and policy tests).
- Targeted oxlint for engine, policy, unit/integration and browser spec: **zero warnings / zero errors**. Application and browser-test TypeScript projects: **both exit 0**.
- Browser suites are local mock-HTTP tests, **not** provider-visible instruction verification. Neither an LLM nor an inference SDK was invoked.

### Remaining gates
- Before default enablement: representative real technical-corpus precision, full upstream/downstream provider-visible trace after plugin transformations, external desktop/PWA/IME testing, and repeated Prompt Revisor/Goal/busy-session lifecycle coverage.
- For the UI: design a compact before-send review for patch-heavy prompts and an accessible per-rule rejection explanation. The existing Send exactly as written option remains the non-inference escape hatch.
- **Final post-change Chromium confirmation:** V2 composer **9/9 passed** and Goal objective/request parity **1/1 passed**, both on clean isolated Vite instances (`PLAYWRIGHT_REUSE_EXISTING_SERVER=0`). The Settings case includes rejecting forbidden custom rules while retaining `gaol=goal` across reload.
- Final application and E2E TypeScript projects exited **0**; targeted Git whitespace validation exited **0**. The 101-test deterministic suite and focused zero-warning lint result reflect the shared-policy revision. No remote provider or inference was used.

## Sixth continuation — optional review, selective acceptance and admission safeguards

**Principle:** local deterministic spelling assistance must not silently transform developer instructions, project identifiers or typed references. Preserve opt-in, explicit individual control, source snapshot immutability, bounded on-demand work and an always-available exact-send escape hatch. No model inference, external provider request or new package dependency was used.

### Implemented user experience
- New `components/dialog-prompt-correction-review.tsx`: compact, scroll-bounded V2 dialog, launched explicitly from the **existing** send-options menu; it does not create another permanent sidebar or instrument keystrokes. Proposed corrections are listed by exact original/replacement spelling and source (known-typo vs personal rule).
- Each correction has an accessible checkbox. **All/None** controls and a live selected count allow a user to approve only some positions; Send selected is disabled when zero are selected. Exact send and Cancel are always available. This intentionally does **not** persist a one-time rejection as a global word exclusion.
- If the draft is correctly spelled, review presents a simple no-change state and permits only exact send. If a command, unsupported locale, oversized draft or protected syntax triggers engine bypass, it instead explains that the draft cannot be corrected and will be sent exactly as written. It does not falsely report a clean spelling result.
- Correction reviews are unavailable during automatic Prompt Revisor ownership, pending questions, recovery-required state, shell mode or delegated human interjections. Prompt Revisor's ordinary lifecycle remains authoritative; review never invokes an LLM.
- The send-options tooltip content now ignores pointer events, removing an observed browser click-interception source when reopening menus after dismissing review.

### Atomicity and correctness
- New `components/prompt-input/correction-review.ts` owns a pure, local `promptCorrectionReviewFingerprint` covering captured content/reference metadata/image blob descriptors, context comments, session/directory, model/provider/variant, language locale and dictionary settings. A cyclic or unreadable restored draft fails closed (`undefined`).
- On explicit send from review, the controller checks the current fingerprint and all eligibility gates **synchronously before** entering the existing submission path. If they differ, it closes review without submitting and requests a fresh review. A changed context or attachment therefore cannot silently piggyback on stale approval.
- The correction engine accepts an optional set of **original UTF-16 patch start offsets**. Unapproved patches are never applied. Accepted patches retain original ordering and pass through the existing single-pass reconstruction/remapping. The normal default path remains unchanged and incurs no review fingerprint calculation.
- `submit.ts` passes the one-time selected patch starts to `correctPromptParts`. This uses the same immutable snapshot for queue/Goal/request construction and original authored history/failure restoration, rather than replacing the editor with an intermediate selected revision.
- Context snapshots, reference offsets and original images are preserved, including when only an earlier correction is accepted. No additional memory of the user's prompt or remote telemetry is created.

### Reproduced tests and evidence
- Pure deterministic suite: **108 tests passed, 0 failed, 11,194 assertions** across the correction, structured integration, seed corpus, shared policy and review-fingerprint files.
- Chromium first-party composer: **16/16 passed** on freshly launched Vite server, including partial selection, All/None behavior, approved send, exact send, cancel, keyboard Escape, clean-draft and protected-command states, Settings persistence, error restoration after a **partial** correction admission and unmodified quoted literals.
- Existing Goal objective/outgoing worker parity test: **1/1 passed**, proving its mock first-party HTTP request and Goal prepare order remain compatible with changes to submission options. These are *mocked browser boundaries*, not proof of provider-visible plugin-transformed payload fidelity.
- App and E2E TypeScript checks: exit **0**. Targeted engine, review module, dialog and integration oxlint: **0 warnings / 0 errors**. Targeted `git diff --check` on tracked integration files: exit **0**.
- Repeatable `benchmarks/prompt-correction.ts` now covers selectively approved 10k prose and dense-quotation cases as well as ordinary/full/clean workloads. Latest local synthetic p50: 10k full **0.3983 ms**, 10k first correction only **0.3961 ms**, 10k typo-free **0.0444 ms**; dense 12k full **0.8004 ms**, selected single **0.6473 ms**. Measurements reflect parser/remapper CPU only; not interactive or provider latency; sequential samples vary with workstation contention.
- `benchmarks/prompt-correction-adversarial.ts` still passes its checked mask/grammar cases (most recent unmatched-bracket p50 **0.076 ms**). These figures are not statistically controlled production speedups.

### Still to certify
- Post-plugin/provider-visible message content, Prompt Revisor model-generated path and genuine concurrent-session collision behavior; browser and pure harness checks do not prove these.
- Representative real-world precision/false positives across technical prompts, real native desktop/PWA touch and IME operation, external-device accessibility and large-workspace stress. Test the stale modal case under actual cross-tab/draft switch, not merely pure fingerprint mutation.
- Before wider enablement, review localization beyond the English fallback and conduct actual accessibility audit (focus order, screen readers, zoom/high contrast), plus authenticated provider-level telemetry-free acceptance trials.

**Disposition:** Opt-in and default-off. All changes remain local/uncommitted; no unrelated checkout files should be reset or mass-committed.

## Seventh continuation — Harper-powered inline writing assistance

### Decision

**Do not use Grammarly as a server-backed integration and do not invoke an LLM to revise typed prompts.** Add a completely separate, independently opt-in Harper spelling/grammar service. Harper is an offline, privacy-first English grammar checker (Apache-2.0); its pinned `harper.js@2.10.0` package includes a local Rust/WASM rules engine. This is not a model inference service. In particular, its output is **advisory**: a human must explicitly select a suggested change. Ordinary sends never await or depend on the grammar worker, and the existing deterministic send-time autocorrection and exact-send review remain independently controlled.

### First-party architecture

- `packages/app/src/components/prompt-input/harper-controller.ts` is a Solid lifecycle adapter: loads only with `settings.general.promptGrammarHarper() === true`, normal composer mode, English UI locale and no active question/delegated human interjection; debounces authoring by **320 ms** and uses monotonically increasing generations to discard stale lint results; releases the worker lease when disabled or unmounted.
- `harper-worker.ts` owns an explicit singleton/lease-counted worker client (startup timeout 12s, request timeout 12s, bounded returned issue count 32, clean termination and errors). `harper-dedicated.worker.ts` runs Harper's `LocalLinter` inside an actual Vite module **Web Worker**, so WASM compilation and grammar rules do not block contenteditable input/main-thread rendering. Worker receives only sanitized authored text. Neither a provider nor external Harper API is contacted. No prompt text enters logs or telemetry.
- Production Vite's default Harper `WorkerLinter` blob/bootstrap and original `harper.js/binary` URL did **not** work in this checkout: the former hung and the latter returned HTML (incorrect WASM magic). Replaced with explicit same-origin worker + Vite's separately emitted `.wasm?url`. `bunx vite build` exits **0**; the produced worker is **156,563 bytes** and separately cacheable Harper WASM is **16,164,077 bytes**, compared with **21,552,342-byte** `binaryInlined.js` representation. The WASM is downloaded *only after opt-in*, not on normal app startup. Harper's published package export map does not expose the raw WASM asset, so current deep on-disk `node_modules` asset import is an intentional integration seam requiring validation on dependency/toolchain upgrades.
- `harper-projection.ts` builds a bounded (**8,000 UTF-16 units**) sanitized grammar input by blanking protected code fences, inline code, quoted literals, URLs, command flags, identifiers and non-editable structured mention parts using **shared conservative protection** from `correction.ts`. The original editor is **never** rewritten during linting. Harper's Rust spans are Unicode **scalar** offsets; the projection preserves scalar-to-UTF-16 mapping and rejects any result intersecting a protected span. Applying a chosen suggestion revalidates both source range and protection against the **current** draft and recalculates subsequent mention/file metadata without changing their identities or attachments.
- `packages/session-ui/src/v2/components/prompt-input/writing-highlights.ts` supplies a generic app-independent painter using **CSS Custom Highlight API**. It adds red wavy spelling underlines and blue grammar underlines without wrapping text nodes or mutating DOM, preserving IME composition/caret/mention entities. The painter is unique per mounted composer, schedules paint on animation frames, clears immediately on input, checks rendered text/offset parity and cleans global registry/style on unmount. Only on deliberate pointer interaction does it query Range geometry to open suggestions. Native browser spellcheck remains fallback if CSS Highlights unsupported or Harper isn't ready.
- The shared `packages/session-ui` prompt component accepts an **optional generic** `writingAssistance` prop; no Harper WASM or app contexts leak into the UI package. The current compact popover offers individual replacement buttons, dismiss, explicit local Ignore word action and an issue-count affordance; it has keyboard Escape/outside-click dismissal and no permanent dashboard UI. The app stores a single guarded undo step for a manually applied suggestion; the user can restore original draft text with an Undo control/keyboard shortcut, unless intervening edits invalidate the snapshot.
- General Settings has a **new separate toggle** and user-managed technical-word exceptions (`promptGrammarHarper`, `promptGrammarIgnoredWords`); both default to **off/empty** and persist via existing Settings. The Ignore action only writes an explicit word exception after user choice. The existing `promptAutocorrection` toggle remains distinct and disabled by default, and the private Harper dictionary is not used to silently rewrite a submitted prompt.

### Measured functionality and performance

- Real bundled Harper local smoke probe `packages/app/benchmarks/harper-smoke.ts` (run from `packages/app`) finds English indefinite-article (`a` → `an`), pronoun/verb agreement (`has` → `have`), repeated tokens and misspelled `contienu`/`reasearch`; no AI calls or personal user prompts are involved.
- Synthetic unit tests cover quoted and fenced text masking, URLs, structured mention exclusion, astral emoji offsets, large-input/command abstention, safe text-only explicit fixes and stale protected literal refusal.
- Real Chromium E2E confirms the enabled browser WASM worker detects and visually paints suggestions, clicking an actual squiggle can open the popup without editing the text, clicking an explicit suggestion can update the draft, disabling the setting mounts no Harper worker/highlights, ignored dictionary words suppress spelling alerts while leaving prose unchanged, and the separate setting and exceptions survive a reload.
- Targeted app and session-ui TypeScript checks, targeted lint and production bundling have passed during implementation. Treat these as source-local validation, not evidence that native desktop/mobile, PWA service workers or all browsers are certified.
- The grammar engine is capped at 8k visible units, 32 displayed diagnostics and 320ms idle. These are **performance and fidelity guards**, not claims about universal Harper accuracy. Long prompts outside the cap simply fall back to normal editing/sending.

### Future certification gates

1. Stress and instrument Harper worker cold-start, memory footprint, stale response cancellation and concurrent composer leases on Windows/Tauri and mobile Safari, including offline PWA packaging and CSP.
2. Representative, consented technical prompt corpus for Harper's false-positive rate, protected literals/identifiers, stability across undo and IME, and real-world accept/ignore behavior. Never upload actual user prompt text for this.
3. Full accessibility review (focus return, keyboard selection/escape, screen reader live regions, reduced motion, high contrast), non-English user setting explanation, and documented rules/dialect controls.
4. End-to-end provider-visible post-plugin payload parity and Prompt Revisor/Goal lifecycle checks remain separate original send-time autocorrection gates; browser mock admission does not establish provider semantics.

**Disposition:** Built locally with a passing real browser Harper smoke test and a passing production build. Independent opt-in, English only, no inference calls; local uncommitted checkout. The regression numbers below are confirmed separately in the closing validation run.

## Eighth continuation — bounded latest-wins worker scheduling and exact-draft integrity

### Highest-impact candidate selected

Once Harper was functional, the bottleneck was **in-flight and queued stale work**, not faster spelling-rule logic. The previous 320 ms debounce plus generation checks prevented obsolete issues from *appearing*, but all dispatched requests could still execute inside the shared WASM worker. Rapid typing across many concurrent composers could therefore consume unnecessary background CPU and delay current feedback.

### Architecture implemented

- New pure generic `packages/app/src/components/prompt-input/harper-queue.ts` implements a **global single-flight** queue around the existing same-origin Worker. Each mounted composer receives its own ephemeral `Symbol` owner. At most **one request is physically executing and 12 distinct owners are pending**; a second request for an owner atomically supersedes their previous pending request, including promptly rejecting the old caller.
- When a request is already inside synchronous Harper WASM, JavaScript cannot preempt that calculation safely. The scheduler marks its caller obsolete immediately, does **not** dispatch a newer request until the physical worker has completed that calculation, and then dispatches the latest still-current work. Never claim that in-flight WASM is actually interrupted.
- Overflow discards the oldest waiting job rather than growing an unbounded FIFO; each remaining owner is scheduled in insertion order. Requests begin on a microtask boundary to coalesce synchronous state bursts. Aborted and disposed requests have listeners and prompt references released, while timed-out/dead worker RPCs still fail closed.
- `harper-worker.ts` leases now carry owner identity and a per-request `AbortSignal`; lease release calls `cancelOwner` before decrementing global ownership. The shared worker cannot be torn down while another live composer still owns a lease.
- `harper-controller.ts` creates a scoped abort controller per active draft revision and cancels it on rerun/unmount/disable. `AbortError` is a routine supersession, **not** falsely surfaced to users as Harper initialization failure. Its disabled branch now **does not subscribe to prompt edits or create AbortControllers/dictionaries**; normal opt-out typing has no grammar queue/computation.
- Analysis stores a deterministic local **full-draft identity** from a snapshot of all original parts, including structured mention metadata and image descriptors, and applies an explicit suggestion only when that exact identity still matches. Previous word-only matching could theoretically apply an old correction after reference metadata changed. A cycle/unserializable restored draft fails closed. The same identity secures one-step local Undo and prevents overwriting a changed draft.
- IME composition sends an explicit active/idle signal through the generic session-ui writing-assistance contract; composing immediately removes Harper's CSS highlight ranges and stops worker scheduling, then resumes on `compositionend`. The callback remains wired even while the transient enabled flag is false, preventing an opt-in feature from getting stuck off after composition.

### Verification evidence and limits

- The scheduler's **eight deterministic tests** cover 1,000-edit burst coalescing (exactly first physical job and final edit dispatched), rapid latest-wins scheduling (only initial physical work plus last edit dispatched), fairness across owners, queue capacity, abort of both queued/active callers, clean disposal, failure recovery and already-aborted requests. This is a functional **bounded-work guarantee**, not a measured latency improvement.
- Full pure local corpus plus scheduler: **125 passing tests / 12,262 assertions**, 0 failures, across seven files. App and E2E TypeScript: exit 0. Targeted Harper production source lint: **0 warnings / 0 errors**.
- Fresh, isolated **24/24 Chromium composer E2E** passed with IME suppression/resume and rapid consecutive edits, while preexisting tests check actual underlines, selecting/Undo, personal Ignore, opt-out behavior and Settings persistence. A synthetic composition regression was found and corrected: the app initially dropped its own composition-end callback when `enabled` became false.
- Existing first-party Goal prepare/objective/request parity regression passed **1/1** in an isolated fresh server. This does not certify post-plugin or provider-visible effects.
- Final production Vite build (after the worker scheduler and CSP-construction safeguards) **passed, exit 0**. Tracked integration-file `git diff --check`: **exit 0**. The temporary build transcript was deleted after validation.
- No external model inference requests, prompts to third-party grammar APIs, or background inference tools used.
- **Remaining risk:** physical WASM cannot be cancelled mid-operation; measure real application and worker CPU/memory and cold-start distributions before claiming a real-world performance delta. Native desktop, touch/mobile Safari, PWA asset caching, screen-reader interaction, provider-visible payload parity and representative false-positive rates remain independent certification gates.

**Disposition:** Source implemented locally; independently opt-in and disabled by default. No changes committed or pushed, and no unrelated checkout files reset.

## Ninth continuation — reject-first automatic writing corrections

### UX decision and intentional limits

**A human should not have to approve a long stream of unambiguous harmless typos.** The comfortable interaction is to accept those corrections implicitly while keeping them *visibly detectable and individually reversible*. However, automatically accepting every Harper suggestion is indefensible in a coding agent: Harper 2.10.0 ranks **"content"** above **"continue"** for the source typo **"contienu"**. A blindly top-ranked replacement would silently change an instruction's meaning.

Accordingly, the implementation adds a **second separate user opt-in** under General Settings, `promptGrammarAutoApply`. Enabling Harper's red/blue advisory squiggles does **not** enable automatic edits. With this option, automatic replacements require either (1) exact agreement with the application's curated deterministic typo map and Harper's available candidates, or (2) Harper's unambiguous, single-suggestion **"Incorrect indefinite article."** rule for lowercase `a ↔ an`. All other grammar, agreement, style and ambiguous spelling lints remain advisory. No inference-based confidence estimation is performed.

### Actual integrated architecture

- **Policy and inverse engine:** new `src/components/prompt-input/harper-autofix.ts` contains pure proposal, exact inverse/rejection, offset shifting and safe edit rebasing. A correction must be in an editable text span, not protected syntax, not an identifier/function/path boundary, and must not contain the current caret. The source must have been diagnosed by the local engine; positions are exact original UTF-16 offsets, not substring-search substitutions.
- **Atomic composer transaction:** `harper-controller.ts` commits the corrected prompt and its visible change metadata in a single Solid `batch()` transaction. The first Chromium E2E exposed and caught a real early implementation race where updating the marker before the prompt cleared the marker immediately; batching fixed it.
- **Reject rather than approve:** the shared generic session-ui composer displays neutral dotted underlines on auto-corrected words (separate from red/blue Harper diagnostics). Clicking such a word, or the compact `N auto-fixed · Review` indicator, opens a bounded list of exact `original → replacement` changes and individually accessible **Restore** actions. Closing the list means **keep**; there is no redundant Accept button.
- **Rejection loop prevention:** restored words are session-/draft-local exceptions in the Harper controller. They suppress Harper reruns and are additionally fed into the independent send-time deterministic autocorrection exclusions. The test confirms an explicitly rejected word is not silently re-corrected at submission.
- **Undo and caret behavior:** the latest untouched automatic edit supports Ctrl+Z; a subsequent explicit typing edit releases Ctrl+Z back to native browser undo while older automatic changes remain rejectable in the compact review. Automatic corrections update the cursor without stealing focus from the user's active input. Manual Restore returns focus to the prompt.
- **Persistence across ordinary typing:** the change ledger rebases at most **32** recent visible correction spans across independent text edits, validating unchanged replacement bytes, word boundaries, structured reference identity and topology. It discards individual markers after edits inside their words and fails closed on changes to opaque mention/file/image identity. Only explicit user dictionary changes persist across drafts; transient rejected words reset on a fresh empty draft.
- **Punctuation and simple grammar:** terminal sentence punctuation (`.`, `!`, `,`, etc.) cannot block a safe spelling repair merely because a punctuation character follows the token. Member access like `module.reasearch`, function names like `reasearch()`, quote contents and Markdown code remain protected. The exact basic article correction `This is a example.` → `This is an example.` can also be individually reverted.
- **Conservative performance:** only when Harper and auto-apply are both enabled does the controller consider a maximum one vetted correction per settled local worker result. A new successful correction may schedule the next settled pass, permitting multiple edits without large speculative batch rewrites or changing the submission pipeline. User input, IME and async worker generations remain authoritative; there is no network grammar request or model inference.

### Verification

- The dedicated pure `harper-autofix.test.ts` covers misleading Harper suggestion order, protected technical identifiers, exact basic grammar, punctuation, caret safety, structured reference remapping, exact rejection, rebasing, and metadata invalidation.
- Full eight-file deterministic suite: **136 passed, 0 failed, 12,300 assertions**. Covers vetted typo/Harper dual agreement, article `a/an` rule, inverse/rejected-word suppression, caret behavior, structured references and metadata, punctuation and function-call protection, rebasing markers across typing, queue capacity, and previous seed corpus.
- **Fresh isolated Chromium browser suite: 32/32 passed** (3.2 minutes) after fixing a previously flaky rising send-options control. This tests automatic spelling fixes, selective rejection through a first-party mocked send, dotted underline click, direct hover restoration and hover X dismissal, Ctrl+Z, conservative grammar, no code/quote changes, IME, disabled default, personal dictionary, Settings reload, old review approvals, exact-send paths, and admission-failure recovery.
- Separate Goal-mode objective/first-party outgoing-request parity Chromium regression: **1/1 passed**.
- App and E2E TypeScript checks **passed**; targeted new Harper/correction code oxlint: **zero warnings/zero errors**; tracked-file `git diff --check` exited **0**. Production Vite build had passed after the main auto-apply changes and before a final CSS send-control stacking amendment.
- **Send-options reliability fix:** a full-suite run surfaced pointer interception when a rising menu tab overlapped the footer/contenteditable stacking context. `send-turn-lane.css` now gives the whole send-group a higher stacking level; adjacent tooltip content does not intercept clicks. Verified focused mouse and keyboard exact-send E2E **2/2** and the final complete suite **32/32**.
- No inference calls or third-party online grammar service were used. All work remains local and uncommitted.

### Outstanding validation

Actual Safari/mobile IME/selection semantics, repeated native Ctrl+Z/redo behavior, real-world false-positive rate and after-plugin provider-visible payload trace remain unproven until separately measured. Never infer broad Grammarly-level parity from these narrow, source-backed fixtures.

## Tenth continuation — t3code-informed premium correction chips and contextual rejection

### Upstream mechanism inspected

The upstream T3 Code source (`pingdotgg/t3code`, `apps/web/src/components/ComposerPromptEditorTiptap.tsx`) uses Tiptap/ProseMirror **inline, atomic, selectable, contentEditable=false NodeViews** for *structured context* mentions, with `ContextChip`, `FileTagChipContent`, node-selection overlay and hover `Tooltip`. That atomic editing model is appropriate for a file reference but **wrong for ordinary editable English words**. It would interfere with caret movement, IME composition and everyday typing.

### Implementation

- Generic presentation component `packages/session-ui/src/v2/components/prompt-input/writing-hover-badge.tsx` provides a dense zinc-themed hover group with **×**, word identity and contextual action. Applied words show `Fixed · original → replacement` and × restores exactly the original. Unresolved spelling/grammar text shows category and × dismisses only that diagnostic. Clicking the primary badge opens detailed review.
- The badge is a **detached portal overlay** above fully editable text. CSS Custom Highlight ranges annotate native editor text without replacing/wrapping nodes, mutating editor serialization, breaking @mentions, or touching the submission pipeline.
- New `writing-hover-controller.ts` owns pointer capture, viewport-clamped positioning, delayed hover transfer to the floating badge, cleanup and scroll/resize invalidation. Measurements are **at most one requestAnimationFrame per mouse/pen frame**, on actual pointer motion and only for active opt-in annotations. No listeners or timers in the disabled path.
- `writing-highlights.ts` provides `hoverAtPoint` over the existing bounded, protected annotations (corrected tokens get click precedence).
- The multi-change review is now a compact, hierarchical strikethrough-original → corrected-word list with a hover/focus-revealed **× Restore** per row; the detailed popover also closes on outside pointer activity and Escape. No gradients, dashboard-style panes, accept/reject dialogs, or additional persistent UI.
- Accessible named actions and a polite status message announce new automatic fixes. Touch users retain tap-to-review without relying on mouse hover.
- `harper-controller.ts` exposes exact-draft `dismiss(id)`. Closing an advisory diagnosis suppresses it on that draft, **without adding a permanent personal dictionary entry**. It is deliberately distinct from restoring an auto-fix, which also creates a veto for the separate send-time autocorrect.

### Validation and residual risks

- Upstream t3code implementation inspected directly through connected GitHub repository source, rather than inferred from screenshots.
- Three isolated Chromium hover tests **all passed**: hover corrected word → contextual badge → X → precise restoration; hover unresolved spelling issue → X → dismiss one diagnostic with content unchanged; hover primary chip → full contextual suggestion review → dismiss without draft mutation.
- Deterministic eight-file suite **136/136 passed, 12,300 assertions** before final UI-only updates. App and E2E TypeScript and targeted lint passed; independent Goal objective/request parity regression passed 1/1.
- The complete isolated Chromium composer suite passed **32/32** before the final suggestion-popup presentation refinement; the three post-refinement hover tests passed **3/3**. Independent Goal objective/request parity **1/1** passed. Latest full app/E2E and session-ui TypeScript checks: exit 0; targeted new-source lint: 0 warnings/0 errors; source diff whitespace validation: exit 0.
- The production Vite build in a separate output folder passed **exit 0**, transforming **5,182 modules**. It reported existing Vite static/dynamic import warnings from unrelated modules; the warnings do not constitute errors and the build completed.
- Native desktop, Safari/mobile, comprehensive screen-reader/high-contrast and real-usage false-positive measurement remain distinct certification gates. All work local and uncommitted; no model inference calls.

**Disposition:** premium t3code-informed *visual and interaction* semantics without copying atomic/noneditable mention behavior into normal prose.










