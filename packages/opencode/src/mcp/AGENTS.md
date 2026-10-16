# MCP tool boundary and executable parity

Read the root/package `AGENTS.md` and
`docs/architecture/tool-surface-parity.md` before changing MCP discovery,
invocation, import, or export.

- Distinguish OpenFork **consuming** external MCP tools in normal Sessions
  and Code Mode from **serving** its own tools to an MCP client (including
  the OXP MCP endpoint). Import registration never implies export consent.
- For supported invocation directions and principals, catalog entries must
  resolve to real leaf execution with correct schemas, permissions, output,
  error semantics, cancellations and redaction; never count listing alone.
- Preserve MCP server credentials and Session/workspace ownership.
  Explicitly grant export per principal/root where supported, and do not
  forward ambient tokens, fabricate Sessions or recursively proxy brokers.
- Validate action-level positive and denied execution paths and record
  deliberately unsupported export/import cases in the parity matrix.
