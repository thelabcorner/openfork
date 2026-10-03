import { createHash } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { createServer as createNetServer } from "node:net"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import appPlugins from "../../app/vite.js"
import { createServer as createViteServer } from "vite"
import { expect, test } from "bun:test"

const execFileAsync = promisify(execFile)
const desktopRoot = resolve(import.meta.dir, "..")
const opencodeRoot = resolve(import.meta.dir, "../../opencode")
const repoRoot = resolve(import.meta.dir, "../../..")
const password = "full-app-startup-gate-only"
const within = (parent: string, leaf: string) => join(parent, leaf)

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,authorization" })
  response.end(JSON.stringify(body))
}

function body(request: IncomingMessage) {
  return new Promise<string>((resolveBody, reject) => {
    let value = ""
    request.setEncoding("utf8")
    request.on("data", (chunk) => (value += chunk))
    request.once("end", () => resolveBody(value))
    request.once("error", reject)
  })
}

function modelServer() {
  const pending = new Map<string, ServerResponse>()
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    if (request.method === "OPTIONS") {
      response.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "POST,OPTIONS", "access-control-allow-headers": "content-type,authorization" })
      response.end()
      return
    }
    if (url.pathname === "/gate/release" && request.method === "POST") {
      void body(request).then((raw) => {
        const sessions = (JSON.parse(raw) as { sessions: Array<{ id: string; cycle: number }> }).sessions
        const deadline = Date.now() + 15_000
        const awaitAll = () => new Promise<void>((resolvePending) => {
          const poll = () => {
            if (sessions.every(({ id, cycle }) => pending.has(`${id}:${cycle}`)) || Date.now() >= deadline) return resolvePending()
            setTimeout(poll, 20)
          }
          poll()
        })
        void awaitAll().then(() => {
        const released: string[] = []
        const missing: string[] = []
        for (const { id, cycle } of sessions) {
          const key = `${id}:${cycle}`
          const held = pending.get(key)
          if (!held) { missing.push(key); continue }
          pending.delete(key)
          released.push(key)
          held.write(`data: ${JSON.stringify({ id: "full-app-gate", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: `\n\n**full-app-gate-tail-${id}-cycle-${cycle}**` }, finish_reason: null }] })}\n\n`)
          held.write(`data: ${JSON.stringify({ id: "full-app-gate", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`)
          held.end("data: [DONE]\n\n")
        }
        send(response, 200, { released, missing })
        })
      }, (error) => send(response, 400, { error: String(error) }))
      return
    }
    if (request.method === "GET" && url.pathname.endsWith("/models")) {
      send(response, 200, { data: [{ id: "gate-model", object: "model" }] })
      return
    }
    if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      send(response, 404, { error: "unexpected mock model request", path: url.pathname })
      return
    }
    void body(request).then((raw) => {
      const serialized = JSON.stringify((JSON.parse(raw) as { messages?: unknown[] }).messages ?? [])
      const match = serialized.match(/full-app-gate-(ses_[A-Za-z0-9_-]+?)-cycle-(\d+)/)
      const id = match?.[1]
      const cycle = Number(match?.[2])
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" })
      response.write(`data: ${JSON.stringify({ id: "full-app-gate", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`)
      if (!id) { response.end("data: [DONE]\n\n"); return }
      response.write(`data: ${JSON.stringify({ id: "full-app-gate", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: `full-app-gate-start-${id}` }, finish_reason: null }] })}\n\n`)
      pending.set(`${id}:${cycle}`, response)
    }, (error) => send(response, 400, { error: String(error) }))
  })
  return {
    server,
    pending,
    close: async () => {
      for (const response of pending.values()) response.destroy()
      pending.clear()
      server.closeAllConnections()
      if (server.listening) await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    },
  }
}

async function privatePort() {
  const reservation = createNetServer()
  await new Promise<void>((resolveListen, reject) => {
    reservation.once("error", reject)
    reservation.listen(0, "127.0.0.1", resolveListen)
  })
  try {
    const address = reservation.address()
    if (!address || typeof address === "string" || address.port === 5173) throw new Error("failed to reserve a private renderer port")
    return address.port
  } finally {
    if (reservation.listening) {
      await new Promise<void>((resolveClose, reject) => reservation.close((error) => error ? reject(error) : resolveClose()))
    }
  }
}

