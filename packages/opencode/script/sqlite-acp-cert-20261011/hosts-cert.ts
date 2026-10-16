/// <reference types="bun" />
// Concurrent packaged-ACP host certification: 1/3/6 independent ACP host
// processes sharing ONE disposable WAL database, each running repeated
// initialize/session/new/session/close rounds with protocol responsiveness
// probes, a forced native writer-busy window, and cross-host DB integrity
// verification. Drivers run sequentially with fresh fixtures (never mixed).
//
// Usage:
//   bun run hosts-cert.ts --binary <path> --matrix 1,3,6 --rounds 6
//   bun run hosts-cert.ts --binary <path> --drivers-both --stdout-json

import { AcpHost } from "./lib/acp-host"
import { parseArgs, type DriverMode } from "./lib/args"
import { describeBinary } from "./lib/binary"
import { buildCertEnv } from "./lib/env"
import { acquireWriterLock, countRows, createFixture, integrityCheck, type Fixture } from "./lib/fixture"
import { errorRecord, nowIso, round, roundSummary, summarize, type Summary } from "./lib/report"
import { aggregateProcessMetrics, ProcessSampler } from "./lib/sampler"

const rawArgv = process.argv.slice(2)
// hosts-cert-specific option: removed before the shared arg parser sees it.
const matrixFlagIndex = rawArgv.indexOf("--matrix")
const matrixValue = matrixFlagIndex >= 0 ? rawArgv[matrixFlagIndex + 1] : undefined
const args = parseArgs(matrixFlagIndex >= 0 ? rawArgv.toSpliced(matrixFlagIndex, matrixValue ? 2 : 1) : rawArgv)
const log = (message: string) => process.stderr.write(`[hosts-cert] ${message}\n`)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const matrix = (() => {
  if (matrixValue === undefined) return [args.hosts]
  const values = matrixValue
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value >= 1)
  if (values.length === 0) throw new Error("--matrix requires a comma-separated list of host counts")
  return values
})()

if (!args.binary) {
  console.error("hosts-cert requires --binary <path> (build once via smoke-cert --build)")
  process.exit(64)
}
const binary = await describeBinary(args.binary)
log(`binary ${binary.path} sha256=${binary.sha256.slice(0, 16)} version=${binary.version}`)

type HostOutcome = {
  label: string
  pid: number
  exitCode: number | null
  roundsCompleted: number
  failures: { method: string; message: string }[]
  stdoutViolations: number
  latencies: Record<string, number[]>
}

type ConfigReport = {
  driver: DriverMode
  hosts: number
  roundsPerHost: number
  fixture: string
  db: string
  wallMs: number
  throughputCompletedPerSecond: number
  perHost: HostOutcome[]
  aggregate: {
    latencies: Record<string, Summary | undefined>
    failures: number
    probe: Summary | undefined
    busyHold?: {
      holdMs: number
      newSessionMs: number
      newSessionOk: boolean
      probes: Summary | undefined
    }
    process: ReturnType<typeof aggregateProcessMetrics>
    clientEventLoopLagMs: Summary | undefined
  }
  integrity: ReturnType<typeof integrityCheck>
  expectedSessions: number
  observedSessions: number | undefined
  releaseOk: boolean
  verdict: "pass" | "fail"
}

const reports: ConfigReport[] = []
const drivers: DriverMode[] = args.driversBoth ? ["default", "optout"] : [args.driver]

