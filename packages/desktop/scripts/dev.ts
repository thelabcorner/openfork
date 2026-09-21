/**
 * The sanctioned dev entrypoint: one Electron desktop (which spawns the
 * opencode sidecar) plus one mobile PWA server, tied together by a run id.
 *
 * This used to be a bare `concurrently` invocation in package.json. It is a
 * script now because both halves have to inherit the *same*
 * `OPENCODE_DEV_RUN_ID`. That id is what lets the PWA server tell "the desktop
 * I was launched with" apart from "some other dev stack that happens to be
 * running" — historically the PWA would bind to whichever backend a
 * well-known file last named, which on a machine full of opencode processes
 * meant it regularly drove the wrong one.
 *
 * See packages/mobile/dev/handshake.ts for the rest of the binding contract.
 */
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

const runID = process.env.OPENCODE_DEV_RUN_ID?.trim() || randomUUID()
const root = join(import.meta.dir, "..")
const mobileRoot = join(root, "..", "mobile")

type DevTargetProbe = {
  bound?: boolean
  code?: string
  instanceID?: string
}

const probeExistingPwa = async () => {
  try {
    const response = await fetch("http://127.0.0.1:3301/__opencode/dev-target", {
      signal: AbortSignal.timeout(750),
    })
    if (!response.ok) return undefined
    return (await response.json()) as DevTargetProbe
  } catch {
    return undefined
  }
}

const windowsProcessAtPwaPort = async () => {
  if (process.platform !== "win32") return undefined

  const script = [
    "$connection = Get-NetTCPConnection -State Listen -LocalPort 3301 -ErrorAction SilentlyContinue | Select-Object -First 1",
    "if ($null -eq $connection) { exit 0 }",
    "$process = Get-CimInstance Win32_Process -Filter (\"ProcessId=\" + $connection.OwningProcess)",
    "if ($null -eq $process) { exit 0 }",
    "$parent = Get-CimInstance Win32_Process -Filter (\"ProcessId=\" + $process.ParentProcessId) -ErrorAction SilentlyContinue",
    "[PSCustomObject]@{ ProcessId=$process.ProcessId; ParentProcessId=$process.ParentProcessId; CommandLine=$process.CommandLine; ParentCommandLine=$parent.CommandLine } | ConvertTo-Json -Compress",
  ].join("; ")

  const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  })
  const output = (await new Response(child.stdout).text()).trim()
  if ((await child.exited) !== 0 || !output) return undefined

  try {
    return JSON.parse(output) as {
      ProcessId: number
      ParentProcessId: number
      CommandLine?: string
      ParentCommandLine?: string
    }
  } catch {
    return undefined
  }
}

const normalizedWindowsPath = (value: string) => value.replaceAll("/", "\\").toLowerCase()

const reclaimStaleOwnPwa = async (probe: DevTargetProbe | undefined) => {
  if (process.platform !== "win32") return false
  if (probe?.bound !== false || probe.code !== "DesktopSidecarUnavailableError") return false

  const owner = await windowsProcessAtPwaPort()
  if (!owner?.CommandLine) return false

  const expected = normalizedWindowsPath(mobileRoot)
  const command = normalizedWindowsPath(owner.CommandLine)
  if (!command.includes(expected) || !command.includes("\\vite")) return false

  const parentCommand = normalizedWindowsPath(owner.ParentCommandLine ?? "")
  const pid =
    parentCommand.includes(expected) && parentCommand.includes("\\vite")
      ? owner.ParentProcessId
      : owner.ProcessId

  console.warn("[opencode:dev] reclaiming stale mobile PWA on :3301 (pid " + pid + ")")
  const killer = Bun.spawn(["taskkill.exe", "/PID", String(pid), "/T", "/F"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })
  if ((await killer.exited) !== 0) return false

  for (let attempt = 0; attempt < 20; attempt++) {
    if (!(await probeExistingPwa())) return true
    await Bun.sleep(50)
  }
  return false
}

const existingPwa = await probeExistingPwa()
if (existingPwa?.bound === true) {
  const detail = existingPwa.instanceID ? " (instance " + existingPwa.instanceID + ")" : ""
  throw new Error(
    "Port 3301 already belongs to a running OpenFork dev stack" +
      detail +
      ". Stop that stack before starting another one.",
  )
}
await reclaimStaleOwnPwa(existingPwa)

// Stale handshakes name dead instances. The desktop clears this at startup
// too, but doing it here closes the window before Electron gets that far.
for (const stale of [".opencode-dev-handshake.json", ".opencode-dev-url"]) {
  try {
    await Bun.file(join(root, "..", "mobile", stale)).delete()
  } catch {}
}

console.log(`[opencode:dev] run ${runID}`)

// Run concurrently's entry through bun rather than its shim, so this works
// the same on Windows (where .bin holds a .cmd/.exe) as it does elsewhere.
const concurrently = (() => {
  try {
    const manifest = createRequire(import.meta.url).resolve("concurrently/package.json")
    return join(dirname(manifest), "dist", "bin", "concurrently.js")
  } catch {
    return undefined
  }
})()
if (!concurrently) throw new Error("concurrently is not installed — run `bun install` at the repo root")

const child = Bun.spawn(
  [
    "bun",
    concurrently,
    "-n",
    "desktop,pwa",
    "-c",
    "blue,green",
    // Both halves live and die together. A PWA server that outlives its
    // desktop is the hazard this whole change exists to remove: it would sit
    // on :3301 waiting to be pointed at the next dev stack's backend.
    "--kill-others",
    "bun ./scripts/dev-electron.ts",
    "bun --cwd ../mobile dev",
  ],
  {
    cwd: root,
    env: { ...process.env, OPENCODE_DEV_RUN_ID: runID },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
)

const stop = () => child.kill()
process.once("SIGINT", stop)
process.once("SIGTERM", stop)

process.exitCode = await child.exited
process.off("SIGINT", stop)
process.off("SIGTERM", stop)
