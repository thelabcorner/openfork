# Multi-account model picker — current routing contract

**Status:** Former proposal superseded. This page reflects the implemented OpenFork routing contract; prior design iterations remain in Git history.

For OpenCode Zen / Go, there are precisely two account-selection strategies: **Adaptive** and **Round Robin**. Manual account pinning is independent and always remains selectable for connected accounts, regardless of displayed quota/cooldown state. Execution-time authorization and eligibility remain server-owned; an explicit pin must never be silently substituted.

Adaptive prefers eligible accounts with greater time-adjusted quota-expiry pressure and higher measured usage. Round Robin advances the durable account cursor without Adaptive's quota preference. Existing healthy Session bindings remain sticky until the route must legitimately fail over or the user changes selection.

Canonical design and acceptance criteria: [Model-picker account routing](../../architecture/model-picker-account-routing.md).

The separately documented WorkBuddy catalog default and OpenRouter upstream-provider choice are provider-specific behaviors, not additional Zen/Go account strategies. The old three-policy proposal is retired.
