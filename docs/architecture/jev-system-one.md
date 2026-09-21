# Jev / System One integration

## Status

OpenFork models TypeSafe.ai Jev as a **System One semantic-inference primitive**,
not as a conversational language model. The implementation is complete enough for
first-party callers to invoke Jev independently through the local Tier-2 API and
generated SDK while ordinary agent/chat surfaces fail closed.

This document is the implementation handoff and compatibility record. It is not a
ProofGate policy specification and it does not make Jev a correctness oracle.

## Upstream findings

The relevant upstream OpenCode work landed on upstream `dev` after the local
`v1.18.30` baseline. The donor series includes the Jev hosted-proxy support beginning
with `1573a7b608` and later endpoint/documentation fixes. It was not part of the
`v1.18.31` release tag inspected during this work.

That upstream work primarily teaches the hosted OpenCode Console/Zen proxy how to
forward System One traffic. It does **not** make the local OpenCode/OpenFork runtime
understand that Jev is a non-generative computational primitive. Selectively adapting
the remote-contract knowledge was therefore safer than merging the donor branch.

The public models.dev catalog also does not yet carry a System One discriminator for
Jev and can make the OpenCode Jev entries look like ordinary OpenAI-compatible text
models. OpenFork contains one narrow compatibility classifier at catalog ingestion
until upstream metadata becomes authoritative.

## Primitive architecture

The canonical model primitive is:

```text
language
system-one
```

Legacy and custom models default to `language`. Explicit primitive metadata wins over
all compatibility rules.

The ownership direction is:

```text
packages/schema
  model primitive + browser-safe System One contracts
        |
packages/core
  models.dev/config projection
        |
packages/llm
  provider-neutral System One wire protocol
        |
packages/opencode
  provider/auth/account/identity/cost orchestration
        |
local Tier-2 HTTP API
        |
generated SDK / first-party callers
```

Important files include:

- `packages/schema/src/model.ts` - primitive contract and temporary OpenCode-hosted
  Jev compatibility classifier;
- `packages/schema/src/system-one.ts` - Noul, Choice, Score, request, result, raw
  payload, cost, timeout, account, and semantic-affinity contracts;
- `packages/core/src/models-dev.ts` and the models.dev plugin - primitive projection;
- `packages/llm/src/system-one.ts` - `/systemone` serialization, typed decoding,
  validation, cancellation, and first-failure semantics;
- `packages/opencode/src/system-one/system-one.ts` - provider/model resolution,
  OpenCode Zen/Go account routing, client identity, affinity, pricing, telemetry;
- `packages/opencode/src/server/routes/instance/httpapi/groups/system-one.ts` -
  the workspace-scoped local semantic API;
- `packages/sdk/js/src/v2/gen/*` - generated `systemOne.infer` client surface.

## Wire contract

System One receives shared structured state and one or more typed questions. A request
is structurally equivalent to:

```json
{
  "model": "jev-1.13-free",
  "state": { "candidate": "proof-42" },
  "questions": {
    "should_escalate": {
      "type": "noul",
      "instructions": "The candidate requires expensive review."
    },
    "route": {
      "type": "choice",
      "instructions": "Choose the next routing class.",
      "criteria": {
        "allow": "Continue normally",
        "inspect": "Escalate for inspection",
        "reject": "Do not spend more search budget"
      }
    },
    "quality": {
      "type": "score",
      "instructions": "Score semantic evidence quality.",
      "criteria": ["poor", "mixed", "strong"]
    }
  }
}
```

OpenFork validates known fields but preserves the complete successful upstream JSON
payload in `raw`. Noul probabilities, Choice probability maps/confidence, and Score
probabilities/confidence/legend are returned without thresholding or normalization.
Application policy owns thresholds, permissions, escalation, and fallback behavior.

## Retry and error semantics

System One deliberately does not inherit chat-style status retry/backoff. During live
verification an upstream HTTP 429 was initially retried until the semantic operation
deadline expired, incorrectly converting an immediate rate-limit into a timeout.
The System One path now requests first-failure behavior from the shared request
executor while ordinary chat retains its existing retry policy.

