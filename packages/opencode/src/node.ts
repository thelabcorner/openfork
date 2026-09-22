export { Config } from "@/config/config"
export { Server } from "./server/server"
export { bootstrap } from "./cli/bootstrap"
export { Database } from "@opencode-ai/core/database/database"
export { OxpHost } from "./oxp/host"
export { OxpRuntimeRefresh } from "./oxp/runtime-refresh"

/**
 * Canonical URL of the compiled backend artifact that owns this module
 * instance. The Desktop sidecar uses it only to content-address and reload this
 * exact artifact; OXP callers can never provide or observe the path.
 */
export const runtimeModuleUrl = import.meta.url
