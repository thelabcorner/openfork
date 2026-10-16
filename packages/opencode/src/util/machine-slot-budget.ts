import { Flock } from "@opencode-ai/core/util/flock"
import { Global } from "@opencode-ai/core/global"
import path from "node:path"
import { Effect, Semaphore } from "effect"

export type MachineSlotLease = Flock.Lease

export const MACHINE_SLOT_WAIT_DEFAULT_MS = 120_000
export const MACHINE_SLOT_WAIT_MAX_MS = 600_000
export const MACHINE_SLOT_WAIT_ENV = "OPENCODE_MAX_PROCESS_QUEUE_WAIT_MS"

export function configuredMachineSlotWaitMs(env: NodeJS.ProcessEnv = process.env) {
  const raw = env[MACHINE_SLOT_WAIT_ENV]
  if (!raw || !raw.trim()) return MACHINE_SLOT_WAIT_DEFAULT_MS
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0
    ? Math.min(value, MACHINE_SLOT_WAIT_MAX_MS)
    : MACHINE_SLOT_WAIT_DEFAULT_MS
}

export class MachineSlotWaitTimeoutError extends Error {
  readonly code = "OPENFORK_PROCESS_QUEUE_TIMEOUT"
  constructor(readonly lane: string, readonly waitedMs: number, readonly slots: number) {
    super(`Process queue admission timed out (${lane}, ${waitedMs}ms, ${slots} permits); no command was executed`)
    this.name = "MachineSlotWaitTimeoutError"
  }
}

type Waiting = { readonly ticket: number; readonly lane: string; readonly startedAt: number; readonly slots: number }
const waiting = new Map<number, Waiting>()
let nextTicket = 0

/** This host's authoritative admission waiters, not a claim about other processes. */
export function machineSlotWaitingSnapshot(now = performance.now()) {
  return [...waiting.values()].map((entry) => ({
    ticket: entry.ticket,
    lane: entry.lane,
    slots: entry.slots,
    waitedMs: Math.max(0, Math.floor(now - entry.startedAt)),
  }))
}

/** Queue admission ends before the admitted tool starts; only waiting times out. */
export function withLocalAdmissionSlot<A, E, R>(
  semaphore: Semaphore.Semaphore,
  effect: Effect.Effect<A, E, R> | ((remainingWaitMs: number) => Effect.Effect<A, E, R>),
  lane: string,
  permits: number,
): Effect.Effect<A, E, R> {
  const acquire = Effect.gen(function* () {
    const startedAt = performance.now()
    const waitBudgetMs = configuredMachineSlotWaitMs()
    const ticket = ++nextTicket
    waiting.set(ticket, { ticket, lane, startedAt, slots: permits })
    const outcome = yield* semaphore.take(1).pipe(
      Effect.timeoutOption(waitBudgetMs),
      Effect.ensuring(Effect.sync(() => { waiting.delete(ticket) })),
    )
    if (outcome._tag === "None")
      return yield* Effect.fail(new MachineSlotWaitTimeoutError(lane, Math.floor(performance.now() - startedAt), permits))
    // The machine-wide acquisition consumes what remains of the SAME queue
    // deadline. The local and cross-process waits must never each receive a
    // fresh 120-second budget, silently doubling worst-case latency.
    return Math.max(1, waitBudgetMs - (performance.now() - startedAt))
  // acquireUseRelease normally masks interruption during acquire. Restore
  // interruptibility while waiting so a cancelled queued Session releases its
  // queue position immediately; the enclosing bracket still owns cleanup
  // after a permit was actually granted.
  }).pipe(Effect.orDie, Effect.interruptible)
  return Effect.acquireUseRelease(
    acquire,
    (remaining) => typeof effect === "function" ? effect(remaining) : effect,
    () => semaphore.release(1),
  )
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Machine slot admission aborted"))
      return
    }
    const timer = setTimeout(done, ms)
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      reject(signal.reason ?? new Error("Machine slot admission aborted"))
    }
    function done() {
      signal.removeEventListener("abort", abort)
      resolve()
    }
    signal.addEventListener("abort", abort, { once: true })
  })
}

/**
 * Cross-process counting semaphore built from the existing crash-recovering
 * Flock primitive. Each numbered key is one machine-wide permit. A killed owner
 * is reclaimed after `staleMs`; contenders poll cheaply and interruptibly.
 */
