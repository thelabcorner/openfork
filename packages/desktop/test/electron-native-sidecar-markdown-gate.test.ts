import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { createServer as createNetServer } from "node:net"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { join, resolve, relative, isAbsolute, sep } from "node:path"
import { tmpdir } from "node:os"
import { promisify } from "node:util"
import appPlugins from "../../app/vite.js"
import { createServer as createViteServer } from "vite"
import { expect, test } from "bun:test"

const execFileAsync = promisify(execFile)
const desktopRoot = resolve(import.meta.dir, "..")
const opencodeRoot = resolve(import.meta.dir, "../../opencode")
const repoRoot = resolve(import.meta.dir, "../../..")
const backgroundBytes = 8 * 1024 * 1024
const password = "native-markdown-gate-only"

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "oc://renderer",
    "access-control-allow-methods": "POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
  })
  response.end(JSON.stringify(body))
}

function readBody(request: IncomingMessage) {
  return new Promise<string>((resolveBody, reject) => {
    let value = ""
    request.setEncoding("utf8")
    request.on("data", (chunk) => (value += chunk))
    request.once("end", () => resolveBody(value))
    request.once("error", reject)
  })
}

function ensureOwnedPath(parent: string, target: string) {
  const resolvedParent = resolve(parent)
  const resolvedTarget = resolve(target)
  const rel = relative(resolvedParent, resolvedTarget)
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`refusing to clean a path outside the fixture-owned parent: ${resolvedTarget}`)
  }
  return resolvedTarget
}

function makeModelServer() {
  const waiting = new Map<string, ServerResponse>()
  let requests = 0
  let largeReplyBytes = 0
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": "oc://renderer",
        "access-control-allow-methods": "POST,OPTIONS",
        "access-control-allow-headers": "content-type,authorization",
      })
      response.end()
      return
    }
    if (url.pathname === "/gate/release" && request.method === "POST") {
      void readBody(request).then((raw) => {
        const body = JSON.parse(raw) as { sessions: string[] }
        const released: string[] = []
        const missing: string[] = []
        for (const id of body.sessions) {
          const held = waiting.get(id)
          if (!held) {
            missing.push(id)
            continue
          }
          waiting.delete(id)
          released.push(id)
          writeChunk(held, { content: `\n\n**native-tail-${id}**\n\n` })
          writeChunk(held, { finish_reason: "stop" })
          held.end("data: [DONE]\n\n")
        }
        send(response, 200, { released, missing })
      }, (error) => send(response, 400, { error: String(error) }))
      return
    }
    if (url.pathname.endsWith("/models") && request.method === "GET") {
      send(response, 200, { data: [{ id: "gate-model", object: "model" }] })
      return
    }
    if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      send(response, 404, { error: "unexpected model endpoint", path: url.pathname })
      return
    }
    void readBody(request).then((raw) => {
      requests++
      const body = JSON.parse(raw) as { messages?: unknown[] }
      const serialized = JSON.stringify(body.messages ?? [])
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "access-control-allow-origin": "oc://renderer",
        connection: "keep-alive",
      })
      response.write("data: {\"id\":\"native-gate\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"},\"finish_reason\":null}]}\n\n")
      if (serialized.includes("native-gate-background-")) {
        const header = "# Background history\n\n"
        const paragraph = "A completed background history paragraph with stable plain text for Markdown parsing.\n\n"
        const bodyText = header + paragraph.repeat(Math.ceil((backgroundBytes - header.length) / paragraph.length))
        const exactText = bodyText.slice(0, backgroundBytes) + "\n\n**native-background-ready**"
        largeReplyBytes = exactText.length
        writeChunk(response, { content: exactText })
        writeChunk(response, { finish_reason: "stop" })
        response.end("data: [DONE]\n\n")
        return
      }
      const id = serialized.match(/native-gate-(ses_[A-Za-z0-9_-]+)/)?.[1]
      if (!id) {
        response.end("data: [DONE]\n\n")
        return
      }
      writeChunk(response, { content: `native-start-${id}` })
      waiting.set(id, response)
    }, (error) => send(response, 400, { error: String(error) }))
  })
  return {
    server,
    stats: () => ({ requests, largeReplyBytes, pending: waiting.size }),
    close: async () => {
      for (const response of waiting.values()) response.end("data: [DONE]\n\n")
      waiting.clear()
      if (server.listening) await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    },
  }
}

async function reserveLoopbackPort() {
  const reservation = createNetServer()
  await new Promise<void>((resolveListen, reject) => {
    reservation.once("error", reject)
    reservation.listen(0, "127.0.0.1", resolveListen)
  })
  const address = reservation.address()
  if (!address || typeof address === "string") throw new Error("failed to reserve a private Vite port")
  const port = address.port
  await new Promise<void>((resolveClose, reject) => reservation.close((error) => error ? reject(error) : resolveClose()))
  return port
}

