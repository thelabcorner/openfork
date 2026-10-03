import type { SidecarLivenessEvent } from "./sidecar-liveness"

export type SidecarLivenessState = SidecarLivenessEvent

/**
 * Process-owned replayable liveness projection. IPC subscribers get the latest
 * state immediately, so a renderer mounting after a detected hang cannot miss it.
 */
export function createSidecarStatus() {
  let current: SidecarLivenessState = {
    state: "starting",
    consecutiveFailures: 0,
    checkedAt: new Date(0).toISOString(),
  }
  const listeners = new Set<(state: SidecarLivenessState) => void>()
  return {
    get: () => current,
    set: (next: SidecarLivenessState) => {
      if (
        current.state === next.state &&
        current.consecutiveFailures === next.consecutiveFailures &&
        current.checkedAt === next.checkedAt
      ) return
      current = next
      // A renderer can disappear between Electron's isDestroyed check and
      // webContents.send. One dead observer must not prevent other windows
      // from receiving the status transition.
      for (const listener of listeners) {
        try {
          listener(current)
        } catch {}
      }
    },
    subscribe: (listener: (state: SidecarLivenessState) => void) => {
      listeners.add(listener)
      try {
        listener(current)
      } catch {}
      return () => listeners.delete(listener)
    },
  }
}
