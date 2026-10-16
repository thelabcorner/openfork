#!/usr/bin/env bun
import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"
import { validateChunkDbCapability } from "./chunkdb-capability"

const AGENT_NAME = "OpenFork"
const root = path.resolve(import.meta.dir, "..")
const skipBuild = Bun.argv.includes("--skip-build")
const configuredSource = process.env.OPENFORK_ACP_SOURCE?.trim()
// Optional live JetBrains workspace certification. Keep the default repository
// smoke, but also exercise actual IDE directories before touching acp.json.
const configuredSmokeDirectories = process.env.OPENFORK_ACP_SMOKE_CWDS?.trim()
const additionalSmokeDirectories: string[] = configuredSmokeDirectories ? JSON.parse(configuredSmokeDirectories) : []
if (
  !Array.isArray(additionalSmokeDirectories) ||
  additionalSmokeDirectories.some((directory) => typeof directory !== "string" || !directory.trim())
) {
  throw new Error("OPENFORK_ACP_SMOKE_CWDS must be a JSON array of non-empty directory strings")
}
const smokeDirectories = [...new Set([root, ...additionalSmokeDirectories.map((directory) => path.resolve(directory))])]

if (process.platform !== "win32") {
  throw new Error("JetBrains OpenFork ACP installer currently targets Windows only.")
}

async function run(command: string[], cwd = root) {
  const child = Bun.spawn(command, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  const code = await child.exited
  if (code !== 0) throw new Error(`${command.join(" ")} exited with code ${code}`)
}

if (!skipBuild && !configuredSource) {
  await run(["bun", "run", "script/build.ts", "--single", "--skip-embed-web-ui"])
}

const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { version: string }
const source = configuredSource
  ? path.resolve(configuredSource)
  : path.join(root, "dist", "openfork-windows-x64", "bin", "openfork.exe")
await fs.access(source).catch(() => {
  throw new Error(
    configuredSource
      ? `Configured OpenFork ACP source executable not found at ${source}`
      : `Built OpenFork executable not found at ${source}. Run without --skip-build first.`,
  )
})

const localAppData = process.env.LOCALAPPDATA
if (!localAppData) throw new Error("LOCALAPPDATA is not set")
const configuredInstallRoot = process.env.OPENFORK_ACP_INSTALL_ROOT?.trim()
const installRoot = configuredInstallRoot
  ? path.resolve(configuredInstallRoot)
  : path.join(localAppData, "JetBrains", "acp-agents", "openfork")

const shaResult = Bun.spawnSync(["git", "rev-parse", "--short=10", "HEAD"], { cwd: root, stdout: "pipe" })
const sha = shaResult.exitCode === 0 ? shaResult.stdout.toString().trim() : "unknown"
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)
const buildID = `${pkg.version}-openfork-${sha}-${stamp}`
const installDir = path.join(installRoot, buildID)
const canonicalInstalled = path.join(installDir, "openfork.exe")
const installed = path.join(installDir, "opencode.exe")
await fs.mkdir(installDir, { recursive: true })
await fs.copyFile(source, canonicalInstalled)
// JetBrains' ACP boundary historically identifies the OpenCode-compatible agent
// executable as opencode.exe. Keep that compatibility filename while retaining
// the canonical OpenFork binary beside it; both bytes come from the same
// validated fork build and no consumer-specific compatibility profile is set.
await fs.copyFile(source, installed)

// Validate the copied executable before pointing JetBrains at it.
const version = Bun.spawnSync([installed, "--version"], { stdout: "pipe", stderr: "pipe" })
if (version.exitCode !== 0) {
  throw new Error(`Installed executable failed --version: ${version.stderr.toString().trim()}`)
}

// A version-only smoke test cannot detect a stale bundled storage module. Prove
// the copied executable can open the newest durable ChunkDB representation
// before JetBrains is pointed at it. This uses an isolated temporary database.
await validateChunkDbCapability(installed)

