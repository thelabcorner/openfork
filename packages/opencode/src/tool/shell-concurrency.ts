import { Effect, Semaphore } from "effect"
import { availableParallelism } from "node:os"
import { acquireMachineSlot, withLocalAdmissionSlot } from "@/util/machine-slot-budget"
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
 * - Foreground shell commands use one of three bounded lanes: heavy work shares
 *   the machine-wide heavy-tool budget; known wait/I/O commands use their own
 *   pool; and a narrow literal PowerShell metadata-listing form uses a quick
 *   pool that cannot be occupied by builds or long waits.
 * - MCP server processes, project git, snapshots, and detached background jobs
 *   are outside these foreground shell lanes. Long-lived background jobs would
 *   otherwise permanently occupy foreground permits.
 * - Queue, never fail: exceeding the bound waits for a slot.
 * - OPENCODE_MAX_CONCURRENT_SHELL_COMMANDS remains supported as a legacy
 *   fallback, but the shared heavy-tool budget owns the actual semaphore.
 */

export type ShellResourceClass = "heavy" | "io" | "quick"

export const IO_SHELL_ENV = "OPENCODE_MAX_CONCURRENT_IO_SHELLS"
export const MAX_SAFE_IO_SHELLS = 12
export const QUICK_SHELL_ENV = "OPENCODE_MAX_CONCURRENT_QUICK_SHELLS"
export const MAX_SAFE_QUICK_SHELLS = 12

const IO_SLOT_PREFIX = "opencode-io-shell-v1"
const IO_SLOT_STALE_MS = 15_000
const QUICK_SLOT_PREFIX = "opencode-quick-shell-v1"
const QUICK_SLOT_STALE_MS = 15_000
const COMPLEX_SHELL = /(?:&&|\|\||[|;<>`]|\$\(|\r|\n)/

const SAFE_POWERSHELL_LISTING = new RegExp(
  "^\\s*Get-ChildItem\\s+" +
    "(?:\"[a-z]:[\\\\/][^\"$`*?\\[\\]\\r\\n]*\"|'[a-z]:[\\\\/][^'$`*?\\[\\]\\r\\n]*')" +
    "\\s*(?:\\|\\s*Select-Object\\s+Name\\s*,\\s*Length\\s*,\\s*LastWriteTime\\s*\\|\\s*Format-Table\\s+-AutoSize\\s*)?$",
  "i",
)

// Reserve the quick lane for bounded read-only Git worktree metadata as well.
// Keep paths literal to prevent shell expansions and compound commands.
const SAFE_GIT_ROOT = String.raw`(?:'[A-Za-z]:[\\/][A-Za-z0-9 _./\\()-]*'|"[A-Za-z]:[\\/][A-Za-z0-9 _./\\()-]*"|[A-Za-z]:[\\/][A-Za-z0-9_./\\()-]*)`
const SAFE_GIT_WORKTREE_LIST = new RegExp(
  String.raw`^\s*git(?:\.exe)?(?:\s+-C\s+${SAFE_GIT_ROOT})?\s+worktree\s+list(?:\s+--porcelain)?\s*$`,
  "i",
)

