import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http"
import { execFile, spawn } from "node:child_process"
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { tmpdir } from "node:os"
import { createInterface } from "node:readline"
import appPlugins from "../../app/vite.js"
import { createServer as createViteServer } from "vite"
import { expect, test } from "bun:test"
import { privateViteIsolation } from "./private-vite-isolation"

const execFileAsync = promisify(execFile)
const sessions = Array.from({ length: 6 }, (_, i) => `ses_sdk_gate_${i + 1}`)
const sessionState = new Map(sessions.map((id) => [id, { text: `authoritative repair ${id}`, repairFailures: 0 }]))
const streamRequests: Array<{ cursor?: string; subscriber?: string; sessions: string[] }> = []
const interestAcks: Array<{ subscriber: string; generation: number; sessions: string[] }> = []
const failedRepairs: string[] = []
const emitted = new Set<string>()
const heldBackground = new Set<string>()
const sseResponses = new Set<ServerResponse>()
let eventID = 1

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" })
  response.end(JSON.stringify(body))
}

function route(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1")
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,last-event-id,x-opencode-stream-subscriber,x-opencode-stream-sessions,x-opencode-stream-generation",
    })
    response.end()
    return
  }
  if (url.pathname === "/gate/control" && request.method === "POST") {
    let raw = ""
    request.setEncoding("utf8")
    request.on("data", (chunk) => (raw += chunk))
    request.on("end", () => {
      const body = JSON.parse(raw) as { action: string; sessions?: string[]; session?: string; failFirstRepair?: boolean }
      if (body.action === "disconnect") {
        for (const stream of sseResponses) stream.end()
        sseResponses.clear()
      }
      if (body.action === "deltas") {
        for (const id of body.sessions ?? []) {
          const state = sessionState.get(id)
          if (!state) continue
          sse(++eventID, { directory: "global", payload: { type: "session.status", properties: { sessionID: id, status: { type: "busy" } } } })
          const delta = `\n\nsse-tail-${id}`
          state.text += delta
          sse(++eventID, { directory: "global", payload: { type: "message.part.delta", properties: { sessionID: id, messageID: `msg_${id}`, partID: `part_${id}`, field: "text", delta, offset: state.text.length - delta.length } } })
        }
      }
      if (body.action === "cursor-marker" && body.session) {
        const id = body.session
        const state = sessionState.get(id)
        if (state) {
          const delta = `\n\ncursor-tail-${id}`
          state.text += delta
          sse(++eventID, { directory: "global", payload: { type: "message.part.delta", properties: { sessionID: id, messageID: `msg_${id}`, partID: `part_${id}`, field: "text", delta, offset: state.text.length - delta.length } } })
        }
      }
      if (body.action === "gap" && body.session) {
        const state = sessionState.get(body.session)
        if (state && body.failFirstRepair) state.repairFailures = 1
        if (state) state.text += `\n\nrepaired-after-gap-${body.session}`
        sse(++eventID, { directory: "global", payload: { type: "message.part.delta", properties: { sessionID: body.session, messageID: `msg_${body.session}`, partID: `part_${body.session}`, field: "text", delta: "offset-gap", offset: Number.MAX_SAFE_INTEGER } } })
      }
      send(response, 200, { ok: true })
    })
    return
  }
  if (url.pathname === "/gate/stats") return send(response, 200, { streamRequests, interestAcks, failedRepairs })
  if (url.pathname === "/global/health") return send(response, 200, { healthy: true })
  if (url.pathname === "/global/event/interest" && request.method === "POST") {
    let raw = ""
    request.setEncoding("utf8")
    request.on("data", (chunk) => (raw += chunk))
    request.on("end", () => {
      const body = JSON.parse(raw) as { subscriber: string; generation: number; sessions: string[] }
      interestAcks.push(body)
      send(response, 200, { updated: true, generation: body.generation })
    })
    return
  }
  if (url.pathname === "/global/event") {
    const subscriber = request.headers["x-opencode-stream-subscriber"] as string | undefined
    const interest = request.headers["x-opencode-stream-sessions"]
    const selected = typeof interest === "string" ? JSON.parse(interest) as string[] : []
    streamRequests.push({ cursor: request.headers["last-event-id"] as string | undefined, subscriber, sessions: selected })
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "access-control-allow-origin": "*",
      connection: "keep-alive",
    })
    response.flushHeaders()
    sseResponses.add(response)
    response.write(`id: ${eventID}\ndata: ${JSON.stringify({ directory: "global", payload: { type: "server.connected", properties: {} } })}\n\n`)
    request.on("close", () => sseResponses.delete(response))
    return
  }
  if (url.pathname === "/global/config") {
    heldBackground.add(url.pathname)
    setTimeout(() => send(response, 200, {}), 2_000)
    return
  }
  const sessionMatch = url.pathname.match(/^\/session\/(ses_sdk_gate_\d+)(?:\/(message))?$/)
  if (sessionMatch) {
    const id = sessionMatch[1]!
    const state = sessionState.get(id)
    if (!state) return send(response, 404, { error: "missing session" })
    if (sessionMatch[2] === "message") {
      if (state.repairFailures > 0) {
        state.repairFailures--
        failedRepairs.push(id)
        return send(response, 503, { error: "intentional first repair failure" })
      }
      return send(response, 200, [
        {
          info: { id: `msg_${id}`, sessionID: id, role: "assistant", time: { created: 1 }, parentID: `user_${id}`, modelID: "gate", providerID: "gate", mode: "build", agent: "build", path: { cwd: "/gate", root: "/gate" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
          parts: [{ id: `part_${id}`, sessionID: id, messageID: `msg_${id}`, type: "text", text: state.text }],
        },
      ])
    }
    return send(response, 200, { id, slug: id, projectID: "sdk-stream-gate", directory: "/gate", title: id, version: "1", time: { created: 1, updated: 1 } })
  }
  if (url.pathname === "/global/session") return send(response, 200, [])
  if (url.pathname.startsWith("/global/")) return send(response, 200, {})
  if (url.pathname.startsWith("/")) return send(response, 404, { error: "fixture route not implemented", path: url.pathname })
}

function sse(id: number, event: unknown) {
  const frame = `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`
  for (const response of sseResponses) response.write(frame)
}

test("production ServerSync consumes SDK SSE and repairs active markdown without tab navigation", async () => {
  streamRequests.length = 0
  interestAcks.length = 0
  failedRepairs.length = 0
  emitted.clear()
  heldBackground.clear()
  for (const state of sessionState.values()) {
    state.repairFailures = 0
    state.text = `authoritative repair ${[...sessionState.entries()].find(([, value]) => value === state)?.[0]}`
  }
  const directory = await mkdtemp(join(import.meta.dir, ".electron-sdk-markdown-gate-"))
  const peer = createServer(route)
  await new Promise<void>((resolveListen, reject) => peer.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolveListen()))
  const peerAddress = peer.address()
  if (!peerAddress || typeof peerAddress === "string") throw new Error("peer did not bind")
  const previousPeer = process.env.VITE_SDK_MARKDOWN_PEER_URL
  const previousControl = process.env.VITE_SDK_MARKDOWN_CONTROL_URL
  const previousBackendProxy = process.env.VITE_SDK_MARKDOWN_USE_BACKEND_PROXY
  const previousHttpApi = process.env.OPENFORK_TEST_HTTPAPI_URL
  const previousSessions = process.env.VITE_SDK_MARKDOWN_SESSION_IDS
  process.env.VITE_SDK_MARKDOWN_PEER_URL = `http://127.0.0.1:${peerAddress.port}/`
  process.env.VITE_SDK_MARKDOWN_CONTROL_URL = `http://127.0.0.1:${peerAddress.port}/`
  process.env.VITE_SDK_MARKDOWN_USE_BACKEND_PROXY = "false"
  delete process.env.OPENFORK_TEST_HTTPAPI_URL
  process.env.VITE_SDK_MARKDOWN_SESSION_IDS = JSON.stringify(sessions)
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined
  try {
    vite = await createViteServer({
      configFile: false,
      root: resolve(import.meta.dir, "markdown-sdk-stream-gate"),
      plugins: appPlugins,
      resolve: { alias: [{ find: "@tanstack/solid-query", replacement: resolve(import.meta.dir, "../../app/node_modules/@tanstack/solid-query") }] },
      ...await privateViteIsolation(join(directory, "vite-cache")),
      optimizeDeps: { exclude: ["shiki"], noDiscovery: true, entries: [] },
      appType: "spa",
    })
    await vite.listen()
    const address = vite.httpServer?.address()
    if (!address || typeof address === "string") throw new Error("Vite did not bind")
    const build = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "electron-markdown-sdk-stream-gate.ts")],
      target: "node",
      format: "cjs",
      packages: "external",
      outdir: directory,
    })
    expect(build.success, build.logs.map((log) => log.message).join("\n")).toBe(true)
    const main = join(directory, "electron-markdown-sdk-stream-gate.cjs")
    await rename(join(directory, "electron-markdown-sdk-stream-gate.js"), main)
    const electron = resolve(import.meta.dir, "../node_modules/electron/dist/electron.exe")
    const electronEnv = {
      ...process.env,
      OPENFORK_SDK_MARKDOWN_GATE_URL: `http://127.0.0.1:${address.port}/`,
      OPENFORK_FIXTURE_PROFILE_ROOT: join(directory, "electron-profile"),
      OPENFORK_SDK_MARKDOWN_PEER_URL: `http://127.0.0.1:${peerAddress.port}/`,
      OPENFORK_SDK_MARKDOWN_SESSION_IDS: JSON.stringify(sessions),
    }
    delete electronEnv.ELECTRON_RUN_AS_NODE
    await execFileAsync("node", ["--check", main], { timeout: 15_000 })
    const result = await execFileAsync(electron, ["--no-sandbox", "--disable-gpu", main], {
      cwd: resolve(import.meta.dir, "../../.."),
      env: electronEnv,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    const marker = result.stdout.split("\n").find((line) => line.startsWith("ELECTRON_SDK_MARKDOWN_GATE_RESULT "))
    expect(marker, result.stdout + result.stderr).toBeTruthy()
    const evidence = JSON.parse(marker!.slice("ELECTRON_SDK_MARKDOWN_GATE_RESULT ".length)) as Record<string, unknown>
    console.log("Electron SDK Markdown evidence:", evidence)
    expect(evidence.completed).toBe(true)
    expect(evidence.concurrency).toBe(6)
    expect(evidence.rendered).toBe(6)
    expect(evidence.interestActivated).toBe(true)
    expect((evidence.scenarios as Array<{ interestAcked?: boolean }>).every((scenario) => scenario.interestAcked)).toBe(true)
    expect(evidence.cursorReconnect).toBe(true)
    expect(evidence.autonomousRepair).toBe(true)
    expect(evidence.repairAfterFirstFailure).toBe(true)
    expect(evidence.teardownRoots).toBe(0)
    expect(streamRequests.some((request) => request.cursor !== undefined)).toBe(true)
    expect(interestAcks.some((ack) => ack.sessions.length === 6)).toBe(true)
    expect(heldBackground.has("/global/config")).toBe(true)
    expect(failedRepairs).toContain(sessions[0])
  } finally {
    for (const response of sseResponses) response.end()
    await new Promise<void>((resolveClose) => peer.close(() => resolveClose()))
    await vite?.close()
    if (previousPeer === undefined) delete process.env.VITE_SDK_MARKDOWN_PEER_URL
    else process.env.VITE_SDK_MARKDOWN_PEER_URL = previousPeer
    if (previousControl === undefined) delete process.env.VITE_SDK_MARKDOWN_CONTROL_URL
    else process.env.VITE_SDK_MARKDOWN_CONTROL_URL = previousControl
    if (previousBackendProxy === undefined) delete process.env.VITE_SDK_MARKDOWN_USE_BACKEND_PROXY
    else process.env.VITE_SDK_MARKDOWN_USE_BACKEND_PROXY = previousBackendProxy
    if (previousHttpApi === undefined) delete process.env.OPENFORK_TEST_HTTPAPI_URL
    else process.env.OPENFORK_TEST_HTTPAPI_URL = previousHttpApi
    if (previousSessions === undefined) delete process.env.VITE_SDK_MARKDOWN_SESSION_IDS
    else process.env.VITE_SDK_MARKDOWN_SESSION_IDS = previousSessions
    await rm(directory, { recursive: true, force: true })
  }
}, 120_000)

