import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { $ } from "bun"

const VERSION = "v0.0.14"
const TARGETS = {
  darwin: {
    x64: { upstreamArch: "amd64", sha256: "581c594632f907d250901e869025a504a2d031cca251133286dfce262fc3e821" },
    arm64: { upstreamArch: "arm64", sha256: "dd0f7b4f5cb35dcb85c77814ed113abf05f9fcdc69c739d31facf74325b112d2" },
  },
  linux: {
    x64: { upstreamArch: "amd64", sha256: "29d29cf860ada54e4d3c82c715f4fbfcff2abcdc2584c0fc26431308dfa2505b" },
    arm64: { upstreamArch: "arm64", sha256: "7a4a6a4eb995c175aa0243434ff79ae9e4c2675d1c25e0d983622c48098159fb" },
  },
  win32: {
    x64: { upstreamArch: "amd64", sha256: "c276db68609ac9771b07f078eac3dc23f8943a42f9dedd4c50a4001cb74df149" },
    arm64: { upstreamArch: "arm64", sha256: "b42c6774efe63888bed2b2256d9dbf47a3f312845a9fd7b991555bbb80d1a810" },
  },
} as const

type SupportedPlatform = keyof typeof TARGETS
type SupportedArch = "x64" | "arm64"

function target() {
  const platform = process.platform as SupportedPlatform
  const arch = process.arch as SupportedArch
  const config = TARGETS[platform]?.[arch]
  if (!config) throw new Error(`OpenAI tunnel-client is not pinned for ${process.platform}-${process.arch}`)
  return { platform, arch, config }
}

async function sha256(file: string) {
  return createHash("sha256").update(await readFile(file)).digest("hex")
}

async function flattenSingleDirectory(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true })
  if (entries.length !== 1 || !entries[0]!.isDirectory()) return
  const nested = path.join(directory, entries[0]!.name)
  for (const name of await readdir(nested)) await rename(path.join(nested, name), path.join(directory, name))
  await rm(nested, { recursive: true, force: true })
}

async function extract(zip: string, directory: string) {
  if (process.platform === "win32") await $`tar.exe -xf ${zip} -C ${directory}`
  else await $`unzip -q -o ${zip} -d ${directory}`
}

async function syncSupportFiles(
  staging: string,
  output: string,
  upstreamExecutableName: string,
) {
  await mkdir(output, { recursive: true })
  for (const entry of await readdir(staging)) {
    if (entry === upstreamExecutableName) continue
    await cp(path.join(staging, entry), path.join(output, entry), {
      recursive: true,
      force: true,
    })
  }
}

export async function fetchTunnelClient() {
  const { platform, config } = target()
  const upstreamOS = platform === "win32" ? "windows" : platform
  const archive = `tunnel-client-runtime-${VERSION}-${upstreamOS}-${config.upstreamArch}.zip`
  const cache = path.resolve("node_modules/.cache/openfork-oxp", archive)
  const output = path.resolve("resources/tunnel")
  const executable = path.join(output, platform === "win32" ? "tunnel-client.exe" : "tunnel-client")
  const stamp = path.join(output, "VERSION")

  await mkdir(path.dirname(cache), { recursive: true })
  if (!existsSync(cache)) {
    const response = await fetch(`https://github.com/openai/tunnel-client/releases/download/${VERSION}/${archive}`, {
      headers: { "user-agent": "openfork-desktop-build" },
    })
    if (!response.ok) throw new Error(`Downloading ${archive} failed with HTTP ${response.status}`)
    await writeFile(cache, Buffer.from(await response.arrayBuffer()))
  }
  const digest = await sha256(cache)
  if (digest !== config.sha256) {
    await rm(cache, { force: true })
    throw new Error(`Checksum mismatch for ${archive}: expected ${config.sha256}, got ${digest}`)
  }

  const staging = await mkdtemp(path.join(tmpdir(), "openfork-tunnel-"))
  try {
    await extract(cache, staging)
    await flattenSingleDirectory(staging)
    const upstreamExecutable = path.join(
      staging,
      platform === "win32" ? "tunnel-client-runtime.exe" : "tunnel-client-runtime",
    )
    if (!existsSync(upstreamExecutable)) throw new Error(`${archive} did not contain tunnel-client-runtime`)
    if (platform !== "win32") await chmod(upstreamExecutable, 0o755)

    const upstreamExecutableName =
      platform === "win32" ? "tunnel-client-runtime.exe" : "tunnel-client-runtime"
    const stagedExecutableDigest = await sha256(upstreamExecutable)
    const installedExecutableDigest = existsSync(executable)
      ? await sha256(executable).catch(() => undefined)
      : undefined
    const executableAlreadyPinned =
      installedExecutableDigest !== undefined &&
      installedExecutableDigest === stagedExecutableDigest

    if (platform === "win32" && executableAlreadyPinned) {
      // A running Windows desktop keeps tunnel-client.exe mapped and prevents
      // removing its parent directory. If the installed executable is
      // byte-identical to the executable from the checksum-verified pinned
      // archive, preserve that mapped file and refresh only the support payload.
      await syncSupportFiles(staging, output, upstreamExecutableName)
    } else {
      try {
        await rm(output, { recursive: true, force: true })
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String((error as { code?: unknown }).code ?? "")
            : ""
        if (platform === "win32" && (code === "EACCES" || code === "EPERM")) {
          throw new Error(
            "Cannot replace the pinned OXP tunnel-client while the existing Windows runtime is in use. Stop the running OpenFork desktop and retry the build.",
            { cause: error },
          )
        }
        throw error
      }
      await mkdir(output, { recursive: true })
      await cp(staging, output, { recursive: true })
      await rename(path.join(output, upstreamExecutableName), executable)
    }
    await writeFile(stamp, `${VERSION}\n`, "utf8")
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  const probe = spawnSync(executable, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 10_000 })
  if (probe.error) throw probe.error
  const versionText = `${probe.stdout ?? ""}${probe.stderr ?? ""}`
  if (probe.status !== 0 || !versionText.includes(VERSION.slice(1))) {
    throw new Error(`Staged tunnel-client failed runtime version verification: ${versionText.trim()}`)
  }
  console.log(`Pinned OpenAI tunnel-client ${VERSION} staged for ${platform}-${process.arch}`)
}

if (import.meta.main) await fetchTunnelClient()
