# Muse Spark / OpenCode Go request compatibility

**Scope:** Hosted OpenCode Go's Responses-compatible Muse Spark and Muse Glimmer models. This is a remote-service wire-compatibility exception, not an OpenFork-local API compatibility target; see [compatibility-boundary.md](./compatibility-boundary.md).

## Failure classes

- [Meta function-name contract](https://dev.meta.ai/docs/tool-calling): function tool names must match `^[a-zA-Z0-9_.-]+$`, be at most 64 characters, **and contain no more than one dot**. [Meta call-ID contract](https://dev.meta.ai/docs/tool-calling): `call_id` must be between 1 and 64 characters. In addition to overlong MCP tools, historical model-hallucinated names (such as `ash:execute`), multi-dot namespaces, and oversized/empty call IDs can poison future Muse requests and compaction. Request-local, collision-safe, deterministic wire aliases cover both current tool definitions and historical tool names/paired call IDs; the original tool-name identities are restored on every AI-SDK/native LLM tool event **before** the processor, permissions, telemetry, and persistence run. Canonical tool IDs, historical IDs and source messages are never changed.
- Meta's tool-parameter schema limit is ten structural levels. The provider-specific output of `ProviderTransform.schema` inlines supported local JSON Pointers, detects recursive references, and bounds expansion depth. Original source schemas and runtime tool implementations are not modified.
- Hosted Responses rejects some invalid or stale encrypted reasoning. The existing `SessionStaleReasoning` owner already strips caller-bound replay state under its own recovery semantics. The Muse schema/name lowering does not substitute for or alter that recovery. For **hosted Muse requests with `store !== true`**, the outgoing `ProviderTransform.message` omits historical assistant reasoning parts (including empty reasoning with `openai.reasoningEncryptedContent` and `itemId`), and `providerOptions` suppresses `include: ["reasoning.encrypted_content"]` (without discarding unrelated include entries), avoiding unnecessary new caller-bound blobs. This preserves tool calls, tool results, visible text, and the durable transcript. Other Go models, direct Meta, and explicitly stored Muse requests retain their existing replay behavior.
- [Upstream generic 400 investigation #47975](https://github.com/anomalyco/opencode/issues/47975): hosted **Contributor/free** Muse Spark gateway instances can advertise `reasoning.effort: "max"` but reject it with exactly `The request contains invalid parameters`. An agent's explicit `reasoningEffort: "max"` can override correct models.dev variants. The final `providerOptions` boundary therefore lowers this unsupported hosted Contributor/free effort to `xhigh` (observed accepted) without changing the user's settings, other models, direct Meta, or the [Standard tier where Meta supports `max`](https://dev.meta.ai/docs/models).
- An invalid request encoded as a Responses stream error may omit HTTP status entirely. Known invalid request, invalid parameter, validation and tool-schema failures must be nonretryable. The dedicated stale-reasoning, overflow, and quota classifications take priority.
- Structured nested upstream provider error messages and parameter paths can be displayed when the outer SDK error is generic, without dumping the full response payload.

## Invariants

1. Do not truncate the canonical tool ID; alias only provider-visible names and matching replayed history. Tool dispatch retains the original execution closure.
2. Do not mutate stored tool schemas, stored session messages, or system prompts as part of provider lowering.
3. Do not apply Muse's limits to other models from the same Go provider.
4. Do not retry a deterministic 400/SSE validation error unchanged; also do not mistake a typed `invalid_encrypted_content` error for an ordinary request-invalid rejection.
5. Do not silently change Go account routing, authentication, quota handling, or the active selected model.

## Regression evidence

- `bun test test/provider/transform.test.ts test/session/muse-tool-names.test.ts test/provider/error.test.ts test/provider/muse-replay.test.ts test/session/llm.test.ts`
- Covers maximum nesting, recursive local references, original-schema immutability, overlong/malformed tool names, collision handling, historical replay matching, canonical event restoration (tool-input/start/end/call/result/error), source immutability, non-Muse passthrough, informative upstream errors, nonretryable streamed validation failures, and hosted Muse encrypted-reasoning omission without breaking tool-call/result pairing.
- The isolated Responses SSE integration test `round-trips Muse transport tool aliases through the real Responses stream without persisting aliases` also verifies alias-only wire definitions, `strict: false`, real tool execution, and canonical names on emitted tool events (using a mock HTTP endpoint; it does not spend Muse tokens).
- The source fix requires a fresh local runtime to affect existing sessions. A live hosted model response was not used as an automated test, to avoid modifying an active swarm session or consuming Go quota without an isolated replay fixture.
- Package-wide typechecking currently reports unrelated errors in CLI, server, and existing tests; review baseline separately rather than hiding those errors.

## Upstream references

- [Long tool names and Muse errors](https://github.com/anomalyco/opencode/issues/47049)
- [Tool schema depth and Muse](https://github.com/anomalyco/opencode/issues/50297)
- [Upstream depth compatibility change](https://github.com/anomalyco/opencode/pull/50320)

Incident investigation reference: `ses_edd0da9b8ffezt2XSNThofHq38` in project `presGEN_v2`. The observed transcript exhibited repeated empty assistant turns interleaved with `swarm.peer` synthetic messages and generic invalid-parameters errors. Without a captured redacted outgoing wire request and its full upstream rejection, these are supported failure classes, not a unique forensic proof of that incident's exact offending field.

## Outstanding / external failure classes

These findings are distinct from the client request-lowering defects above:

| Signal | Evidence | Disposition |
| --- | --- | --- |
| Generic 400 in very large Muse free-tier sessions | [#46564](https://github.com/anomalyco/opencode/issues/46564), [#54514](https://github.com/anomalyco/opencode/issues/54514) | Possible context overflow in some incidents. Generic `invalid_request_error` **also** occurs for effort=max and invalid tool definitions, so never classify every 400 as overflow or automatically drop history. Require bounded input evidence or positive upstream overflow signal. |
| Absent terminal `finish_reason` | [#43379](https://github.com/anomalyco/opencode/issues/43379), [#43882](https://github.com/anomalyco/opencode/issues/43882) | Reported on **Chat Completions SSE** used by third-party strict clients. OpenFork's observed Muse incident uses **Responses**. Do not synthesize success after an incomplete stream or unfinished tool call. |
| Intermittent free-tier `Invalid upload request` | [#47237](https://github.com/anomalyco/opencode/issues/47237) | Reproduced in new sessions too; likely hosted gateway. Do not spoof client identity or mutate upload content without wire evidence. |
| OpenCode free-tier eligibility | [#49966](https://github.com/anomalyco/opencode/issues/49966) | Server-enforced eligibility, not permission to bypass access policy. |
| Muse Contributor opt-in | [#44495](https://github.com/anomalyco/opencode/issues/44495) | Consent requirement, not a request-validation bug. Never automatically opt in. |
| Narrated tool intent without actual tool call | [#49062](https://github.com/anomalyco/opencode/issues/49062) | Potential model behavior. Never fabricate or execute a narrated action without an actual tool-call event. |

## Certification scope

- **Verified:** unit/regression tests and a real AI SDK Responses SSE integration test against an isolated mock transport, checking deterministic aliasing, `strict: false`, real tool execution and canonical tool identity restoration.
- **Not verified:** live Go/Zen Muse generations after rebuilding this concurrently edited checkout. The running application was deliberately not restarted or changed.
- **Compilation:** package-wide typechecking reports existing unrelated CLI, HTTP API and test-file errors; no package-wide clean-build claim is made.