// ACP stdout is protocol-only NDJSON. Validate the installed executable in the
// user's real plugin/config environment so a noisy plugin cannot poison the
// JetBrains transport after we update acp.json.
async function validateAcpProtocol() {
  for (const directory of smokeDirectories) {
    const stat = await fs.stat(directory).catch(() => undefined)
    if (!stat?.isDirectory()) throw new Error(`ACP smoke-test directory not found: ${directory}`)
  }
  // The installer is often invoked from an OpenFork development process whose
  // process-local OPENCODE_* overrides point at the dev database/desktop
  // instance. JetBrains itself does not inherit that launcher-local state.
  // Preserve the user's ordinary environment, but remove development-channel
  // overrides so the deployment gate exercises the same canonical runtime path
  // the global ACP entry will launch.
  const env = { ...process.env }
  for (const key of [
    "NODE_ENV",
    "NODE_ENV_ELECTRON_VITE",
    "BUN_ENV",
    "OPENCODE_CLIENT",
    "OPENCODE_DB",
    "OPENCODE_DEV_RUN_ID",
    "OPENCODE_DISABLE_CHANNEL_DB",
    "OPENCODE_DISABLE_EMBEDDED_WEB_UI",
    "OPENCODE_INSTANCE_ID",
    "OPENCODE_PRINT_LOGS",
  ]) {
    delete env[key]
  }

  const child = Bun.spawn([installed, "acp"], {
    cwd: root,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text()
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let buffered = ""

  const write = async (message: unknown) => {
    const written = child.stdin.write(JSON.stringify(message) + "\n")
    if (typeof written !== "number") await written
  }

  const line = async (): Promise<string | undefined> => {
    while (true) {
      const split = buffered.indexOf("\n")
      if (split >= 0) {
        const next = buffered.slice(0, split).replace(/\r$/, "")
        buffered = buffered.slice(split + 1)
        if (next.trim()) return next
        continue
      }
      const chunk = await reader.read()
      if (chunk.done) {
        const tail = buffered.replace(/\r$/, "")
        buffered = ""
        return tail.trim() ? tail : undefined
      }
      buffered += decoder.decode(chunk.value, { stream: true })
    }
  }

  const response = async (id: number) => {
    while (true) {
      const raw = await line()
      if (raw === undefined) {
        const err = (await stderr).trim()
        throw new Error(`Installed ACP stdout closed before response ${id}${err ? `: ${err.slice(0, 4000)}` : ""}`)
      }
      let message: any
      try {
        message = JSON.parse(raw)
      } catch {
        throw new Error(`Installed ACP emitted non-JSON stdout: ${raw.slice(0, 1000)}`)
      }
      if (message?.id === id) return message
      // Notifications and responses to other ids are valid ACP traffic. Every
      // line is still parsed above so any protocol contamination fails loudly.
    }
  }

  const modeValues = (options: any[]): string[] =>
    options.flatMap((option) =>
      typeof option?.value === "string" ? [option.value] : Array.isArray(option?.options) ? modeValues(option.options) : [],
    )

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      child.kill()
      reject(new Error("Installed ACP smoke test exceeded its bounded deadline"))
    }, 180_000 + additionalSmokeDirectories.length * 60_000)
  })

  const smoke = (async () => {
    await write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "openfork-installer-smoke", version: "1" },
      },
    })
    const initialized = await response(1)
    if (initialized?.error || initialized?.result?.protocolVersion !== 1) {
      throw new Error(`Installed ACP initialize failed: ${JSON.stringify(initialized).slice(0, 1000)}`)
    }

    let requestID = 2
    for (const cwd of smokeDirectories) {
      const createID = requestID++
      await write({ jsonrpc: "2.0", id: createID, method: "session/new", params: { cwd, mcpServers: [] } })
      const created = await response(createID)
      if (created?.error || typeof created?.result?.sessionId !== "string") {
        throw new Error(`Installed ACP session/new failed for ${cwd}: ${JSON.stringify(created).slice(0, 1000)}`)
      }
      const mode = created.result.configOptions?.find((option: any) => option?.id === "mode")
      const modes = mode && Array.isArray(mode.options) ? modeValues(mode.options) : []
      // Agent/mode availability is configuration-dependent. Certify a usable
      // selector for every real workspace, not merely one default environment.
      if (modes.length === 0) {
        throw new Error(`Installed ACP did not advertise usable modes for ${cwd}`)
      }

      const closeID = requestID++
      await write({
        jsonrpc: "2.0",
        id: closeID,
        method: "session/close",
        params: { sessionId: created.result.sessionId },
      })
      const closed = await response(closeID)
      if (closed?.error) {
        throw new Error(`Installed ACP session/close failed for ${cwd}: ${JSON.stringify(closed).slice(0, 1000)}`)
      }
      console.log(`ACP workspace certified: ${cwd}`)
    }

    child.stdin.end()
    while (true) {
      const raw = await line()
      if (raw === undefined) break
      try {
        JSON.parse(raw)
      } catch {
        throw new Error(`Installed ACP emitted trailing non-JSON stdout: ${raw.slice(0, 1000)}`)
      }
    }
    const code = await child.exited
    const err = await stderr
    if (code !== 0) throw new Error(`Installed ACP executable exited ${code}: ${err.trim()}`)
  })()

  try {
    await Promise.race([smoke, timeout])
  } finally {
    if (timer) clearTimeout(timer)
    if (child.exitCode === null) child.kill()
  }
}
try {
  await validateAcpProtocol()
} catch (error) {
  await fs.rm(installDir, { recursive: true, force: true }).catch(() => {})
  throw error
}

