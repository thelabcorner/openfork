# Multi-account model picker — user experience

**Status:** Consolidated into [canonical account-routing spec](../../architecture/model-picker-account-routing.md).

For hosted Zen/Go with a route-intent-capable picker, the routing section contains exactly two selectable items:

- **Adaptive** — prioritize eligible, highly used / expiring account allowances.
- **Round Robin** — distribute new account assignments across eligible connected accounts.

A separate **Accounts** section shows all connected identities, including those at zero visible headroom or cooling down. Selecting any displayed identity persists an explicit pin; the UI does not override it based on percentages. If execution is presently disallowed, report that exact failure without changing the pin.

Model-only configuration pickers must not display a control they cannot persist. OpenRouter and WorkBuddy retain their separate provider-specific catalog features.