const isSafePowerShellListing = (shell: string | undefined, command: string): boolean => {
  if (!shell || !/(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(shell)) return false
  // The bounded quick lane accepts only literal, non-recursive metadata listings
  // and a fixed projection pipeline. Variables, wildcards, script blocks,
  // redirection, and arbitrary pipeline stages fall back to the heavy lane.
  return SAFE_POWERSHELL_LISTING.test(command)
}

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
 * Only predictably waiting/network/log commands enter the I/O pool. The quick
 * pool has a separate exact PowerShell allowlist for literal, non-recursive
 * directory metadata listings. Other compound syntax remains heavy because a
 * harmless prefix can otherwise hide expensive work in a pipeline/conditional.
 * Unknown commands always fail conservative.
 */
export function classifyShellCommand(command: string, shell?: string): ShellResourceClass {
  if (isSafePowerShellListing(shell, command)) return "quick"
  if (SAFE_GIT_WORKTREE_LIST.test(command)) return "quick"
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

export function defaultQuickShellPermits(parallelism = safeParallelism()): number {
  return Math.min(8, Math.max(4, Math.ceil(parallelism / 3)))
}

export function configuredQuickShellPermits(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[QUICK_SHELL_ENV]
  if (raw === undefined || raw.trim() === "") return defaultQuickShellPermits()
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultQuickShellPermits()
  return Math.min(parsed, MAX_SAFE_QUICK_SHELLS)
}

type IoSharedState = {
  permits?: number
  semaphore?: Semaphore.Semaphore
}

type QuickSharedState = {
  permits?: number
  semaphore?: Semaphore.Semaphore
}

const IO_SHARED_KEY = Symbol.for("opencode.io-shell-concurrency")
const QUICK_SHARED_KEY = Symbol.for("opencode.quick-shell-concurrency")

function ioSharedState(): IoSharedState {
  const root = globalThis as typeof globalThis & { [IO_SHARED_KEY]?: IoSharedState }
  return (root[IO_SHARED_KEY] ??= {})
}

function quickSharedState(): QuickSharedState {
  const root = globalThis as typeof globalThis & { [QUICK_SHARED_KEY]?: QuickSharedState }
  return (root[QUICK_SHARED_KEY] ??= {})
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

function quickSemaphore(): { semaphore: Semaphore.Semaphore; permits: number } {
  const permits = configuredQuickShellPermits()
  const state = quickSharedState()
  if (!state.semaphore || state.permits !== permits) {
    state.semaphore = Semaphore.makeUnsafe(permits)
    state.permits = permits
  }
  return { semaphore: state.semaphore, permits }
}

const withIoShellSlot = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
  const { semaphore, permits } = ioSemaphore()
  return withLocalAdmissionSlot(semaphore,
    (remainingWaitMs) => Effect.acquireUseRelease(
      Effect.tryPromise((signal) =>
        acquireMachineSlot({ prefix: IO_SLOT_PREFIX, slots: permits, signal, staleMs: IO_SLOT_STALE_MS, maxWaitMs: remainingWaitMs }),
      ).pipe(Effect.orDie, Effect.interruptible),
      () => effect,
      (lease) => Effect.promise(() => lease.release()).pipe(Effect.ignore),
    ),
    "opencode-local-io-shell-v1",
    permits,
  )
}

const withQuickShellSlot = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
  const { semaphore, permits } = quickSemaphore()
  return withLocalAdmissionSlot(semaphore,
    (remainingWaitMs) => Effect.acquireUseRelease(
      Effect.tryPromise((signal) =>
        acquireMachineSlot({ prefix: QUICK_SLOT_PREFIX, slots: permits, signal, staleMs: QUICK_SLOT_STALE_MS, maxWaitMs: remainingWaitMs }),
      ).pipe(Effect.orDie, Effect.interruptible),
      () => effect,
      (lease) => Effect.promise(() => lease.release()).pipe(Effect.ignore),
    ),
    "opencode-local-quick-shell-v1",
    permits,
  )
}

/** Test escape hatch: drop cached semaphores so env changes take effect. */
export const resetForTesting = (): void => {
  resetHeavyProcessConcurrencyForTesting()
  const io = ioSharedState()
  io.semaphore = undefined
  io.permits = undefined
  const quick = quickSharedState()
  quick.semaphore = undefined
  quick.permits = undefined
}

export const withShellSlot = <A, E, R>(
  command: string,
  effect: Effect.Effect<A, E, R>,
  shell?: string,
): Effect.Effect<A, E, R> => {
  const resourceClass = classifyShellCommand(command, shell)
  if (resourceClass === "quick") return withQuickShellSlot(effect)
  if (resourceClass === "io") return withIoShellSlot(effect)
  return withHeavyProcessSlot(effect)
}

export { LEGACY_SHELL_ENV }

export * as ShellConcurrency from "./shell-concurrency"