function writeChunk(response: ServerResponse, value: { content?: string; finish_reason?: string }) {
  const choice = value.content === undefined
    ? { index: 0, delta: {}, finish_reason: value.finish_reason }
    : { index: 0, delta: { content: value.content }, finish_reason: null }
  response.write(`data: ${JSON.stringify({ id: "native-gate", object: "chat.completion.chunk", choices: [choice] })}\n\n`)
}

test("current native Node sidecar streams real session output into the Electron Markdown renderer", async () => {
  const runID = `${process.pid}-${crypto.randomUUID()}`
  const desktopFixture = await mkdtemp(join(import.meta.dir, `.native-sidecar-gate-${runID}-`))
  const artifactName = `.native-sidecar-gate-${runID}`
  const nodeArtifactRoot = ensureOwnedPath(join(opencodeRoot, "dist"), join(opencodeRoot, "dist", artifactName))
  const buildScript = ensureOwnedPath(join(opencodeRoot, "script"), join(opencodeRoot, "script", `build-node-native-gate-${runID}.ts`))
  const configPath = join(desktopFixture, "electron-vite.config.ts")
  const sidecarOut = join(desktopFixture, "electron-build")
  const workspace = join(desktopFixture, "workspace")
  const dataRoot = join(desktopFixture, "isolated-user-data")
  const worktrees = [desktopFixture, nodeArtifactRoot, buildScript]
  const model = makeModelServer()
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined
  let electronOutput = ""
  let modelPort: number | undefined
  try {
    await mkdir(workspace, { recursive: true })
    await mkdir(dataRoot, { recursive: true })
    await execFileAsync("git", ["init", workspace], { timeout: 20_000 })
    await execFileAsync("git", ["-C", workspace, "config", "core.fsmonitor", "false"], { timeout: 15_000 })
    await new Promise<void>((resolveListen, reject) => model.server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolveListen()))
    const address = model.server.address()
    if (!address || typeof address === "string") throw new Error("fixture OpenAI-compatible server did not bind")
    modelPort = address.port
    await writeFile(join(workspace, "openfork.json"), JSON.stringify({
      formatter: false,
      lsp: false,
      provider: {
        "native-gate": {
          name: "Native renderer gate",
          npm: "@ai-sdk/openai-compatible",
          api: `http://127.0.0.1:${modelPort}/v1`,
          options: { apiKey: "native-gate-key" },
          models: {
            "gate-model": {
              name: "Gate model",
              limit: { context: 20_000_000, output: 20_000_000 },
            },
          },
        },
      },
    }))

    // Reuse the repository's official Node build recipe, directing every output
    // into this test's uniquely named dist child so the shared dev artifact is untouched.
    const buildSource = await readFile(join(opencodeRoot, "script", "build-node.ts"), "utf8")
    await writeFile(buildScript, buildSource.replaceAll("./dist/node", `./dist/${artifactName}`))
    const nodeBuild = await execFileAsync("bun", [buildScript], {
      cwd: opencodeRoot,
      timeout: 300_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, OPENCODE_FORCE_NODE_BUILD: "1" },
    })
    console.log("Isolated Node artifact build:", nodeBuild.stdout.trim())
    if (!(await stat(join(nodeArtifactRoot, "node.js"))).size) throw new Error("isolated Node artifact was empty")

    const nodeArtifact = join(nodeArtifactRoot, "node.js")
    const configContents = `
import base from "../../electron.vite.config.ts"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
export default (env) => {
  const config = typeof base === "function" ? base(env) : base
  const override = {
    name: "native-sidecar-gate-server-module",
    enforce: "pre",
    resolveId(id) {
      if (id === "virtual:opencode-server") return { id: pathToFileURL(resolve(process.env.OPENFORK_NATIVE_GATE_NODE_ARTIFACT)).href, external: true }
    },
  }
  config.main.plugins = [override, ...(config.main.plugins ?? []).filter((plugin) => plugin && plugin.name !== "opencode:copy-server-assets")]
  config.main.build.rollupOptions.input = { sidecar: "src/main/sidecar.ts" }
  config.preload = undefined
  config.renderer = undefined
  return config
}
`
    await writeFile(configPath, configContents)
    await mkdir(sidecarOut, { recursive: true })
    const sidecarBuild = await execFileAsync("bun", ["x", "electron-vite", "build", "--config", configPath, "--outDir", sidecarOut, "--logLevel", "warn"], {
      cwd: desktopRoot,
      timeout: 240_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, OPENFORK_NATIVE_GATE_NODE_ARTIFACT: nodeArtifact },
    })
    console.log("Isolated Electron sidecar build:", sidecarBuild.stdout.trim())
    const sidecarEntry = join(sidecarOut, "main", "sidecar.js")
    if (!(await stat(sidecarEntry)).size) throw new Error("production sidecar bundle was not emitted")

    const vitePort = await reserveLoopbackPort()
    vite = await createViteServer({
      configFile: false,
      root: resolve(import.meta.dir, "native-sidecar-markdown-gate"),
      plugins: appPlugins,
      resolve: { alias: [{ find: "@tanstack/solid-query", replacement: resolve(import.meta.dir, "../../app/node_modules/@tanstack/solid-query") }] },
      server: { host: "127.0.0.1", port: vitePort, strictPort: true, hmr: false },
      cacheDir: join(desktopFixture, "vite-cache"),
      optimizeDeps: { exclude: ["shiki"], noDiscovery: true, entries: [] },
      appType: "spa",
    })
    await vite.listen()
    const viteAddress = vite.httpServer?.address()
    if (!viteAddress || typeof viteAddress === "string") throw new Error("Electron renderer Vite server did not bind")
    if (viteAddress.port !== vitePort || viteAddress.address !== "127.0.0.1") {
      throw new Error(`renderer Vite escaped fixture loopback binding: ${JSON.stringify(viteAddress)}`)
    }
    const mainBuild = await Bun.build({
      entrypoints: [
        resolve(import.meta.dir, "native-sidecar-markdown-gate/main.ts"),
        resolve(import.meta.dir, "native-sidecar-markdown-gate/preload.ts"),
      ],
      target: "node",
      format: "cjs",
      packages: "external",
      outdir: desktopFixture,
    })
    expect(mainBuild.success, mainBuild.logs.map((log) => log.message).join("\n")).toBe(true)
    const electronMain = join(desktopFixture, "electron-main.cjs")
    await rename(join(desktopFixture, "main.js"), electronMain)
    const electronPreload = join(desktopFixture, "electron-preload.cjs")
    await rename(join(desktopFixture, "preload.js"), electronPreload)

    const electron = resolve(desktopRoot, "node_modules/electron/dist/electron.exe")
    const electronEnv = {
      ...process.env,
      OPENFORK_NATIVE_GATE_SIDECAR: sidecarEntry,
      OPENFORK_NATIVE_GATE_VITE: `http://127.0.0.1:${viteAddress.port}/`,
      OPENFORK_NATIVE_GATE_DATA: dataRoot,
      OPENFORK_NATIVE_GATE_WORKSPACE: workspace,
      OPENFORK_NATIVE_GATE_PASSWORD: password,
      OPENFORK_NATIVE_GATE_MODEL_CONTROL: `http://127.0.0.1:${modelPort}/`,
      OPENFORK_NATIVE_GATE_PRELOAD: electronPreload,
    }
    delete electronEnv.ELECTRON_RUN_AS_NODE
    const run = await execFileAsync(electron, ["--no-sandbox", "--disable-gpu", electronMain], {
      cwd: repoRoot,
      env: electronEnv,
      timeout: 360_000,
      maxBuffer: 12 * 1024 * 1024,
    })
    electronOutput = `${run.stdout}\n${run.stderr}`
    const marker = run.stdout.split("\n").find((line) => line.startsWith("ELECTRON_NATIVE_SIDECAR_MARKDOWN_RESULT "))
    expect(marker, electronOutput).toBeTruthy()
    const evidence = JSON.parse(marker!.slice("ELECTRON_NATIVE_SIDECAR_MARKDOWN_RESULT ".length)) as Record<string, unknown>
    console.log("Current native Electron sidecar + renderer evidence:", { ...evidence, model: model.stats() })
    expect(evidence.completed).toBe(true)
    expect(evidence.rendered).toBe(6)
    expect((evidence.scenarios as Array<{ promptStatuses: number[]; startsSeen: number; interestAcked: boolean; urgentProbeStatus: number }>).every((item) => item.promptStatuses.every((status) => status === 204) && item.startsSeen === item.promptStatuses.length && item.interestAcked && item.urgentProbeStatus === 200)).toBe(true)
    expect(evidence.sseOpens).toBe(1)
    const expectedAdmissions = [1, 3, 6].reduce((sum, value) => sum + value, 0)
    const transportStats = evidence.transportStats as {
      urgent?: number
      admission?: number
      controlFetches?: number
      admissionFetches?: number
    }
    expect(transportStats.admission).toBe(expectedAdmissions)
    expect(transportStats.admissionFetches).toBe(expectedAdmissions)
    expect(transportStats.urgent ?? 0).toBeGreaterThan(0)
    expect(transportStats.controlFetches).toBe(transportStats.urgent)
    expect(model.stats().largeReplyBytes).toBeGreaterThanOrEqual(backgroundBytes)
    const database = await stat(join(dataRoot, "sidecar.sqlite"))
    expect(database.size).toBeGreaterThan(0)
  } catch (error) {
    electronOutput = `${electronOutput}\n${String(error)}`
    throw error
  } finally {
    await vite?.close()
    await model.close()
    for (const path of worktrees) {
      if (path === buildScript) await rm(path, { force: true }).catch(() => undefined)
      else await rm(path, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}, 600_000)
