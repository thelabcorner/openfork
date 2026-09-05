declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
}

export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"

// Version pin for `npm install @opencode-ai/plugin`. Dev builds stamp a
// synthetic version (e.g. "0.0.0-main-202609052029") that was never published
// to npm, so pinning to it fails on every config dir. Treat it like a local
// build and let the registry resolve latest instead.
export const InstallationPluginVersion =
  InstallationLocal || InstallationVersion.startsWith("0.0.0-") ? undefined : InstallationVersion
