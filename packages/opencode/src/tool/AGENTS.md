# Native OpenFork tool implementation contract

This tree implements V1/fork production native tools and their lazy surfaces.
Read the repository root `AGENTS.md`, `packages/opencode/AGENTS.md`,
and `docs/architecture/tool-surface-parity.md` first.

- Every added/changed provider-callable tool **and action** requires real,
  authorized executable parity across supported normal Sessions, Code Mode,
  OXP, OFXP, ACP, MCP, and any additional intended tool invocation routes.
  A name in a registry, schema, `@tool` catalog or coverage ledger is not proof.
- Register native identity through the existing V1 `ToolRegistry`; update the
  external semantic disposition in `src/exchange/tool-coverage.ts`.
  Do not duplicate domain behavior in transport adapters or manufacture
  `Tool.Context` to serve external callers.
- Preserve default versus lazy visibility, schema/action contracts,
  per-leaf grants, Session/root ownership, revocation, cancellation, stable
  result/error semantics, and action-scoped test evidence.
- Cross-surface exceptions must be narrowly reasoned, reviewed, recorded,
  and tested. Follow the OXP-specific ledger and verifier **plus** the
  dispatcher-backed checks for each other applicable surface.