const sourceFiles = [
  "packages/desktop/electron.vite.config.ts",
  "packages/desktop/src/main/sidecar.ts",
  "packages/desktop/src/main/sidecar-control-transport.ts",
  "packages/desktop/src/renderer/control-fetch.ts",
  "packages/desktop/test/electron-fixture-profile.ts",
  "packages/desktop/test/electron-full-app-startup-gate.test.ts",
  "packages/desktop/test/full-app-startup-gate/main.ts",
  "packages/desktop/test/full-app-startup-gate/main.tsx",
  "packages/desktop/test/full-app-startup-gate/preload.ts",
  "packages/app/vite.ts",
  "packages/app/src/app.tsx",
  "packages/app/src/pages/layout-new.tsx",
  "packages/app/src/pages/home.tsx",
  "packages/app/src/pages/home/home-sessions-controller.tsx",
  "packages/app/src/context/server-sync.tsx",
  "packages/app/src/context/server-sdk.tsx",
  "packages/app/src/context/global-sync/bootstrap.ts",
  "packages/app/src/hooks/use-openrouter-free-usage.ts",
  "packages/opencode/src/server/shared/workspace-routing.ts",
  "packages/opencode/src/server/routes/instance/httpapi/groups/experimental.ts",
  "packages/opencode/src/server/routes/instance/httpapi/handlers/experimental.ts",
  "packages/opencode/src/project/instance-store.ts",
]

