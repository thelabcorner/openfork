import { spawn, type ChildProcess } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { ago, probeReady, readClientStatus, readPollHealth, type TunnelHealth } from "./tunnel-health"
import {
  NO_OUTAGE,
  boundedTunnelLineReader,
  describeNetworkError,
  isAuthFailure,
  isUnreachableError,
  outageRecovered,
  parseLoopbackHealthUrl,
  redactTunnelText,
  restartBackoffMs,
  routeObservation,
  type Outage,
} from "./tunnel-contract"

export type OxpTunnelState = "disconnected" | "starting" | "connected" | "offline" | "auth-failed" | "unavailable"
export type OxpTunnelReport = {
  state: OxpTunnelState
  detail?: string
  handshakeAt?: number
  health?: TunnelHealth | null
}

export type TunnelHandle = { stop: () => Promise<void> }
export class TunnelError extends Error {}

export type TunnelLaunch = {
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

export type TunnelSupervisorLog = (
  message: string,
  extra?: Record<string, unknown>,
  level?: "info" | "warn" | "error",
) => void

const READY_TIMEOUT_MS = 60_000
const WATCH_INTERVAL_MS = 15_000
const OFFLINE_RECHECK_MS = 5_000
const UNREADY_CONFIRM_MS = 15_000

const TUNNEL_ENV_PASSTHROUGH = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
])

export function buildTunnelChildEnv(
  overrides: Readonly<Record<string, string>>,
  source: Readonly<NodeJS.ProcessEnv> = process.env,
) {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (!TUNNEL_ENV_PASSTHROUGH.has(key.toUpperCase())) continue
    env[key] = value
  }
  return { ...env, ...overrides }
}

async function terminateTree(child: ChildProcess | null, timeoutMs = 6_000) {
  if (!child?.pid) return true
  if (process.platform !== "win32") {
    const pid = child.pid
    const groupAlive = () => {
      try {
        process.kill(-pid, 0)
        return true
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH"
      }
    }
    if (!groupAlive()) return true
    try {
      process.kill(-pid, "SIGTERM")
    } catch {
      return !groupAlive()
    }
    const deadline = Date.now() + timeoutMs
    const killAt = Date.now() + Math.max(250, Math.floor(timeoutMs / 2))
    let killed = false
    while (Date.now() < deadline) {
      if (!groupAlive()) return true
      if (!killed && Date.now() >= killAt) {
        killed = true
        try {
          process.kill(-pid, "SIGKILL")
        } catch {
          if (!groupAlive()) return true
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return !groupAlive()
  }

  // The pinned tunnel-client is a single-process runtime. If Electron has
  // already observed that exact child exit, there is no live root left for
  // taskkill /T to address; treating taskkill's inevitable "not found" as a
  // kill failure would turn ordinary crash recovery into a terminal state.
  // Live roots still require successful /T /F below, which is the Windows
  // process-tree proof used for directed shutdown/restart.
  if (child.exitCode !== null || child.signalCode !== null) return true
  const waitForRootExit = async () => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) return true
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return child.exitCode !== null || child.signalCode !== null
  }
  try {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" })
    const taskkillSucceeded = await new Promise<boolean>((resolve) => {
      let done = false
      const finish = (value: boolean) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => {
        try {
          killer.kill()
        } catch {}
        finish(false)
      }, Math.min(timeoutMs, 4_000))
      timer.unref?.()
      killer.once("close", (code) => finish(code === 0))
      killer.once("error", () => finish(false))
    })
    if (!taskkillSucceeded) {
      // taskkill can report a non-zero status when the root exits during its
      // snapshot/termination race. We still invoked the only Windows tree-kill
      // primitive (/T /F); accept the race only if Electron independently
      // observes the owned root close within the same bounded proof window.
      return waitForRootExit()
    }
  } catch {
    return false
  }
  return waitForRootExit()
}

