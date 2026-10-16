# Hosted Cat Jam prompt-rendering failure — 2026-10-16

## Observed incident

The Workmark Build Session `ses_ebeef2f73fferAG1qnIRpbqoY9` (Cat Jam Free, xhigh, `opencode-go`) was rejected by the upstream provider:

```
AI_APICallError: Upstream request failed: [prompt_rendering_failed]
The request could not be rendered into a prompt for this model.
```

The error denotes an upstream **model-specific prompt-compiler rejection**. It is not evidence of a network timeout, quota exhaustion, or a retryable 502. OpenFork cannot alter the upstream-hosted prompt compiler. The precise offending message shape has not been proven from a redacted wire dump, so no root cause narrower than the rejected request/model combination is asserted.

## Ownership / code path

- `packages/opencode/src/session/prompt.ts`: authoritative V1 turn ownership; plugin-transformed provider-only history, `MessageV2.toModelMessagesEffect`.
- `packages/opencode/src/session/message-v2.ts`: stable tool IDs, result causality, provider-only reasoning projection.
- `packages/opencode/src/provider/transform.ts`: final SDK prompt transformations (not remote wire compiler).
- `packages/opencode/src/session/llm.ts`: V1 stream dispatch.
- `packages/opencode/src/provider/error.ts`: structured upstream error classification already marks `prompt_rendering_failed` terminal.
- `packages/opencode/src/session/retry.ts`: no generic physical retry, no route-health penalty for that error.
- `packages/opencode/src/session/processor.ts`: one owned recovery chance, before generic retry policy.

## Applied implementation

`packages/opencode/src/session/prompt-rendering-recovery.ts` creates a **request-local** portable replay projection only when:
1. A hosted `opencode`/`opencode-go` model using the OpenAI-compatible Chat API returns the structured `prompt_rendering_failed` code or bracketed gateway error code.
2. The rejected attempt published **zero provider progress events** (including tool, step, usage, or partial-text events) and the processor has emitted no turn output. A lone terminal `provider-error` event is classified as rejection, not generation progress, because native adapters may use that representation.
3. Outgoing historical assistant messages actually contain replayed `reasoning` parts.
4. No prior prompt-render compatibility attempt has occurred in the logical turn.

The projection removes those reasoning parts, and reasoning-only assistant messages, **without** altering durable Session parts, text, system/user instructions, tool-call IDs, tool-call arguments, tool-result text, or role sequence. The exact committed route, model, and request ownership remain unchanged. If no reasoning exists, or if the replacement is rejected, the original terminal failure is surfaced. Repeated byte-equivalent retries, provider route churn, automatic tool-history flattening and untrusted prompt-text error detection are disallowed.

This is intentionally a constrained compatibility recovery, **not** a blanket fix for all upstream prompt templates. Cat Jam may reject requests for other reasons (tools/media/roles/token format), which require model-specific evidence before modifying their serialization.

## Verification

- `bun test test/session/prompt-rendering-recovery.test.ts test/provider/error.test.ts test/session/retry.test.ts`
- `bun test test/session/processor-effect.test.ts`
- V1 processor integration tests cover positive one-shot replay with preserved tool causality, refusal of retry after a provider progress event, termination when a second prompt-rendering rejection occurs, and recovery from a lone native `provider-error` event.
- `git diff --check` on modified tracked source and tests.
- `bun run typecheck` is the package's canonical `tsgo --noEmit` check. It completed with nonzero exit status 2 and diagnostics in numerous other source/test files (for example, `packages/llm/src/protocols/bedrock-converse.ts`, `src/cli/cmd/debug/support-bundle.ts`, and compatibility tests). It is **not** a green package-wide typecheck. The legacy direct TypeScript 5.8 `tsc` invocation separately crashed inside `_tsc.js` and was not a useful check. The focused executed tests and integration suites are green.

## Follow-up diagnosis / external validation

To identify the upstream compiler's precise limitation, instrument a **privacy-safe, request-local shape witness** around post-SDK lowering: record role counts, assistant reasoning counts, tool-call/result pair counts, media-type counts, token estimate, transport/API family, catalog capabilities, and response error code. Do **not** log prompts, tool outputs, credentials, encrypted reasoning, raw media, or raw provider payloads. Reproduce a fresh Cat Jam session and a session with a single tool call before declaring a model-wide repair. Upstream service acceptance cannot be inferred from local mock success.

Rollout requires the current OpenFork sidecar process to load the updated source/build; a prebuilt desktop binary will not change until rebuilt or updated.
