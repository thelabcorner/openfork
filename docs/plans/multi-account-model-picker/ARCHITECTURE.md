# Multi-account model picker — architecture

**Status:** Superseded design consolidated into [the canonical routing architecture](../../architecture/model-picker-account-routing.md). Historical exploratory proposals are retained in Git history, not presented as current architecture.

**Authoritative execution path:** model-picker choice → typed `ProviderRouteIntent` → Session persistence → Core provider-route resolver → transactional credential binding → exact execution lease.

**Supported Zen/Go account selection:** Adaptive or Round Robin, plus explicit hard/soft account pinning. Adaptive favors eligible quota pressure, utilization and near-term reset urgency; Round Robin uses its durable cursor. Neither overwrites a manual pin on the same selected turn.

The picker groups account-qualified catalog rows by canonical model identity, displays connected account identities from live roster state, preserves independent explicit pins, and never infers authorization from quota-bar UI. Server-owned model eligibility and route health determine execution.

**No routing policy is encoded into model identifiers.** Provider-qualified variants remain provider-specific catalog aliases, not a basis for credential substitution.
