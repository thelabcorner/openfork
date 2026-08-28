// Child-environment handling for Claude CLI/SDK subprocesses.
//
// The official CLI owns authentication: credential overrides are removed from
// the child environment so it uses its own login store. Values are never read,
// logged, or copied — this module only returns sanitized copies.

export const AUTH_OVERRIDE_ENV_KEYS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
])

export type ChildEnv = Record<string, string | undefined>

/**
 * Build a child-process env for Claude subscription mode: starts from the
 * base env (never mutated), then deletes credential overrides so the CLI
 * exclusively owns authentication.
 */
export function buildChildEnv(baseEnv: ChildEnv = process.env): ChildEnv {
  const env: ChildEnv = { ...baseEnv }
  for (const key of AUTH_OVERRIDE_ENV_KEYS) {
    delete env[key]
  }
  return env
}

/** Home directory with Windows precedence (USERPROFILE) and POSIX fallback. */
export function homeDir(env: ChildEnv = process.env): string | undefined {
  const windows = typeof env.USERPROFILE === "string" && env.USERPROFILE.trim() ? env.USERPROFILE : undefined
  if (windows) return windows
  const posix = typeof env.HOME === "string" && env.HOME.trim() ? env.HOME : undefined
  return posix
}

/**
 * Explicit Claude config directory override. Only the path is surfaced —
 * never the credential files inside it.
 */
export function claudeConfigDir(env: ChildEnv = process.env): string | undefined {
  const value = env.CLAUDE_CONFIG_DIR
  return typeof value === "string" && value.trim() ? value : undefined
}

export * as ClaudeEnv from "./env"
