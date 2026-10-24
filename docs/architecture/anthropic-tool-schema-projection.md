# Anthropic tool-schema wire projection

## Failure and ownership

Anthropic Messages rejects `tools[*].custom.input_schema` when `oneOf`, `anyOf`, or `allOf` appears **at the root**. Nested property combinators are not the cause of that error. A single malformed tool poisons the whole provider request, even if that tool is not called.

OpenFork imports MCP tool definitions in `packages/opencode/src/mcp/catalog.ts`. The adapter inserts `type: "object"` and `properties` but retains root combinators from the source schema. The production V1 registry uses `ProviderTransform.schema`; late additions (including structured output) can enter after registry construction. Native `@opencode-ai/llm` Anthropic lowerers accept their own tool definitions. This necessitates wire coverage at multiple execution paths.

Upstream OpenCode has reports of the same failure: [#35516](https://github.com/anomalyco/opencode/issues/35516), [#37916](https://github.com/anomalyco/opencode/issues/37916), and [#38616](https://github.com/anomalyco/opencode/issues/38616). Upstream's existing OpenAI and Gemini schema transformations are not a replacement for Anthropic-specific rules in this fork.

## Implementation

One projection is owned by `packages/llm/src/protocols/utils/tool-schema.ts` as `ToolSchemaProjection.anthropic`.

- No root composition: return the original schema by identity.
- Root composition: expose a plain object with no root `oneOf`, `anyOf`, or `allOf`; preserve existing top-level properties, annotations, and `additionalProperties`.
- Collect branch properties. Keep field-level union/intersection descriptions nested under their affected property, rather than throwing those field shapes away.
- For `allOf`, preserve the union of required fields. For `anyOf` or `oneOf`, require only fields shared by every branch. Expose required-only branch names even if not accompanied by property definitions.
- Annotate required-branch alternatives in schema description when possible. That hint is **not** an exact encoding of cross-field `oneOf` constraints.
- Do not mutate source schemas, other providers' tools, or provider-owned tools.

Apply projection at three locations:

1. V1 AI SDK native/registry tool construction: `ProviderTransform.schema` for `@ai-sdk/anthropic` and `@ai-sdk/google-vertex/anthropic`.
2. V1 AI SDK final V3 request middleware: `ProviderTransform.anthropicWireTools` for late-added function tools, without rewriting tool execution objects or their argument validators.
3. Native Anthropic Messages: `fromRequest` projects tool input schemas after model compatibility and immediately before `input_schema` body lowering.

**Tradeoff:** JSON Schema's cross-field composition cannot in general be represented exactly by a single uncomposed object. The provider sees a conservative, more permissive schema. The underlying implementation and MCP server remain the authoritative argument/permission validation boundary; model-facing metadata must never be construed as authorization.

## Tests and deployment

- `packages/llm/test/tool-schema-projection.test.ts`: oneOf, anyOf, allOf, nested schemas, alternative-only requirements, immutability and idempotence.
- `packages/llm/test/provider/anthropic-messages.test.ts`: exact native request body; a mocked Haiku 5.5 transport resumes full conversation history including completed tool call/result with formerly invalid MCP tool available and returns a final message.
- `packages/opencode/test/provider/transform.test.ts`: AI SDK model gating, nested schema preservation, last-mile late tool injection, unchanged unrelated providers.
- Typecheck `packages/llm` and `packages/opencode`; run both focused suites.

Tests verify local deterministic lowering and a mocked transport. They do **not** establish that the already-running packaged sidecar has loaded new source, that the Anthropic production API accepted a live call, or that any specific failed user Session has been resumed. Session recovery requires an identified Session and a runtime using the patched build; do not fabricate a user message or resume an unrelated Session.
