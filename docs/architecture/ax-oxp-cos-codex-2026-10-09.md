# OXP AX campaign: CoS prior art, Codex MCP and nested-workspace repairs

**Source checkpoint: October 9, 2026 (Central).** This is a source-and-fixture engineering record, not a claim that ChatGPT's connected OXP sidecar has loaded the checkout. All deployment claims require a fresh `openfork_info(status)` handshake and an actual live external invocation.

## Objective and decision

Optimize **verified agent task completion per elapsed time, model tokens, tool calls and operational risk**. Preserve the canonical native ToolRegistry owner, Effect services and shared Exchange semantics. OXP is an external authorized MCP principal, not a fabricated OpenFork Session. Catalog discovery never conveys permission; roots and independent grants remain hard boundaries.

## Comparative research

- [Chat On Steroids](https://github.com/totec448-spec/chat-on-steroids) demonstrates a coherent local-first workspace/tool experience: bounded read/edit/apply-patch, long-running terminal handles, optional visual interaction, delegated workers, goals/continuations and compact/resume, with explicit user control. Transfer the **experience patterns** (continuity, stable handles, partial results, inspect-before-retry, cheap discovery), not its browser-extension automation or its provider limits/account behavior. CoS's browser UI automation is explicitly not a documented public OpenAI API.
- [Codex MCP documentation](https://developers.openai.com/codex/mcp) documents STDIO and Streamable HTTP with host-side authentication, server instructions, and use from Codex CLI/IDE/ChatGPT desktop. The **first 512 characters** of server instructions should carry a usable standalone cross-tool workflow. This is now a source-level regression invariant for OXP.
- [Codex configuration reference](https://developers.openai.com/codex/config-reference) exposes per-server enable/disable, tool approval modes, startup/per-tool timeouts and per-tool output-token budgets. These are **client/host configuration**, not authorization that an MCP server can silently claim. OXP can supply truthful operation metadata and bound result payloads, but must not duplicate Codex's user approvals or assert that the current ChatGPT connector supports all Codex-host features.

## What was already present (avoid rebuilding it)

- The `OxpSurface` direct MCP tools already advertise `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` and result schemas. The Secure MCP Tunnel already owns the authenticated ChatGPT connector boundary, so OXP's loopback MCP declares `noauth` rather than adding a second model-authored OAuth path.
- Broker `capability.list/describe/call` provides progressive disclosure, balanced/compact/full guidance, focus-by-action and contract replay checks in source. Ranked discovery is shared with Exchange and separate from root authority.
- `openfork_worker`, `openfork_swarm`, scheduler, supervised Session requests, typed Git/test/read/edit/patch/write and Code Mode already offer much of CoS's multi-step agent workflow. Live Swarm describe currently exposes `member.batch` and `task.batch`; older missing-action observations must not be repeated as current facts.
- Activity recording is nonblocking observability with bounded SQLite-busy retries and sanitizer-controlled incidents. Retained host incidents are still evidence to investigate, not proof that every failure was a lock conflict or that the source fix solved the deployed incident rate.

## Implemented: nested-project semantics without extra native tools

An approved OXP root can be a monorepo parent, whereas relevant `AGENTS.md`, `.agents/skills` and TS source files live several levels below. Previously `skill.list` scanned the approved-root root directories and could return **zero** for a nested repository; `symbols.search` defaulted to the entire approved root.

The `skill` and `symbols` broker schemas now accept optional `workdir`:

1. It is **root-relative** and authorized as a second path-scoped read admission. Empty, non-directory and escaping paths fail closed. Canonical root/path validation remains owned by `OxpRoot`/`OxpAuthority`; the adapters do not invent path privileges.
2. `skill.list/search` and skill load by **name** scan only that nested project's ordinary local skill folders, through the existing shared `ExchangeSkill` reader. An **explicit** `filePath` retains existing approved-root-relative semantics, including the ability to read another approved-root skill by an intentionally named path.
3. `symbols.search` defaults to the nested directory. AST/Tree-sitter symbol intelligence stays in shared `Symbols`; an explicit `path`/`file` retains root-relative spelling but cannot search outside the selected nested worktree.
4. Default calls **without** `workdir` retain the original hot path (no additional directory `stat`). With `workdir`, one directory check and an additional egress revalidation are paid only when needed. The fresh authorized canonical directory must equal the admitted directory, preventing same-root path-identity swaps from silently substituting a different search scope. Cancellation and existing read authority still apply.
5. Neither feature creates an OpenFork Session, expands root approval or changes the privileges of `process`/Git/worker execution.

Example after deployment, using a valid root ID from `openfork_info(status)`:

```json
{"action":"call","namespace":"openfork","capability":"skill","contract":"<freshly described contract>","args":{"rootID":"<approved-root-id>","workdir":"opencode","mode":"search","query":"agent experience"}}
```

```json
{"action":"call","namespace":"openfork","capability":"symbols","contract":"<freshly described contract>","args":{"rootID":"<approved-root-id>","workdir":"opencode","action":"search","query":"OxpCapability"}}
```

The broker contracts and `workdir` fields above are **source-only until the host is redeployed**. Describing a live old capability and omitting `workdir` remains the only executable path on that old host.

## Implemented: Codex-compatible initial instructions

`OxpSurface.SERVER_INSTRUCTIONS` now begins with an explicit external-principal boundary, the exact `openfork_info(status,sessionTitle)` step, direct-tool vs brokered `list/describe/call` routing, and explicit discovery/unknown-commit warnings. A dedicated Gate-C regression asserts that **every one of those elements occurs in the first 512 characters**. The instruction change alters the static MCP surface fingerprint; the source-level `AX_IMPLEMENTATION.schemaProjection` revision also advances to `guided-focus-null-preserving-v3-nested-project-workdir`. A runtime that still advertises the former revision has not loaded this implementation, irrespective of which checkout was edited.

## Evidence and qualification

- Focused OXP capability integration tests exercised nested symbol searches and nested skill list/load, non-directory and traversal rejection, and virtualized responses. **Two focused tests passed, 30 assertions**, before subsequent default-hot-path simplification; rerun after final edits.
- A wider OXP parity run observed **101 passed / 1 failed**. The failure was a stale strict-equality assertion for a memory metadata object that now intentionally includes `timingMs` and `runtimeTimingMs`. The regression assertion has been updated to check identity and numeric latency fields, rather than erase diagnostics. Rerun the verifier to establish the final status.
- **Final release-gate rerun:** `bun packages/opencode/script/verify-oxp-native-parity.ts --quick` passed both selected gates: 4 context-footprint tests and 102 OXP broker/parity/usage/domain tests (**1,411 OXP assertions; 0 failures**). This is source fixture coverage, not live sidecar rollout certification.
- After adding canonical nested-workdir identity comparison at egress, the focused skill/symbol tests passed again (**2 tests, 30 assertions**) and the selected OXP parity verifier was rerun once more with **exit code 0**.
- Unbounded package-wide `tsc --noEmit` under Node's ~4 GB default heap **OOMed**, not a TypeScript diagnostic. Use a bounded package-specific build/typecheck lane or an explicitly larger Node heap before claiming typecheck green. The fixture tests by themselves do not prove universal TypeScript or all-protocol runtime parity.
- Reattempting the same full-package TypeScript check with an **8 GB V8 heap** did not yield type diagnostics either: TypeScript 5.8.2 itself threw `TypeError: Cannot read properties of undefined (reading 'kind')` inside `getModifierFlagsWorker`. This is a compiler-process failure, not proof of valid or invalid OXP type checking. The initial smaller-heap OOM and the larger-heap compiler exception are both recorded; avoid reporting package-wide `tsc` as passed.
- The current connected ChatGPT tool schema lacks on-demand `focusAction`/`guidanceMode` arguments even though the live backend describe reports a guidance object. This is **client/schema skew**: compare static MCP manifest and refreshed client tool list after a supported reconnect. Do not inject unknown fields into the current client schema.
- A final **live** brokered `skill` description still omitted `workdir`; this proves the checkout feature is **not deployed** on the connected host and avoids a false statement that the running MCP connector already supports it.

## Next AX experiments, prioritized by leverage

1. **Deploy-and-prove:** cleanly load source on a supported OXP sidecar; compare static fingerprint and AX behavior revision, then live-test workdir lookups, focused contracts, revocation and client reconnect. `runtime.refreshable=false` on the current host means checkout edits do not activate it.
2. **Observe persistence, don't guess:** inspect *fresh* sanitized `activity_recording` codes after redeploy, measure busy retries/parent attribution p50/p95/p99, and distinguish lock errors from constraint/schema/migration errors. Do not block successful workspace operations for auxiliary attribution and never blindly replay an uncertain write.
3. **Bound work output with fidelity:** benchmark response tokens and call count by representative tasks, retain continuation cursors, mutation receipts and exact failure codes even when client output-token budgets apply. Host-side tool approval modes should not silently become OXP policy.
4. **Codex transport parity:** verify actual initialization instructions, `tools/list`, `tools/call`, typed errors and cancellation across modern Codex STDIO/HTTP clients, old ChatGPT tunnel, ACP, Code Mode and OFXP. Discovery/list-changed notifications do not imply a mutable tool list was accepted by an already-running client.
5. **Concurrency and safety benchmarks:** include nested monorepo search cost, symlink/reparse-point substitutions, changed directories between admission/egress, concurrent source edits, typecheck memory ceilings, cancellation and provider-side permission blocks. Measure real task success and recovery turns; fixture assertions alone are not an AX win-rate claim.

## Operational non-goals

Do not automate the ChatGPT browser through undocumented interfaces, invent authorization from MCP hints, silently enlarge model or account access, clone CoS's local security model into OXP, or conflate successful dispatch with successful commit. Do not invent new Session identities for external agents. Leave unrelated active worktrees, user data and live Sessions untouched.