for (const driver of drivers) {
  for (const hosts of matrix) {
    const fixture: Fixture = await createFixture(`hosts-${driver}-${hosts}`)
    const metricsDir = `${fixture.root}/metrics`
    const sampler = new ProcessSampler(metricsDir, 500)
    await sampler.start()
    const cert = buildCertEnv(fixture, driver)
    const started = performance.now()
    const hostList: AcpHost[] = []
    const perHost: HostOutcome[] = []
    let expectedSessions = 0
    let probeValues: number[] = []
    let busyHold: ConfigReport["aggregate"]["busyHold"]

    try {
      for (let index = 0; index < hosts; index++) {
        // All hosts share the fixture HOME/XDG (same-user production shape) and
        // the same WAL database; each host owns an independent ACP process.
        const hostEnv = { ...cert.env, OPENCODE_DB: fixture.db }
        const host = AcpHost.spawn({
          binary: binary.path,
          cwd: fixture.workspace,
          env: hostEnv,
          label: `host-${index}`,
          requestTimeoutMs: args.requestTimeoutMs,
        })
        hostList.push(host)
      }
      await sampler.setPids(hostList.map((host) => host.pid))
      log(`driver=${driver} hosts=${hosts} pids=${hostList.map((host) => host.pid).join(",")}`)

      const outcomes: HostOutcome[] = hostList.map((host, index) => ({
        label: `host-${index}`,
        pid: host.pid,
        exitCode: null,
        roundsCompleted: 0,
        failures: [],
        stdoutViolations: 0,
        latencies: {},
      }))

      const record = (outcome: HostOutcome, method: string, ms: number) => {
        const list = outcome.latencies[method] ?? (outcome.latencies[method] = [])
        list.push(ms)
      }

      await Promise.all(
        hostList.map(async (host, index) => {
          const outcome = outcomes[index]!
          try {
            const initStart = performance.now()
            const initialized = await host.request<{ protocolVersion?: number }>(
              "initialize",
              { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "openfork-hosts-cert", version: "1" } },
              { phase: "initialize" },
            )
            record(outcome, "initialize", performance.now() - initStart)
            if (initialized?.protocolVersion !== 1) throw new Error("protocol negotiation failed")

            let lastProgress = performance.now()
            for (let roundIndex = 0; roundIndex < args.rounds; roundIndex++) {
              if (performance.now() - lastProgress > 60_000) throw new Error("watchdog: no round progress for 60s")
              const newStart = performance.now()
              const created = await host.request<{ sessionId?: string }>(
                "session/new",
                { cwd: fixture.workspace, mcpServers: [] },
                { phase: "session/new" },
              )
              record(outcome, "session/new", performance.now() - newStart)
              if (typeof created?.sessionId !== "string") throw new Error("session/new returned no sessionId")
              const closeStart = performance.now()
              await host.request("session/close", { sessionId: created.sessionId }, { phase: "session/close" })
              record(outcome, "session/close", performance.now() - closeStart)
              expectedSessions++
              outcome.roundsCompleted++
              lastProgress = performance.now()
            }
          } catch (error) {
            outcome.failures.push({ method: "lifecycle", message: errorRecord(error).message })
          }
        }),
      )

      // Responsiveness probes from every host while all are alive.
      await Promise.all(
        hostList.map(async (host, index) => {
          const outcome = outcomes[index]!
          for (let attempt = 0; attempt < 4; attempt++) {
            const start = performance.now()
            try {
              await host.request("session/list", { cwd: fixture.workspace }, { phase: "probe", timeoutMs: 10_000 })
              const ms = performance.now() - start
              record(outcome, "session/list", ms)
              probeValues.push(ms)
            } catch (error) {
              outcome.failures.push({ method: "session/list", message: errorRecord(error).message })
            }
            await sleep(args.probeIntervalMs)
          }
        }),
      )

      // Forced native writer-busy window against host-0.
      if (!args.skipBusyHold && hostList[0] && hostList[0].exitCode === null) {
        const host = hostList[0]
        const lock = await acquireWriterLock(fixture.db, 2000)
        const holdStart = performance.now()
        const probesDuringHold: number[] = []
        const busyPromise = host
          .request<{ sessionId?: string }>("session/new", { cwd: fixture.workspace, mcpServers: [] }, { phase: "busy-new", timeoutMs: 60_000 })
          .then(
            (value) => ({ ok: true as const, value }),
            (error) => ({ ok: false as const, error: errorRecord(error).message }),
          )
        const probePromise = (async () => {
          for (let i = 0; i < 6; i++) {
            const start = performance.now()
            try {
              await host.request("session/list", { cwd: fixture.workspace }, { phase: "busy-probe", timeoutMs: 10_000 })
              probesDuringHold.push(performance.now() - start)
            } catch {
              probesDuringHold.push(performance.now() - start)
            }
            await sleep(100)
          }
        })()
        await sleep(args.busyHoldMs)
        const heldMs = performance.now() - holdStart
        await lock.release()
        const [busyOutcome] = await Promise.all([busyPromise, probePromise])
        const newSessionMs = performance.now() - holdStart
        if (busyOutcome.ok) {
          if (typeof busyOutcome.value?.sessionId === "string") {
            expectedSessions++
            const outcome = outcomes[0]!
            outcome.roundsCompleted++
            record(outcome, "session/new-busy", newSessionMs)
            await host.request("session/close", { sessionId: busyOutcome.value.sessionId }).catch(() => {})
          }
        } else {
          outcomes[0]!.failures.push({ method: "session/new-busy", message: busyOutcome.error })
        }
        busyHold = {
          holdMs: Math.round(heldMs),
          newSessionMs: Math.round(newSessionMs),
          newSessionOk: busyOutcome.ok,
          probes: summarize(probesDuringHold),
        }
        probeValues = probeValues.concat(probesDuringHold)
      }

      // Clean shutdown on stdin EOF.
      await Promise.all(
        hostList.map(async (host, index) => {
          const outcome = outcomes[index]!
          try {
            host.closeStdin()
            const code = await host.waitExit(30_000)
            outcome.exitCode = code
            outcome.stdoutViolations = host.stdoutViolations.length
            if (code !== 0) outcome.failures.push({ method: "exit", message: `exit code ${code}` })
          } catch (error) {
            host.kill()
            outcome.exitCode = -1
            outcome.failures.push({ method: "exit", message: errorRecord(error).message })
          }
        }),
      )
      perHost.push(...outcomes)
    } catch (error) {
      perHost.push({
        label: "harness",
        pid: -1,
        exitCode: -1,
        roundsCompleted: 0,
        failures: [{ method: "harness", message: errorRecord(error).message }],
        stdoutViolations: 0,
        latencies: {},
      })
    } finally {
      const samples = await sampler.stop().catch(() => [])
      for (const host of hostList) {
        if (host.exitCode === null) {
          host.kill()
          await host.waitExit(5000).catch(() => {})
        }
        host.dispose()
      }

      const latencyTotals: Record<string, number[]> = {}
      for (const outcome of perHost) {
        for (const [method, values] of Object.entries(outcome.latencies)) {
          latencyTotals[method] = (latencyTotals[method] ?? []).concat(values)
        }
      }
      const wallMs = performance.now() - started
      const completed = perHost.reduce((total, outcome) => total + outcome.roundsCompleted, 0)
      const failures = perHost.reduce((total, outcome) => total + outcome.failures.length, 0)
      const integrity = integrityCheck(fixture.db)
      const observedSessions = countRows(fixture.db, "session")
      let releaseOk = false
      try {
        await fixture.dispose()
        releaseOk = true
      } catch {
        releaseOk = false
      }

      const verdict =
        failures === 0 &&
        integrity.ok &&
        observedSessions === expectedSessions &&
        releaseOk
          ? "pass"
          : "fail"

      reports.push({
        driver,
        hosts,
        roundsPerHost: args.rounds,
        fixture: fixture.root,
        db: fixture.db,
        wallMs: Math.round(wallMs),
        throughputCompletedPerSecond: round(completed / Math.max(1, wallMs / 1000)),
        perHost,
        aggregate: {
          latencies: Object.fromEntries(Object.entries(latencyTotals).map(([method, values]) => [method, roundSummary(summarize(values))])),
          failures,
          probe: roundSummary(summarize(probeValues)),
          busyHold: busyHold
            ? { ...busyHold, probes: roundSummary(busyHold.probes) }
            : undefined,
          process: aggregateProcessMetrics(samples ?? []),
          clientEventLoopLagMs: roundSummary(summarize(hostList.flatMap((host) => host.lagSamples))),
        },
        integrity,
        expectedSessions,
        observedSessions,
        releaseOk,
        verdict,
      })
      log(
        `driver=${driver} hosts=${hosts} verdict=${verdict} completed=${completed} expected=${expectedSessions} observed=${observedSessions} failures=${failures} wallMs=${Math.round(wallMs)}`,
      )
    }
  }
}

const report = {
  probe: "acp-hosts-cert",
  startedAt: nowIso(),
  finishedAt: nowIso(),
  binary,
  matrix,
  rounds: args.rounds,
  reports,
}
const text = JSON.stringify(report, null, 2)
if (args.reportPath) {
  const { mkdir, writeFile } = await import("node:fs/promises")
  const { dirname } = await import("node:path")
  await mkdir(dirname(args.reportPath), { recursive: true })
  await writeFile(args.reportPath, text, "utf8")
}
if (args.stdoutJson) process.stdout.write(text + "\n")
else
  process.stdout.write(
    reports.map((item) => `${item.driver} n=${item.hosts} ${item.verdict} throughput=${item.throughputCompletedPerSecond}/s failures=${item.aggregate.failures} sessions=${item.observedSessions}/${item.expectedSessions}`).join("\n") + "\n",
  )
process.exit(reports.some((item) => item.verdict === "fail") ? 1 : 0)
