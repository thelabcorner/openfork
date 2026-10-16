import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { promises as fs } from "node:fs"
import path from "node:path"
import { app } from "electron"
import type { OxpTunnelReport, TunnelHandle } from "./tunnel-supervisor"
import { buildTunnelChildEnv } from "./tunnel-supervisor"

async function locateCloudflared() {
  const executable = process.platform === "win32" ? "cloudflared.exe" : "cloudflared"
  const explicit = process.env.OPENFORK_CLOUDFLARED?.trim()
  if (explicit && existsSync(explicit)) return explicit
  const { app } = await import("electron")
  const candidates = [
    path.join(process.resourcesPath || "", "cloudflared", executable),
    path.join(app.getAppPath(), "resources", "cloudflared", executable),
    path.resolve(import.meta.dirname, "../../../resources/cloudflared", executable),
  ]
  const bundled = candidates.find((candidate) => existsSync(candidate))
  if (bundled) return bundled
  const { execFile } = await import("node:child_process")
  const found = await new Promise<string | undefined>((resolve) => {
    execFile(process.platform === "win32" ? "where.exe" : "which", [executable], { windowsHide: true }, (error, stdout) => {
      if (error) return resolve(undefined)
      resolve(stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line && existsSync(line)))
    })
  })
  return found
}

