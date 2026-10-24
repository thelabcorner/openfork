---
name: agent-experience
description: Audit and improve Agent Experience (AX) across OpenFork's native V1 tools, lazy tools, Code Mode, OXP, OFXP, ACP, MCP, swarms and worker workflows. Use when changing a tool schema, catalog, tool help, output, retry, delegation, authorization, context usage or recovery behavior; require executable parity and measured task success.
license: MIT
compatibility: OpenFork repository-local skill. Read docs/architecture/tool-surface-parity.md and AGENTS.md before tool changes; test with Bun.
metadata:
  version: "1.1.0"
  scope: "OpenFork"
---

# AX — Agent Experience Engineering for OpenFork

AX optimizes an authorized agent's ability to achieve **verified human-intended outcomes** with minimal wasted tool calls, context, time, money and irreversible side effects. Do not optimize schema size or tool-call count at the expense of correct execution. Do not treat AX as an official standardized score.

## Start with the actual authority and source

1. Read the root `AGENTS.md`, `docs/map/README.md`, `docs/architecture/tool-surface-parity.md` and the relevant nested package guides. Treat V1 as the production native registry, not a compatibility shim for upstream OpenCode. Inspect the actual leaf owner, schemas, negative tests, real dispatcher, configuration and host availability. Preserve unrelated dirty worktrees and concurrent changes.
2. Read `docs/architecture/agent-experience-audit-2026-10-09.md` for the initial 33-capability OXP / 43-native-tool investigation and its known deployment, persistence and discovery issues.
3. Read `docs/architecture/ax-tool-descriptions.md` before changing OXP capability description, schema projection or contract handshakes. Its documentation modes, action-focus behavior and executable decoder requirements are design constraints, **not evidence of deployed availability**.
4. Read `docs/architecture/ax-capability-discovery.md` before changing the list/search/ranking path. Distinguish retrieval Recall@k and MRR on curated fixtures from real model completion. Search aliases and action tags are not permission grants.
5. Read `docs/architecture/ax-activity-reliability.md` for activity persistence/retry diagnostics and the `implementation.ax` deployment handshake. A static MCP tool-manifest fingerprint cannot verify an on-demand broker rollout; check both. Do not infer a SQLite busy error from the generic `SqlError` label.
6. Confirm the entry point actually used: normal Session, lazy/native `@tool`, Code Mode, OXP, OFXP, ACP or MCP. Never claim cross-surface coverage from a catalog listing or unrelated unit test.

## The AX-16 audit

For each common user task, inspect these dimensions: **discovery, selection, parameter construction, context economics, execution predictability, observable state, error recovery, partial progress, replay/idempotence, verification, continuity, delegation, authorization, total task economics, version evolution, diagnostics.**

Record every finding as *observed*, *inferred*, *proposed*, or *experimentally verified*. Safety and authorization violations are hard gates; an aggregate score cannot cancel them. For an agent workflow, map intent → tool discovery → selection → argument preparation → admission/permission → execution → receipt → verification → possible replay or successor handoff.

## Make context and AX reinforce each other

- **Keep the permanent provider tool catalog small** but rich enough to select the right tool and distinguish overlaps (read/find/symbols, edit/write/patch, worker/swarm). Do not eagerly register every optional schema or hydrate workspace state on discovery.
- **Make discovery forgiving, not permissive.** Rank compact catalog entries using source-authorized names, descriptions and reviewed action names; bound matching work and retain exact load/authority visibility. Avoid all-term search that returns nothing on natural task phrasing, but never turn a synonym into an executable operation.
- **Use the shared Exchange ranking owner.** `src/exchange/capability-search.ts` is reused by OXP capability.list and External Code search. Code search may receive operation names internally from its host, but result payloads stay compact, authorized and canonical. Cursor generations must change when ranking/action maps change; never replay stale offsets over a reshuffled list.
- **Preserve semantics on demand.** The OXP capability broker supports `action=describe`, `guidanceMode=compact|balanced|full`, and `focusAction` for provably safe action projections. Full guidance must be available; do not delete useful parameter help simply to save bytes.
- **Focus on the actual operation.** Only prune branches when a typed discriminator or reviewed domain-owner action mapping proves what remains. Return an actual executable schema, not a prose-only hallucinated simplification.
- **Do not change accepted inputs when compressing JSON Schema.** Required nullable fields, authored literals, nested definitions, intersections, and conditional requirements must remain representable. Verify representative inputs against the **same decoder the leaf executes**. Runtime decoding and authorization remain authoritative.
- **Disclose information loss.** If annotations were omitted, tell the agent how to expand. If no annotations exist, report that honestly; `full` cannot invent missing documentation.
- **Preserve ability to recover.** Output summaries should carry IDs, checked state, receipts and continuation cursors; truncate only with a working expansion route. Avoid flooding the agent with unrelated schema fields and payloads.

