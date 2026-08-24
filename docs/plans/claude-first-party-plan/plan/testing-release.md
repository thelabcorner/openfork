# Testing, Observability, and Release Plan

## Test Layers

### Pure unit tests

- credential shape parsing and precedence;
- executable/SDK availability detection;
- model aliases and effort variants;
- event translation and malformed event handling;
- session binding validation and invalidation;
- error categorization and redaction;
- tool-call parking/resume state machine;
- cancellation state transitions.

### Fake Agent SDK tests

Inject a fake SDK module and fake query stream. Cover text, reasoning, tool calls, partial tool results, multiple pending tools, resume, interruption, malformed events, SDK load failure, child-process failure, and stream stall.

### Provider/session integration tests

Use the real OpenCode provider and session services with a fake runtime. Verify durable user/tool messages, retries, permissions, cancellation, model selection, and no duplicate turns.

### Runtime contract tests

Run against a controlled Agent SDK/CLI fixture where licensing and credentials are not involved. Verify cwd, settings source, model, effort, MCP registration, process cleanup, and external session resume.

### Packaging tests

Run both:

- Bun source backend: `bun run --conditions=browser ./src/index.ts serve --port 4096` from `../../../../packages/opencode`.
- Node sidecar bundle: `bun script/build-node.ts`, then exercise the bundled server path.

Also run `bun run dev` from `../../../../packages/desktop` for desktop smoke tests. Test standalone CLI behavior separately if the provider is enabled there.

## Compatibility Matrix

| Dimension | Required cases |
|---|---|
| OS | Windows native, macOS, Linux; Windows process-tree cleanup is mandatory |
| Runtime | Bun source, Node sidecar, packaged desktop, standalone CLI |
| Auth | API key, approved CLI subscription mode, missing auth, expired/invalid auth |
| CLI | installed, absent, wrong path, non-executable, `CLAUDE_CONFIG_DIR` override |
| SDK | installed, unavailable, load failure, incompatible version |
| Session | new, resumed, stale binding, missing transcript, cwd change, concurrent turn |
| Tools | no tools, one tool, parallel tools, denied tool, timeout, result too large |
| Stream | normal completion, provider error, 429, stall, disconnect, cancel |
| Packaging | fresh bundle, stale bundle detection, dependency missing from bundle |

## Observability

Use redacted structured events with:

- provider/runtime mode;
- availability result category;
- model family and effort, not prompt content;
- turn start/end and latency buckets;
- tool count and outcome category, not tool arguments;
- process exit category;
- resume hit/miss/invalidation reason;
- bridge pending/closed counts;
- cache/rate-limit status for quota reads.

Provide a diagnostic command or report that proves which runtime path is active without printing secrets.

## Release Gates

1. Anthropic approval/legal decision is recorded, or subscription mode is disabled.
2. Architecture and provider ID are finalized.
3. CLI-authenticated mode works without the external plugin.
4. Security acceptance tests pass.
5. Bun and Node sidecar tests pass.
6. Migration does not double-load the external plugin.
7. Full package typecheck and relevant tests pass from package directories.
8. Desktop dev smoke test passes; packaged build includes the dependency.
9. Rollback flag/path is verified.
10. User-facing setup, privacy, and migration documentation is localized and reviewed.
