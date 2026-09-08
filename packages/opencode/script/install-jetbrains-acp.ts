#!/usr/bin/env bun
import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"
import { validateChunkDbCapability } from "./chunkdb-capability"

const AGENT_NAME = "OpenCode (OpenFork)"
const root = path.resolve(import.meta.dir, "..")
const skipBuild = Bun.argv.includes("--skip-build")

if (process.platform !== "win32") {
  throw new Error("JetBrains OpenFork ACP installer currently targets Windows only.")
}

async function run(command: string[], cwd = root) {
  const child = Bun.spawn(command, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  const code = await child.exited
  if (code !== 0) throw new Error(`${command.join(" ")} exited with code ${code}`)
}

if (!skipBuild) {
  await run(["bun", "run", "script/build.ts", "--single", "--skip-embed-web-ui"])
}

const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { version: string }
const source = path.join(root, "dist", "opencode-windows-x64", "bin", "opencode.exe")
await fs.access(source).catch(() => {
  throw new Error(`Built OpenCode executable not found at ${source}. Run without --skip-build first.`)
})

const localAppData = process.env.LOCALAPPDATA
if (!localAppData) throw new Error("LOCALAPPDATA is not set")

const shaResult = Bun.spawnSync(["git", "rev-parse", "--short=10", "HEAD"], { cwd: root, stdout: "pipe" })
const sha = shaResult.exitCode === 0 ? shaResult.stdout.toString().trim() : "unknown"
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)
const buildID = `${pkg.version}-openfork-${sha}-${stamp}`
const installDir = path.join(localAppData, "JetBrains", "acp-agents", "openfork", buildID)
const installed = path.join(installDir, "opencode.exe")
await fs.mkdir(installDir, { recursive: true })
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
  const child = Bun.spawn([installed, "acp"], {
    cwd: root,
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
      if (raw === undefined) throw new Error(`Installed ACP stdout closed before response ${id}`)
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
      reject(new Error("Installed ACP smoke test did not finish within 20 seconds"))
    }, 20_000)
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

    await write({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: root, mcpServers: [] } })
    const created = await response(2)
    if (created?.error || typeof created?.result?.sessionId !== "string") {
      throw new Error(`Installed ACP session/new failed: ${JSON.stringify(created).slice(0, 1000)}`)
    }
    const mode = created.result.configOptions?.find((option: any) => option?.id === "mode")
    const modes = mode && Array.isArray(mode.options) ? modeValues(mode.options) : []
    if (!modes.includes("yolo")) {
      throw new Error(`Installed ACP did not advertise YOLO mode. Modes: ${modes.join(", ") || "(none)"}`)
    }

    await write({
      jsonrpc: "2.0",
      id: 3,
      method: "session/close",
      params: { sessionId: created.result.sessionId },
    })
    const closed = await response(3)
    if (closed?.error) throw new Error(`Installed ACP session/close failed: ${JSON.stringify(closed).slice(0, 1000)}`)

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
  config = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>
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

// Keep a last-known-good backup, then replace the config. Never rewrite the
// JetBrains registry-managed OpenCode cache: those versions remain stock and
// can update independently of this custom entry.
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

// Heal stale OpenFork builds that cannot read the current durable ChunkDB epoch.
// JetBrains can keep an older custom ACP command cached in memory even after
// acp.json changes. Deleting that old versioned path merely changes the failure
// from a schema mismatch to ENOENT; replacing its executable with this newly
// validated build makes cached commands safe immediately. Only our versioned
// OpenFork install root is examined here. Stock JetBrains-managed OpenCode
// binaries are never touched, and already-compatible OpenFork builds remain
// unchanged as rollback candidates.
const openforkRoot = path.dirname(installDir)
const healedBuilds: string[] = []
for (const entry of await fs.readdir(openforkRoot, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === path.basename(installDir)) continue
  const candidateDir = path.join(openforkRoot, entry.name)
  const candidate = path.join(candidateDir, "opencode.exe")
  try {
    await fs.access(candidate)
  } catch {
    continue
  }

  try {
    await validateChunkDbCapability(candidate)
  } catch {
    // Versioned directories are installer-owned and resolved under the explicit
    // OpenFork root above. Preserve the path JetBrains may have cached, but make
    // that path execute the same validated binary as the current config target.
    try {
      await fs.copyFile(installed, candidate)
      await validateChunkDbCapability(candidate)
      healedBuilds.push(entry.name)
    } catch (error) {
      console.warn(`Could not heal stale OpenFork ACP path ${candidate}: ${String(error)}`)
    }
  }
}

console.log(`Installed ${AGENT_NAME}`)
console.log(`  version: ${version.stdout.toString().trim()}`)
console.log(`  binary:  ${installed}`)
console.log(`  config:  ${configPath}`)
if (healedBuilds.length > 0) console.log(`  healed:  ${healedBuilds.length} stale cached OpenFork path(s)`)
console.log("Existing JetBrains ACP processes were left untouched; new agent processes use this build when JetBrains launches the custom entry.")
