type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

// OpenFork: the feed is fork-owned, but auto-update remains disabled until
// stable/beta/dev channel metadata and signed installer policy are explicitly
// defined. Manual checks must never fall back to an upstream OpenCode feed.
export const UPDATER_ENABLED = false
