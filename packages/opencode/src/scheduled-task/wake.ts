type Driver = () => Promise<void>

interface InstalledDriver {
  readonly token: number
  readonly driver: Driver
}

let sequence = 0
let installed: InstalledDriver | undefined

/**
 * Process-local wake port for the one native ScheduledTaskRunner.
 *
 * The desktop sidecar owns both the ordinary OpenFork server/runner and OXP in
 * one utility process. Tier-0 adapters can therefore request an immediate
 * scheduler reconciliation without importing/instantiating the runner graph.
 * Durable generation reconciliation remains the crash/lost-wake fallback.
 *
 * The returned disposer is token-fenced so teardown of an older scoped runner
 * cannot clear a newer driver's registration.
 */
export function install(driver: Driver | undefined) {
  if (!driver) {
    installed = undefined
    return () => undefined
  }
  const token = ++sequence
  installed = { token, driver }
  return () => {
    if (installed?.token === token) installed = undefined
  }
}

export async function poke() {
  const current = installed
  if (!current) return false
  await current.driver()
  return true
}

export * as ScheduledTaskWake from "./wake"
