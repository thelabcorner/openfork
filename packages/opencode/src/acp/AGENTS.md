# ACP tool execution parity

Read the root/package `AGENTS.md` and
`docs/architecture/tool-surface-parity.md` before changing ACP tools,
session bridges, or editor-agent invocation.

- Supported ACP tool calls must reach the existing native Session tool
  owner or an explicit authorized shared adapter. A mirrored catalog,
  schema, or editor-side menu entry is not evidence of execution.
- Preserve real Session identity and native tool permissions, lazy tool
  activation, Code gateway semantics, cancellation, streaming/error
  projection, and tool-result attribution; never invent `Tool.Context`.
- Test actual ACP-to-leaf execution and rejection of unauthorized or
  unsupported actions. Record intentional ACP-specific limitations in the
  tool-by-surface parity matrix, without duplicating leaf implementations.
