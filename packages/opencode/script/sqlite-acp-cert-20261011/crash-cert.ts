/// <reference types="bun" />
// Hard-kill recovery certification for the packaged ACP host.
//
// Variants:
//   mid-life:  initialize + one session, then SIGKILL the host process
//   startup:   SIGKILL immediately after spawn
//
// For both: the OS process must die promptly; an independent writer probe must
// acquire the WAL writer reservation afterwards (no orphaned lock); the DB must
// pass integrity_check; and a FRESH host must complete a full
// initialize/session/new/session/close on the same database.
//
// Usage: bun run crash-cert.ts --binary <path> [--stdout-json]

import { AcpHost } from "./lib/acp-host"
import { parseArgs } from "./lib/args"
import { describeBinary } from "./lib/binary"
import { buildCertEnv } from "./lib/env"
import { countRows, createFixture, externalWriteProbe, integrityCheck } from "./lib/fixture"
import { errorRecord, nowIso } from "./lib/report"

const args = parseArgs(process.argv.slice(2))
const log = (message: string) => process.stderr.write(`[crash-cert] ${message}\n`)

if (!args.binary) {
  console.error("crash-cert requires --binary <path>")
  process.exit(64)
}
const binary = await describeBinary(args.binary)

type VariantReport = {
  variant: string
  killedPid: number
  killObserved: boolean
  writerProbeAfterKill: unknown
  integrityAfterKill: unknown
  freshHost: { initialized: boolean; sessionCreated: boolean; closed: boolean; exitCode: number | null; error?: string; stderrTail?: string }
  sessions: number | undefined
  verdict: "pass" | "fail"
}

const variantReports: VariantReport[] = []

for (const variant of ["mid-life", "startup"] as const) {
  const fixture = await createFixture(`crash-${variant}`)
  const cert = buildCertEnv(fixture, args.driver)
  let report: VariantReport | undefined
  let first: AcpHost | undefined
  let second: AcpHost | undefined

  try {
    first = AcpHost.spawn({
      binary: binary.path,
      cwd: fixture.workspace,
      env: cert.env,
      label: `crash-${variant}-first`,
      requestTimeoutMs: args.requestTimeoutMs,
    })

    if (variant === "mid-life") {
      await first.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "openfork-crash-cert", version: "1" },
      })
      const created = await first.request<{ sessionId?: string }>("session/new", { cwd: fixture.workspace, mcpServers: [] })
      if (typeof created?.sessionId !== "string") throw new Error("session/new failed before crash phase")
    } else {
      await new Promise((resolve) => setTimeout(resolve, 750))
    }

    first.kill()
    let killObserved = false
    try {
      await first.waitExit(10_000)
      killObserved = true
    } catch (error) {
      log(`kill wait failed: ${errorRecord(error).message}`)
    }

    // Direct lock-release proof after kill: only valid when the killed host had
    // already materialized the schema (mid-life). In the startup variant the
    // database file may not exist yet; probing it would create a foreign table
    // that the fail-closed migration guard then (correctly) refuses.
    const writerProbeBeforeRecovery =
      variant === "mid-life" ? await externalWriteProbe(fixture.db, { busyTimeoutMs: 3000 }) : undefined

    // Fresh host recovery on the same database.
    second = AcpHost.spawn({
      binary: binary.path,
      cwd: fixture.workspace,
      env: cert.env,
      label: `crash-${variant}-second`,
      requestTimeoutMs: args.requestTimeoutMs,
    })
    let initialized = false
    let sessionCreated = false
    let closed = false
    let recoveryError: string | undefined
    try {
      const init = await second.request<{ protocolVersion?: number }>(
        "initialize",
        { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "openfork-crash-cert", version: "1" } },
        { phase: "recovery-initialize" },
      )
      initialized = init?.protocolVersion === 1
      const created = await second.request<{ sessionId?: string }>(
        "session/new",
        { cwd: fixture.workspace, mcpServers: [] },
        { phase: "recovery-new" },
      )
      sessionCreated = typeof created?.sessionId === "string"
      if (sessionCreated) {
        await second.request("session/close", { sessionId: created.sessionId }, { phase: "recovery-close" })
        closed = true
      }
    } catch (error) {
      recoveryError = errorRecord(error).message
    }
    second.closeStdin()
    let exitCode: number | null = -1
    try {
      exitCode = await second.waitExit(30_000)
    } catch (error) {
      second.kill()
      recoveryError ??= errorRecord(error).message
    }

    const sessions = countRows(fixture.db, "session")
    const writerProbe = writerProbeBeforeRecovery ?? (await externalWriteProbe(fixture.db, { busyTimeoutMs: 3000 }))
    const integrity = integrityCheck(fixture.db)
    const freshStderr = second.stderrTail().slice(-1500)
    const verdict =
      killObserved &&
      (writerProbe as { ok?: boolean }).ok === true &&
      (integrity as { ok?: boolean }).ok === true &&
      initialized &&
      sessionCreated &&
      closed &&
      exitCode === 0
        ? "pass"
        : "fail"

    report = {
      variant,
      killedPid: first.pid,
      killObserved,
      writerProbeAfterKill: writerProbe,
      integrityAfterKill: integrity,
      freshHost: { initialized, sessionCreated, closed, exitCode, error: recoveryError, stderrTail: freshStderr },
      sessions,
      verdict,
    }
  } catch (error) {
    report = {
      variant,
      killedPid: first?.pid ?? -1,
      killObserved: false,
      writerProbeAfterKill: { error: errorRecord(error).message },
      integrityAfterKill: { error: errorRecord(error).message },
      freshHost: { initialized: false, sessionCreated: false, closed: false, exitCode: null, error: errorRecord(error).message },
      sessions: undefined,
      verdict: "fail",
    }
  } finally {
    for (const host of [first, second]) {
      if (host && host.exitCode === null) {
        host.kill()
        await host.waitExit(5000).catch(() => {})
      }
      host?.dispose()
    }
    await fixture.dispose().catch(() => {})
    if (report) variantReports.push(report)
    log(`variant=${variant} verdict=${report?.verdict} killObserved=${report?.killObserved}`)
  }
}

const report = { probe: "acp-crash-cert", finishedAt: nowIso(), binary, variants: variantReports }
const text = JSON.stringify(report, null, 2)
if (args.reportPath) {
  const { mkdir, writeFile } = await import("node:fs/promises")
  const { dirname } = await import("node:path")
  await mkdir(dirname(args.reportPath), { recursive: true })
  await writeFile(args.reportPath, text, "utf8")
}
if (args.stdoutJson) process.stdout.write(text + "\n")
else process.stdout.write(variantReports.map((item) => `${item.variant} ${item.verdict}`).join("\n") + "\n")
process.exit(variantReports.some((item) => item.verdict === "fail") ? 1 : 0)
