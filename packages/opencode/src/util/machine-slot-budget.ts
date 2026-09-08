import { Flock } from "@opencode-ai/core/util/flock"
import { Global } from "@opencode-ai/core/global"
import path from "node:path"

export type MachineSlotLease = Flock.Lease

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
}): Promise<MachineSlotLease> {
  const slots = Math.max(1, Math.floor(input.slots))
  const staleMs = Math.max(1_000, input.staleMs ?? 15_000)
  const retryMs = Math.max(10, input.retryMs ?? 25)
  const start = Math.abs(process.pid) % slots

  for (;;) {
    input.signal.throwIfAborted()
    for (let offset = 0; offset < slots; offset++) {
      const slot = (start + offset) % slots
      try {
        return await Flock.acquire(`${input.prefix}:${slot}`, {
          dir: input.dir ?? path.join(Global.Path.data, "runtime-locks"),
          signal: input.signal,
          staleMs,
          timeoutMs: 1,
          baseDelayMs: 5,
          maxDelayMs: 5,
        })
      } catch (error) {
        if (input.signal.aborted) throw error
      }
    }
    await delay(retryMs, input.signal)
  }
}

export * as MachineSlotBudget from "./machine-slot-budget"
