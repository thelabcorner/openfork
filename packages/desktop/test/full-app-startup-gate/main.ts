import { app, BrowserWindow, ipcMain, net, protocol, screen, session as electronSession, utilityProcess } from "electron"
import { createServer } from "node:net"
import { DatabaseSync } from "node:sqlite"
import path from "node:path"
import { createSidecarControlTransport } from "../../src/main/sidecar-control-transport"
import { sidecarControlLane, type SidecarControlFetchInput } from "../../../app/src/utils/sidecar-control-request"
import { configureElectronFixtureProfile } from "../electron-fixture-profile"

protocol.registerSchemesAsPrivileged([{ scheme: "oc", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])
let activeSidecar: ReturnType<typeof utilityProcess.fork> | undefined

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("could not select an isolated sidecar port"))
      const port = address.port
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

async function run() {
  const dataRoot = process.env.OPENFORK_FULL_APP_GATE_DATA
  if (!dataRoot) throw new Error("full-app profile root is missing")
  const profilePaths = configureElectronFixtureProfile(app, dataRoot)
  await app.whenReady()
  const sidecarPath = process.env.OPENFORK_FULL_APP_GATE_SIDECAR
  const viteURL = process.env.OPENFORK_FULL_APP_GATE_VITE
  const workspace = process.env.OPENFORK_FULL_APP_GATE_WORKSPACE
  const password = process.env.OPENFORK_FULL_APP_GATE_PASSWORD
  const preloadPath = process.env.OPENFORK_FULL_APP_GATE_PRELOAD
  const modelControl = process.env.OPENFORK_FULL_APP_GATE_MODEL_CONTROL
  if (!sidecarPath || !viteURL || !dataRoot || !workspace || !password || !preloadPath || !modelControl) {
    throw new Error("full-app startup gate configuration is incomplete")
  }
  protocol.handle("oc", (request) => {
    const incoming = new URL(request.url)
    const target = new URL(`${incoming.pathname}${incoming.search}`, viteURL)
    const headers = new Headers(request.headers)
    headers.delete("host")
    headers.delete("origin")
    return net.fetch(target, { method: request.method, headers, body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body })
  })

  const port = await freePort()
  const env = {
    ...process.env,
    OPENCODE_DB: path.join(dataRoot, "sidecar.sqlite"),
    OPENCODE_DISABLE_EMBEDDED_WEB_UI: "true",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_CLIENT: "desktop",
    HOME: dataRoot,
    USERPROFILE: dataRoot,
    APPDATA: path.join(dataRoot, "appdata"),
    LOCALAPPDATA: path.join(dataRoot, "localappdata"),
    XDG_CONFIG_HOME: path.join(dataRoot, "config"),
    XDG_DATA_HOME: path.join(dataRoot, "data"),
    XDG_CACHE_HOME: path.join(dataRoot, "cache"),
    XDG_STATE_HOME: path.join(dataRoot, "state"),
  }
  const startSidecar = async () => {
    const next = utilityProcess.fork(sidecarPath, [], { cwd: workspace, env, serviceName: "OpenFork full-app startup gate", stdio: "pipe" })
    activeSidecar = next
    next.stdout?.on("data", (chunk) => process.stdout.write(String(chunk)))
    next.stderr?.on("data", (chunk) => process.stderr.write(String(chunk)))
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("private sidecar readiness timed out")), 90_000)
      next.on("message", (message: { type?: string; error?: { message?: string; stack?: string } }) => {
        if (message?.type === "error") { clearTimeout(timeout); reject(new Error(message.error?.stack ?? message.error?.message ?? "sidecar start failed")) }
        if (message?.type === "ready") { clearTimeout(timeout); resolve() }
      })
      next.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`private sidecar exited before ready (${code})`)) })
    })
    next.postMessage({ type: "start", hostname: "127.0.0.1", port, password, userDataPath: dataRoot })
    await ready
    return next
  }
  const stopSidecar = async (target: ReturnType<typeof utilityProcess.fork>) => {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        target.kill()
        resolve()
      }, 8_000)
      target.once("exit", () => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }
  let child = await startSidecar()

  const baseURL = `http://127.0.0.1:${port}/`
  const control = electronSession.fromPartition(`full-app-gate-control-${process.pid}`, { cache: false })
  const admission = electronSession.fromPartition(`full-app-gate-admission-${process.pid}`, { cache: false })
  const transport = createSidecarControlTransport({
    sidecarURL: () => baseURL,
    fetch: (url, init) => control.fetch(url.href, init),
    fetchAdmission: (url, init) => admission.fetch(url.href, init),
  })
  const active = new Map<string, AbortController>()
  ipcMain.handle("full-app-gate-restart-sidecar", async (event) => {
    if (event.sender !== window.webContents) throw new Error("untrusted full-app gate sidecar restart request")
    const previous = child
    previous.postMessage({ type: "stop" })
    await stopSidecar(previous)
    child = await startSidecar()
    return { pid: child.pid }
  })
  const workArea = screen.getPrimaryDisplay().workArea
  const width = Math.min(1440, workArea.width)
  const height = Math.min(1000, workArea.height)
  const window = new BrowserWindow({
    show: true,
    x: workArea.x + Math.max(0, Math.floor((workArea.width - width) / 2)),
    y: workArea.y + Math.max(0, Math.floor((workArea.height - height) / 2)),
    width,
    height,
    frame: false,
    webPreferences: { sandbox: true, contextIsolation: true, preload: preloadPath },
  })
  ipcMain.handle("full-app-gate-control-fetch", async (event, requestID: string, input: SidecarControlFetchInput) => {
    if (event.sender !== window.webContents) throw new Error("untrusted full-app gate IPC sender")
    if (active.has(requestID)) throw new Error("duplicate full-app control request id")
    const controller = new AbortController()
    active.set(requestID, controller)
    try {
      const lane = sidecarControlLane(new URL(input.url), { method: input.method })
      const response = await transport(input, controller.signal)
      return response
    } finally {
      active.delete(requestID)
    }
  })
  ipcMain.on("full-app-gate-control-cancel", (event, requestID: string) => {
    if (event.sender === window.webContents) active.get(requestID)?.abort()
  })
  ipcMain.handle("full-app-gate-click-stop", async (event, input: { x: number; y: number }) => {
    if (event.sender !== window.webContents || !Number.isFinite(input?.x) || !Number.isFinite(input?.y)) {
      throw new Error("untrusted or invalid Stop click request")
    }
    const requestedAt = Date.now()
    await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed", x: input.x, y: input.y, button: "left", clickCount: 1,
    })
    await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: input.x, y: input.y, button: "left", clickCount: 1,
    })
    return { requestedAt, dispatchedAt: Date.now() }
  })
  ipcMain.handle("full-app-gate-seed-large-history", (event, input: { sessionID: string; messageID: string; count: number }) => {
    if (event.sender !== window.webContents) throw new Error("untrusted full-app history seed sender")
    if (!/^ses_[A-Za-z0-9_-]+$/.test(input.sessionID) || !/^msg_[A-Za-z0-9_-]+$/.test(input.messageID)) {
      throw new Error("invalid fixture session/message identity")
    }
    if (!Number.isInteger(input.count) || input.count < 100 || input.count > 80_000) {
      throw new Error("the adversarial history fixture accepts between 100 and 80,000 parts")
    }
    const startedAt = performance.now()
    const database = new DatabaseSync(path.join(dataRoot, "sidecar.sqlite"))
    try {
      database.exec("PRAGMA busy_timeout = 15000")
      database.exec("PRAGMA foreign_keys = ON")
      database.exec("BEGIN IMMEDIATE")
      const now = Date.now()
      const insertMessage = database.prepare(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      )
      const insertPart = database.prepare(
        "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, search_text) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      insertMessage.run(
        input.messageID,
        input.sessionID,
        now,
        now,
        JSON.stringify({
          role: "user",
          time: { created: now },
          agent: "default",
          model: { providerID: "full-app-gate", modelID: "gate-model" },
          tools: {},
          mode: "",
        }),
      )
      for (let index = 0; index < input.count; index++) {
        const text = `gate-large-history-part-${String(index).padStart(5, "0")}`
        insertPart.run(
          `prt_gate_large_history_${String(index).padStart(8, "0")}`,
          input.messageID,
          input.sessionID,
          now + index,
          now + index,
          JSON.stringify({ type: "text", text }),
          text,
        )
      }
      database.exec("COMMIT")
      return { messageID: input.messageID, parts: input.count, elapsedMs: performance.now() - startedAt }
    } catch (error) {
      try { database.exec("ROLLBACK") } catch {}
      throw error
    } finally {
      database.close()
    }
  })
  const traceRoot = process.env.OPENFORK_FULL_APP_GATE_TRACE_DIR
  const profileReasoningStop = process.env.OPENFORK_FULL_APP_GATE_PROFILE === "1"
  const profileHistorySeedTail = process.env.OPENFORK_FULL_APP_GATE_PROFILE_HISTORY === "1"
  const profileStartup = process.env.OPENFORK_FULL_APP_GATE_PROFILE_STARTUP === "1"
  const startupProfilerSteps: Array<{ command: string; status: "started" | "timed-out" | "failed"; elapsedMs: number; error?: string }> = []
  const startupTraceSteps: Array<{ command: string; status: "started" | "timed-out" | "failed"; elapsedMs: number; error?: string }> = []
  let startupProfilerStarted = false
  let startupProfilerStartPromise: Promise<void> | undefined
  let startupTraceStarted = false
  const traceScenarios = new Set(["startup", "stream-1", "stream-3", "stream-6-user-scroll-up", "reasoning-stop", "history-seed-tail"])
  if (traceRoot) {
    window.webContents.debugger.attach("1.3")
    if (profileStartup) {
      // Start the Chrome trace before navigation so renderer initialization and
      // the first cold Home frame are covered. This is independently bounded:
      // a debugger that is not ready must not delay app navigation.
      const traceStartedAt = performance.now()
      let traceTimeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          window.webContents.debugger.sendCommand("Tracing.start", {
            transferMode: "ReturnAsStream",
            traceConfig: {
              recordMode: "recordContinuously",
              includedCategories: [
                "devtools.timeline",
                "blink",
                "blink.user_timing",
                "cc",
                "viz",
                "toplevel",
                "disabled-by-default-devtools.timeline.frame",
              ],
            },
          }),
          new Promise<never>((_, reject) => {
            traceTimeout = setTimeout(() => reject(new Error("Tracing.start did not acknowledge before navigation")), 1_500)
          }),
        ])
        startupTraceStarted = true
        startupTraceSteps.push({ command: "Tracing.start", status: "started", elapsedMs: performance.now() - traceStartedAt })
      } catch (error) {
        const timedOut = error instanceof Error && error.message.includes("did not acknowledge")
        startupTraceSteps.push({
          command: "Tracing.start",
          status: timedOut ? "timed-out" : "failed",
          elapsedMs: performance.now() - traceStartedAt,
          error: error instanceof Error ? error.message : String(error),
        })
      } finally {
        if (traceTimeout) clearTimeout(traceTimeout)
      }
      // CDP Profiler does not acknowledge until Chromium has created the first
      // renderer target. Start it at top-level navigation, independently of the
      // loadURL promise, and keep every command bounded so profiling never
      // delays navigation or the production UI.
      const onNavigation = (_event: Electron.Event, _url: string, _inPlace: boolean, isMainFrame: boolean) => {
        if (!isMainFrame) return
        window.webContents.removeListener("did-start-navigation", onNavigation)
        startupProfilerStartPromise = (async () => {
          for (const [command, params] of [
            ["Profiler.enable", undefined],
            ["Profiler.setSamplingInterval", { interval: 2_000 }],
            ["Profiler.start", undefined],
          ] as const) {
            const startedAt = performance.now()
            let timeout: ReturnType<typeof setTimeout> | undefined
            try {
              await Promise.race([
                window.webContents.debugger.sendCommand(command, params),
                new Promise<never>((_, reject) => {
                  timeout = setTimeout(() => reject(new Error(`${command} did not acknowledge after navigation`)), 1_500)
                }),
              ])
              startupProfilerSteps.push({ command, status: "started", elapsedMs: performance.now() - startedAt })
            } catch (error) {
              const timedOut = error instanceof Error && error.message.includes("did not acknowledge")
              startupProfilerSteps.push({
                command,
                status: timedOut ? "timed-out" : "failed",
                elapsedMs: performance.now() - startedAt,
                error: error instanceof Error ? error.message : String(error),
              })
              break
            } finally {
              if (timeout) clearTimeout(timeout)
            }
          }
          startupProfilerStarted = startupProfilerSteps.length === 3 && startupProfilerSteps.every((step) => step.status === "started")
        })()
      }
      window.webContents.on("did-start-navigation", onNavigation)
    }
    ipcMain.handle("full-app-gate-trace-start", async (event, scenario: string) => {
      if (event.sender !== window.webContents || !traceScenarios.has(scenario)) throw new Error("untrusted or invalid trace scenario")
      if ((profileReasoningStop && scenario === "reasoning-stop") || (profileHistorySeedTail && scenario === "history-seed-tail")) {
        await window.webContents.debugger.sendCommand("Profiler.enable")
        await window.webContents.debugger.sendCommand("Profiler.setSamplingInterval", { interval: 2_000 })
        await window.webContents.debugger.sendCommand("Profiler.start")
      }
      await window.webContents.debugger.sendCommand("Tracing.start", {
        transferMode: "ReturnAsStream",
        traceConfig: {
          recordMode: "recordContinuously",
          includedCategories: [
            "devtools.timeline",
            "blink",
            "blink.user_timing",
            "cc",
            "viz",
            "toplevel",
            "disabled-by-default-devtools.timeline.frame",
          ],
        },
      })
      return { scenario, startedAt: Date.now() }
    })
    ipcMain.handle("full-app-gate-trace-stop", async (event, scenario: string) => {
      if (event.sender !== window.webContents || !traceScenarios.has(scenario)) throw new Error("untrusted or invalid trace scenario")
      const complete = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("renderer Chrome trace did not complete")), 30_000)
        const listener = (_event: Electron.Event, method: string, params: { stream?: string }) => {
          if (method !== "Tracing.tracingComplete" || !params.stream) return
          clearTimeout(timeout)
          window.webContents.debugger.removeListener("message", listener)
          resolve(params.stream)
        }
        window.webContents.debugger.on("message", listener)
      })
      await window.webContents.debugger.sendCommand("Tracing.end")
      const stream = await complete
      const chunks: string[] = []
      for (;;) {
        const result = await window.webContents.debugger.sendCommand("IO.read", { handle: stream, size: 1_048_576 }) as { data: string; eof?: boolean }
        chunks.push(result.data)
        if (result.eof) break
      }
      await window.webContents.debugger.sendCommand("IO.close", { handle: stream })
      const traceFile = path.join(traceRoot, `${scenario}.trace.json`)
      const content = chunks.join("")
      await (await import("node:fs/promises")).writeFile(traceFile, content)
      const parsed = JSON.parse(content) as { traceEvents?: Array<{ name?: string; cat?: string; ph?: string; ts?: number; dur?: number; args?: unknown }> }
      const events = parsed.traceEvents ?? []
      let cpuProfile: Record<string, unknown> | undefined
      if ((profileReasoningStop && scenario === "reasoning-stop") || (profileHistorySeedTail && scenario === "history-seed-tail")) {
        const result = await window.webContents.debugger.sendCommand("Profiler.stop") as {
          profile?: {
            startTime?: number
            endTime?: number
            nodes?: Array<{ id: number; children?: number[]; callFrame?: { functionName?: string; url?: string; lineNumber?: number } }>
            samples?: number[]
            timeDeltas?: number[]
          }
        }
        const profile = result.profile
        const nodes = new Map((profile?.nodes ?? []).map((node) => [node.id, node]))
        const parents = new Map<number, number>()
        for (const node of profile?.nodes ?? []) for (const child of node.children ?? []) parents.set(child, node.id)
        const self = new Map<string, number>()
        const stacks = new Map<string, number>()
        for (let index = 0; index < (profile?.samples?.length ?? 0); index++) {
          const sample = profile!.samples![index]!
          const delta = profile?.timeDeltas?.[index] ?? 0
          const frameName = (id: number) => {
            const frame = nodes.get(id)?.callFrame
            return `${frame?.url ?? ""}:${(frame?.lineNumber ?? -1) + 1}:${frame?.functionName ?? "anonymous"}`
          }
          const leaf = frameName(sample)
          self.set(leaf, (self.get(leaf) ?? 0) + delta)
          const stack: string[] = []
          let nodeID: number | undefined = sample
          for (let depth = 0; nodeID !== undefined && depth < 16; depth++) {
            stack.push(frameName(nodeID))
            nodeID = parents.get(nodeID)
          }
          const key = stack.reverse().join(" <- ")
          stacks.set(key, (stacks.get(key) ?? 0) + delta)
        }
        const profileFile = path.join(traceRoot, `${scenario}.cpu-profile.json`)
        await (await import("node:fs/promises")).writeFile(profileFile, JSON.stringify(profile))
        cpuProfile = {
          path: profileFile,
          startTime: profile?.startTime,
          endTime: profile?.endTime,
          sampleCount: profile?.samples?.length ?? 0,
          samplingIntervalUs: 2_000,
          topSelfMs: [...self.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 40)
            .map(([frame, microseconds]) => ({ frame, selfMs: microseconds / 1000 })),
          topStacksMs: [...stacks.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 30)
            .map(([stack, microseconds]) => ({ stack, samplesMs: microseconds / 1000 })),
        }
      }
      return {
        scenario,
        path: traceFile,
        eventCount: events.length,
        eventCounts: Object.fromEntries([...new Set(events.map((item) => item.name ?? "unknown"))]
          .map((name) => [name, events.filter((item) => item.name === name).length])
          .filter(([name]) => /Layout|Paint|UpdateLayoutTree|Frame|UserTiming|RunTask/.test(String(name)))
          .sort((a, b) => Number(b[1]) - Number(a[1]))
          .slice(0, 40)),
        userTimingMarks: events.filter((item) => item.cat?.includes("user_timing")).map((item) => ({ name: item.name, ts: item.ts, phase: item.ph, args: item.args })),
        slowRendererEvents: events
          .filter((item) => item.dur !== undefined && /Layout|Paint|UpdateLayoutTree|RecalculateStyles|CompositeLayers|RasterTask/.test(item.name ?? ""))
          .sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0))
          .slice(0, 40)
          .map((item) => ({ name: item.name, category: item.cat, startUs: item.ts, durationMs: (item.dur ?? 0) / 1000, args: item.args })),
        cpuProfile,
      }
    })
    ipcMain.handle("full-app-gate-profile-stop-startup", async (event) => {
      if (event.sender !== window.webContents || !profileStartup) throw new Error("untrusted or disabled startup CPU profile request")
      await startupProfilerStartPromise
      if (!startupProfilerStarted) return { available: false, steps: startupProfilerSteps }
      const result = await window.webContents.debugger.sendCommand("Profiler.stop") as {
        profile?: {
          startTime?: number
          endTime?: number
          nodes?: Array<{ id: number; children?: number[]; callFrame?: { functionName?: string; url?: string; lineNumber?: number } }>
          samples?: number[]
          timeDeltas?: number[]
        }
      }
      const profile = result.profile
      if (!profile) throw new Error("Electron startup CPU profile returned no profile")
      const nodes = new Map((profile.nodes ?? []).map((node) => [node.id, node]))
      const parents = new Map<number, number>()
      for (const node of profile.nodes ?? []) for (const child of node.children ?? []) parents.set(child, node.id)
      const self = new Map<string, number>()
      const stacks = new Map<string, number>()
      for (let index = 0; index < (profile.samples?.length ?? 0); index++) {
        const sample = profile.samples![index]!
        const delta = profile.timeDeltas?.[index] ?? 0
        const frameName = (id: number) => {
          const frame = nodes.get(id)?.callFrame
          return `${frame?.url ?? ""}:${(frame?.lineNumber ?? -1) + 1}:${frame?.functionName ?? "anonymous"}`
        }
        const leaf = frameName(sample)
        self.set(leaf, (self.get(leaf) ?? 0) + delta)
        const stack: string[] = []
        let nodeID: number | undefined = sample
        for (let depth = 0; nodeID !== undefined && depth < 16; depth++) {
          stack.push(frameName(nodeID))
          nodeID = parents.get(nodeID)
        }
        const key = stack.reverse().join(" <- ")
        stacks.set(key, (stacks.get(key) ?? 0) + delta)
      }
      const profileFile = path.join(traceRoot, "startup.cpu-profile.json")
      await (await import("node:fs/promises")).writeFile(profileFile, JSON.stringify(profile))
      return {
        available: true,
        steps: startupProfilerSteps,
        path: profileFile,
        startTime: profile.startTime,
        endTime: profile.endTime,
        sampleCount: profile.samples?.length ?? 0,
        samplingIntervalUs: 2_000,
        topSelfMs: [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([frame, microseconds]) => ({ frame, selfMs: microseconds / 1000 })),
        topStacksMs: [...stacks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([stack, microseconds]) => ({ stack, samplesMs: microseconds / 1000 })),
      }
    })
  }
  window.webContents.setBackgroundThrottling(false)
  window.showInactive()
  window.webContents.on("console-message", (_event, level, message, line, source) => {
    // Keep routine per-second performance summaries out of the Electron
    // subprocess pipe; the renderer snapshot already captures them. Persist
    // only warnings/errors so long-history runs stay below execFile maxBuffer.
    if (level >= 2) process.stderr.write(`renderer[${level}] ${source}:${line} ${message}\n`)
  })
  const historyCycles = process.env.OPENFORK_FULL_APP_GATE_HISTORY_CYCLES ?? "48"
  const largeParts = process.env.OPENFORK_FULL_APP_GATE_LARGE_PARTS ?? "0"
  const largeHistoryParts = process.env.OPENFORK_FULL_APP_GATE_LARGE_HISTORY_PARTS ?? "0"
  const reasoningOnly = process.env.OPENFORK_FULL_APP_GATE_REASONING_ONLY === "1"
  const startupOnly = process.env.OPENFORK_FULL_APP_GATE_STARTUP_ONLY === "1"
  await window.loadURL(`oc://renderer/?server=${encodeURIComponent(baseURL)}&directory=${encodeURIComponent(workspace)}&password=${encodeURIComponent(password)}&modelControl=${encodeURIComponent(modelControl)}&phase-trace=1&historyCycles=${encodeURIComponent(historyCycles)}&largeParts=${encodeURIComponent(largeParts)}&largeHistoryParts=${encodeURIComponent(largeHistoryParts)}&reasoningOnly=${reasoningOnly ? "1" : "0"}&startupOnly=${startupOnly ? "1" : "0"}&profileHistory=${profileHistorySeedTail ? "1" : "0"}&profileStartup=${profileStartup ? "1" : "0"}&preNavigationTrace=${startupTraceStarted ? "1" : "0"}`)
  // Chromium IPC cannot clone Solid store proxies included in diagnostic
  // snapshots. Serialize within the renderer and cross the bridge as plain JSON.
  const evidenceJSON = await window.webContents.executeJavaScript("window.__fullAppGate.run().then((value) => JSON.stringify(value))") as string
  const evidence = JSON.parse(evidenceJSON) as Record<string, unknown>
  process.stdout.write(`ELECTRON_FULL_APP_STARTUP_GATE_RESULT ${JSON.stringify({
    electron: process.versions.electron,
    node: process.versions.node,
    chromium: process.versions.chrome,
    sidecarPid: child.pid,
    profilePaths,
    startupTraceStart: startupTraceSteps,
    ...evidence,
  })}\n`)
  window.destroy()
  child.postMessage({ type: "stop" })
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(() => { child.kill(); resolve() }, 8_000)),
  ])
  ipcMain.removeHandler("full-app-gate-control-fetch")
  ipcMain.removeAllListeners("full-app-gate-control-cancel")
  ipcMain.removeHandler("full-app-gate-restart-sidecar")
  if (traceRoot) {
    ipcMain.removeHandler("full-app-gate-trace-start")
    ipcMain.removeHandler("full-app-gate-trace-stop")
    ipcMain.removeHandler("full-app-gate-profile-stop-startup")
    window.webContents.debugger.detach()
  }
  app.exit(0)
}

void run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  activeSidecar?.kill()
  app.exit(1)
})
