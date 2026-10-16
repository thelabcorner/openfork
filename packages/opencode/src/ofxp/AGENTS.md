# OFXP peer-tool executable parity

Read the root/package `AGENTS.md` and
`docs/architecture/tool-surface-parity.md` before changing peer discovery,
capability catalogs, or dispatch.

- A peer-advertised tool/action must resolve to a **real executable** shared
  owner under cryptographically established peer authority. No catalog-only,
  self-referential broker, or fabricated Session coverage.
- Compare `src/exchange/tool-coverage.ts` semantic dispositions to the actual
  peer dispatcher. Record pending, unsupported, intrinsic and exceptional
  operations honestly; distinguish capabilities from supervision/delegation.
- Preserve root/peer-scoped grants, identity, replay/idempotency, cancellation,
  laziness, and denial/revocation. Never inherit the remote host's credentials.
- Require executable peer-path tests and negative grants tests for changes,
  alongside normal Session/OXP/ACP/MCP matrix review.