test("real TestHttpApi producer events reach 1/3/6 Markdown tails in Electron", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openfork-httpapi-markdown-gate-"))
  const workspace = join(directory, "workspace")
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, "openfork.json"), JSON.stringify({ formatter: false, lsp: false }))
  await execFileAsync("git", ["init", workspace], { timeout: 15_000 })
  await execFileAsync("git", ["-C", workspace, "config", "core.fsmonitor", "false"], { timeout: 15_000 })
  const opencodeRoot = resolve(import.meta.dir, "../../opencode")
  const backend = spawn(process.execPath, ["run", "test/fixture/markdown-httpapi-gate.ts"], {
    cwd: opencodeRoot,
    env: {
      ...process.env,
      OPENCODE_DB: join(directory, "isolated.db"),
      OPENFORK_RENDERER_GATE_DIRECTORY: workspace,
    },
    stdio: ["pipe", "pipe", "pipe"],
  })
  const backendOutput: string[] = []
  const pendingCommands = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  let commandID = 0
  let backendReadyResolve: ((url: string) => void) | undefined
  let backendReadyReject: ((error: Error) => void) | undefined
  const backendReady = new Promise<string>((resolveReady, rejectReady) => {
    backendReadyResolve = resolveReady
    backendReadyReject = rejectReady
  })
  const lines = createInterface({ input: backend.stdout })
  lines.on("line", (line) => {
    backendOutput.push(line)
    if (line.startsWith("OPENFORK_RENDERER_GATE_READY ")) {
      backendReadyResolve?.(line.slice("OPENFORK_RENDERER_GATE_READY ".length))
      return
    }
    if (line.startsWith("OPENFORK_RENDERER_GATE_RESULT ")) {
      const value = JSON.parse(line.slice("OPENFORK_RENDERER_GATE_RESULT ".length)) as { id: string; result: unknown }
      const pending = pendingCommands.get(value.id)
      if (!pending) return
      pendingCommands.delete(value.id)
      pending.resolve(value.result)
      return
    }
    if (line.startsWith("OPENFORK_RENDERER_GATE_ERROR ")) {
      const value = JSON.parse(line.slice("OPENFORK_RENDERER_GATE_ERROR ".length)) as { id: string; error: string }
      const pending = pendingCommands.get(value.id)
      if (!pending) return
      pendingCommands.delete(value.id)
      pending.reject(new Error(value.error))
    }
  })
  backend.stderr.on("data", (chunk) => backendOutput.push(String(chunk)))
  backend.once("error", (error) => backendReadyReject?.(error))
  backend.once("exit", (code, signal) => {
    if (code !== 0) backendReadyReject?.(new Error(`TestHttpApi fixture exited ${code ?? signal}: ${backendOutput.join("\n")}`))
  })
  const callBackend = (action: string, payload: Record<string, unknown> = {}) => {
    const id = String(++commandID)
    return new Promise<unknown>((resolveCommand, rejectCommand) => {
      pendingCommands.set(id, { resolve: resolveCommand, reject: rejectCommand })
      backend.stdin.write(`${JSON.stringify({ id, action, ...payload })}\n`)
    })
  }

  let control: ReturnType<typeof createServer> | undefined
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined
  let electronOutput = ""
  const apiFailures: string[] = []
  const apiRequests: string[] = []
  const previousControl = process.env.VITE_SDK_MARKDOWN_CONTROL_URL
  const previousBackendProxy = process.env.VITE_SDK_MARKDOWN_USE_BACKEND_PROXY
  const previousApiURL = process.env.VITE_SDK_MARKDOWN_API_URL
  const previousSessions = process.env.VITE_SDK_MARKDOWN_SESSION_IDS
  const previousHttpApi = process.env.OPENFORK_TEST_HTTPAPI_URL
  try {
    const backendURL = await Promise.race([
      backendReady,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`TestHttpApi fixture did not start: ${backendOutput.join("\n")}`)), 45_000)),
    ])
    const seeded = await callBackend("seed") as Array<{ sessionID: string }>
    const sessionIDs = seeded.map((entry) => entry.sessionID)
    expect(sessionIDs).toHaveLength(6)

    control = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      response.setHeader("access-control-allow-origin", "*")
      response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS")
      response.setHeader("access-control-allow-headers", "content-type,last-event-id,x-opencode-stream-subscriber,x-opencode-stream-sessions,x-opencode-stream-generation")
      if (request.method === "OPTIONS") {
        response.writeHead(204)
        response.end()
        return
      }
      if (url.pathname !== "/gate/control" || request.method !== "POST") {
        apiRequests.push(`${request.method} ${url.pathname}${url.search}`)
        const upstream = httpRequest(new URL(`${url.pathname}${url.search}`, backendURL), {
          method: request.method,
          headers: Object.fromEntries(Object.entries(request.headers).filter(([name]) => name !== "host" && name !== "origin")),
        }, (upstreamResponse) => {
          if ((upstreamResponse.statusCode ?? 500) >= 400) {
            let body = ""
            upstreamResponse.on("data", (chunk) => {
              if (body.length < 4096) body += String(chunk).slice(0, 4096 - body.length)
            })
            upstreamResponse.on("end", () => apiFailures.push(`${request.method} ${url.pathname}${url.search} -> ${upstreamResponse.statusCode}: ${body}`))
          }
          response.writeHead(upstreamResponse.statusCode ?? 502, {
            ...upstreamResponse.headers,
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "content-type,last-event-id,x-opencode-stream-subscriber,x-opencode-stream-sessions,x-opencode-stream-generation",
          })
          upstreamResponse.pipe(response)
        })
        upstream.on("error", (error) => {
          if (response.headersSent) {
            response.destroy()
            return
          }
          response.writeHead(502, { "content-type": "text/plain", "access-control-allow-origin": "*" })
          response.end(String(error))
        })
        request.pipe(upstream)
        return
      }
      let raw = ""
      request.setEncoding("utf8")
      request.on("data", (chunk) => (raw += chunk))
      request.on("end", () => {
        const command = JSON.parse(raw) as { action: string; sessions?: string[]; session?: string }
        if (command.action === "disconnect") {
          response.writeHead(200, { "content-type": "application/json" })
          response.end(JSON.stringify({ ok: true }))
          return
        }
        void callBackend(command.action, { sessions: command.sessions, session: command.session }).then(
          (result) => {
            response.writeHead(200, { "content-type": "application/json" })
            response.end(JSON.stringify({ ok: true, result }))
          },
          (error) => {
            response.writeHead(500, { "content-type": "application/json" })
            response.end(JSON.stringify({ error: String(error) }))
          },
        )
      })
    })
    await new Promise<void>((resolveListen, reject) => control!.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolveListen()))
    const controlAddress = control.address()
    if (!controlAddress || typeof controlAddress === "string") throw new Error("test control endpoint did not bind")
    const controlURL = `http://127.0.0.1:${controlAddress.port}/`
    process.env.VITE_SDK_MARKDOWN_CONTROL_URL = controlURL
    process.env.VITE_SDK_MARKDOWN_USE_BACKEND_PROXY = "true"
    process.env.VITE_SDK_MARKDOWN_API_URL = controlURL
    process.env.VITE_SDK_MARKDOWN_SESSION_IDS = JSON.stringify(sessionIDs)
    process.env.OPENFORK_TEST_HTTPAPI_URL = backendURL

    vite = await createViteServer({
      configFile: false,
      root: resolve(import.meta.dir, "markdown-sdk-stream-gate"),
      plugins: appPlugins,
      resolve: { alias: [{ find: "@tanstack/solid-query", replacement: resolve(import.meta.dir, "../../app/node_modules/@tanstack/solid-query") }] },
      ...await privateViteIsolation(join(directory, "vite-cache")),
      optimizeDeps: { exclude: ["shiki"], noDiscovery: true, entries: [] },
      appType: "spa",
    })
    await vite.listen()
    const address = vite.httpServer?.address()
    if (!address || typeof address === "string") throw new Error("Vite did not bind")
    const build = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "electron-markdown-sdk-stream-gate.ts")],
      target: "node",
      format: "cjs",
      packages: "external",
      outdir: directory,
    })
    expect(build.success, build.logs.map((log) => log.message).join("\n")).toBe(true)
    const main = join(directory, "electron-markdown-sdk-stream-gate.cjs")
    await rename(join(directory, "electron-markdown-sdk-stream-gate.js"), main)
    const electron = resolve(import.meta.dir, "../node_modules/electron/dist/electron.exe")
    const electronEnv = {
      ...process.env,
      OPENFORK_SDK_MARKDOWN_GATE_URL: `http://127.0.0.1:${address.port}/`,
      OPENFORK_FIXTURE_PROFILE_ROOT: join(directory, "electron-profile"),
      OPENFORK_SDK_MARKDOWN_PEER_URL: "http://unused.invalid/",
      VITE_SDK_MARKDOWN_API_URL: controlURL,
      OPENFORK_SDK_MARKDOWN_SESSION_IDS: JSON.stringify(sessionIDs),
    }
    delete electronEnv.ELECTRON_RUN_AS_NODE
    await execFileAsync("node", ["--check", main], { timeout: 15_000 })
    const result = await execFileAsync(electron, ["--no-sandbox", "--disable-gpu", main], {
      cwd: resolve(import.meta.dir, "../../.."),
      env: electronEnv,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    }).catch((error) => {
      const diagnostics = `\nAPI requests:\n${apiRequests.join("\n")}\nAPI failures:\n${apiFailures.join("\n")}`
      electronOutput = `${String(error)}${diagnostics}`
      if (error instanceof Error) error.message += diagnostics
      throw error
    })
    electronOutput = `${result.stdout}\n${result.stderr}`
    const marker = result.stdout.split("\n").find((line) => line.startsWith("ELECTRON_SDK_MARKDOWN_GATE_RESULT "))
    expect(marker, electronOutput).toBeTruthy()
    const evidence = JSON.parse(marker!.slice("ELECTRON_SDK_MARKDOWN_GATE_RESULT ".length)) as Record<string, unknown>
    console.log("Electron real TestHttpApi Markdown evidence:", evidence)
    expect(evidence.completed).toBe(true)
    expect(evidence.rendered).toBe(6)
    expect(evidence.interestActivated).toBe(true)
    expect((evidence.scenarios as Array<{ interestAcked?: boolean }>).every((scenario) => scenario.interestAcked)).toBe(true)
    expect(evidence.autonomousRepair).toBe(true)
    expect(evidence.teardownRoots).toBe(0)
    expect(evidence.streamFramesRead).toBeGreaterThan(0)
  } finally {
    if (control?.listening) await new Promise<void>((resolveClose) => control!.close(() => resolveClose()))
    await vite?.close()
    lines.close()
    backend.stdin.end()
    if (backend.exitCode === null) backend.kill("SIGTERM")
    await new Promise<void>((resolveClose) => {
      if (backend.exitCode !== null) return resolveClose()
      const timeout = setTimeout(() => {
        backend.kill("SIGKILL")
        resolveClose()
      }, 15_000)
      backend.once("exit", () => {
        clearTimeout(timeout)
        resolveClose()
      })
    })
    if (previousControl === undefined) delete process.env.VITE_SDK_MARKDOWN_CONTROL_URL
    else process.env.VITE_SDK_MARKDOWN_CONTROL_URL = previousControl
    if (previousBackendProxy === undefined) delete process.env.VITE_SDK_MARKDOWN_USE_BACKEND_PROXY
    else process.env.VITE_SDK_MARKDOWN_USE_BACKEND_PROXY = previousBackendProxy
    if (previousApiURL === undefined) delete process.env.VITE_SDK_MARKDOWN_API_URL
    else process.env.VITE_SDK_MARKDOWN_API_URL = previousApiURL
    if (previousSessions === undefined) delete process.env.VITE_SDK_MARKDOWN_SESSION_IDS
    else process.env.VITE_SDK_MARKDOWN_SESSION_IDS = previousSessions
    if (previousHttpApi === undefined) delete process.env.OPENFORK_TEST_HTTPAPI_URL
    else process.env.OPENFORK_TEST_HTTPAPI_URL = previousHttpApi
    await rm(directory, { recursive: true, force: true })
  }
}, 180_000)
