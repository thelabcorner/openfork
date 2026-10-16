# Goal natural-language authorization

Owner: `packages/core/src/goal/creation-policy.ts`. Bounded lexical preprocessing: `packages/core/src/goal/language.ts`. V1 adapter: `packages/opencode/src/tool/user-action-turn.ts`; tool: `packages/opencode/src/tool/goal.ts`.

## Contract

The user does not need to memorize `create a goal` or fill in a predefined acceptance-criteria list. Natural English instructions to establish a durable Goal, enter Goal Mode, track work as a Goal, or explicitly keep working autonomously until done can authorize creation. Natural requests to edit a focused Goal can authorize an update **in the current human turn**.

This is **not** blanket agent autonomy. A trusted, active human provenance root is always required. Previous authorized human Goal creation intent is inherited only within the bounded human-turn history, and newer relevant rejection revokes older intent. Child/host/scheduled/assistant/tool-origin turns cannot supply this authority. An ambiguous discussion, hypothetical, quote, documentation request, or educational question is not permission to create durable state. Goal cancellation and bypassing completion/verification are not delegated to the agent.

Acceptance criteria are recommended. With an authorized, nonempty title/objective and no criteria list, the Core GoalAgent creates one baseline verification criterion. It does not silently invent objective-specific requirements. Explicit draft/no-start wording overrides implicit start. This preserves the independent-audit lifecycle.

## Language pipeline

1. **Trusted human boundary** — obtain the V1 current worker-root human turn and bounded human history before language evaluation.
2. **Instruction versus data** — strip Markdown code fences, inline code, blockquotes, and bounded quoted spans from *authorization evidence*; leave the original user text and persisted objective untouched.
3. **Discourse segmentation** — analyze independently actionable clauses rather than suppressing a full message because one sentence starts with “how” or “what.” Respect explicit corrections and negation; keep newest relevant directive in a turn.
4. **Conservative spoken-English cleanup** — normalize selected fillers (“uh”, “um”, “erm”, “you know”) and command punctuation without deleting negations or indiscriminately dropping semantically meaningful words such as “like.”
5. **Explicit intent** — reviewed, bounded creation/update patterns and explanatory/nonaction exclusions. Distinguish a software-development request to *implement* `create a goal` from a request to *invoke* Goal creation.
6. **Proposal confirmation** — affirmative replies authorize creation only after a concrete assistant proposal, not after any question merely mentioning Goal Mode. “Yes, but don't start it” creates a **draft**; “Yes, but don't create a Goal” does not grant creation.
7. **Domain-owned execution** — Core resolves Session project/workspace ownership, prevents conflicting duplicate Goals, verifies the specification, preserves source human message ID, and uses the Goal state machine. Language matching does not bypass domain validation or permissions.

The language layer is deterministic: no embedding service, paid API call, inference, or untrusted text being promoted into privileged provenance.

## Evidence and caveats

The fixed development language challenges cover explicit requests, explanations, code/documentation mentions, quotation, reversal, updates, proposals, draft-vs-start, and spoken-English fillers. Tests were initially run *before* the associated changes and then used to repair failures, so passing results are **in-sample regression evidence**, not blinded production accuracy.

At the latest source validation:

- `bun test test/goal/creation-language.test.ts test/goal/creation-language-transfer.test.ts test/goal/creation-language-voice.test.ts test/goal/creation-policy-language.test.ts test/goal/creation-policy.test.ts` (from `packages/core`).
- `bun test test/goal --only-failures --timeout 30000` (from `packages/core`) for the full Goal suite.
- `bun test test/tool/goal.test.ts test/tool/user-action-turn.test.ts --only-failures` (from `packages/opencode`).
- `bun script/measure-goal-language.ts` (from `packages/core`) reports outcomes and CPU timings while asserting benchmark semantic expectations.

A warm local Bun 1.4.3 CPU microprobe measured median authorization times around **6.4 μs** for simple creation, **10 μs** for mixed instructions, **336 μs** across a 64-human-turn history, and **160 μs** for a long message after eliminating repeated reclassification of the same candidate. These are small local measurements, sensitive to host workload and not comparable to whole-agent/task latency.

**Known limits:** a deterministic English-focused parser is not general semantic understanding. Unsupported languages, unusual phrasings, contradictory long utterances, and context-dependent references can still require user clarification. Production metrics need independently labeled user requests, false-action weighting, and a deployed host. The fixed suite never uses inference; any later model-level A/B evaluation must explicitly distinguish model costs from policy-test costs.

## Design lineage

The architecture separates *what action is requested* from *whether that request authorizes mutation*, consistent with [MCP tool-security considerations](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/tools.mdx) and [OWASP AI Agent Security guidance](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html). [ACL work on negation versus implicature](https://aclanthology.org/2024.acl-long.33/) motivates paired positive/negative wording tests, rather than relying on positive-example retrieval alone.

This change is source-only. A successful local test run does not establish deployment into an already-connected OpenFork/OXP host.
