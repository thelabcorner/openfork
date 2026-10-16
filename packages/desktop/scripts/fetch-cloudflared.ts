import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { $ } from "bun"

const VERSION = "2026.10.0"
const TARGETS = {
  darwin: {
    x64: { asset: "cloudflared-darwin-amd64.tgz", sha256: "0560c9ab7281ac3f746055323623ed23bc0405b6dab9400474020cba33a978da" },
    arm64: { asset: "cloudflared-darwin-arm64.tgz", sha256: "72edfd3eea463aef4d5cb89e2e209cecb048cc756c2b01915de2e0ad7cb39830" },
  },
  linux: {
    x64: { asset: "cloudflared-linux-amd64", sha256: "d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db" },
    arm64: { asset: "cloudflared-linux-arm64", sha256: "e6422b9d4f72d3194bc5a38676f13667c06666523217b842a877d72a80b5ac08" },
  },
  win32: {
    x64: { asset: "cloudflared-windows-amd64.exe", sha256: "86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c" },
  },
} as const

export async function fetchCloudflared() {
  const platform = process.platform as keyof typeof TARGETS
  const arch = process.arch as "x64" | "arm64"
  const target = TARGETS[platform]?.[arch]
  if (!target) throw new Error(`cloudflared is not pinned for ${process.platform}-${process.arch}`)
  const archive = target.asset
  const cache = path.resolve(`node_modules/.cache/openfork-oxp/${archive}`)
  const output = path.resolve("resources/cloudflared")
  const executable = path.join(output, process.platform === "win32" ? "cloudflared.exe" : "cloudflared")
  await mkdir(path.dirname(cache), { recursive: true })
  if (!existsSync(cache)) {
    const response = await fetch(`https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/${archive}`, {
      headers: { "user-agent": "openfork-desktop-build" },
    })
    if (!response.ok) throw new Error(`Downloading ${archive} failed with HTTP ${response.status}`)
    await writeFile(cache, Buffer.from(await response.arrayBuffer()))
  }
  const digest = createHash("sha256").update(await readFile(cache)).digest("hex")
  if (digest !== target.sha256) {
    await rm(cache, { force: true })
    throw new Error(`Checksum mismatch for ${archive}: expected ${target.sha256}, got ${digest}`)
  }

  const staging = await mkdtemp(path.join(tmpdir(), "openfork-cloudflared-"))
  try {
    const stagedExecutable = path.join(staging, process.platform === "win32" ? "cloudflared.exe" : "cloudflared")
    if (archive.endsWith(".tgz")) {
      await $`tar -xzf ${cache} -C ${staging}`
      const extracted = path.join(staging, "cloudflared")
      if (!existsSync(extracted)) throw new Error(`${archive} did not contain cloudflared`)
    } else {
      await copyFile(cache, stagedExecutable)
    }
    if (process.platform !== "win32") await chmod(stagedExecutable, 0o755)
    await mkdir(output, { recursive: true })
    await copyFile(stagedExecutable, executable)
    const licenseResponse = await fetch(`https://raw.githubusercontent.com/cloudflare/cloudflared/${VERSION}/LICENSE`, {
      headers: { "user-agent": "openfork-desktop-build" },
    })
    if (!licenseResponse.ok) throw new Error(`Downloading the cloudflared license failed with HTTP ${licenseResponse.status}`)
    await writeFile(path.join(output, "LICENSE"), await licenseResponse.text(), "utf8")
    await writeFile(path.join(output, "VERSION"), `${VERSION}\n`, "utf8")
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  const probe = spawnSync(executable, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 10_000 })
  if (probe.error) throw probe.error
  const versionText = `${probe.stdout ?? ""}${probe.stderr ?? ""}`
  if (probe.status !== 0 || !versionText.includes(VERSION)) throw new Error(`Staged cloudflared failed version verification: ${versionText.trim()}`)
  console.log(`Pinned cloudflared ${VERSION} staged for ${platform}-${arch}`)
}

if (import.meta.main) await fetchCloudflared()
