// Compatibility re-export: ranking semantics belong to the shared Exchange layer.
// OXP and externally scoped Code Mode must not drift to competing search models.
export { rankCapabilities } from "@/exchange/capability-search"
export { OxpCapabilitySearch } from "@/exchange/capability-search"
export type { SearchableCapability, RankedResult } from "@/exchange/capability-search"
