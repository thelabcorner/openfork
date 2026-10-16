import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { DevHandshake } from "../../../mobile/dev/handshake"

const execFileAsync = promisify(execFile)
export type SidecarProcessSnapshot = {
  pid: number
  parentPID: number
  createdAt: string
  executablePath: string
  commandLine: string
}

/** CIM returns a DateTime object, not the DMTF string required by ManagementDateTimeConverter. */
export function windowsSidecarInspectionScript(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return
  return [
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction SilentlyContinue`,
    "if ($null -eq $p) { exit 3 }",
    "[PSCustomObject]@{ ProcessId=$p.ProcessId; ParentProcessId=$p.ParentProcessId; CreationDate=$p.CreationDate.ToUniversalTime().ToString('o'); ExecutablePath=$p.ExecutablePath; CommandLine=$p.CommandLine } | ConvertTo-Json -Compress",
  ].join("; ")
}

/** Reject a stale, exited PID before paying for Windows CIM initialization.
 * Only ESRCH proves absence; EPERM/other errors are inconclusive and must
 * continue to the full incarnation/ownership verification below. */
export function previousSidecarPidMayExist(
  pid: number,
  check: (pid: number) => void = (value) => process.kill(value, 0),
): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    check(pid)
    return true
  } catch (error) {
    return (error as { code?: unknown } | null)?.code !== "ESRCH"
  }
}

/** Fail closed unless handshake generation, PID incarnation and executable all agree. */
export function validatePreviousSidecar(
  handshake: DevHandshake | undefined,
  process: SidecarProcessSnapshot | undefined,
  expectedElectronPath: string,
) {
  if (!handshake || handshake.version < 1 || !handshake.instanceID || !handshake.pid)
    return { ok: false as const, reason: "stale-or-invalid-handshake" }
  if (!handshake.sidecarPID || !handshake.sidecarStartedAt || !process)
    return { ok: false as const, reason: "missing-process-generation" }
  if (handshake.sidecarPID !== process.pid) return { ok: false as const, reason: "pid-mismatch" }
  if (handshake.pid !== process.parentPID) return { ok: false as const, reason: "parent-mismatch" }
  const expectedStart = Date.parse(handshake.sidecarStartedAt)
  const actualStart = Date.parse(process.createdAt)
  if (!Number.isFinite(expectedStart) || !Number.isFinite(actualStart) || Math.abs(expectedStart - actualStart) > 30_000) {
    return { ok: false as const, reason: "pid-reused-or-start-mismatch" }
  }
  const normalize = (value: string) => value.replaceAll("/", "\\").toLowerCase()
  if (normalize(process.executablePath) !== normalize(expectedElectronPath)) return { ok: false as const, reason: "foreign-process" }
  if (!/--type=utility(?:\s|$)/i.test(process.commandLine)) return { ok: false as const, reason: "foreign-process" }
  if (!/--utility-sub-type=node\.mojom\.NodeService(?:\s|$)/i.test(process.commandLine)) {
    return { ok: false as const, reason: "foreign-process" }
  }
  return { ok: true as const, instanceID: handshake.instanceID, pid: process.pid }
}

/**
 * Windows process-tree termination is allowed only after the stale handshake's
 * PID, creation time and exact sidecar entrypoint have all matched. Other
 * platforms intentionally fail closed: Node has no cross-platform primitive
 * for atomically terminating an old process tree, and this app does not ship a
 * native Job Object binding. Current-run children remain owned by Electron's
 * UtilityProcess handle and are always stopped through that handle.
 */
export async function reapPreviousSidecar(
  handshake: DevHandshake | undefined,
  expectedElectronPath: string,
  platform = process.platform,
  log: (message: string, details: Record<string, unknown>) => void = () => {},
) {
  if (!handshake?.sidecarPID || !handshake.sidecarStartedAt) return { reaped: false, reason: "no-owned-sidecar-metadata" }
  if (platform !== "win32") {
    log("previous sidecar retained; safe process-tree primitive unavailable", { pid: handshake.sidecarPID, instanceID: handshake.instanceID })
    return { reaped: false, reason: "safe-tree-termination-unavailable" }
  }
  const script = windowsSidecarInspectionScript(handshake.sidecarPID)
  if (!script) return { reaped: false, reason: "invalid-sidecar-pid" }
  // A dead PID needs no CIM inspection. Unknown/surviving PIDs retain both
  // full incarnation proofs before any termination is permitted.
  if (!previousSidecarPidMayExist(handshake.sidecarPID)) {
    return { reaped: false, reason: "process-not-running" }
  }
  let snapshot: SidecarProcessSnapshot
  try {
    // Cold CIM initialization can exceed five seconds on a busy Windows host.
    const result = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 20_000 })
    const row = JSON.parse(result.stdout) as {
      ProcessId: number
      ParentProcessId: number
      CreationDate: string
      ExecutablePath: string
      CommandLine: string
    }
    snapshot = {
      pid: row.ProcessId,
      parentPID: row.ParentProcessId,
      createdAt: row.CreationDate,
      executablePath: row.ExecutablePath ?? "",
      commandLine: row.CommandLine ?? "",
    }
  } catch {
    return { reaped: false, reason: "process-not-inspectable" }
  }
  const validated = validatePreviousSidecar(handshake, snapshot, expectedElectronPath)
  if (!validated.ok) {
    log("previous sidecar reaping refused", { reason: validated.reason, pid: handshake.sidecarPID, instanceID: handshake.instanceID })
    return { reaped: false, reason: validated.reason }
  }
  // Re-read incarnation immediately before taskkill; /T reaps descendants as
  // well as the verified utility process, unlike a PID-only kill by itself.
  const second = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 20_000 }).catch(() => undefined)
  if (!second) return { reaped: false, reason: "process-changed-before-termination" }
  let again: SidecarProcessSnapshot | undefined
  try {
    const row = JSON.parse(second.stdout) as {
      ProcessId: number
      ParentProcessId: number
      CreationDate: string
      ExecutablePath: string
      CommandLine: string
    }
    again = {
      pid: row.ProcessId,
      parentPID: row.ParentProcessId,
      createdAt: row.CreationDate,
      executablePath: row.ExecutablePath ?? "",
      commandLine: row.CommandLine ?? "",
    }
  } catch {}
  if (!validatePreviousSidecar(handshake, again, expectedElectronPath).ok) {
    return { reaped: false, reason: "process-changed-before-termination" }
  }
  try {
    await execFileAsync("taskkill.exe", ["/PID", String(validated.pid), "/T", "/F"], { timeout: 10_000 })
    log("verified previous sidecar process tree reaped", { pid: validated.pid, instanceID: validated.instanceID })
    return { reaped: true as const, pid: validated.pid, instanceID: validated.instanceID }
  } catch (error) {
    log("verified previous sidecar could not be reaped", { pid: validated.pid, instanceID: validated.instanceID, error: String(error) })
    return { reaped: false, reason: "termination-failed" }
  }
}
