# Native Session human-operator authority and legacy delegation recovery

## Incident (2026-10-21)

Affected real native Session: `ses_e9ff237b5ffeBiw10zHEVFvqZh` ("OXP Usage parity implementation").
The UI reported a worker-controller-only prompt restriction and POST
`/session/:sessionID/abort` returned HTTP 400.

Verified persisted state: `metadata.workerDelegation` has a complete OXP origin
envelope whose `model.routeIntent` is `{ "kind": "auto" }`. That is a
pre-refactor, persisted discriminator; it is not a supported third routing
strategy. The canonical representation is `{ "kind": "strategy" }` (omitted
strategy means Adaptive, not a hard account pin). `Schema.is(Info)` checked
the canonical *output* shape, rather than decoding this valid stored *input*.
`workerDelegation()` therefore returned undefined, making the UI and API
treat a real worker as uncontrollable.

## Implemented invariants

1. **Decode legacy at durable read boundaries.** The existing
   `ProviderRouteIntent.Info` migrator canonicalizes saved `kind:"auto"`
   to `kind:"strategy"`. The worker-origin parser must invoke the decoder,
   not `Schema.is` on unnormalized storage. Other truly invalid/mixed origin
   records remain invalid; no guessed producer authority is fabricated.
2. **Human conversational authority is independent from aggregate ownership.**
   An interactive human follow-up on a valid delegated worker can use its
   controller-assigned selection by default, or explicitly choose its own
   model, account, variant, or agent *for that turn*. A human turn does not
   rewrite the worker's durable producer origin or default selection. An
   attempted permission mutation is still protected.
3. **Human Stop is not a producer privilege.** The ordinary native Stop API
   accepts user control over producer-owned worker, scheduled-task and
   special-agent Sessions. A real Session must still exist and match the native
   location; only the exact observed execution generation may be interrupted.
   This does not transfer authorship of immutable orchestration metadata.
4. **In-flight model switching is a user action.** Valid delegated workers may
   pass interactive model-selection preflight. The existing exact-attempt,
   no-provider-output-yet and generation-CAS guards remain in force.
5. **Failure messages must identify the real failure.** Do not tell the user
   that they are subordinate to a worker's controller. Invalid delegation
   metadata and genuine permission-override attempts must have actionable,
   distinct error semantics instead of a generic 400 wherever possible.

## Regression evidence

- `packages/core/test/session-metadata-ownership.test.ts`: explicit legacy
  OXP worker with saved `kind:"auto"` decodes as strategy and is human
  controllable; unsupported discriminators stay rejected.
- `packages/opencode/test/server/httpapi-session.test.ts`: a raw legacy
  worker can accept an initial and repeated prompt, pause, resume, stop, and
  accept a human per-turn agent override without changing its persisted
  default/metadata; explicit model-switch reaches model validation.
- Same HTTP suite: scheduled-task and special-agent Sessions accept human Stop
  without mutating their producer metadata.
- `packages/core` and `packages/opencode` TypeScript typechecking.

## Remaining architectural separation

Prompting a protected special-agent **internal transcript**, updating immutable
orchestration ownership, and controlling other disconnected OpenFork runtimes
are different operations from supervising an ordinary delegated worker.
Do not silently pretend those are ordinary worker prompts. A future explicit
human-intervention API should identify the actual runtime, scope, causal turn
and user authority, while retaining safe-boundary execution and audit
semantics. Existing broad OXP Session discovery must not be confused with a
root-scoped filesystem or process grant.

Changes are source-level until the active OpenFork native server is restarted
or reloaded. Never claim a source regression test is proof that the already
running binary has reloaded.