test("production desktop application keeps cold Home and background sessions on their owners", async () => {
  const runID = `${process.pid}-${crypto.randomUUID()}`
  // SQLite's Windows WAL/SHM companions append suffixes to a 64-hex global
  // file-index database name. Keep the retained fixture root compact so those
  // legitimate sidecar paths stay well below the Win32 path boundary.
  const fixture = await mkdtemp(join(import.meta.dir, `.fg-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}-`))
  const workspace = within(fixture, "workspace")
  const dataRoot = within(fixture, "isolated-user-data")
  const nodeOut = within(fixture, "private-node-artifact")
  const buildScript = within(join(opencodeRoot, "script"), `build-node-full-app-gate-${runID}.ts`)
  const configPath = within(fixture, "electron-vite.config.ts")
  const electronOut = within(fixture, "electron-build")
  const evidencePath = within(fixture, "evidence.json")
  const model = modelServer()
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined
  let modelPort: number | undefined
  let electronOutput = ""
  try {
    await mkdir(workspace, { recursive: true })
    await mkdir(dataRoot, { recursive: true })
    await mkdir(nodeOut, { recursive: true })
    // The private ESM artifact is outside the package tree. Link the exact
    // external package it needs into this run-owned fixture. A junction to the
    // whole workspace node_modules would break Bun's relative per-package
    // symlinks, so resolve the package target before creating the link.
    const privateNodeModules = join(nodeOut, "node_modules")
    await mkdir(privateNodeModules)
    const jsoncPackageRoot = await realpath(join(opencodeRoot, "node_modules", "jsonc-parser"))
    const jsoncFixtureLink = join(privateNodeModules, "jsonc-parser")
    await symlink(jsoncPackageRoot, jsoncFixtureLink, "junction")
    if (await realpath(jsoncFixtureLink) !== jsoncPackageRoot) throw new Error("private jsonc-parser link did not resolve to its inspected package target")
    await execFileAsync("git", ["init", workspace], { timeout: 20_000 })
    await execFileAsync("git", ["-C", workspace, "config", "core.fsmonitor", "false"], { timeout: 15_000 })
    await new Promise<void>((resolveListen, reject) => model.server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolveListen()))
    const address = model.server.address()
    if (!address || typeof address === "string") throw new Error("private mock model server did not bind")
    modelPort = address.port
    await writeFile(join(workspace, "openfork.json"), JSON.stringify({
      formatter: false,
      lsp: false,
      provider: {
        "full-app-gate": {
          name: "Full application gate",
          npm: "@ai-sdk/openai-compatible",
          api: `http://127.0.0.1:${modelPort}/v1`,
          options: { apiKey: "full-app-gate-key" },
          models: { "gate-model": { name: "Gate model", limit: { context: 100000, output: 100000 } } },
        },
      },
    }))

    const nodeSource = await readFile(join(opencodeRoot, "script", "build-node.ts"), "utf8")
    const sources = await Promise.all(sourceFiles.map(async (path) => [path, createHash("sha256").update(await readFile(resolve(repoRoot, path))).digest("hex")] as const))
    const sourceFingerprint = createHash("sha256").update(JSON.stringify(sources)).digest("hex")
    const absoluteNodeOut = nodeOut.replaceAll("\\", "/")
    const buildInstrumentation = `
  const result = await Bun.build({
    ...options,
    plugins: [...(options.plugins ?? []), {
      name: "full-app-gate-instance-owner-trace",
      setup(build) {
        build.onLoad({ filter: /instance-store/ }, async ({ path }) => {
          const source = await Bun.file(path).text()
          const needle = 'yield* Effect.logInfo("creating instance", {'
          if (!source.includes(needle)) throw new Error("InstanceStore authoritative creation seam moved; update the full-app gate")
          const trace = 'process.stdout.write("FULL_APP_GATE_INSTANCE_LOAD " + JSON.stringify({ directory, explicitLocation: !!input.attribution, caller: input.attribution?.caller ?? "unspecified", route: input.attribution?.route, reason: input.attribution?.reason }) + "\\\\n")\\n            '
          return { contents: source.replace(needle, trace + needle), loader: "ts" }
        })
      },
    }],
  })`
    const buildSource = nodeSource
      .replace('const outFile = path.join(dir, "dist/node/node.js")', `const outFile = path.join(${JSON.stringify(absoluteNodeOut)}, "node.js")`)
      .replace('const compressWorkerFile = path.join(dir, "dist/node/compress-worker.js")', `const compressWorkerFile = path.join(${JSON.stringify(absoluteNodeOut)}, "compress-worker.js")`)
      .replace('const decompressWorkerFile = path.join(dir, "dist/node/decompress-worker.js")', `const decompressWorkerFile = path.join(${JSON.stringify(absoluteNodeOut)}, "decompress-worker.js")`)
      .replace('const stampFile = path.join(dir, "dist/node/.build-stamp")', `const stampFile = path.join(${JSON.stringify(absoluteNodeOut)}, ".build-stamp")`)
      .replace('const artifactLockFile = path.join(dir, "dist/node/.oxp-runtime-refresh.lock")', `const artifactLockFile = path.join(${JSON.stringify(absoluteNodeOut)}, ".oxp-runtime-refresh.lock")`)
      .replaceAll("./dist/node", absoluteNodeOut)
      .replace("const result = await Bun.build(options)", buildInstrumentation)
    if (buildSource === nodeSource || buildSource.includes("./dist/node") || buildSource.includes('path.join(dir, "dist/node')) throw new Error("private Node build output/instrumentation rewrite did not apply")
    await writeFile(buildScript, buildSource)
    const build = await execFileAsync("bun", [buildScript], {
      cwd: opencodeRoot,
      timeout: 300_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, OPENCODE_FORCE_NODE_BUILD: "1" },
    })
    const nodeArtifact = join(nodeOut, "node.js")
    if (!(await stat(nodeArtifact)).size) throw new Error("private Node sidecar artifact was empty")
    if (!(await readFile(nodeArtifact, "utf8")).includes("FULL_APP_GATE_INSTANCE_LOAD")) {
      throw new Error("private Node artifact omitted the InstanceStore owner trace injection")
    }
    const afterNodeBuild = await Promise.all(sourceFiles.map(async (path) => [path, createHash("sha256").update(await readFile(resolve(repoRoot, path))).digest("hex")] as const))
    if (createHash("sha256").update(JSON.stringify(afterNodeBuild)).digest("hex") !== sourceFingerprint) {
      throw new Error("measured production sources changed during the private Node sidecar build")
    }
    const nodeArtifactHash = createHash("sha256").update(await readFile(nodeArtifact)).digest("hex")

    const config = `
import base from "../../electron.vite.config.ts"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
export default (env) => {
  const config = typeof base === "function" ? base(env) : base
  const override = { name: "full-app-gate-sidecar-module", enforce: "pre", resolveId(id) {
    if (id === "virtual:opencode-server") return { id: pathToFileURL(resolve(process.env.OPENFORK_FULL_APP_GATE_NODE_ARTIFACT)).href, external: true }
  } }
  config.main.plugins = [override, ...(config.main.plugins ?? []).filter((plugin) => plugin && plugin.name !== "opencode:copy-server-assets")]
  config.main.build.rollupOptions.input = { sidecar: "src/main/sidecar.ts" }
  config.preload = undefined
  config.renderer = undefined
  return config
}`
    await writeFile(configPath, config)
    await mkdir(electronOut, { recursive: true })
    await execFileAsync("bun", ["x", "electron-vite", "build", "--config", configPath, "--outDir", electronOut, "--logLevel", "warn"], {
      cwd: desktopRoot,
      timeout: 240_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, OPENFORK_FULL_APP_GATE_NODE_ARTIFACT: nodeArtifact },
    })
    const sidecarEntry = join(electronOut, "main", "sidecar.js")
    if (!(await stat(sidecarEntry)).size) throw new Error("private production sidecar build was missing")

    const vitePort = await privatePort()
    const cacheRoot = within(fixture, "vite-cache")
    if (cacheRoot.startsWith(resolve(desktopRoot)) === false) throw new Error("renderer cache is outside the fixture tree")
    const plannedProfilePaths = [
      join(dataRoot, "user-data"), join(dataRoot, "session-data"), join(dataRoot, "logs"), join(dataRoot, "crash-dumps"),
    ]
    const sqliteBase = join(dataRoot, "data", "openfork", "file-index", `${"0".repeat(64)}.db`)
    const sqlitePaths = [sqliteBase, `${sqliteBase}-wal`, `${sqliteBase}-shm`, `${sqliteBase}-journal`]
    if (sqlitePaths.some((path) => path.length >= 240)) {
      throw new Error(`private profile leaves insufficient room for Windows SQLite sidecars: ${JSON.stringify(sqlitePaths.map((path) => path.length))}`)
    }
    if (plannedProfilePaths.some((path) => {
      const rel = relative(resolve(fixture), resolve(path))
      return !rel || rel === ".." || rel.startsWith(`..${sep}`)
    })) throw new Error("Electron profile preflight escaped the fixture-owned root")
    if (vitePort === 5173) throw new Error("private renderer port preflight failed")
    vite = await createViteServer({
      configFile: false,
      root: import.meta.dir + "/full-app-startup-gate",
      publicDir: resolve(desktopRoot, "../app/public"),
      plugins: appPlugins,
      resolve: { alias: [{ find: "@tanstack/solid-query", replacement: resolve(import.meta.dir, "../../app/node_modules/@tanstack/solid-query") }] },
      server: { host: "127.0.0.1", port: vitePort, strictPort: true, hmr: false },
      cacheDir: cacheRoot,
      optimizeDeps: { exclude: ["shiki"], include: ["@shikijs/stream", "remend"] },
      appType: "spa",
    })
    await vite.listen()
    const viteAddress = vite.httpServer?.address()
    if (!viteAddress || typeof viteAddress === "string" || viteAddress.port !== vitePort || viteAddress.address !== "127.0.0.1") {
      throw new Error(`private renderer escaped loopback binding: ${JSON.stringify(viteAddress)}`)
    }
    const mainBuild = await Bun.build({
      entrypoints: [join(import.meta.dir, "full-app-startup-gate/main.ts"), join(import.meta.dir, "full-app-startup-gate/preload.ts")],
      target: "node", format: "cjs", packages: "external", outdir: fixture,
    })
    expect(mainBuild.success, mainBuild.logs.map((log) => log.message).join("\n")).toBe(true)
    const electronMain = join(fixture, "electron-main.cjs")
    await Bun.write(electronMain, await readFile(join(fixture, "main.js")))
    const electronPreload = join(fixture, "electron-preload.cjs")
    await Bun.write(electronPreload, await readFile(join(fixture, "preload.js")))
    await execFileAsync("node", ["--check", electronMain], { timeout: 20_000 })
    await execFileAsync("node", ["--check", electronPreload], { timeout: 20_000 })

    const electron = resolve(desktopRoot, "node_modules/electron/dist/electron.exe")
    await stat(electron)
    await stat(electronMain)
    await stat(electronPreload)
    await stat(sidecarEntry)
    if (!modelPort || modelPort === viteAddress.port) throw new Error("private model/renderer ports collided or were unavailable")
    const profileRoot = resolve(dataRoot)
    if (relative(resolve(fixture), profileRoot).startsWith(`..${sep}`)) throw new Error("Electron profile path escaped fixture before launch")
    await writeFile(join(fixture, "preflight.json"), JSON.stringify({
      fixture,
      profileRoot,
      profilePaths: plannedProfilePaths,
      maximumSQLitePathLengths: sqlitePaths.map((path) => path.length),
      renderer: viteAddress,
      modelPort,
      sidecarArtifact: nodeArtifact,
      sidecarArtifactHash: nodeArtifactHash,
      sourceFingerprint,
      logRoot: join(dataRoot, "logs"),
    }, null, 2))
    const immediatelyBeforeLaunch = await Promise.all(sourceFiles.map(async (path) => [path, createHash("sha256").update(await readFile(resolve(repoRoot, path))).digest("hex")] as const))
    if (createHash("sha256").update(JSON.stringify(immediatelyBeforeLaunch)).digest("hex") !== sourceFingerprint) {
      throw new Error("measured production sources changed during Electron/Vite fixture builds")
    }
    const env = {
      ...process.env,
      OPENFORK_FULL_APP_GATE_SIDECAR: sidecarEntry,
      OPENFORK_FULL_APP_GATE_VITE: `http://127.0.0.1:${viteAddress.port}/`,
      OPENFORK_FULL_APP_GATE_DATA: dataRoot,
      OPENFORK_FULL_APP_GATE_WORKSPACE: workspace,
      OPENFORK_FULL_APP_GATE_PASSWORD: password,
      OPENFORK_FULL_APP_GATE_MODEL_CONTROL: `http://127.0.0.1:${modelPort}/`,
      OPENFORK_FULL_APP_GATE_PRELOAD: electronPreload,
    }
    delete env.ELECTRON_RUN_AS_NODE
    const run = await execFileAsync(electron, ["--no-sandbox", "--disable-gpu", electronMain], {
      cwd: repoRoot, env, timeout: 360_000, maxBuffer: 16 * 1024 * 1024,
    })
    electronOutput = `${run.stdout}\n${run.stderr}`
    const marker = run.stdout.split("\n").find((line) => line.startsWith("ELECTRON_FULL_APP_STARTUP_GATE_RESULT "))
    expect(marker, electronOutput).toBeTruthy()
    const appEvidence = JSON.parse(marker!.slice("ELECTRON_FULL_APP_STARTUP_GATE_RESULT ".length)) as Record<string, any>
    const afterRunSources = await Promise.all(sourceFiles.map(async (path) => [path, createHash("sha256").update(await readFile(resolve(repoRoot, path))).digest("hex")] as const))
    const sourceFingerprintAfterRun = createHash("sha256").update(JSON.stringify(afterRunSources)).digest("hex")
    const ownerEvents = [...electronOutput.matchAll(/^FULL_APP_GATE_INSTANCE_LOAD (\{.*\})\s*$/gm)].map((match) => JSON.parse(match[1]!))
    const evidence = {
      runID, sourceFiles: Object.fromEntries(sources), sourceFingerprint, sourceFingerprintAfterRun, nodeArtifactHash,
      runtimes: { testNode: process.versions.node, electron: appEvidence.electron, rendererNode: appEvidence.node, chromium: appEvidence.chromium },
      ownerEvents, app: appEvidence,
    }
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2))
    console.log("Full application startup gate evidence:", evidencePath, evidence)
    expect(sourceFingerprintAfterRun).toBe(sourceFingerprint)

    expect(appEvidence.cold.path).toBe("/")
    expect(appEvidence.cold.tabs).toBe(0)
    expect(appEvidence.cold.historyReads).toBe(0)
    expect(appEvidence.cold.partReads).toBe(0)
    expect(appEvidence.cold.rendererErrors).toEqual([])
    expect(appEvidence.cold.consoleErrors).toEqual([])
    expect(appEvidence.cold.visibleAlerts).toEqual([])
    expect(appEvidence.locationFailures.every((status: number) => status >= 400)).toBe(true)
    expect(appEvidence.visibleBeforeSelect.path).toBe("/")
    expect(appEvidence.visibleBeforeSelect.tabs).toBe(0)
    expect(appEvidence.visibleBeforeSelect.rows.some((row: string) => row.includes("full-app-first-project-row"))).toBe(true)
    expect(appEvidence.visibleBeforeSelect.historyReads).toBe(0)
    expect(appEvidence.selected.path).toContain(`/session/${ownerSessionID(appEvidence)}`)
    expect(appEvidence.selected.visibleBodyText).toContain(ownerSessionID(appEvidence))
    expect(appEvidence.selected.visibleBodyText).not.toContain("Something went wrong")
    expect(appEvidence.final.sseOpens).toBe(1)
    expect(Object.values(appEvidence.final.rootReadsByDirectory as Record<string, number>).length).toBe(1)
    expect(Object.values(appEvidence.final.rootReadsByDirectory as Record<string, number>)[0]).toBeLessThanOrEqual(2)
    expect(appEvidence.scenarios.map((scenario: { count: number }) => scenario.count)).toEqual([1, 3, 6])
    expect(appEvidence.scenarios.every((scenario: { statuses: number[] }) => scenario.statuses.every((status) => status === 204))).toBe(true)
    expect(appEvidence.scenarios.every((scenario: { view: { tabs: number; historyPaths: string[]; rendererErrors: string[]; consoleErrors: string[]; visibleAlerts: string[]; visibleBodyText: string }; uniqueTail: string; idle: Record<string, { type?: string }> }) =>
      scenario.view.tabs <= 1 &&
      scenario.view.visibleBodyText.includes(scenario.uniqueTail) &&
      scenario.view.historyPaths.every((path) => path.includes(ownerSessionID(appEvidence))) &&
      scenario.view.rendererErrors.length === 0 &&
      scenario.view.consoleErrors.length === 0 &&
      scenario.view.visibleAlerts.length === 0 &&
      Object.values(scenario.idle).every((status) => status.type !== "busy") &&
      appEvidence.scenarios.filter((candidate: { uniqueTail: string }) => candidate.uniqueTail === scenario.uniqueTail).length === 1,
    )).toBe(true)
    expect(Number.isFinite(appEvidence.final.maxLongAnimationFrameMs)).toBe(true)
    expect(appEvidence.final.rendererErrors).toEqual([])
    expect(appEvidence.final.consoleErrors).toEqual([])
    expect(appEvidence.final.visibleAlerts).toEqual([])
    expect(appEvidence.final.heldOptionalCount).toBe(appEvidence.final.heldOptionalPaths.length)
    expect(appEvidence.final.heldOptionalPaths.every((path: string) => path === "/fork/credential" || path === "/fork/usage")).toBe(true)
    expect(Number.isFinite(appEvidence.coldElapsedMs)).toBe(true)
    expect(Number.isFinite(appEvidence.rowVisibilityMs)).toBe(true)
    expect(appEvidence.scenarios.every((scenario: { admissionMs: number; releaseWaitMs: number; selectedTailMs: number; idleConvergenceMs: number }) =>
      [scenario.admissionMs, scenario.releaseWaitMs, scenario.selectedTailMs, scenario.idleConvergenceMs].every(Number.isFinite),
    )).toBe(true)
    expect(Number.isFinite(appEvidence.final.maxFrameGapMs)).toBe(true)
    expect(ownerEvents.every((event: { explicitLocation: boolean }) => event.explicitLocation)).toBe(true)
    expect(ownerEvents.every((event: { directory: string }) => event.directory === workspace)).toBe(true)
    expect(ownerEvents.length).toBe(1)
    expect(ownerEvents.every((event: { caller: string; route?: string }) => event.caller === "http" && routeIsPrompt(event.route))).toBe(true)
    const profilePaths = appEvidence.profilePaths as Record<string, string>
    expect(Object.values(profilePaths).every((path) => {
      const rel = relative(resolve(dataRoot), resolve(path))
      return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`)
    })).toBe(true)
  } catch (error) {
    electronOutput = `${electronOutput}\n${String(error)}`
    const failure = error as { stdout?: string; stderr?: string }
    await writeFile(within(fixture, "failure.log"), `${failure.stdout ?? ""}\n${failure.stderr ?? ""}\n${electronOutput}`).catch(() => undefined)
    throw error
  } finally {
    await vite?.close()
    await model.close()
    // The cloned recipe is the only temporary file in the shared source tree;
    // it is uniquely named and owned by this exact run. Keep all fixture output
    // for diagnosis and never prune another run's artifacts.
    await rm(buildScript, { force: true }).catch(() => undefined)
    console.info("Full application gate fixture retained at", fixture)
  }
}, 720_000)

function routeIsPrompt(route: string | undefined) {
  return typeof route === "string" && /\/prompt_async$/.test(route)
}

function ownerSessionID(appEvidence: Record<string, any>) {
  return appEvidence.scenarios?.[0]?.ids?.[0] ?? appEvidence.selected?.historyPaths?.[0]?.match(/ses_[A-Za-z0-9_-]+/)?.[0] ?? "__no_session__"
}
