# Exchange tool semantics and parity contract

Read root `AGENTS.md`, `packages/opencode/AGENTS.md`, and
`docs/architecture/tool-surface-parity.md` before changing mappings.

- `tool-coverage.ts` records native-to-external semantic dispositions.
  It is **not** an executable parity certificate. Native names/actions come
  from real registries; OXP/OFXP/ACP/MCP availability is determined by the
  corresponding live dispatchers and their supported tool entry points.
- Preserve one authoritative domain executor, with protocol-specific
  principal/root/Session checks at real execution boundaries. Do not
  recursively delegate through brokers or invent a Session/`Tool.Context`.
- Represent aliases, intrinsic protocol operations, unsupported operations
  and security/lifecycle exceptions truthfully. Keep action-level scope,
  lazy exposure, capability classes, errors and side effects explicit.
- Every mapping change requires dispatcher-backed positive/negative tests,
  a surface-by-surface matrix update and relevant architecture-map changes.
