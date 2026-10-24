# T1 — Account and model identity

**Status:** Prior proposed three-policy identity format superseded by the [canonical account-routing architecture](../../../architecture/model-picker-account-routing.md).

Hosted Zen/Go account identity is independent of the model's canonical ID and independent of the two supported selection strategies (**Adaptive** and **Round Robin**). Route intent expresses the chosen policy; an explicit account pin carries the stable account ID separately. WorkBuddy keeps its own catalog-qualified account ID contract.

Regression requirements: never embed routing strategies in model IDs, never mistake a stale qualified alias for an enrolled account, never invent an account from an empty roster, and never replace an explicitly pinned account based solely on quota estimates. Legacy persisted route records are normalized to canonical strategy intent at the schema boundary.
