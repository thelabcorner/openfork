# AX: explicit @tool mentions in native Sessions

**Status (2026-10-09):** Implemented in the OpenFork V1 source checkout and covered by targeted unit tests. This does not claim that the already-running external OXP connector has been redeployed, or that model-level task-completion improvements have been measured.

## Problem and owner

Native agent references such as `@general` and `@explore` are structured `AgentPart` entries. The V1 prompt admission owner produces a synthetic task-delegation instruction for those entries. Composer tool pills use a different contract: their `@<id>` token is transmitted in ordinary user text, because there is no V1 native `ToolMentionPart`. Historically, `SessionTools.explicitLazyToolContext` only supplied synthetic model context for lazy capabilities. Direct provider-visible tools were omitted despite being selectable in the same mention picker.

The **single native Session owner** is `packages/opencode/src/session/tools.ts` (`SessionTools.explicitToolMentionContext`), wired at the actual provider-turn boundary in `packages/opencode/src/session/prompt.ts`. The legacy `explicitLazyToolContext` name remains a compatibility alias. This feature does not introduce a new executable dispatcher or change Code/OXP/OFXP/ACP/MCP authority.

## Lowering pipeline

1. The composer renders a registered, atomic tool pill, with a stable canonical `name`. `build-request-parts.ts` transmits the visible text token; no speculative tool execution occurs on selection or submission. Text-only API/CLI clients retain the same recognition path.
2. At model processing, obtain the **causal human worker-root text**, excluding existing synthetic text. Resolve the actual provider-visible tool map from `SessionTools.resolve` and the existing lazy inventory from `ToolRegistry.all`.
3. Parse only token-boundary `@identifiers`; ignore email-like embedded `@`, path-like `@id/`, unknown IDs, and duplicates. Prefer exact registered dotted IDs over trimming terminal sentence punctuation. Exclude only verifiable `AgentPart`/`FilePart` source spans matching the worker-root text, so a same-name tool explicitly typed elsewhere still activates.
4. For a **direct, provider-visible** tool, append a brief model-facing hint containing the exact ID, compact description, and instruction to call that existing tool with its already-visible schema. Never duplicate the full schema in the user context or route it through the lazy `tool` broker.
5. For a **lazy** tool, provide the existing broker descriptor, full schema and exact current contract when within budget, permitting a single broker `call` without redundant `list`/`describe`. If schema construction fails or the descriptor is too large, fall back to a *compact describe-first hint*, never a guessed contract, truncated schema or unearned admission.
6. Attach the whole block as **request-only, synthetic user-role capability metadata** after the provider-converted conversation and before generation. It is not persisted as another human message; it cannot become a new turn, overwrite tool outputs or alter the stable provider tool manifest. Subsequent steps use the same causal root, not accidental strings from tool results.

## Security and AX invariants

- **No new authority:** names are resolved against the current selected tool set, and both agent/session permission rules are checked before context is emitted. The actual leaf/broker still enforces its own authorization and revocation at execution time. A mention is a selection hint, not a forced invocation.
- **No subagent confusion:** `@general`/`@explore` retain native `AgentPart` delegation behavior; tool names never manufacture worker delegation. Structured file/agent spans are excluded before tool matching.
- **Bounded context:** at most **8 distinct registered tool hints**, at most **4 expanded lazy tool descriptors**, and at most **48,000 characters** of payload blocks. Direct hints are compact, and oversized lazy schemas preserve the describe-first fallback instead of silently vanishing.
- **Cache and stability:** no per-mention mutation of the provider tool manifest. No global enumeration of expensive schemas for ordinary prompts without tool mentions. The schema and broker contract are sourced from the runtime registry, not user-authored text.
- **Compatibility:** V1 Session processing is the supported production integration. Existing Code Mode and external transports keep their separately authorized discovery and execution paths; source-level native mention tests do not certify full transport parity.

## Verification and remaining proof

Run from `packages/opencode`:

```sh
bun test test/session/tools.test.ts --timeout 30000 --only-failures
```

The focused suite currently reports **22 passed, 0 failed (74 assertions)**. Cases cover direct/lazy mixed hints, an actual `SessionTools.resolve` provider-tool map, registry identity, missing IDs, agent/session denied tools, disabled lazy broker with an independently available direct tool, email-like text, punctuation, dotted canonical IDs, same-name file/agent span collisions, inherited JavaScript prototype-key spoofing, oversized schema fallback, and avoiding registry hydration on no-mention turns. The UI request-part serialization suite independently reports **14 passed, 0 failed (52 assertions)**.

The full `bun run typecheck` still reports **22 diagnostics in other, concurrently modified paths** as of this checkout inspection; none was attributed to these mention-owner source/test files. A clean whole-repo check has **not** been established.

An additional broad `bun test test/session/prompt.test.ts` attempt surfaced unrelated route-intent attribution and Goal/worker-run-state failures; it was terminated after those failures rather than allowed to keep running. This is **not** a clean prompt-suite pass and does not, by itself, prove whether those failures predated this change. The targeted mention-path checks above are the positive regression evidence.

**Further release gates:** execute an actual UI composer-to-provider trace for direct, lazy and structured-collision cases; verify permission denial and runtime tool dispatch end-to-end (not just emitted metadata). Run baseline versus candidate agent trajectories with identical models and real registered tools to measure first-call validity, unnecessary discovery, task completion, latency and token cost. Confirm source/build identity after deploying the running sidecar; the connected external OXP runtime is not automatically refreshed by these edits.