export async function acquireMachineSlot(input: {
  prefix: string
  slots: number
  signal: AbortSignal
  staleMs?: number
  retryMs?: number
  dir?: string
  /** Entire wait, including retries. The body of an admitted process is unaffected. */
  maxWaitMs?: number
  onWait?: (waitedMs: number) => void
}): Promise<MachineSlotLease> {
  // API callers are trusted code, but an invalid numerical override must
  // never turn an otherwise bounded queue into an infinite retry loop.
  const slots = Number.isSafeInteger(input.slots) && input.slots > 0 ? Math.min(1_024, input.slots) : 1
  const staleMs = Number.isSafeInteger(input.staleMs) && input.staleMs! >= 1_000 ? input.staleMs! : 15_000
  const retryMs = Number.isSafeInteger(input.retryMs) && input.retryMs! > 0
    ? Math.max(10, Math.min(1_000, input.retryMs!))
    : 25
  const start = Math.abs(process.pid) % slots
  const maxWaitMs = Number.isSafeInteger(input.maxWaitMs) && input.maxWaitMs! > 0
    ? Math.min(MACHINE_SLOT_WAIT_MAX_MS, input.maxWaitMs!)
    : configuredMachineSlotWaitMs()
  const startedAt = performance.now()
  const ticket = ++nextTicket
  waiting.set(ticket, { ticket, lane: input.prefix, startedAt, slots })
  // Effect.tryPromise interruption can settle the calling fiber before an
  // in-flight OS filesystem promise finishes. Stop reporting that cancelled
  // Session as an active contender immediately; the async finally below
  // remains responsible for completing the cleanup as the promise unwinds.
  const onAbort = () => { waiting.delete(ticket) }
  input.signal.addEventListener("abort", onAbort, { once: true })
  if (input.signal.aborted) onAbort()

  try {
    let missedRounds = 0
    for (;;) {
      input.signal.throwIfAborted()
      for (let offset = 0; offset < slots; offset++) {
        // A slow filesystem call can consume most of the admission budget.
        // Check before *every* lock probe, not only after a full slot sweep.
        const remaining = maxWaitMs - (performance.now() - startedAt)
        if (remaining <= 0)
          throw new MachineSlotWaitTimeoutError(input.prefix, Math.floor(performance.now() - startedAt), slots)
        const slot = (start + offset) % slots
        // One-shot acquisition makes contention explicit (undefined). Never
        // mistake EACCES, ENOSPC, or corrupt lock state for an occupied permit.
        const lease = await Flock.tryAcquire(`${input.prefix}:${slot}`, {
          dir: input.dir ?? path.join(Global.Path.data, "runtime-locks"),
          signal: input.signal,
          staleMs,
          protectLiveProcess: true,
        })
        if (lease) {
          // A lease acquired after the deadline is not executable authority.
          // The deadline includes the probe itself, even when filesystem I/O
          // stalls past a timer boundary. Release before propagating timeout.
          const elapsedAfterAcquire = performance.now() - startedAt
          if (input.signal.aborted || elapsedAfterAcquire >= maxWaitMs) {
            await lease.release()
            input.signal.throwIfAborted()
            throw new MachineSlotWaitTimeoutError(input.prefix, Math.floor(elapsedAfterAcquire), slots)
          }
          return lease
        }
      }
      const elapsed = performance.now() - startedAt
      if (elapsed >= maxWaitMs) throw new MachineSlotWaitTimeoutError(input.prefix, Math.floor(elapsed), slots)
      input.onWait?.(elapsed)
      // Independent hosts otherwise poll every slot on identical 25 ms ticks:
      // exponential jitter substantially reduces metadata/file-lock traffic
      // during large swarms without sacrificing cancellation or wait bounds.
      const backoff = Math.min(250, retryMs * 2 ** Math.min(5, missedRounds++))
      const randomized = backoff * (0.8 + Math.random() * 0.4)
      await delay(Math.min(randomized, Math.max(1, maxWaitMs - elapsed)), input.signal)
    }
  } finally {
    input.signal.removeEventListener("abort", onAbort)
    waiting.delete(ticket)
  }
}

export * as MachineSlotBudget from "./machine-slot-budget"
