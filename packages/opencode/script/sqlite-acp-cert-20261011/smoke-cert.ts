/// <reference types="bun" />
// Single-host packaged ACP certification smoke.
//
// Real Bun --compile executable + real NDJSON ACP protocol against a disposable
// file-backed SQLite fixture. Covers: initialize -> session/new -> session/close,
// independent external writer/read lock-release proof, protocol cancellation,
// stdin-EOF exit, stdout protocol cleanliness, post-exit DB integrity, and
// fixture file-handle release. No provider network: the provider config points
// at a bounded local stall mock (or an unreachable loopback port when the
// cancellation prompt phase is skipped).
//
// Usage:
//   bun run smoke-cert.ts --binary <path> [--driver default|optout] [--stdout-json]
//   bun run smoke-cert.ts --build [--driver default] [--report <path>]

import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { AcpHost } from "./lib/acp-host"
import { parseArgs } from "./lib/args"
import { buildPackagedBinary, defaultOutputDir, describeBinary, type BinaryInfo } from "./lib/binary"
import { buildCertEnv } from "./lib/env"
import { countRows, createFixture, externalWriteProbe, integrityCheck, type Fixture } from "./lib/fixture"
import { errorRecord, nowIso, roundSummary, summarize, type Summary } from "./lib/report"
import { aggregateProcessMetrics, ProcessSampler } from "./lib/sampler"
import { startStallMock, type StallMock } from "./lib/stall-llm"

type Check = {
  name: string
  status: "pass" | "fail" | "skip"
  detail?: unknown
}

const args = parseArgs(process.argv.slice(2))
const log = (message: string) => process.stderr.write(`[smoke-cert] ${message}\n`)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const checks: Check[] = []
const pass = (name: string, detail?: unknown) => checks.push({ name, status: "pass", detail })
const fail = (name: string, detail?: unknown) => checks.push({ name, status: "fail", detail })
const skip = (name: string, detail?: unknown) => checks.push({ name, status: "skip", detail })

let binary: BinaryInfo | undefined
let buildFailure: string | undefined
let stall: StallMock | undefined
let fixture: Fixture | undefined
let sampler: ProcessSampler | undefined
let host: AcpHost | undefined
const startedAt = nowIso()
const phaseErrors: Record<string, string> = {}

