# AX: progressive, semantically rich tool descriptions

**Status:** Implemented in the OpenFork source tree, October 9, 2026. **Do not claim live OXP deployment:** the currently connected external host has `runtime.refreshable=false` and is not automatically updated by source edits.

## Design objective

Agent Experience (AX) should optimize **verified task success per unit of time, tokens, tool calls, and risk**, not schema bytes in isolation. Blindly removing parameter descriptions can save input context but increase tool-call selection errors and repair turns. Eagerly loading complete descriptions for everything can also harm AX. The correct default is **progressive semantic disclosure**.

1. **List** remains compact and cheap: capability identity, when to use it, authority/mutation classification, and lazy/default policy. Listing cannot grant execution permission.
2. **Describe (balanced)** reveals the selected capability's executable schema and retains authored parameter descriptions subject to an 8,192-character shared budget and 1,024-character individual description limit. If a description exceeds the limit it is omitted as a whole; never cut a permission or safety caveat in half. Structural JSON Schema constraints remain intact.
3. **Describe (compact)** returns the same executable constraints with the parameter descriptions removed, for situations where the caller already understands the shape and optimizes context.
4. **Describe (full)** preserves all authored parameter descriptions without a text budget. This explicitly removes the old unconditionally restrictive policy when the agent needs richer guidance.
5. **Describe one operation** via `focusAction` when the canonical schema has a provably unique `action` or `operation` discriminated union. The response then contains **only that executable branch**, not a vaguely pruned summary. Flat multifunction schemas require an explicitly reviewed action-to-field mapping; otherwise refuse focus rather than concealing conditional requirements.

The server calculates the descriptor contract from the *exact selected schema*. The caller provides the resulting contract for `action=call`; when a nondefault documentation mode was selected, it repeats `guidanceMode` on call. When a focused schema was selected, `args.action` or `args.operation` must match the focused operation. The descriptor's `guidance` field explicitly reports available, returned and omitted authored descriptions, and an expansion path if incomplete; a zero-authored-hints case is not disguised as complete documentation. In all cases the leaf owner still validates the full canonical parameters and enforces execution-time authorization, root confinement and side-effect guards. Neither schema listing nor a contract token is an authority grant.

### API examples

**Cheap capability discovery:**

```json
{"action":"list","namespace":"openfork","query":"browser","load":"all"}
```

**Focused browser navigation schema:**

```json
{"action":"describe","namespace":"openfork","capability":"browser","focusAction":"navigate"}
```

**Focused call (same operation as the described schema):**

```json
{"action":"call","namespace":"openfork","capability":"browser","contract":"<exact contract returned by describe>","args":{"operation":"navigate","args":{"url":"https://example.com"}}}
```

This is an *argument-shape illustration*, not an assertion that the browser permits navigation to the example URL or accepts the shown nested argument. The returned actual schema is authoritative.

**All source-authored parameter guidance for a complex capability:**

```json
{"action":"describe","namespace":"openfork","capability":"openfork_swarm","guidanceMode":"full"}
```

**Calling a nondefault documentation profile:** `action=call` must include the same `guidanceMode:"full"` in addition to the returned `contract` and ordinary capability `args`. Do not send `focusAction` during call: the action itself is in `args`.

### Measured structural results (source, not deployed host)

| Input schema | Complete balanced (serialized characters) | Focused (serialized characters) | Reduction |
|---|---:|---:|---:|
| Browser: navigate | 32,165 | 557 | 98.27% |
| Swarm: task.batch | 16,081 | 2,764 | 82.81% |
| Scheduler: list | 12,777 | 336 | 97.37% |

Documentation retention was verified against representative native OXP schemas:

| Input schema | Compact characters | Balanced characters | Full characters | Balanced authored descriptions |
|---|---:|---:|---:|---:|
| Swarm | 10,574 | 16,081 | 16,081 | 74 |
| Delegated worker | 4,264 | 6,831 | 6,831 | 27 |
| Browser | 32,165 | 32,165 | 32,165 | 0 (source schema lacks authored field-level descriptions) |
| Scheduler | 10,840 | 12,777 | 12,777 | 25 |

Reproduce with `bun packages/opencode/script/measure-ax-schema.ts` at the repository root. It prints schema JSON UTF-8 bytes, source-annotation coverage, focus reductions, and two decoder-backed guards. These numbers are not actual tokenizer counts, task-cost estimates, or live deployed-runtime results. Measurements can drift with concurrent source changes. The user-visible catalog remains compact; balanced/full annotations are only loaded at describe.

## Critical schema-projection repair

Effect Schema may encode both a required nullable field and an optional field as `anyOf:[T,null]`. Previously, compaction **unconditionally removed the null branch** and flattened the remaining value, denying callers a value that a required nullable field actually accepts. Projection now retains valid nullable alternatives and their wrapper annotations. Caveat: Effect's emitted JSON Schema for some `optional(T)` fields also contains `null` although the runtime decoder rejects an explicit null; owner decoding remains authoritative. Until AST-aware schema emission is available, preserving expressibility is safer than blocking legitimate nullable values.

A second false-negative was reproduced using the canonical decoder: `Schema.Union([Schema.Number, Schema.Literal("NaN")])` accepts the literal string `"NaN"`, while the previous numeric-shortcut optimizer projected **only** `number`. The shortcut now fires only for the exact four-branch numeric sentinel pattern, retaining independently authored literals. Finally, JSON Schema `allOf` is intersection, not last-wins assignment: the projector now flattens only truly disjoint keyword fragments, preserving overlapping constraints.

