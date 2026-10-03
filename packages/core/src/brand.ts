/**
 * Canonical OpenFork product identity.
 *
 * Keep remote-service compatibility identifiers such as OPENCODE_* environment
 * variables, provider IDs, and protocol/storage keys distinct from product
 * identity. Executable naming is fork-owned: `openfork` is canonical and
 * `opencode` is compatibility-only.
 */
export const PRODUCT_NAME = "OpenFork"
export const PRODUCT_SLUG = "openfork"
export const PRODUCT_EXECUTABLE = "openfork"
export const LEGACY_PRODUCT_EXECUTABLE = "opencode"
export const PRODUCT_REPOSITORY = "thelabcorner/openfork"
export const PRODUCT_REPOSITORY_URL = "https://github.com/thelabcorner/openfork"
export const PRODUCT_REPOSITORY_API_URL = `https://api.github.com/repos/${PRODUCT_REPOSITORY}`
export const PRODUCT_RELEASES_URL = `${PRODUCT_REPOSITORY_URL}/releases`
export const PRODUCT_DOCS_URL = `${PRODUCT_REPOSITORY_URL}/tree/main/docs`
export const PRODUCT_ISSUES_URL = `${PRODUCT_REPOSITORY_URL}/issues`

