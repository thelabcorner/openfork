# Repository-local OpenFork custom tools

Read the root `AGENTS.md` and
`docs/architecture/tool-surface-parity.md` before adding or changing a
repository-local custom tool in this folder.

- A custom tool must work through the real host registration and authorized
  native/Code invocation paths; a name in discovery is not executable proof.
- Review every other **supported** tool-calling entry point (OXP, OFXP, ACP,
  MCP, workers and future gateways). External accessibility is **not**
  automatic: dynamic/user/project tools may require explicit root/principal
  consent, a dedicated adapter, or a narrow reviewed exception.
- Preserve lazy loading, schema/action equivalence, roots, grants, secrets,
  revocation, cancellation and output bounds. Never re-export local plugin
  credentials or invent an OpenFork Session for a remote caller.
- Test actual execution and unauthorized denial where a surface is
  intentionally supported. Document exceptions in the tool-by-surface matrix.
