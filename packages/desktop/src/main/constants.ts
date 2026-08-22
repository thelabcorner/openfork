type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

// OpenFork: auto-update stays off. The upstream publish feed points at
// anomalyco/opencode, so enabling the updater in a packaged build would let
// official OpenCode install over this fork. Re-enable only after retargeting
// electron-builder's publish config to thelabcorner/openfork.
export const UPDATER_ENABLED = false
