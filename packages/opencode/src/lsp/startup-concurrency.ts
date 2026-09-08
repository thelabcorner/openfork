import { acquireMachineSlot } from "@/util/machine-slot-budget"

export const LSP_STARTUP_ENV = "OPENCODE_MAX_CONCURRENT_LSP_STARTUPS"
export const UNSAFE_DISABLE_LSP_STARTUP_ENV = "OPENCODE_UNSAFE_DISABLE_LSP_STARTUP_LIMIT"
export const DEFAULT_LSP_STARTUPS = 1
export const MAX_SAFE_LSP_STARTUPS = 2

const SLOT_PREFIX = "opencode-lsp-startup-v1"
const SLOT_STALE_MS = 60_000

export function configuredLspStartupLimit(env: NodeJS.ProcessEnv = process.env): number | undefined {
  if (env[UNSAFE_DISABLE_LSP_STARTUP_ENV] === "1") return undefined
  const raw = env[LSP_STARTUP_ENV]
  if (raw === undefined || raw.trim() === "") return DEFAULT_LSP_STARTUPS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LSP_STARTUPS
  return Math.min(parsed, MAX_SAFE_LSP_STARTUPS)
}

/**
 * Serializes only LSP STARTUP/INITIALIZATION, not the server lifetime. Language
 * servers can legitimately remain alive for hours, so a lifetime permit would
 * deadlock later language servers. Startup is the CPU-spiky phase: several ACP
 * and Desktop hosts launching tsserver/eslint/etc. together can all index the
 * same worktree at once. Once initialized, the permit is released.
 */
export async function withLspStartupSlot<T>(body: () => Promise<T>, signal = new AbortController().signal): Promise<T> {
  const limit = configuredLspStartupLimit()
  if (limit === undefined) return body()
  const lease = await acquireMachineSlot({
    prefix: SLOT_PREFIX,
    slots: limit,
    signal,
    staleMs: SLOT_STALE_MS,
    retryMs: 100,
  })
  try {
    return await body()
  } finally {
    await lease.release().catch(() => undefined)
  }
}

export * as LspStartupConcurrency from "./startup-concurrency"
