import { existsSync } from "node:fs"
import path from "node:path"
import { write as writeLog } from "../logging"
import { tunnelLaunchSpec } from "./tunnel-contract"
import {
  startTunnelSupervisor,
  TunnelError,
  type OxpTunnelReport,
  type OxpTunnelState,
  type TunnelHandle,
} from "./tunnel-supervisor"

export { TunnelError }
export type { OxpTunnelReport, OxpTunnelState, TunnelHandle }

const TUNNEL_ID = /^tunnel_[0-9a-f]{32}$/

async function locateTunnelClient() {
  const executable = process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client"
  const explicit = process.env.OPENFORK_TUNNEL_CLIENT?.trim()
  if (explicit && existsSync(explicit)) return explicit
  const { app } = await import("electron")
  const candidates = [
    path.join(process.resourcesPath || "", "tunnel", executable),
    path.join(app.getAppPath(), "resources", "tunnel", executable),
    path.resolve(import.meta.dirname, "../../../resources/tunnel", executable),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

export async function startOpenAiTunnel(input: {
  localUrl: string
  tunnelID: string
  apiKey: string
  label: string
  report: (report: OxpTunnelReport) => void
}): Promise<TunnelHandle> {
  const binary = await locateTunnelClient()
  if (!binary) throw new TunnelError("OpenAI tunnel-client is not installed in this OpenFork build.")
  if (!TUNNEL_ID.test(input.tunnelID)) throw new TunnelError("Enter a valid OpenAI Secure MCP Tunnel ID.")
  if (!input.apiKey.trim()) throw new TunnelError("Save an OXP OpenAI API key before connecting.")

  writeLog("oxp", "starting OpenAI Secure MCP Tunnel", { label: input.label })
  return startTunnelSupervisor({
    binary,
    launch: (healthFile) => tunnelLaunchSpec({ ...input, healthFile }),
    secrets: [input.apiKey, input.localUrl],
    report: input.report,
    log: (message, extra, level) => writeLog("oxp", message, extra, level),
  })
}
