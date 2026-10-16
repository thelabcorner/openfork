import type { SidecarOxpState } from "./sidecar-protocol"

export function dispatchOxpState(
  state: SidecarOxpState,
  listeners: Iterable<(state: SidecarOxpState) => boolean | void>,
) {
  let accepted = false
  for (const listener of listeners) {
    try {
      if (listener(state) === true) accepted = true
    } catch {
      // A failed observer cannot acknowledge or prevent another owner from
      // consuming the state. The trial stays unacknowledged unless one owner
      // explicitly confirms acceptance.
    }
  }
  return accepted
}
