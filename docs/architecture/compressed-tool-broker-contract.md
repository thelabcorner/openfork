# Compressed tool broker contract

## Purpose

OpenFork deliberately compresses large tool families behind stable provider-facing gateways to reduce prompt-prefix size, preserve provider cache stability, and improve top-level tool selection. That compression is an invariant. It must not be undone merely to make delegated schemas easier for the model to see.

The failure mode is different: a gateway can hide the delegated input schema while still allowing `call` directly. The model then guesses nested arguments from memory or names, producing avoidable validation failures and sometimes repeatedly calling the wrong shape.

The architectural rule is therefore:

> **Hidden delegated schema => descriptor contract before delegated call.**

If the permanent provider schema does not contain the complete delegated input shape, the model must load that exact descriptor on demand before execution. The runtime must enforce the rule; prose alone is insufficient.

## Protocol

All hidden-schema brokers use the shared `BrokerContract` protocol:

1. `list` is optional discovery. Use it only when the delegated target id/name is unknown.
2. `describe` reveals exactly one target's current instructions and complete input schema.
3. `describe` also returns a `broker-descriptor-v1` envelope and opaque `broker-v1:<fingerprint>` contract.
4. `call` must echo that exact contract together with arguments satisfying the described schema.
5. The broker recomputes the contract from the live target descriptor before touching the delegated leaf. Missing, guessed, cross-target, or stale contracts are rejected before leaf execution.
6. Leaf validation, permissions, authority, plugin hooks, and execution still belong to the delegated tool. The descriptor contract is not authorization.

The contract is stateless. Its fingerprint binds the broker id, target id, model-facing instructions, and input schema. This avoids mutable per-session broker state and remains safe under concurrent sessions and tool refreshes. If a tool/plugin reload changes its instructions or schema between `describe` and `call`, the old contract becomes invalid and the model must describe again.

For OXP, this stateless descriptor contract is independent from the
[ChatGPT parent-tool epoch](./oxp-parent-tool-epoch.md). A `capability.describe`
or `capability.call` inside the same observed parent epoch does **not** renew the
25-minute ChatGPT tool deadline. Broker handshakes must therefore
remain compact, and long-running work should establish durable worker continuation
before the parent epoch expires rather than relying on additional broker calls.

### Explicit `@tool` fast path

An explicit `@<lazy-tool-id>` user mention is already strong target intent. `SessionTools.explicitLazyToolContext` may inject that target's exact descriptor/schema and matching contract into the request-only turn context. That pre-seed satisfies the discovery phase for that exact descriptor, so the model should call the stable `tool` broker directly with the supplied contract rather than wasting a `describe` round trip.

### Narrow eager intent facades

Compression applies to **tool-family breadth**, not to every common intent regardless of measured
failure cost. A broad lazy tool may expose one or more small eager facades when all of the following
hold:

1. the facade represents one high-frequency/high-value intent with a substantially smaller schema
   than the hidden tool family;
2. it delegates to the exact same domain/service owner rather than reimplementing semantics;
3. it does not expose host-derived authority such as project/session/member/task/run ids;
4. its provider-visible schema is manifest-stable across Session permission state;
5. owner-level denies also deny the facade, so the alias cannot widen an existing permission
   boundary;
6. the broad/long-tail surface remains lazy.

Native Swarm is the measured precedent:

| Surface | Exposure | Purpose |
| --- | --- | --- |
| `swarm` | lazy | broad coordinator/admin/read/recovery surface |
| `swarm_create` | eager | creation-only facade over the same `SwarmCommand.delegate` workflow |
| `swarm_member` | eager | Session-derived worker intent: settle/send/inbox/shared state/publish |

A live coordinator required three attempts to create a Swarm through the generic broker, including a
broker-vs-target action mistake and a malformed nested call. After the creation-only facade was added,
the same model created a Swarm on its **first and only `swarm_create` invocation**, with zero broker
calls before creation and zero malformed creation attempts. The broad `swarm` schema remains hidden.

This exception is intentionally narrow. Do **not** solve hidden-schema failures by making the whole
delegated family eager, by auto-repairing guessed nested arguments, or by allowing a facade to invent
authority that the hidden owner would reject.

