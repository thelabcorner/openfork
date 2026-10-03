/**
 * Verified upstream OpenCode release baseline for unbundled/dev execution.
 *
 * Packaged builds stamp OPENCODE_UPSTREAM_COMPAT_VERSION from keep-manifest.json.
 * fork-sync verify requires this fallback to match that manifest value, so source
 * execution and packaged execution present the same upstream-hosted identity.
 */
export const OPEN_CODE_HOSTED_COMPATIBILITY_FALLBACK = "1.18.30"