export async function startCloudflareTunnel(input: {
  token: string
  endpointUrl?: string
  report: (report: OxpTunnelReport) => void
}): Promise<TunnelHandle> {
  const binary = await locateCloudflared()
  if (!binary) throw new Error("cloudflared was not found. Install Cloudflare Tunnel and restart OpenFork.")
  if (!input.token.trim()) throw new Error("Save a Cloudflare Tunnel token before connecting.")
  const workDir = await fs.mkdtemp(path.join(app.getPath("userData"), "oxp-cloudflare-"))
  const tokenFile = path.join(workDir, "tunnel-token")
  const configFile = path.join(workDir, "cloudflared.yml")
  try {
    await fs.writeFile(tokenFile, input.token.trim(), { encoding: "utf8", mode: 0o600, flag: "wx" })
    // A user's default ~/.cloudflared/config.yml may contain local ingress rules.
    // This is a remotely-managed tunnel, so loading those rules can reject the
    // connector before it contacts Cloudflare (and can route traffic elsewhere).
    // Give cloudflared an isolated config with no local ingress rules instead.
    await fs.writeFile(configFile, "# OpenFork remote-managed tunnel; routes are configured in Cloudflare.\n", { encoding: "utf8", mode: 0o600, flag: "wx" })
  } catch (error) {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  let stopped = false
  let stopPromise: Promise<void> | undefined
  let proc: ReturnType<typeof spawn> | undefined
  let timer: NodeJS.Timeout | undefined
  let attempts = 0
  let lineBuffer = ""
  let outputTail = ""
  let probeTimer: NodeJS.Timeout | undefined
  let probing = false
  const probePublicRoute = async () => {
    if (stopped || probing || !input.endpointUrl) return
    probing = true
    try {
      const endpoint = new URL(input.endpointUrl)
      const metadata = new URL(`/.well-known/oauth-protected-resource${endpoint.pathname}`, endpoint.origin)
      const response = await fetch(metadata, { cache: "no-store", signal: AbortSignal.timeout(8_000) })
      const value = response.ok ? await response.json() as { resource?: unknown } : undefined
      const resource = typeof value?.resource === "string" ? value.resource : ""
      if (response.ok && new URL(resource).toString() === endpoint.toString()) {
        input.report({ state: "connected", detail: "Cloudflare Tunnel and the public OXP backup URL are reachable. Install this URL as a separate connector in ChatGPT." })
      } else {
        input.report({ state: "offline", detail: "Cloudflare connected, but the public hostname route is not serving this OXP endpoint yet. Check the tunnel route points to http://127.0.0.1:42991." })
      }
    } catch {
      if (!stopped) input.report({ state: "starting", detail: "Cloudflare is registered; checking the public OXP backup URL…" })
    } finally {
      probing = false
    }
  }
  const launch = () => {
    if (stopped) return
    outputTail = ""
    input.report({ state: "starting", detail: attempts ? "Restarting the Cloudflare Tunnel…" : "Starting the Cloudflare Tunnel. Waiting for Cloudflare to register this connector…" })
    const child = spawn(binary, ["tunnel", "--config", configFile, "run", "--token-file", tokenFile], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildTunnelChildEnv({ NO_PROXY: "127.0.0.1,localhost" }),
    })
    proc = child
    const observe = (chunk: Buffer) => {
      if (stopped || proc !== child) return
      lineBuffer = (lineBuffer + chunk.toString("utf8")).slice(-16_384)
      const lines = lineBuffer.split(/\r?\n/)
      lineBuffer = lines.pop() ?? ""
      for (const line of lines) {
        outputTail = `${outputTail}\n${line}`.slice(-2_000)
        if (/Registered tunnel connection/i.test(line)) {
          attempts = 0
          if (input.endpointUrl) void probePublicRoute()
          else input.report({ state: "starting", detail: "Cloudflare Tunnel is connected. Add the public hostname route to finish the backup URL setup." })
        } else if (/connection .* (?:failed|terminated)|failed to connect to edge|retrying connection/i.test(line)) {
          input.report({ state: "offline", detail: "Cloudflare Tunnel is reconnecting to Cloudflare." })
        }
      }
    }
    child.stdout?.on("data", observe)
    child.stderr?.on("data", observe)
    child.once("error", (error) => {
      if (!stopped && proc === child) input.report({ state: "offline", detail: `cloudflared could not start: ${safeCloudflaredDetail(error.message, input.token)}` })
    })
    child.once("close", (code, signal) => {
      if (stopped || proc !== child) return
      proc = undefined
      if (lineBuffer.trim()) outputTail = `${outputTail}\n${lineBuffer.trim()}`.slice(-2_000)
      lineBuffer = ""
      attempts += 1
      const delay = Math.min(60_000, 1_000 * 2 ** Math.min(attempts - 1, 6))
      const reason = outputTail.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-3).join(" | ")
      const exit = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`
      const diagnostic = reason ? ` Last output: ${safeCloudflaredDetail(reason, input.token)}` : ""
      input.report({ state: "offline", detail: `cloudflared exited with ${exit}.${diagnostic} Retrying in ${Math.round(delay / 1000)} seconds.` })
      outputTail = ""
      timer = setTimeout(() => {
        timer = undefined
        launch()
      }, delay)
      timer.unref?.()
    })
  }
  launch()
  probeTimer = setInterval(() => void probePublicRoute(), 15_000)
  probeTimer.unref?.()
  return {
    stop() {
      return (stopPromise ??= (async () => {
        stopped = true
        if (timer) clearTimeout(timer)
        if (probeTimer) clearInterval(probeTimer)
        const child = proc
        if (child && child.exitCode === null && child.signalCode === null) {
          const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
          if (process.platform === "win32" && child.pid) {
            const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" })
            await new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(() => reject(new Error("Timed out confirming cloudflared process-tree shutdown.")), 5_000)
              killer.once("close", (code) => {
                clearTimeout(timeout)
                if (code === 0) resolve()
                else reject(new Error("Could not confirm cloudflared process-tree shutdown."))
              })
            })
          } else child.kill("SIGTERM")
          await Promise.race([closed, new Promise<void>((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for cloudflared to exit.")), 5_000))])
        }
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
      })())
    },
  }
}

function safeCloudflaredDetail(value: string, token: string) {
  return value.replaceAll(token, "[redacted]").replace(/eyJ[a-zA-Z0-9_-]{20,}/g, "[redacted token]").slice(-1_000)
}
