/**
 * Read-only OXP idle-host startup probe. Run in a fresh Bun process from
 * packages/opencode: bun script/bench-oxp-idle-startup.ts
 *
 * This intentionally never enables a connector, starts an OXP endpoint,
 * modifies grants/roots, or touches delegated workers. Timings are in-process
 * phases, not Desktop/ChatGPT transport startup or controlled cold-cache data.
 */
const started = performance.now()
const { OxpHost } = await import("../src/oxp/host")
const imported = performance.now()

try {
  const state = await OxpHost.getState()
  const first = performance.now()
  const warmSamples: number[] = []
  for (let i = 0; i < 10; i++) {
    const t = performance.now()
    await OxpHost.getState()
    warmSamples.push(performance.now() - t)
  }
  warmSamples.sort((a, b) => a - b)
  // Compare independent successive projections with callers arriving in the
  // same microtask. These are real Config/Root reads (not synthetic delays).
  // Burst reads may coalesce only while a projection is in flight.
  const burstSize = 64
  const serialStart = performance.now()
  for (let i = 0; i < burstSize; i++) await OxpHost.getState()
  const serialStateMs = performance.now() - serialStart
  const concurrentStart = performance.now()
  const burst = await Promise.all(Array.from({ length: burstSize }, () => OxpHost.getState()))
  const concurrentStateMs = performance.now() - concurrentStart
  if (burst.some((item) => item.configRevision !== state.configRevision || item.roots.length !== state.roots.length)) {
    throw new Error("Concurrent state projections are inconsistent")
  }
  const round = (v: number) => Math.round(v * 1000) / 1000
  console.log(JSON.stringify({
    workload: "oxp-idle-host-read-only",
    importMs: round(imported - started),
    firstStateMs: round(first - imported),
    warmStateMedianMs: round(warmSamples[Math.floor(warmSamples.length / 2)]!),
    warmStateP95Ms: round(warmSamples[Math.floor((warmSamples.length - 1) * 0.95)]!),
    serial64ReadsMs: round(serialStateMs),
    concurrent64ReadsMs: round(concurrentStateMs),
    readBurstSpeedup: round(serialStateMs / Math.max(concurrentStateMs, 0.001)),
    roots: state.roots.length,
    availableRoots: state.roots.filter((root) => root.available).length,
    childEndpointState: state.endpoint.state,
    heapMiB: round(process.memoryUsage().heapUsed / (1024 * 1024)),
    note: "No endpoint start/refresh; do not compare runs without matching host load and filesystem cache state.",
  }))
} finally {
  await OxpHost.dispose()
}