The local API preserves important distinctions:

- invalid semantic request / unsupported primitive;
- model not found;
- authentication / permission;
- transient rate limit;
- quota exhaustion;
- upstream provider failure;
- request timeout.

No credential value is included in result objects, diagnostics, telemetry, or tests.

## OpenCode Zen availability

OpenCode Zen currently advertises `jev-1.13`, `jev-1.13-free`, and Jev aliases as
System One models at the Zen `/v1/systemone` path.

The currently connected environment returned a fast `FreeUsageLimitError` / HTTP 429
for a live Zen Jev request. After the retry fix OpenFork reports that response as an
immediate typed rate-limit rather than a false timeout. Credential validity and free
usage entitlement remain environment/account concerns, separate from transport
correctness.

## OpenCode Go availability

OpenCode Go **does not currently advertise Jev** and OpenFork must not synthesize it.
This was checked three ways during implementation:

1. the current public Go model list contains no Jev entry;
2. an authenticated call to `/zen/go/v1/models` returned HTTP 200 with zero
   `jev-*` model IDs for the connected Go credential;
3. probing the Go System One-shaped endpoint with Jev model IDs returned a provider
   ModelError indicating the Jev model is not supported.

OpenFork is nevertheless future-compatible. If OpenCode adds an existing
`opencode-go/jev-*` catalog row before models.dev gains explicit primitive metadata,
the shared compatibility resolver classifies that row as `system-one`; it is never
copied from the Zen catalog or fabricated locally.

A future Go-hosted Jev model will therefore:

- use its Go catalog base URL and resolve to `/zen/go/v1/systemone`;
- preserve `system-one` through per-account `@zen-*` catalog clones;
- honor account selection and provider-scoped credentials;
- remain excluded from every conversational model selector.

## OpenCode credential and account precedence

Routing uses one shared authority, but the bare-model precedence intentionally differs
because only OpenCode Go has a separately connected provider credential surface:

```text
opencode (Zen):
  explicit @zen-<account> model/account selection
      > unified Zen/Go pool default
      > legacy/direct provider bearer only when the pool is empty

opencode-go:
  explicit @zen-<account> model/account selection
      > directly selected provider bearer/API key
      > unified Zen/Go pool default
```

An explicit account that no longer exists fails closed instead of silently moving to
another account. A separately connected `opencode-go` key remains authoritative for
a bare Go model even when the shared pool has a different default. Plain `opencode`
Zen does not grant that precedence to legacy `auth.json` state once the unified pool
has accounts; this prevents a stale pre-migration credential from shadowing the
user-selected vault account.

## Provider identity and semantic affinity

System One does not create a durable OpenFork Session merely to satisfy upstream
provider routing. Callers may provide `affinityID`, an opaque semantic-run identity.
OpenFork hashes it into a stable non-persisted `ses_sem_...` provider-affinity token.
Without `affinityID`, a fresh one-shot Session-shaped transport token is generated.

OpenCode-hosted calls also receive the same class of identity metadata expected by
ordinary provider traffic: canonical client/User-Agent identity, a fresh request ID,
and project identity when an instance is already available.

## Conversational isolation

System One models remain discoverable in provider/catalog inventory but cannot be
selected as ordinary generative agents. Language-only admission is enforced in:

- `Provider.getLanguage`;
- closest/default/small/housekeeping model resolution;
- desktop model store and persisted/default/agent fallback resolution;
- session composer fallback;
- legacy run/TUI model selection;
- ACP directory/config/default/explicit model selection;
- OXP Session model switching.

This is intentional. Semantic inference is called through `systemOne.infer`; it is not
a chat model with a special prompt.

## Calling from ProofGate

ProofGate should initially use the generated semantic surface in shadow mode. A
representative call is:

```ts
const response = await client.systemOne.infer({
  directory: proofgateDirectory,
  systemOneInferInput: {
    providerID: "opencode",
    modelID: "jev-1.13-free",
    affinityID: `proofgate:${campaignID}`,
    state: {
      candidate,
      verifierHistory,
      searchHistory,
      evidence,
    },
    questions: {
      should_escalate: {
        type: "noul",
        instructions: "The case warrants expensive frontier-model review.",
      },
      route: {
        type: "choice",
        instructions: "Classify the next semantic routing action.",
        criteria: {
          allow: "Continue the current search path.",
          inspect: "Escalate for deeper review.",
          reject: "Do not spend additional search budget on this path.",
        },
      },
      quality: {
        type: "score",
        instructions: "Score the usefulness of the available evidence.",
        criteria: ["poor", "mixed", "strong"],
      },
    },
  },
})
```

The deterministic ProofGate verifier remains authoritative:

```text
generator -> deterministic verifier -> verified frontier
```

Jev belongs beside that path:

```text
candidate/history -> Jev semantic judgments -> shadow diagnostics / routing signals
```

Initial shadow-mode output should be recorded and compared with deterministic
verification/search outcomes. Jev must not admit a proof, alter deterministic
correctness, or replace verification. Ordinary deterministic code owns any later
thresholds and permissions.

## Verification record

Focused verification completed during this tranche:

- schema package typecheck: clean;
- Core models.dev primitive tests: 3/3;
- LLM System One + request-executor tests: 22/22 and LLM typecheck clean;
- Zen routing/model-hook tests: 19/19;
- System One host + Zen/Go routing tests: 8/8;
- focused provider Jev/System One catalog + primitive tests: 7/7;
- provider language/housekeeping/default-projection primitive guards: 3/3;
- System One HTTP and error-contract tests: 4/4;
- ACP directory tests: 7/7;
- focused ACP service model-selection tests: 2/2;
- legacy run/TUI Jev exclusion: 1/1;
- focused OXP System One capability tests: 3/3;
- renderer provider-normalization test: 8/8;
- app TypeScript build/typecheck: clean;
- generated JavaScript SDK typecheck: clean, SDK tests 19/19.

Fresh live-runtime verification on desktop sidecar
`0.0.0-main-202609201958`:

- bare/default `opencode/jev-1.13-free` through OXP -> native
  `SystemOne.Service`: success, zero reported cost;
- explicit `zen-889db3308123` selection through the same OXP capability:
  success, zero reported cost;
- ProofGate's exact six frozen shadow-sanity states replayed through OXP:
  6/6 success, 0 schema/transport failures, $0 total reported cost,
  4,708 input tokens and 546 output tokens.
- ProofGate full package validation after the parity replay:
  150/150 tests passed under its canonical `tsx --test --test-concurrency=1`
  harness and `tsc --noEmit` completed cleanly.

The full OXP capability suite currently has one unrelated concurrent parity failure:
the native `refactor` tool is registered in the coverage ledger but does not yet
have an executable OXP target. System One-specific OXP coverage remains 3/3 green;
that separate native-tool-parity tranche is not part of this Jev implementation.

The broader worktree remains actively and concurrently modified. Earlier aggregate app
unit runs surfaced unrelated failures in layout tabs, prompt mocks, project-explorer
timing, and text-layout/pretext. They are not part of the System One implementation.
Some `packages/opencode` ad-hoc scoped typecheck invocations also report existing
WASM/declaration or TUI-JSON tooling diagnostics; focused source tests and package
typechecks above are the relevant acceptance evidence.

## Explicitly out of scope

This work does not:

- fabricate Jev availability for OpenCode Go;
- make Jev a primary conversational model;
- replace deterministic verification in ProofGate;
- define application policy thresholds or permissions from Jev probabilities;
- migrate, expose, print, or hardcode user credentials;
- make the currently exhausted/limited Zen free entitlement pass artificially;
- commit or push repository changes.

Future upstream synchronization should preserve the primitive boundary even if
models.dev later gains first-class System One metadata; at that point the temporary
OpenCode-hosted Jev compatibility classifier can be removed rather than duplicated.
