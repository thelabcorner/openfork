import { Effect, Semaphore } from "effect"
import { availableParallelism } from "node:os"

/**
 * Process-wide bound on concurrently RUNNING foreground agent shell commands.
 *
 * Each concurrent session fans out parallel tool calls, and every shell tool
 * call is a child process tree (tsc, eslint, test runners, builds). With N
 * sessions those multiply into triple-digit concurrent heavy processes that
 * saturate every core; the sidecar event loop and the Electron renderer then
 * starve (late SSE heartbeats, red status blip) even though opencode's own
 * event pipeline is healthy. The bound keeps the machine responsive while
 * sessions themselves stay fully concurrent — queued commands still run, just
 * not all in the same millisecond.
 *
 * Scope notes:
 * - Foreground shell TOOL executions only (the long, heavy class). Fast
 *   one-shots (cygpath, ripgrep probes), MCP server processes, project git,
 *   snapshots, and detached background jobs are NOT gated: the former are
 *   millisecond-scale, the latter are few/long-lived/user-visible and would
 *   permanently occupy permits.
 * - Queue, never fail: exceeding the bound waits for a slot. Nesting is
 *   shallow (a waiting parent never holds a shell slot while polling a
 *   subagent), so the generous default cannot deadlock real workloads.
 * - Override with OPENCODE_MAX_CONCURRENT_SHELL_COMMANDS (positive int);
 *   0 or negative disables the bound entirely.
 */

const ENV_KEY = "OPENCODE_MAX_CONCURRENT_SHELL_COMMANDS"

function defaultPermits(): number {
  try {
    return Math.max(12, availableParallelism() * 3)
  } catch {
    return 24
  }
}

function configuredPermits(): number {
  const raw = process.env[ENV_KEY]
  if (raw === undefined || raw.trim() === "") return defaultPermits()
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return defaultPermits()
  return parsed
}

let semaphore: Semaphore.Semaphore | undefined
let semaphorePermits: number | undefined

const getSemaphore = (): Semaphore.Semaphore | undefined => {
  const permits = configuredPermits()
  if (permits <= 0) return undefined
  if (!semaphore || semaphorePermits !== permits) {
    semaphore = Semaphore.makeUnsafe(permits)
    semaphorePermits = permits
  }
  return semaphore
}

/** Test escape hatch: drop the cached semaphore so env changes take effect. */
export const resetForTesting = (): void => {
  semaphore = undefined
  semaphorePermits = undefined
}

export const withShellSlot = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
  const current = getSemaphore()
  if (!current) return effect
  return current.withPermit(effect)
}

export * as ShellConcurrency from "./shell-concurrency"
