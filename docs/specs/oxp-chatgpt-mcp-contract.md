# OXP ↔ ChatGPT MCP contract

Status: normative implementation contract

Last audited: 2026-09-20

This document records the ChatGPT/OpenAI-facing MCP features OXP intentionally
implements. The goal is not to add metadata indiscriminately; every advertised
field must describe executable behavior and remain cheap enough for a permanent
tool prefix.

Primary references:

- https://developers.openai.com/plugins/reference
- https://developers.openai.com/plugins/plan/tools
- https://developers.openai.com/plugins/build/mcp-server
- https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28
- https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions

## Protocol boundary

OXP ingress uses `@modelcontextprotocol/server` v2 and `createMcpHandler`.
MCP `2026-07-28` is the canonical OXP contract. The endpoint also configures
`legacy: "stateless"` as a **transport-only compatibility adapter** because the
currently deployed ChatGPT connector still initiates MCP `2025-11-25`.

Modern behavior is executable, not documentary: tests pin v2 clients to
`2026-07-28`, require `getProtocolEra() === "modern"`, enumerate OXP tools,
and call real root-bound tools. A second regression exercises the current 2025
ChatGPT transport through the stateless adapter.

The compatibility adapter does **not** restore legacy OXP semantics. In
particular it does not restore `Mcp-Session-Id` correlation, delegation
model/agent allowlists or defaults, transport-owned authority, or stateful MCP
session behavior. All OXP authority and runtime behavior remains the same as the
canonical 2026 path.

OpenFork's unrelated outbound MCP client remains a separate dependency domain;
this OXP ingress contract neither depends on nor provides compatibility for it.

## Tool descriptors

Every permanent OXP tool advertises:

- stable `name`;
- concise human-readable `title`;
- canonical intent/constraint `description`;
- structural `inputSchema`;
- `outputSchema` because OXP returns `structuredContent`;
- explicit `readOnlyHint`, `destructiveHint`, and `openWorldHint`;
- `idempotentHint` only when truthfully true;
- `securitySchemes: [{type:"noauth"}]` in OXP's ChatGPT descriptor projection
  plus `_meta.securitySchemes`. The MCP 2026 standard Tool codec does not retain
  OpenAI's non-standard top-level extension, so the modern wire path carries the
  documented `_meta` compatibility form. The Secure MCP Tunnel/connector is the
  authenticated transport boundary; OXP does not initiate per-tool OAuth;
- bounded ChatGPT invocation-status prose in
  `_meta["openai/toolInvocation/invoking"]` and
  `_meta["openai/toolInvocation/invoked"]`;
- `_meta["openai/fileParams"]` only where ChatGPT-native file injection is
  executable.

`openWorldHint` is behavioral, not a synonym for "networked": public web,
browser, and open external-MCP/process behavior is open-world; a bounded private
OpenFork workspace is not.

## Structured results

`content` remains concise model-readable text. On the canonical 2026 surface,
`structuredContent.output` is required and mirrors that successful text so
structured-only connector bridges cannot discard tool output. The 2025 transport
adapter advertises the same envelope with `output` optional because the MCP v2
compatibility projector otherwise rejects valid legacy-era results before they
leave OXP; OXP still emits `output` in the actual structured result. The rest
of `structuredContent` is the stable machine-readable projection for progressive follow-up calls: capability data,
opaque attachment handles, bounded metadata, mutation truth, errors, and OXP
continuity metadata. OXP validates successful structured results against the
advertised output schema before the MCP SDK projects the result onto the active
protocol era.

Do not put secrets, credentials, native approved-root paths, or unnecessary
internal diagnostics in structured results.

## Native ChatGPT files

The generic progressive capability broker has one top-level `source_file` field
declared through `_meta["openai/fileParams"]`. It is accepted only for
`capability=file.transfer`; every other namespace/capability fails closed.

The injected object follows ChatGPT's contract:

`{download_url, file_id, mime_type?, file_name?}`

The existing `OxpFileExchange` owner retains download-host pinning, bounded
transfer, approved-root confinement, no-follow/no-overwrite rules, and atomic
publication. Authenticated OpenAI Files operations remain the separate direct
`openai_files` tool.

## Server instructions and request metadata

ChatGPT consumes MCP server instructions, so `SERVER_INSTRUCTIONS` is a compact
cross-tool contract, not duplicated prose. Parent correlation continues to use
the documented OpenAI request metadata when present; the MCP 2026 envelope is
handled by the v2 SDK and OXP reads non-reserved OpenAI metadata from the handler
context.

## Deliberately not advertised

- UI resources / `_meta.ui.resourceUri`: OXP's coding/automation tools are
  headless. Add an MCP App only when an interactive component materially helps.
- `openai/widgetAccessible`: no OXP widget currently calls tools.
- `openai/profile`: OXP does not expose a user-account OAuth profile tool.
- OAuth tool schemes: the local Secure MCP Tunnel is the connector boundary;
  claiming per-tool OAuth would be false.
- arbitrary `openai/fileParams`: only the real file-transfer path gets it.

These are omissions by semantic applicability, not missing SDK adoption.

## Prefix/performance rule

OpenAI charges model context for imported tool definitions. Rich metadata is
therefore part of the performance budget. Keep the fixed manifest bounded,
strip redundant field prose, and leave large native capability schemas behind
progressive `capability.list/describe`. Never remove correctness metadata merely
to win a byte-count benchmark; measure the richer contract explicitly.