try {
  if (args.binary) {
    binary = await describeBinary(args.binary)
    pass("binary.resolved", { path: binary.path, bytes: binary.bytes, version: binary.version, source: binary.source })
  } else {
    try {
      binary = await buildPackagedBinary({
        outputDir: args.outputDir ?? defaultOutputDir("smoke"),
        timeoutMs: 15 * 60_000,
        log,
      })
      binary.buildFailure
        ? fail("build.pipeline", { message: binary.buildFailure.slice(-2500), outputDir: binary.buildOutputDir })
        : pass("build.pipeline", { buildMs: binary.buildMs, outputDir: binary.buildOutputDir })
    } catch (error) {
      buildFailure = errorRecord(error).message
      fail("build.pipeline", { message: buildFailure })
    }
  }

  if (!binary) {
    const report = {
      probe: "acp-smoke-cert",
      startedAt,
      finishedAt: nowIso(),
      driver: args.driver,
      binary: { path: args.binary ?? null, buildFailure },
      checks,
      verdict: "fail",
      note: "no binary available; packaging gate failed",
    }
    // If the packaging pipeline wrote a binary before failing its own smoke,
    // locate it so the caller can still harness it explicitly via --binary.
    process.stdout.write(JSON.stringify(report, null, 2) + "\n")
    process.exit(1)
  }

  const fx = await createFixture("smoke")
  fixture = fx
  const metricsDir = join(fx.root, "metrics")
  await mkdir(metricsDir, { recursive: true })

  if (!args.skipCancellationPrompt) {
    stall = startStallMock({ stallMs: args.stallMs })
    log(`stall mock on ${stall.baseURL}`)
  }

  sampler = new ProcessSampler(metricsDir, 500)
  await sampler.start()

  const cert = buildCertEnv(fx, args.driver, { baseURL: stall?.baseURL })
  host = AcpHost.spawn({
    binary: binary.path,
    cwd: fx.workspace,
    env: cert.env,
    label: "smoke",
    requestTimeoutMs: args.requestTimeoutMs,
  })
  await sampler.setPids([host.pid])
  log(`host pid ${host.pid} driver=${args.driver}`)
  pass("host.spawned", { pid: host.pid, cwd: fx.workspace, env: cert.certKeys })

  // 1. initialize
  let initialized: { protocolVersion?: number; agentInfo?: { name?: string; version?: string } } | undefined
  try {
    initialized = await host.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "openfork-acp-cert-20261011", version: "1" },
    }, { phase: "initialize" })
    initialized?.protocolVersion === 1
      ? pass("initialize.protocolVersion", 1)
      : fail("initialize.protocolVersion", initialized)
    initialized?.agentInfo?.name
      ? pass("initialize.agentInfo", initialized.agentInfo)
      : fail("initialize.agentInfo", initialized)
  } catch (error) {
    phaseErrors.initialize = errorRecord(error).message
    fail("initialize", errorRecord(error))
  }

  // 2. session/new
  let sessionId: string | undefined
  if (initialized) {
    try {
      const created = await host.request<{ sessionId?: string; configOptions?: unknown[] }>(
        "session/new",
        { cwd: fixture.workspace, mcpServers: [] },
        { phase: "session/new" },
      )
      sessionId = created?.sessionId
      typeof sessionId === "string" && sessionId.length > 0
        ? pass("session/new.sessionId", sessionId)
        : fail("session/new.sessionId", created)
      Array.isArray(created?.configOptions) && created.configOptions.length > 0
        ? pass("session/new.configOptions", { count: created.configOptions.length })
        : fail("session/new.configOptions", created?.configOptions)
    } catch (error) {
      phaseErrors.sessionNew = errorRecord(error).message
      fail("session/new", { ...errorRecord(error), stderrTail: host?.stderrTail().slice(-600) })
    }
  } else {
    skip("session/new", "initialize failed")
  }

  // 3. External writer lock release while the host is idle and alive.
  try {
    const probe = await externalWriteProbe(fx.db, { busyTimeoutMs: 3000 })
    probe.ok ? pass("lock-release.external-write", probe) : fail("lock-release.external-write", probe)
  } catch (error) {
    fail("lock-release.external-write", errorRecord(error))
  }

  // 4. session/list membership + idle-session cancellation liveness.
  if (sessionId) {
    try {
      const listed = await host.request<{ sessions?: { sessionId?: string }[] }>(
        "session/list",
        { cwd: fx.workspace },
        { phase: "session/list" },
      )
      listed?.sessions?.some((item) => item.sessionId === sessionId)
        ? pass("session/list.membership", { count: listed.sessions.length })
        : fail("session/list.membership", listed)
    } catch (error) {
      fail("session/list", errorRecord(error))
    }

    try {
      await host.notify("session/cancel", { sessionId })
      await sleep(250)
      const liveness = await host.request<{ sessions?: unknown[] }>(
        "session/list",
        { cwd: fx.workspace },
        { phase: "cancel-liveness" },
      )
      Array.isArray(liveness?.sessions)
        ? pass("cancel.idle.liveness", { count: liveness.sessions.length })
        : fail("cancel.idle.liveness", liveness)
    } catch (error) {
      fail("cancel.idle.liveness", errorRecord(error))
    }
  } else {
    skip("session/list.membership", "no session")
    skip("cancel.idle.liveness", "no session")
  }

  // 5. Real prompt cancellation through the local stall mock (no external network).
  if (sessionId && stall && !args.skipCancellationPrompt) {
    try {
      const promptPromise = host.request<{ stopReason?: string }>(
        "session/prompt",
        { sessionId, prompt: [{ type: "text", text: "certification cancellation probe" }] },
        { timeoutMs: Math.max(args.requestTimeoutMs, 15_000), phase: "prompt" },
      )
      let reached = false
      for (let attempt = 0; attempt < 100; attempt++) {
        if (stall.requestCount() > 0) {
          reached = true
          break
        }
        await sleep(50)
      }
      if (!reached) {
        const settled = await Promise.race([
          promptPromise.then((value) => ({ settled: true as const, value })).catch((error) => ({ settled: true as const, error: errorRecord(error) })),
          sleep(500).then(() => ({ settled: false as const })),
        ])
        if (settled.settled) {
          skip("cancel.prompt.cancelled", {
            reason: "prompt settled before reaching the mock provider",
            outcome: settled,
            stderrTail: host.stderrTail().slice(-600),
          })
        } else {
          await host.notify("session/cancel", { sessionId })
          const outcome = await promptPromise.then(
            (value) => value,
            (error) => ({ error: errorRecord(error) }),
          )
          skip("cancel.prompt.cancelled", { reason: "mock never observed a request", outcome })
        }
      } else {
        await host.notify("session/cancel", { sessionId })
        const outcome = await promptPromise.then(
          (value) => value,
          (error) => ({ error: errorRecord(error) }),
        )
        "stopReason" in outcome && outcome.stopReason === "cancelled"
          ? pass("cancel.prompt.cancelled", outcome)
          : fail("cancel.prompt.cancelled", outcome)
      }
    } catch (error) {
      fail("cancel.prompt.cancelled", errorRecord(error))
    }
  } else {
    skip("cancel.prompt.cancelled", args.skipCancellationPrompt ? "disabled" : "no session or mock")
  }

  // 6. session/close
  if (sessionId) {
    try {
      await host.request("session/close", { sessionId }, { phase: "session/close" })
      pass("session/close", { sessionId })
    } catch (error) {
      fail("session/close", errorRecord(error))
    }
  } else {
    skip("session/close", "no session")
  }

  // 7. stdin EOF -> clean exit.
  host.closeStdin()
  try {
    const code = await host.waitExit(30_000)
    code === 0 ? pass("exit.code", code) : fail("exit.code", { code, stderrTail: host.stderrTail().slice(-1000) })
  } catch (error) {
    host.kill()
    fail("exit.code", errorRecord(error))
  }
  host.stdoutViolations.length === 0
    ? pass("protocol.clean-stdout")
    : fail("protocol.clean-stdout", host.stdoutViolations.slice(0, 5))
} catch (error) {
  fail("harness", errorRecord(error))
} finally {
  const samples = await sampler?.stop().catch(() => [])
  if (host) {
    if (host.exitCode === null) {
      host.kill()
      await host.waitExit(5000).catch(() => {})
    }
    host.dispose()
  }
  await stall?.stop().catch(() => {})

  // Post-exit durability and file-handle release.
  if (fixture) {
    try {
      const integrity = integrityCheck(fixture.db)
      integrity.ok ? pass("db.integrity", integrity.integrity) : fail("db.integrity", integrity)
      const sessions = countRows(fixture.db, "session")
      sessions === undefined
        ? skip("db.session-count", "session table missing")
        : pass("db.session-count", { sessions })
    } catch (error) {
      fail("db.durability", errorRecord(error))
    }
    try {
      await fixture.dispose()
      pass("fixture.released", { root: fixture.root })
    } catch (error) {
      fail("fixture.released", errorRecord(error))
    }
  }

  const methodSummary: Record<string, Summary | undefined> = {}
  if (host) {
    const byMethod = new Map<string, number[]>()
    for (const sample of host.latencies) {
      if (!sample.ok) continue
      const list = byMethod.get(sample.method)
      if (list) list.push(sample.ms)
      else byMethod.set(sample.method, [sample.ms])
    }
    for (const [method, values] of byMethod) methodSummary[method] = summarize(values)
  }

  const report = {
    probe: "acp-smoke-cert",
    startedAt,
    finishedAt: nowIso(),
    driver: args.driver,
    binary,
    buildFailure,
    checks,
    phaseErrors,
    metrics: {
      latencies: Object.fromEntries(Object.entries(methodSummary).map(([key, value]) => [key, roundSummary(value)])),
      clientEventLoopLagMs: host ? roundSummary(summarize(host.lagSamples)) : undefined,
      process: aggregateProcessMetrics(samples ?? []),
      samplerState: sampler?.state,
    },
    protocol: host
      ? {
          notifications: host.notifications.map((item) => item.method),
          serverRequests: host.serverRequests,
          stdoutViolations: host.stdoutViolations.length,
        }
      : undefined,
    verdict: checks.some((check) => check.status === "fail") ? "fail" : checks.some((check) => check.status === "skip") ? "pass-with-skips" : "pass",
  }

  const text = JSON.stringify(report, null, 2)
  if (args.reportPath) {
    await mkdir(dirname(args.reportPath), { recursive: true })
    await writeFile(args.reportPath, text, "utf8")
  }
  if (args.stdoutJson) process.stdout.write(text + "\n")
  else process.stdout.write(`verdict=${report.verdict} passed=${checks.filter((c) => c.status === "pass").length} failed=${checks.filter((c) => c.status === "fail").length} skipped=${checks.filter((c) => c.status === "skip").length}\n`)
  process.exit(report.verdict === "fail" ? 1 : 0)
}
