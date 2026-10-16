/**
 * Shared validation for locally configured word substitutions.
 *
 * Settings should never retain a rule that the prompt send path silently
 * rejects. The list is deliberately conservative: rewriting intent-critical
 * verbs or permissions can be much worse than leaving a misspelling intact.
 */
const PROTECTED_ACTION_WORDS = new Set([
  "yes", "no", "not", "never", "always", "allow", "deny", "true", "false", "on", "off",
  "enable", "disable", "enabled", "disabled", "delete", "drop", "remove",
  "keep", "preserve", "undo", "force", "safe", "unsafe", "must", "dont",
  "permit", "permitted", "forbid", "forbidden", "grant", "revoke",
  "approve", "reject", "accept", "decline", "cancel", "confirm",
  "run", "execute", "commit", "push", "merge", "deploy", "publish", "send",
  "erase", "wipe", "destroy", "archive", "restore", "overwrite", "discard",
  "save", "stop", "start", "pause", "resume", "abort", "lock", "unlock",
  "read", "write", "public", "private", "admin", "root",
])

/** Canonical word pair, or undefined when a setting must be rejected. */

/** Normalize older persisted settings as well as new user input.
 * Invalid preexisting entries must not appear enabled in Settings. */
export function normalizePromptCorrectionRules(
  entries: Readonly<Record<string, unknown>> | undefined,
): Record<string, string> {
  const rules: Record<string, string> = {}
  for (const [source, destination] of Object.entries(entries ?? {}).slice(0, 64)) {
    const pair = normalizePromptCorrectionRule(source, destination)
    if (!pair) continue
    rules[pair.from] = pair.to
  }
  return rules
}

export function normalizePromptCorrectionRule(
  source: unknown,
  destination: unknown,
): { from: string; to: string } | undefined {
  if (typeof source !== "string" || typeof destination !== "string") return undefined
  if (!/^[a-z]{2,40}$/i.test(source) || !/^[a-z]{2,40}$/i.test(destination)) return undefined
  const from = source.toLowerCase()
  const to = destination.toLowerCase()
  if (from === to || PROTECTED_ACTION_WORDS.has(from) || PROTECTED_ACTION_WORDS.has(to)) return undefined
  return { from, to }
}