**Context-performance balance:** The complete browser schema grew from the earlier 27 KB shape to 32.2 KB because it no longer discards nullable alternatives. Agents can instead request its 557-byte `navigate` focus. This is deliberate: trim unrelated branches, not values the operation can really accept. The focused-schema cache is bounded to 96 operation keys per definition, including negative lookups, to prevent malformed selectors from growing process memory indefinitely.

## Trust / correctness invariants

- **No fabricated conditional arguments.** An operation can be focused only when exactly one discriminated branch is provable, or an explicitly reviewed flat-schema action projection exists. `openfork_swarm` has reviewed projections for `delegate`, `member.batch`, and `task.batch`; these must stay synchronized with the authoritative Swarm validation rules and never silently change permissions.
- **No privilege changes.** OXP root/session permission and revocation policy must remain unchanged by presentation changes.
- **No unsafe cross-action replay.** A focused `navigate` token cannot authorize a `resize` call, nor can a `full` schema contract silently substitute for a `balanced` one.
- **No mutable contract poisoning.** Descriptor caches store serialized snapshots, not shared mutable caller objects. This is necessary because caller-side schema traversal can decorate mutable values after `describe`.
- **No hidden schema modification.** Description budgets never remove a validation keyword or partially truncate a safety warning.
- **No unbounded default prompt growth.** Only the selected capability has a rich schema loaded. `full` is explicitly requested and should not become the permanent catalog default.
- **No unsupported transport claims.** Existing native V1/Code/OXP/OFXP/ACP/MCP parity expectations still apply. This implementation modifies the OpenFork OXP capability presentation; each other provider-facing transport must prove its own actual execution semantics.

## Coverage and verification

The OpenFork-local AX skill is available at `.agents/skills/agent-experience/SKILL.md` for agents working in this repository. This tracked location is important: `.opencode/` is Git-ignored, so a previous successful local-only installation there was relocated after a byte-for-byte SHA-256 copy check. The ignored duplicate was removed. The skill references the canonical tool-surface parity policy, this design report, the prior audit, decoder tests and the schema-footprint probe. The running OXP `skill` capability successfully **loaded the tracked nested SKILL.md by explicit filePath**, returning `name=agent-experience` and `missing=[]`. Root-scoped automatic listing under the broader `webstormprojects` parent was not verified and must not be inferred from an explicit successful load. Use the repository as the Session project root for normal project-local discovery.

Source changes:
- `packages/opencode/src/oxp/schema-projection.ts`: balanced/full/compact semantic projection, optional wrapper preservation, safe discriminated action focus.
- `packages/opencode/src/oxp/capability.ts`: selected documentation mode and action-focused broker contracts; repeatable call verification, snapshot cache.
- `packages/opencode/src/oxp/worker.ts`: previously missing worker parameter annotations.
- `packages/opencode/test/oxp/schema-projection-ax.test.ts`: pure, size, negative and contract tests.
- `packages/opencode/test/oxp/capability.test.ts`: actual broker describe/call wrong-action checks, worker backward-compatibility and documentation modes.
- `packages/opencode/script/measure-ax-schema.ts`: reproducible non-mutating JSON-byte/description-coverage report with decoder-backed projection guards.

Reproduce focused verification:

```sh
cd packages/opencode
bun test test/oxp/schema-projection-ax.test.ts test/oxp/capability.test.ts --timeout 30000 --only-failures
```

Recorded outcome: **50 pass, 0 fail, 918 assertions** in the two focused AX suites, and **101 pass, 0 fail, 1,370 assertions** in the selected OXP release parity suite (October 9, 2026). The latter verifies source dispatch/parity, not live connector deployment or cross-family agent task success.

The package-wide TypeScript check still fails in concurrently modified unrelated code; the last result contained 22 errors and **none referenced the AX-modified OXP source/tests or the new schema measurement script**. Always rerun after final modifications and distinguish introduced errors from other diagnostics.

## Follow-up AX experiments

The next phase is not to add more automatic schema text. It is a **measured model A/B evaluation**:

- Pre-register representative operations that fail without descriptions (Swarm member creation, worker continuation, tool selection and result pagination) and tasks that benefit from focused schemas (browser navigation, scheduler list).
- Compare legacy stripping, balanced, focused and full in otherwise identical model runs. Track correct first calls, verified task completion, repair turns, context/token use, wall time, tool execution cost and unauthorized-side-effect regressions.
- For flat multifunction tools, replace manually reviewed projections with **domain-owned action requirements** generated into true per-action schemas. While curated mappings exist, enforce parity against the authoritative owner's validation rules; never silently mirror divergent input requirements.
- Gradually add descriptions to high-friction tools with zero authored parameter annotations (browser branches are a high-priority example). Limit prose to precise when/how/constraints and examples where measured useful.
- Publish a deployment contract-fingerprint handshake to catch stale live connectors that cannot invoke the newest source actions. Revalidate the running host, not just checkout tests.

External design references: OpenAI function-calling best practices (`https://developers.openai.com/api/docs/guides/function-calling`), MCP tool input/output schema specification (`https://modelcontextprotocol.io/specification/2025-11-25/server/tools`), and Anthropic strict tool use docs (`https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use`). These motivate the architecture; model-specific efficacy remains to be measured.
