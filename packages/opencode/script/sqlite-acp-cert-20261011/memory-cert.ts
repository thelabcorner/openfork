/// <reference types="bun" />
// Reproducible opt-in ACP memory attribution using ONLY a disposable test
// database and the compiled executable supplied with --binary.
import { resolve } from "node:path"
import { mkdir } from "node:fs/promises"
import { AcpHost } from "./lib/acp-host"
import { buildCertEnv } from "./lib/env"
import { createFixture } from "./lib/fixture"
import { aggregateProcessMetrics, ProcessSampler } from "./lib/sampler"

const i = process.argv.indexOf("--binary")
if (i < 0 || !process.argv[i + 1]) {
  console.error("Usage: bun run memory-cert.ts --binary <packaged-executable>")
  process.exit(64)
}
const binary = resolve(process.argv[i + 1]!)
const fixture = await createFixture("memory-cert")
const metricsDir = fixture.root + "/metrics"
await mkdir(metricsDir, { recursive: true })
const sampler = new ProcessSampler(metricsDir, 250)
const environment = buildCertEnv(fixture, "default").env
environment.OPENFORK_ACP_MEMORY_PROFILE = "1"
const host = AcpHost.spawn({
  binary, cwd: fixture.workspace, env: environment,
  label: "memory", requestTimeoutMs: 30000,
})
const started = performance.now()
const phases: { name: string; atMs: number }[] = []
const mark = (name: string) => phases.push({
  name, atMs: Math.round(performance.now() - started),
})
let exitCode: number | null = null
let error: string | undefined
let samples: Awaited<ReturnType<typeof sampler.stop>> = []
try {
  await sampler.start()
  await sampler.setPids([host.pid])
  await host.request("initialize", {
    protocolVersion: 1, clientCapabilities: {},
    clientInfo: { name: "openfork-memory-cert", version: "1" },
  })
  mark("initialized")
  const created = await host.request<{ sessionId?: string }>("session/new", {
    cwd: fixture.workspace, mcpServers: [],
  })
  mark("session-new")
  if (!created.sessionId) throw Error("ACP session/new returned no id")
  await host.request("session/close", { sessionId: created.sessionId })
  mark("session-closed")
  host.closeStdin()
  mark("stdin-eof")
  exitCode = await host.waitExit(20000)
  mark("exited")
} catch (cause) {
  error = String(cause)
  host.kill()
} finally {
  samples = await sampler.stop().catch(() => [])
  const series = samples.filter((x) => x.pid === host.pid)
    .map((x) => ({
      atMs: x.t - samples[0]!.t,
      rssMiB: Math.round(x.rssBytes / 1048576),
    }))
  const lines = host.stderrTail().split(/\r?\n/)
    .filter((line) => line.includes("[acp-profile]") || line.includes("[server-stop-profile]"))
  const profile = lines.map((line) => line.trim()).slice(-45)
  const report = {
    probe: "packaged-acp-memory-phases",
    exitCode, error, phases, profile,
    process: aggregateProcessMetrics(samples),
    rssTail: series.slice(-35),
    stderrProfileTruncated: host.stderrTail().length >= 7995,
    protocolViolations: host.stdoutViolations.length,
  }
  console.log(JSON.stringify(report, null, 2))
  host.dispose()
  await fixture.dispose().catch(() => {})
  if (exitCode !== 0 || error || report.protocolViolations) process.exitCode = 1
}
