import { Effect } from "effect"
import {
  LEGACY_SHELL_ENV,
  resetHeavyProcessConcurrencyForTesting,
  withHeavyProcessSlot,
} from "./heavy-process-concurrency"

/**
 * Backward-compatible shell-specific facade over the process-wide heavy-tool
 * budget. Shell, test, typecheck, and other CPU-heavy agent tools must share one
 * admission controller so independent "reasonable" limits cannot multiply.
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
 * - Queue, never fail: exceeding the bound waits for a slot.
 * - OPENCODE_MAX_CONCURRENT_SHELL_COMMANDS remains supported as a legacy
 *   fallback, but the shared heavy-tool budget owns the actual semaphore.
 */

/** Test escape hatch: drop the cached semaphore so env changes take effect. */
export const resetForTesting = (): void => {
  resetHeavyProcessConcurrencyForTesting()
}

export const withShellSlot = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
  return withHeavyProcessSlot(effect)
}

export { LEGACY_SHELL_ENV }

export * as ShellConcurrency from "./shell-concurrency"
