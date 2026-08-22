// STARTUP-AUTOPSY: temporary boot-timing probe (lane main-proc, swarm startup-autopsy).
// Active only when STARTUP_AUTOPSY_TIMING=1; emits [STARTUP-AUTOPSY] JSON lines to stdout.
// Declared in startup-investigation/02-main-process.md ("Instrumentation edits made").
// Remove after the investigation lands.

const enabled = process.env.STARTUP_AUTOPSY_TIMING === "1"

// Captured at this module's evaluation — it is imported first in index.ts, so
// t0 approximates the start of main-bundle module evaluation.
const t0 = enabled ? performance.now() : 0

export function autopsyMark(name: string, extra?: Record<string, unknown>) {
  if (!enabled) return
  const ms = Math.round((performance.now() - t0) * 100) / 100
  console.log(
    `[STARTUP-AUTOPSY] ${JSON.stringify({ mark: name, ms, pid: process.pid, uptimeMs: Math.round(process.uptime() * 1000), ...extra })}`,
  )
}
