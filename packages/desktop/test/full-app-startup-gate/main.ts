import { app, BrowserWindow, ipcMain, net, protocol, session as electronSession, utilityProcess } from "electron"
import { createServer } from "node:net"
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
  const child = utilityProcess.fork(sidecarPath, [], { cwd: workspace, env, serviceName: "OpenFork full-app startup gate", stdio: "pipe" })
  activeSidecar = child
  child.stdout?.on("data", (chunk) => process.stdout.write(String(chunk)))
  child.stderr?.on("data", (chunk) => process.stderr.write(String(chunk)))
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("private sidecar readiness timed out")), 90_000)
    child.on("message", (message: { type?: string; error?: { message?: string; stack?: string } }) => {
      if (message?.type === "error") { clearTimeout(timeout); reject(new Error(message.error?.stack ?? message.error?.message ?? "sidecar start failed")) }
      if (message?.type === "ready") { clearTimeout(timeout); resolve() }
    })
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`private sidecar exited before ready (${code})`)) })
  })
  child.postMessage({ type: "start", hostname: "127.0.0.1", port, password, userDataPath: dataRoot })
  await ready

  const baseURL = `http://127.0.0.1:${port}/`
  const control = electronSession.fromPartition(`full-app-gate-control-${process.pid}`, { cache: false })
  const admission = electronSession.fromPartition(`full-app-gate-admission-${process.pid}`, { cache: false })
  const transport = createSidecarControlTransport({
    sidecarURL: () => baseURL,
    fetch: (url, init) => control.fetch(url.href, init),
    fetchAdmission: (url, init) => admission.fetch(url.href, init),
  })
  const active = new Map<string, AbortController>()
  const window = new BrowserWindow({
    show: true,
    x: -16_000,
    y: -16_000,
    width: 1440,
    height: 1000,
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
      if (lane === "admission") process.stdout.write("FULL_APP_GATE_ADMISSION 1\n")
      return response
    } finally {
      active.delete(requestID)
    }
  })
  ipcMain.on("full-app-gate-control-cancel", (event, requestID: string) => {
    if (event.sender === window.webContents) active.get(requestID)?.abort()
  })
  window.webContents.setBackgroundThrottling(false)
  window.showInactive()
  window.webContents.on("console-message", (_event, level, message, line, source) => {
    process.stderr.write(`renderer[${level}] ${source}:${line} ${message}\n`)
  })
  await window.loadURL(`oc://renderer/?server=${encodeURIComponent(baseURL)}&directory=${encodeURIComponent(workspace)}&password=${encodeURIComponent(password)}&modelControl=${encodeURIComponent(modelControl)}`)
  const evidence = await window.webContents.executeJavaScript("window.__fullAppGate.run()")
  process.stdout.write(`ELECTRON_FULL_APP_STARTUP_GATE_RESULT ${JSON.stringify({
    electron: process.versions.electron,
    node: process.versions.node,
    chromium: process.versions.chrome,
    sidecarPid: child.pid,
    profilePaths,
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
  app.exit(0)
}

void run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  activeSidecar?.kill()
  app.exit(1)
})
