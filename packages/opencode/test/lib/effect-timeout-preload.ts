/** Align the Effect semantic test deadline with the package's Bun test limit.
 * A preload runs before test modules; CLI --timeout alone is not visible there.
 * Preserve caller overrides for explicitly shorter/longer test runs.
 */
if (!process.env.OPENCODE_EFFECT_TEST_TIMEOUT_MS?.trim()) {
  process.env.OPENCODE_EFFECT_TEST_TIMEOUT_MS = "30000"
}