async function readHealthUrl(file: string) {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(file, "r")
    const buffer = Buffer.allocUnsafe(513)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > 512) return null
    return parseLoopbackHealthUrl(buffer.subarray(0, bytesRead).toString("utf8"))
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export async function startTunnelSupervisor(input: {
  binary: string
  launch: (healthFile: string) => TunnelLaunch
  secrets: readonly string[]
  report: (report: OxpTunnelReport) => void
  log?: TunnelSupervisorLog
}): Promise<TunnelHandle> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "openfork-oxp-"))
  const healthFile = path.join(workDir, "health.url")
  const launchSpec = input.launch(healthFile)

  type Run = {
    proc: ChildProcess
    healthBase: string | null
    health: TunnelHealth | null
    lastHandshake: number | null
    outage: Outage
    unreachableReason: string
    unreadySince: number
    lastError: string
    shown: "connected" | "offline" | "unknown" | null
  }

  let stopped = false
  let current: Run | null = null
  let timer: NodeJS.Timeout | null = null
  let retirement: Promise<boolean> = Promise.resolve(true)
  let attempts = 0
  let stopPromise: Promise<void> | undefined

  const clearTimer = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  const publish = (report: OxpTunnelReport) => {
    if (!stopped) input.report(report)
  }
  const showConnected = (run: Run) => {
    if (stopped || current !== run) return
    run.shown = "connected"
    publish({
      state: "connected",
      detail: run.lastHandshake
        ? `Connected. Last verified OpenAI handshake ${ago(run.lastHandshake)}. Pick the tunnel in ChatGPT.`
        : "Connected. Pick the tunnel in ChatGPT.",
      ...(run.lastHandshake ? { handshakeAt: run.lastHandshake } : {}),
      health: run.health,
    })
  }
  const showOffline = (run: Run) => {
    if (stopped || current !== run) return
    run.shown = "offline"
    publish({
      state: "offline",
      detail: `This PC cannot reach OpenAI — ${run.unreachableReason}. Last verified handshake ${ago(run.lastHandshake)}. The tunnel keeps retrying automatically.`,
      ...(run.lastHandshake ? { handshakeAt: run.lastHandshake } : {}),
      health: run.health,
    })
  }
  const showUnknown = (run: Run) => {
    if (stopped || current !== run) return
    run.shown = "unknown"
    publish({
      state: "starting",
      detail: "Tunnel client is locally ready, but a fresh OpenAI control-plane handshake has not been proven yet.",
      health: run.health,
    })
  }
  const noteUnreachable = (run: Run, raw: string) => {
    if (stopped || current !== run) return
    run.unreachableReason = describeNetworkError(raw)
    if (run.outage.since) return
    run.outage = { since: Date.now(), handshakeBefore: run.lastHandshake }
    input.log?.("OpenAI tunnel route is retrying after a network failure", { reason: run.unreachableReason }, "info")
  }
  const refreshHealth = async (run: Run) => {
    if (!run.healthBase) return null
    const [poll, client] = await Promise.all([readPollHealth(run.healthBase), readClientStatus(run.healthBase)])
    if (stopped || current !== run) return undefined
    if (poll?.lastSuccessMs) run.lastHandshake = poll.lastSuccessMs
    if (outageRecovered(run.outage, run.lastHandshake)) {
      run.outage = NO_OUTAGE
      run.unreachableReason = ""
    }
    run.health = {
      pollErrors: poll?.errors ?? null,
      uptimeSeconds: client?.uptimeSeconds ?? null,
      route: client?.route ?? null,
      probe: client?.probe ?? null,
      clientVersion: client?.version ?? null,
    }
    // A present metrics endpoint with a zero/absent successful-poll timestamp
    // is not remote-route proof. Preserve null so routeObservation cannot turn
    // local readiness into a false "connected" state.
    return poll?.lastSuccessMs ?? null
  }

  const scheduleRestart = (run: Run, detail: string, terminate: boolean) => {
    if (stopped || current !== run) return
    current = null
    clearTimer()
    attempts += 1
    const delay = restartBackoffMs(attempts)
    publish({ state: "starting", detail: `${detail} Reconnecting in ${Math.round(delay / 1000)}s…` })
    retirement = (async () => {
      const retired = !terminate || (await terminateTree(run.proc))
      if (stopped) return retired
      if (!retired) {
        input.report({ state: "unavailable", detail: "The previous tunnel client could not be stopped safely." })
        stopped = true
        return false
      }
      timer = setTimeout(() => {
        timer = null
        void launch()
      }, delay)
      timer.unref?.()
      return true
    })()
  }

  const watch = (run: Run) => {
    if (stopped || current !== run || !run.healthBase) return
    clearTimer()
    timer = setTimeout(() => {
      void (async () => {
        if (stopped || current !== run || !run.healthBase) return
        const ready = await probeReady(run.healthBase)
        if (stopped || current !== run) return
        if (!ready.ok) {
          const now = Date.now()
          if (!run.unreadySince) {
            run.unreadySince = now
            watch(run)
            return
          }
          if (now - run.unreadySince < UNREADY_CONFIRM_MS) {
            watch(run)
            return
          }
          scheduleRestart(run, ready.detail || "Tunnel client stopped responding.", true)
          return
        }
        run.unreadySince = 0
        const poll = await refreshHealth(run)
        if (poll === undefined || stopped || current !== run) return
        const observation = routeObservation(poll, run.lastHandshake, run.outage)
        if (observation === "connected") showConnected(run)
        else if (observation === "offline") {
          if (!run.unreachableReason) run.unreachableReason = "it stopped answering"
          showOffline(run)
        } else showUnknown(run)
        watch(run)
      })()
    }, run.shown === "offline" ? OFFLINE_RECHECK_MS : WATCH_INTERVAL_MS)
    timer.unref?.()
  }

  const launch = async () => {
    if (stopped || current) return
    clearTimer()
    await fs.rm(healthFile, { force: true }).catch(() => undefined)
    if (stopped || current) return
    publish({ state: "starting", detail: attempts ? "Reconnecting tunnel…" : "Starting tunnel client…" })
    const proc = spawn(input.binary, [...launchSpec.args], {
      env: buildTunnelChildEnv(launchSpec.env),
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    })
    const run: Run = {
      proc,
      healthBase: null,
      health: null,
      lastHandshake: null,
      outage: NO_OUTAGE,
      unreachableReason: "",
      unreadySince: 0,
      lastError: "",
      shown: null,
    }
    current = run
    const onLine = (line: string) => {
      if (stopped || current !== run) return
      if (isAuthFailure(line)) {
        stopped = true
        current = null
        clearTimer()
        retirement = terminateTree(proc)
        input.report({ state: "auth-failed", detail: "The tunnel rejected the API key or tunnel ID." })
        return
      }
      try {
        const event = JSON.parse(line) as Record<string, unknown>
        const level = String(event.level ?? "").toUpperCase()
        const message = String(event.msg ?? "tunnel-client event")
        const error = event.error ? String(event.error) : ""
        const diagnostic = redactTunnelText(`${message}${error ? `: ${error}` : ""}`, input.secrets)
        if (level === "WARN" && message === "harpoon host auto-registration failed" && event.inclusion_reason === "loopback") {
          return
        }
        if (level === "ERROR" || level === "FATAL" || level === "WARN") {
          run.lastError = `${level} ${diagnostic}`.slice(0, 400)
          if (isUnreachableError(diagnostic)) noteUnreachable(run, diagnostic)
          else input.log?.("tunnel-client reported a warning", { detail: run.lastError }, "warn")
        }
        return
      } catch {}
      const diagnostic = redactTunnelText(line, input.secrets)
      if (/\b(error|fatal|warn)\b/i.test(diagnostic)) {
        run.lastError = diagnostic.slice(0, 400)
        if (isUnreachableError(diagnostic)) noteUnreachable(run, diagnostic)
        else input.log?.("tunnel-client reported an unstructured warning", { detail: run.lastError }, "warn")
      }
    }
    proc.stdout?.on("data", boundedTunnelLineReader(onLine))
    proc.stderr?.on("data", boundedTunnelLineReader(onLine))
    proc.once("exit", (code) => {
      if (stopped || current !== run) return
      scheduleRestart(run, run.lastError || `Tunnel client stopped (exit ${code}).`, false)
    })
    proc.once("error", () => {
      if (stopped || current !== run) return
      scheduleRestart(run, "Could not start tunnel-client.", true)
    })

    const deadline = Date.now() + READY_TIMEOUT_MS
    while (!stopped && current === run && Date.now() < deadline) {
      const base = await readHealthUrl(healthFile)
      if (base) {
        const ready = await probeReady(base)
        if (ready.ok && !stopped && current === run) {
          attempts = 0
          run.healthBase = base
          const poll = await refreshHealth(run)
          if (poll !== undefined && !stopped && current === run) {
            const observation = routeObservation(poll, run.lastHandshake, run.outage)
            if (observation === "connected") showConnected(run)
            else if (observation === "offline") {
              if (!run.unreachableReason) run.unreachableReason = "it stopped answering"
              showOffline(run)
            } else showUnknown(run)
            watch(run)
            return
          }
        }
        run.lastError = redactTunnelText(ready.detail, input.secrets) || run.lastError
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    if (!stopped && current === run) scheduleRestart(run, run.lastError || "Tunnel did not become ready within 60 seconds.", true)
  }

  void launch()
  return {
    stop: () =>
      (stopPromise ??= (async () => {
        stopped = true
        clearTimer()
        const active = current
        current = null
        const [retired, activeStopped] = await Promise.all([retirement, terminateTree(active?.proc ?? null)])
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
        if (!retired || !activeStopped) {
          throw new TunnelError("The previous tunnel client process tree could not be proven stopped.")
        }
      })()),
  }
}
