# T3 — account-routing observation

**Status:** Former design task superseded by [canonical routing architecture](../../../architecture/model-picker-account-routing.md).

The UI reads provider-owned quota/account projections and shows all connected account identities. Eligibility is determined by the provider-route resolver at execution time. Adaptive / Round Robin routing runs in Core, not in a speculative UI-only router.
