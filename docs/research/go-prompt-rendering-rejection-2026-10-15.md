# Hosted Go prompt-rendering rejection — 2026-10-15

## Evidence and scope

The local OpenFork sidecar log (`log/openfork.log`) records repeated `AI_APICallError` errors:

- `2026-10-15T19:36:28.177Z`, `19:36:36.340Z`, and `19:36:40.944Z`
- `providerID=opencode-go`, `modelID=cat-jam-free`
- `session.id=ses_ebeef2f73fferAG1qnIRpbqoY9`
- `Upstream request failed: [prompt_rendering_failed] The request could not be rendered into a prompt for this model.`

That same Session's first model turn emitted tool calls and the next turn failed at the remote prompt-rendering boundary. User-authored `continue` prompts repeated the same failure. At `19:38:09Z` the Session used `opencode-go/step-5-preview-free` and subsequently advanced through tool calls and background-agent delegation. This is evidence for model-specific prompt-format incompatibility, **not** evidence for a particular unsupported history field or for an upstream service fix.

No evidence attributes the failure to SQLite, a response timeout, or the renderer UI. The upstream Go service's model-specific prompt compiler is outside OpenFork's control. Do not attempt a speculative conversion of tool replies to ordinary user/assistant text: this would change tool-output trust, potentially lose provenance, and could still fail upstream.

## Bottom-up ownership and behavior

1. V1 Session and `MessageV2.toModelMessagesEffect` own conversion from durable conversational parts to AI SDK messages.
2. `session/llm/request.ts` and `session/llm.ts` own compiled request assembly and execution route selection.
3. Upstream `opencode-go` owns its deployed model-specific prompt renderer; OpenFork cannot alter that renderer.
4. `provider/error.ts` owns normalization of HTTP and SSE failure codes.
5. `session/retry.ts` owns whether a failed *committed* request may be replayed; request-incompatibility must not mark an entire route unhealthy.
6. UI displays the server-derived error. It does not infer remote model capabilities or reconstruct message history.

## Local mitigation implemented

- Recognize the stable bracketed upstream code `[prompt_rendering_failed]` and the structured `error.code` field, without searching user-request content.
- Classify it as a terminal request/model incompatibility even if an intermediary supplies status 502 and `isRetryable: true`.
- Do not retry the same committed request, impose route/account cooldown, or silently substitute a different model or credential.
- Provide guidance to select another model **without deleting the existing Session history**.
- Return a fixed, privacy-safe message for this failure rather than printing the untrusted raw provider response body.
- Preserve normal retry behavior for genuine temporary 5xx, overload, quota, and rate-limit failures.

Source/tests:

- `packages/opencode/src/provider/error.ts`
- `packages/opencode/src/session/retry.ts`
- `packages/opencode/test/provider/error.test.ts`
- `packages/opencode/test/session/retry.test.ts`

Verification: `bun test test/provider/error.test.ts test/session/retry.test.ts` from `packages/opencode` passed. Package-wide `bun run typecheck` reported pre-existing errors in other source/test files and no diagnostics in these four changed files. Deployment/restart was **not** performed; other active Sessions must not be interrupted without an operator-controlled safe boundary.

## Open upstream root-cause gate

Do not label the remote prompt renderer repaired until there is a verified provider-wire fixture that reproduces the failure and a subsequent successful, same-model replay preserving all tool calls/results and their trust semantics. Useful evidence would include redacted message-role topology and call/result pairing at the post-transform AI SDK boundary, the exact selected model/API route, and the upstream response code. Never log full prompts, tool outputs, secrets, or provider auth data for this investigation.