const configDir = path.join(os.homedir(), ".jetbrains")
const configPath = path.join(configDir, "acp.json")
await fs.mkdir(configDir, { recursive: true })
let config: Record<string, unknown> = {}
try {
  // Windows PowerShell 5.1's `Set-Content -Encoding UTF8` writes a UTF-8 BOM.
  // JetBrains accepts that file, but JavaScript's JSON.parse does not accept the
  // leading U+FEFF character. Tolerate it on read, then our normal write path
  // emits clean UTF-8 without a BOM.
  const raw = await fs.readFile(configPath, "utf8")
  config = JSON.parse(raw.replace(/^\uFEFF/, "")) as Record<string, unknown>
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
}

const servers =
  config.agent_servers && typeof config.agent_servers === "object" && !Array.isArray(config.agent_servers)
    ? { ...(config.agent_servers as Record<string, unknown>) }
    : {}
servers[AGENT_NAME] = {
  command: installed,
  args: ["acp"],
  env: {},
}
config.agent_servers = servers

// Keep a last-known-good backup, then replace the config. The OpenFork custom
// ACP entry points at the fork-owned opencode.exe compatibility filename while
// canonical openfork.exe is retained beside it. Stock JetBrains-managed OpenCode
// entries are never treated as OpenFork runtime dependencies.
try {
  await fs.copyFile(configPath, `${configPath}.openfork-backup`)
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
}
const temp = `${configPath}.tmp-${process.pid}`
await fs.writeFile(temp, JSON.stringify(config, null, 2) + "\n", "utf8")
try {
  await fs.rename(temp, configPath)
} catch {
  await fs.copyFile(temp, configPath)
  await fs.rm(temp, { force: true })
}

// JetBrains can cache an older custom ACP absolute command in memory even after
// acp.json changes. Keep those OpenFork-owned paths valid, but make every one of
// them execute the same freshly validated build. Rollback belongs to the
// canonical W:\Apps\OpenFork\builds store, not to stale ACP copies. Stock
// JetBrains-managed OpenCode binaries are never touched here.
const openforkRoot = path.dirname(installDir)
const healedBuilds: string[] = []
for (const entry of await fs.readdir(openforkRoot, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === path.basename(installDir)) continue
  const candidateDir = path.join(openforkRoot, entry.name)
  const candidates = [path.join(candidateDir, "openfork.exe"), path.join(candidateDir, "opencode.exe")]
  const existing: string[] = []
  for (const candidate of candidates) {
    try {
      await fs.access(candidate)
      existing.push(candidate)
    } catch {}
  }
  if (existing.length === 0) continue

  let healed = false
  for (const candidate of existing) {
    try {
      await fs.copyFile(source, candidate)
      await validateChunkDbCapability(candidate)
      healed = true
    } catch (error) {
      console.warn(`Could not refresh cached OpenFork ACP path ${candidate}: ${String(error)}`)
    }
  }
  if (healed) healedBuilds.push(entry.name)
}

console.log(`Installed ${AGENT_NAME}`)
console.log(`  version: ${version.stdout.toString().trim()}`)
console.log(`  binary:  ${installed}`)
console.log(`  config:  ${configPath}`)
if (healedBuilds.length > 0) console.log(`  healed:  ${healedBuilds.length} stale cached OpenFork path(s)`)
console.log("Existing JetBrains ACP processes were left untouched; new agent processes use this build when JetBrains launches the custom entry.")