## Repository census

### Hidden-schema brokers: descriptor contract required

| Surface                                    | Compression                                                                        | Contract behavior                                                                             |
| ------------------------------------------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `tool` (`src/tool/access.ts`)              | Stable gateway over lazy `Tool.Def`s (built-ins plus eligible custom/plugin tools) | `describe` required before brokered `call`, except exact harness-preseeded `@tool` descriptor |
| `browser` (`src/tool/browser.ts`)          | One provider tool over 30 mature browser operations                                | Every operation `call` requires that operation's current `describe` contract                  |
| OXP `capability` (`src/oxp/capability.ts`) | Stable OXP long-tail capability gateway                                            | Brokered `capability action=call` requires a contract; direct OXP hot tools remain one-step   |

### Multiplexed but complete-schema surfaces: no extra handshake

These surfaces are compressed/multiplexed, but their permanent outer schema already contains the fields needed to execute their branches. Requiring an additional discovery call would add latency without adding information.

| Surface      | Compression                     | Why no descriptor contract is needed                                    |
| ------------ | ------------------------------- | ----------------------------------------------------------------------- |
| `web`        | `webfetch` + `websearch`        | All action/provider/query/url fields are present in the provider schema |
| `find`       | `glob` + `grep`                 | The outer schema directly exposes `glob`, `grep`, `path`, and `include` |
| `background` | job management + monitor launch | Action-specific fields are directly represented in the outer schema     |
| `swarm_create` | one direct creation intent | Complete creation schema is provider-visible; broad Swarm administration remains lazy |
| `swarm_member` | one direct managed-worker intent family | Complete worker-intent schema is provider-visible and authority is derived from caller Session |

### Code Mode `execute`

Code Mode is OpenFork's default MCP composition strategy. It compresses MCP calls behind `execute`, using a token-budgeted inline catalog plus `$codemode.search` when the complete catalog does not fit. Exact selected signatures are therefore available to the generated program without the opaque nested-`args` contract problem addressed here. Code Mode remains a separate orchestration protocol; do not retrofit `BrokerContract` handshakes into its generated tool calls.

## Construction invariant

`withContractedBrokerArgsSchema()` is the provider-schema projection for V1 brokers whose nested `args` remain opaque. It refuses to construct such a schema unless the broker exposes the `contract` field. `BrokerContract.describe()` standardizes the model-facing descriptor envelope, while `BrokerContract.violation()` / `assertCurrent()` enforce freshness before execution.

The regression suite also scans `src/**/*.ts` for the current opaque nested-args signature (`args: Schema.optional(Schema.Unknown)`) and requires every such source to use `BrokerContract`. Adding another compressed hidden-schema broker without the protocol therefore fails tests instead of silently shipping speculative-call behavior.

## Non-negotiable properties

- Do not expand all delegated schemas back into the permanent provider manifest.
- Do not use mutable per-session "described target" state as proof; concurrent calls and refreshes make it fragile.
- Do not allow "call directly if you already know the args" for a hidden-schema broker. Remembered args may be stale.
- Do not treat the descriptor contract as permission or authority. Leaf authorization remains live and independent.
- Do not require the handshake for multiplexed tools whose complete executable schema is already provider-visible.
- Narrow eager intent facades may exist only when they preserve the same owner/authority semantics and leave long-tail breadth compressed.
- A provider-visible alias must never bypass a deny on its underlying owner.
- Preserve the explicit-mention pre-seed path so strong user intent does not pay a redundant round trip.

## Validation gates

Focused tests cover:

- provider projection refuses opaque args without a contract field;
- contract fingerprints are deterministic and change with instructions/schema;
- undescribed calls fail before the delegated leaf executes;
- cross-target/stale contracts are rejected;
- JSON-stringified nested objects continue to normalize safely;
- OXP broker calls require contracts while direct OXP hot-tool dispatch remains unchanged;
- source-level opaque broker census requires `BrokerContract` adoption;
- narrow eager Swarm facades remain provider-visible while broad `swarm` remains lazy;
- `swarm_create` contains no broker fields or host-derived authority ids, stays under its schema-size ceiling, and inherits broad `swarm` denies.
