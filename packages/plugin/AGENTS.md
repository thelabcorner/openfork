# OpenFork plugin tool integration contract

Follow the repository `AGENTS.md`,
`packages/opencode/AGENTS.md` (for V1 host integration), and
`docs/architecture/tool-surface-parity.md`.

Plugin-provided tools belong to the plugin/host's authorized runtime owner.
Registration or SDK visibility is never proof of execution or permission to
advertise a tool to OXP, OFXP, ACP, MCP, Code Mode, or another principal.

- Preserve executable semantics through the actual native/Code gateway.
  Other supported transports need an explicit authorized leaf adapter,
  action-level tests and evidence, or a documented reviewed exception.
- Keep plugin credentials, per-workspace scope, lazy activation, cancellation,
  result/error contracts and revocation isolated from foreign principals.
- Do not automatically mirror imported MCP tools, arbitrary plugin tools, or
  host-private SDK methods into remote export catalogs.
