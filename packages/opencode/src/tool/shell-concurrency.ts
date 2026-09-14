import { Effect, Semaphore } from "effect"
import { availableParallelism } from "node:os"
import { acquireMachineSlot } from "@/util/machine-slot-budget"
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

export type ShellResourceClass = "heavy" | "io"

export const IO_SHELL_ENV = "OPENCODE_MAX_CONCURRENT_IO_SHELLS"
export const MAX_SAFE_IO_SHELLS = 12

const IO_SLOT_PREFIX = "opencode-io-shell-v1"
const IO_SLOT_STALE_MS = 15_000
const COMPLEX_SHELL = /(?:&&|\|\||[|;<>`]|\$\(|\r|\n)/

const simpleExecutable = (command: string) => {
  const trimmed = command.trim()
  if (!trimmed || COMPLEX_SHELL.test(trimmed)) return
  const match = /^(?:&\s*)?(?:"([^"]+)"|'([^']+)'|([^\s]+))(?:\s|$)/.exec(trimmed)
  const raw = match?.[1] ?? match?.[2] ?? match?.[3]
  if (!raw) return
  return raw.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase()
}

/**
 * Conservative shell resource classifier.
 *
 * Only commands whose local work is predictably waiting/network/log oriented
 * are admitted to the wider I/O pool. Compound shell syntax is deliberately
 * classified as heavy because a harmless prefix can otherwise hide a build in
 * a pipeline/conditional. Unknown commands always fail conservative.
 */
export function classifyShellCommand(command: string): ShellResourceClass {
  const executable = simpleExecutable(command)
  if (!executable) return "heavy"
  const lower = command.trim().toLowerCase()

  if (
    executable === "curl" ||
    executable === "curl.exe" ||
    executable === "wget" ||
    executable === "wget.exe" ||
    executable === "invoke-webrequest" ||
    executable === "invoke-restmethod" ||
    executable === "iwr" ||
    executable === "irm" ||
    executable === "sleep" ||
    executable === "start-sleep" ||
    executable === "timeout" ||
    executable === "timeout.exe" ||
    executable === "ping" ||
    executable === "ping.exe" ||
    executable === "tracert" ||
    executable === "tracert.exe" ||
    executable === "nslookup" ||
    executable === "nslookup.exe"
  )
    return "io"

  if ((executable === "docker" || executable === "docker.exe") && /^docker(?:\.exe)?\s+(?:logs|wait)\b/.test(lower))
    return "io"
  if ((executable === "kubectl" || executable === "kubectl.exe") && /^kubectl(?:\.exe)?\s+(?:logs|wait)\b/.test(lower))
    return "io"
  if (executable === "tail" && /(?:^|\s)-(?:[^\s]*f|follow(?:=|\s))/.test(lower)) return "io"
  if (executable === "get-content" && /(?:^|\s)-wait(?:\s|$)/.test(lower)) return "io"

  return "heavy"
}

export function defaultIoShellPermits(parallelism = safeParallelism()): number {
  return Math.min(8, Math.max(4, Math.ceil(parallelism / 4)))
}

function safeParallelism(): number {
  try {
    return Math.max(1, availableParallelism())
  } catch {
    return 1
  }
}

export function configuredIoShellPermits(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[IO_SHELL_ENV]
  if (raw === undefined || raw.trim() === "") return defaultIoShellPermits()
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultIoShellPermits()
  return Math.min(parsed, MAX_SAFE_IO_SHELLS)
}

type IoSharedState = {
  permits?: number
  semaphore?: Semaphore.Semaphore
}

const IO_SHARED_KEY = Symbol.for("opencode.io-shell-concurrency")

function ioSharedState(): IoSharedState {
  const root = globalThis as typeof globalThis & { [IO_SHARED_KEY]?: IoSharedState }
  return (root[IO_SHARED_KEY] ??= {})
}

function ioSemaphore(): { semaphore: Semaphore.Semaphore; permits: number } {
  const permits = configuredIoShellPermits()
  const state = ioSharedState()
  if (!state.semaphore || state.permits !== permits) {
    state.semaphore = Semaphore.makeUnsafe(permits)
    state.permits = permits
  }
  return { semaphore: state.semaphore, permits }
}

const withIoShellSlot = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
  const { semaphore, permits } = ioSemaphore()
  return semaphore.withPermit(
    Effect.acquireUseRelease(
      Effect.tryPromise((signal) =>
        acquireMachineSlot({ prefix: IO_SLOT_PREFIX, slots: permits, signal, staleMs: IO_SLOT_STALE_MS }),
      ).pipe(Effect.orDie),
      () => effect,
      (lease) => Effect.promise(() => lease.release()).pipe(Effect.ignore),
    ),
  )
}

/** Test escape hatch: drop cached semaphores so env changes take effect. */
export const resetForTesting = (): void => {
  resetHeavyProcessConcurrencyForTesting()
  const io = ioSharedState()
  io.semaphore = undefined
  io.permits = undefined
}

export const withShellSlot = <A, E, R>(
  command: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  return classifyShellCommand(command) === "io" ? withIoShellSlot(effect) : withHeavyProcessSlot(effect)
}

export { LEGACY_SHELL_ENV }

export * as ShellConcurrency from "./shell-concurrency"
