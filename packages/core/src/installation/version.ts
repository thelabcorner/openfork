declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
  /**
   * Release version the build belongs to. Preview/dev builds stamp a synthetic
   * `0.0.0-<channel>-<timestamp>` build version for bookkeeping, but outbound
   * client identity has to present the released version line the build is based
   * on. Release builds omit this define and fall back to the build version.
   */
  const OPENCODE_RELEASE_VERSION: string
}

export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"

export const InstallationReleaseVersion =
  typeof OPENCODE_RELEASE_VERSION === "string" ? OPENCODE_RELEASE_VERSION : InstallationVersion

/**
 * Canonical OpenCode client identity for outbound HTTP requests. The OpenCode
 * Console free-tier gate rejects requests whose User-Agent is not the canonical
 * `opencode/<channel>/<version>/<client>` shape or whose version predates the
 * minimum supported release, so every consumer that identifies the client to a
 * provider must use this formatter instead of composing the string locally.
 */
export function InstallationUserAgent(client = "cli") {
  return `opencode/${InstallationChannel}/${InstallationReleaseVersion}/${client}`
}

// Version pin for `npm install @opencode-ai/plugin`. Dev builds stamp a
// synthetic version (e.g. "0.0.0-main-202609052029") that was never published
// to npm, so pinning to it fails on every config dir. Treat it like a local
// build and let the registry resolve latest instead.
export const InstallationPluginVersion =
  InstallationLocal || InstallationVersion.startsWith("0.0.0-") ? undefined : InstallationVersion
