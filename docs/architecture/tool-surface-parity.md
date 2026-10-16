# Executable tool parity across OpenFork surfaces

## Status and authority

**Normative engineering contract for new or changed OpenFork tools.** Read the repository
`AGENTS.md`, package/subtree guides, and this contract before editing tool
registration, schemas, invocation, catalogs, lazy loading, protocol adapters,
or tool-bearing clients. This document defines the required architecture;
it is **not** a claim that every existing surface is already certified.
The OXP-specific [executable parity ledger](./oxp-native-tool-parity.md)
tracks the narrower verified OXP implementation and its exceptions.

## Invariant

**A tool is complete only when every supported OpenFork entry point capable of
invoking that class of tool has a real, authorized, semantically equivalent
execution path, or a narrow, reviewed, tested, documented exception.**

The contract applies to new and changed native and lazy tools, Code Mode
discovery/invocation, and relevant built-in capability extensions. Audited
entry points include:

| Entry point | Executable-parity responsibility |
| --- | --- |
| Normal OpenFork chat/worker Sessions | Provider-visible native tool, `@tool` / lazy activation, action schema and actual invocation using the real Session context. |
| Code tool / Code Mode | Search, describe, execute and, where genuinely supported, saved/replayed invocation through the host gateway, without cloning leaf policy into the sandbox. |
| OXP | Externally authorized direct tool, progressive capability broker, or explicit existing-Session supervision/delegation. |
| OFXP / OpenFork Network | Peer-discoverable and remotely invokable capability over verified peer authority; no implicit host credential or Session inheritance. |
| ACP | Editor/agent-client tool invocation routed to the owning native Session or supported adapter, with the same actual tool behavior and permissions. |
| MCP | OpenFork's **outbound** MCP/tool-discovery and invocation gateway, plus separately authorized **inbound** MCP-serving adapters where such an export is explicitly supported. An MCP client/tool registration is **not** automatic permission to re-export it externally. |
| Other supported routes | CLI/TUI (where retained), app/desktop/mobile tool callers, APIs, plugins, worker/swarm, scheduled execution, and future transports wherever the runtime intentionally permits that tool class. |

A product surface that is only a presentation client may invoke tools through
its existing Session gateway instead of advertising a new wire protocol.
A disabled, unimplemented, unsupported, or security-incompatible entry point
must be marked as such; do not invent an endpoint solely for symmetry.
**Never label catalog/registry/coverage-only presence as executable parity.**

## Single-owner design

1. **Inventory at the producer.** Derive native IDs, dynamic registrations,
   action sets, and lazy policy from the real registry/runtime. The V1
   `ToolRegistry` is the production native-builtin inventory; current/Core
   `ToolRegistry` is a separate lifecycle, not an alternate source to silently
   substitute. The shared external semantic mapping currently lives at
   `packages/opencode/src/exchange/tool-coverage.ts`.
2. **Implement once.** Put computation, validation, filesystem/process safety,
   state ownership, and deterministic projection in an authoritative domain
   service. Surface-specific adapters should only translate identities,
   authorization, transport shapes and presentation. Do not implement one
   algorithm per native/OXP/OFXP/ACP/MCP adapter or recursively wrap brokers.
3. **Use real ownership.** Session-owned actions require an existing authorized
   Session (or legitimate worker creation when delegation is the operation).
   Workspace actions require an approved root. Global/account actions need
   explicit independent authority. Never manufacture `Tool.Context`, Session
   IDs, principals, workspace roots, peer identity, or provider credentials.
4. **Enforce at execution.** Discoverability and schema visibility are not
   grants. Authorize each leaf, revalidate where required before side effects
   and egress, respect revocation, cancellation, timeouts, receipts, root
   confinement, redaction, and output bounds. Preserve privilege
   non-escalation between native and external principals.
5. **Preserve progressive discovery.** Permanent native/OXP/OFXP hot catalogs
   stay compact; long-tail tools remain lazy. Listing/description must not
   initialize workspaces, spawn processes or hydrate Sessions without a
   justified owner. Exposing a tool through Code Mode is not permission to
   eagerly expand the provider manifest.
6. **Compare operations, not names.** Verify all meaningful action aliases,
   input/output schemas, result/error shapes, side effects, streaming or job
   lifecycle, replay/idempotency, and permissions. A "same name" listing is
   not sufficient; a narrower external action needs an explicit documented
   boundary, not a claim of full parity.

## Proof and release gate

For each added, removed, or materially changed tool, record a **tool-by-surface
matrix** from the real executable dispatchers, not from hand-authored names:

- native tool ID and actions, lazy/eager visibility, and authoritative owner;
- every applicable entry point with its executable dispatch target and
  principal/Session/root requirements;
- status: `executable`, `not-supported`, `blocked`, or
  `reviewed-exception`; actionable reasons for non-executable cells;
- evidence: focused integration test or dispatch smoke test proving execution,
  denied/unauthorized calls, revocation, lazy discoverability, and negative
  cases; include the actual runtime/build/version being exercised.

**Fail the relevant CI/release gate** when a supported surface silently drops
a new tool/action, maps to a nonexistent handler, downgrades authority,
breaks lazy loading, or has only a catalog/coverage entry without an
executable test. Make exceptions explicit, narrow and reviewed, with a reason,
owner and regression test; review them whenever ownership or authorization
changes. An unimplemented surface cannot be quietly counted as passing.

For OXP, continue running
`bun packages/opencode/script/verify-oxp-native-parity.ts` and maintaining
`docs/architecture/oxp-native-tool-parity.md`. This verifier is **OXP-only
evidence**, not universal ACP/OFXP/MCP certification. Add surface-specific
dispatcher-backed checks as their relevant adapters and harnesses exist.
For OFXP, compare the semantic mapping with the actual peer dispatcher set;
for ACP/native/Code/MCP exercise their actual host invocation route.

## Change checklist

A tool feature is not done until its owner, registry and lazy policy,
surface adapters, permission model, parity evidence, exceptions, tests,
`AGENTS.md` guidance, architecture contract, and source-tree/map entries
have been reviewed together. A new transport inherits this invariant on
day one. Preserve existing dirty/unrelated worktree edits; do not use
broad reset, restore, stash, clean, or mass rewrites to satisfy parity.
