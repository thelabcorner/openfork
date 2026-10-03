import { OPEN_CODE_HOSTED_COMPATIBILITY_FALLBACK } from "./upstream-compat"

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
  /** Upstream OpenCode release whose hosted-service wire contract this build implements. */
  const OPENCODE_UPSTREAM_COMPAT_VERSION: string
}

export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"

export const InstallationReleaseVersion =
  typeof OPENCODE_RELEASE_VERSION === "string" ? OPENCODE_RELEASE_VERSION : InstallationVersion

export const InstallationOpenCodeCompatibilityVersion =
  typeof OPENCODE_UPSTREAM_COMPAT_VERSION === "string"
    ? OPENCODE_UPSTREAM_COMPAT_VERSION
    : InstallationReleaseVersion !== "local"
      ? InstallationReleaseVersion
      : OPEN_CODE_HOSTED_COMPATIBILITY_FALLBACK

/** OpenFork-owned/general client identity. Do not use this for upstream Zen admission. */
export function InstallationUserAgent(client = "cli") {
  return `opencode/${InstallationChannel}/${InstallationReleaseVersion}/${client}`
}

/**
 * Exact first-party wire identity emitted by upstream OpenCode.
 *
 * Upstream OpenCode currently sends `User-Agent: opencode/<InstallationVersion>`.
 * Keep this for hosted-service wire and observability parity. Anonymous Zen
 * eligibility is controlled separately by public credential and model metadata.
 */
export function OpenCodeHostedUserAgent() {
  return `opencode/${InstallationOpenCodeCompatibilityVersion}`
}

// Version pin for `npm install @opencode-ai/plugin`. Dev builds stamp a
// synthetic version (e.g. "0.0.0-main-202609052029") that was never published
// to npm, so pinning to it fails on every config dir. Treat it like a local
// build and let the registry resolve latest instead.
export const InstallationPluginVersion =
  InstallationLocal || InstallationVersion.startsWith("0.0.0-") ? undefined : InstallationVersion
