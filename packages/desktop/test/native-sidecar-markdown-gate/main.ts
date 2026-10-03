import { app, BrowserWindow, ipcMain, net, protocol, session as electronSession, utilityProcess } from "electron"
import { createServer } from "node:net"
import path from "node:path"
import { createSidecarControlTransport } from "../../src/main/sidecar-control-transport"
import { sidecarControlLane, type SidecarControlFetchInput } from "../../../app/src/utils/sidecar-control-request"

protocol.registerSchemesAsPrivileged([
  { scheme: "oc", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
])

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("failed to select an isolated sidecar port"))
      const port = address.port
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

async function run() {
  await app.whenReady()
  const sidecarPath = process.env.OPENFORK_NATIVE_GATE_SIDECAR
  const viteURL = process.env.OPENFORK_NATIVE_GATE_VITE
  const dataRoot = process.env.OPENFORK_NATIVE_GATE_DATA
  const workspace = process.env.OPENFORK_NATIVE_GATE_WORKSPACE
  const password = process.env.OPENFORK_NATIVE_GATE_PASSWORD
  const preloadPath = process.env.OPENFORK_NATIVE_GATE_PRELOAD
  if (!sidecarPath || !viteURL || !dataRoot || !workspace || !password || !preloadPath) {
    throw new Error("Native sidecar gate configuration is incomplete")
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
  const child = utilityProcess.fork(sidecarPath, [], {
    cwd: workspace,
    env,
    serviceName: "OpenFork native renderer gate",
    stdio: "pipe",
  })
  child.stderr?.on("data", (chunk) => process.stderr.write(String(chunk)))
  child.stdout?.on("data", (chunk) => process.stdout.write(String(chunk)))
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("current-source native sidecar did not become ready")), 90_000)
    child.on("message", (message: { type?: string; error?: { message?: string; stack?: string } }) => {
      if (message?.type === "error") {
        clearTimeout(timeout)
        reject(new Error(message.error?.stack ?? message.error?.message ?? "sidecar startup failed"))
      }
      if (message?.type === "ready") {
        clearTimeout(timeout)
        resolve()
      }
    })
    child.once("exit", (code) => {
      clearTimeout(timeout)
      reject(new Error(`native sidecar exited before readiness (${code})`))
    })
  })
  child.postMessage({ type: "start", hostname: "127.0.0.1", port, password, userDataPath: dataRoot })
  await ready

  const baseURL = `http://127.0.0.1:${port}/`
  const controlSession = electronSession.fromPartition(`native-gate-control-${process.pid}`, { cache: false })
  const admissionSession = electronSession.fromPartition(`native-gate-admission-${process.pid}`, { cache: false })
  const transportStats = { urgent: 0, admission: 0, controlFetches: 0, admissionFetches: 0 }
  const transport = createSidecarControlTransport({
    sidecarURL: () => baseURL,
    fetch: (url, init) => {
      transportStats.controlFetches++
      return controlSession.fetch(url.href, init)
    },
    fetchAdmission: (url, init) => {
      transportStats.admissionFetches++
      return admissionSession.fetch(url.href, init)
    },
  })
  const activeControl = new Map<string, AbortController>()
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  const sessions: string[] = []
  for (let index = 0; index < 7; index++) {
    const created = await fetch(`${baseURL}session?directory=${encodeURIComponent(workspace)}`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ title: `native renderer gate ${index + 1}` }),
    })
    const body = await created.text()
    if (!created.ok) throw new Error(`isolated sidecar session creation failed (${created.status}): ${body}`)
    sessions.push((JSON.parse(body) as { id: string }).id)
  }

  const window = new BrowserWindow({
    show: true,
    x: -16_000,
    y: -16_000,
    width: 1280,
    height: 900,
    frame: false,
    webPreferences: { sandbox: true, contextIsolation: true, preload: preloadPath },
  })
  ipcMain.handle("native-gate-control-fetch", async (event, requestID: string, input: SidecarControlFetchInput) => {
    if (event.sender !== window.webContents) throw new Error("untrusted native gate control sender")
    if (activeControl.has(requestID)) throw new Error("duplicate native gate control request")
    const controller = new AbortController()
    activeControl.set(requestID, controller)
    const lane = sidecarControlLane(new URL(input.url), { method: input.method })
    try {
      const result = await transport(input, controller.signal)
      if (lane) transportStats[lane]++
      return result
    } finally {
      activeControl.delete(requestID)
    }
  })
  const cancelControl = (event: Electron.IpcMainEvent, requestID: string) => {
    if (event.sender !== window.webContents) return
    activeControl.get(requestID)?.abort()
  }
  ipcMain.on("native-gate-control-cancel", cancelControl)
  window.webContents.setBackgroundThrottling(false)
  window.showInactive()
  window.webContents.on("console-message", (_event, level, message, line, source) => {
    process.stderr.write(`renderer[${level}] ${source}:${line} ${message}\n`)
  })
  await window.loadURL(`oc://renderer/?server=${encodeURIComponent(baseURL)}&directory=${encodeURIComponent(workspace)}&password=${encodeURIComponent(password)}&sessions=${encodeURIComponent(JSON.stringify(sessions))}&modelControl=${encodeURIComponent(process.env.OPENFORK_NATIVE_GATE_MODEL_CONTROL!)}`)
  const visibilityState = await window.webContents.executeJavaScript("document.visibilityState")
  const evidence = await window.webContents.executeJavaScript("window.__nativeSidecarMarkdownGate.run()")
  process.stdout.write(`ELECTRON_NATIVE_SIDECAR_MARKDOWN_RESULT ${JSON.stringify({
    electron: process.versions.electron,
    node: process.versions.node,
    chromium: process.versions.chrome,
    sidecarPid: child.pid,
    transportStats,
    visibilityState,
    ...evidence,
  })}\n`)
  window.destroy()
  child.postMessage({ type: "stop" })
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(() => { child.kill(); resolve() }, 8_000)),
  ])
  ipcMain.removeHandler("native-gate-control-fetch")
  ipcMain.off("native-gate-control-cancel", cancelControl)
  app.exit(0)
}

void run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  app.exit(1)
})