## Tool behavior that prevents wasted work

- **Independent batches:** keep successful siblings and report each failed, skipped, already-satisfied or unknown entry. Retry only failed or absent keys.
- **Dependent operations:** prevalidate invariants, use explicit DAG dependencies and enforce atomicity where required. Never generalize independent partial success to financial or destructive writes.
- **Swarm member/task batches:** stage by failure risk, not a universal fixed count. A small staged batch is often sensible for unknown or fragile model/authority paths; use stable keys, progress receipts and status inspection.
- **Unknown outcomes:** timeouts/disconnects mean *not observed*, not necessarily *not executed*. Reconcile durable state before replaying a non-idempotent mutation.
- **Error design:** report missing/invalid parameter names, action context, already-committed work, repair options, and replay safety; do not reflect user secrets or private payloads into errors.
- **Tool-choice guidance before costly wrong-path work:** when a valid but suboptimal read would bypass an already authorized, task-appropriate capability (e.g. anonymous WebFetch of a GitHub source file instead of the lazy gh-backed github tool), classify at the owning leaf before network/side effects and return a compact successful guidance-only result. Clearly mark contentFetched=false, name an executable next operation and lazy activation route, and offer an explicit same-tool override for genuine fallbacks. Never auto-escalate credentials, fabricate a result, contaminate retrieved content with advice, or advise a tool on unsupported URLs. Prove no network/permission request occurs on the guidance branch, and prove the opt-out reaches ordinary permission checks.
- **Security:** do not fabricate a Session or privilege, expand a root, create credentials in a tool prompt, or move leaf authorization into a model-facing description.

## Implementation and proof

1. Pick a real task corpus with both unnamed-technology discovery and named-tool operation cases. Include failure injection: one bad sibling, stale patch hunk, unknown write outcome, wrong action contract, missing root, denial/revocation, blocked delegated worker, truncated output and retry.
2. Make the smallest owner-level change possible, then add decoder-backed input tests, wrong-contract/cross-action negative tests, proper authority gating and all applicable native/OXP/Code/OFXP/ACP/MCP executable parity evidence. Preserve exception documentation where transport-specific privileges differ.
3. Use `bun packages/opencode/script/measure-ax-schema.ts` for read-only **UTF-8 schema bytes and annotation coverage**, including nullable and NaN-literal decoder guards; this is *not* an agent benchmark.
   Use `bun packages/opencode/script/measure-ax-discovery.ts` for reproducible **warm CPU-only retrieval time** across the source's 33 capability descriptions; neither number measures model reasoning cost.
4. Use `bun packages/opencode/script/verify-oxp-native-parity.ts --quick` for selected source-level OXP gates, and `bun test test/oxp/schema-projection-ax.test.ts test/oxp/capability.test.ts` for focused AX contracts. Review unrelated source errors separately; do not assert whole-checkout cleanliness from a focused pass.
5. Before claiming AX efficacy, run versioned **baseline vs existing vs candidate** trajectories under identical models/tasks/config/roots with independently checked outcomes. Measure first-call validity, completion, side-effect safety, retries, tokens, tool-call count, latency and cost; include both large and small model families. Record uncertainty and regressions.

## Output

Return the audited task map, evidence and authority boundaries, observed failures, hypotheses, changes actually applied, exact test commands/outcomes, context-size measurements when appropriate, deployment identity, untested scenarios and the next falsifiable experiment.

**Highest-order rule:** A tool is agent-friendly when it lets an authorized agent accomplish and independently verify the real user's goal—not merely when its schema is short.
