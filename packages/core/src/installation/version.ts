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
 * Canonical OpenCode client identity for outbound HTTP requests.
 *
 * Keep this wire-compatible with upstream OpenCode: Console parses the token
 * immediately after `opencode/` as the client version. Fork/channel/client
 * metadata belongs in the dedicated x-opencode-* headers, not in this value.
 *
 * Preview/dev builds still use the released semver they are based on so a
 * synthetic `0.0.0-dev.*` build version does not trip Console's minimum
 * version gate.
 */
export function formatInstallationUserAgent(version: string) {
  return `opencode/${version}`
}

export function InstallationUserAgent() {
  return formatInstallationUserAgent(InstallationReleaseVersion)
}

// Version pin for `npm install @opencode-ai/plugin`. Dev builds stamp a
// synthetic version (e.g. "0.0.0-main-202609052029") that was never published
// to npm, so pinning to it fails on every config dir. Treat it like a local
// build and let the registry resolve latest instead.
export const InstallationPluginVersion =
  InstallationLocal || InstallationVersion.startsWith("0.0.0-") ? undefined : InstallationVersion
