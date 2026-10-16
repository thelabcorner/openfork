import assert from "node:assert/strict"
import { createServer } from "node:http"
import { writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { writeFileSync } from "node:fs"
import { registerIpcHandlers } from "../src/main/ipc"
import { RendererTrust } from "../src/main/browser/renderer-trust"
import { app, BrowserWindow } from "electron"

async function run() {
  const stage = (stage: string) => writeFileSync(process.env.OPENCODE_GATE_RESULT_PATH!, JSON.stringify({ stage }))
  stage("run")
  const scratch = dirname(process.env.OPENCODE_GATE_RESULT_PATH!)
  stage("scratch")
  app.setPath("userData", join(scratch, "user-data"))
  await app.whenReady()
  // Finish peer/IPC teardown before exiting the isolated application. The
  // parent removes its private data only after Electron releases file handles.
  app.on("before-quit", event => event.preventDefault())
  stage("ready")
  let admissions = 0
  let aborted = 0
  let abortRequests = 0
  let heldUrgent = 0
  const server = createServer((request, response) => {
    if (request.url?.includes("hold=1")) {
      heldUrgent++
      response.once("close", () => { heldUrgent-- })
      return
    }
    if (request.url?.includes("prompt_async")) {
      admissions++
      response.once("close", () => { admissions--; aborted++ })
      return
    }
    if (request.url?.includes("/abort")) abortRequests++
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ updated: true }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`
  const trust = new RendererTrust()
  const deps = new Proxy({
    rendererTrust: trust,
    getSidecarURL: () => origin,
    sidecarStatus: { subscribe: () => () => {} },
  }, { get: (target, key) => key in target ? Reflect.get(target, key) : () => {} })
  registerIpcHandlers(deps as Parameters<typeof registerIpcHandlers>[0])
  stage("ipc")
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: false, nodeIntegration: true, contextIsolation: false } })
  trust.register(window.webContents)
  await window.loadURL("data:text/html,<title>isolated%20IPC%20gate</title>")
  stage("window")
  const request = (path: string) => ({ url: origin + path, method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
  try {
    const started = await window.webContents.executeJavaScript(`
      (() => {
        const { ipcRenderer } = require('electron');
        globalThis.gateRequests = Array.from({length: 6}, (_, index) => {
          const id = require('node:crypto').randomUUID();
          const promise = ipcRenderer.invoke('sidecar-control-fetch', id, ${JSON.stringify(request("/session/ses_gate/prompt_async"))}).catch(() => {});
          return {id, promise};
        });
        return true;
      })()
    `)
    assert.equal(started, true)
    const deadline = Date.now() + 5000
    while (admissions < 6) {
      assert.ok(Date.now() < deadline, "all six admissions must reach the test peer")
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const baselineListeners = window.webContents.listenerCount("destroyed")
    await window.webContents.executeJavaScript(`
      (() => {
        const { ipcRenderer } = require('electron');
        globalThis.urgentRequests = Array.from({length: 4}, () => {
          const id = require('node:crypto').randomUUID();
          const promise = ipcRenderer.invoke('sidecar-control-fetch', id, ${JSON.stringify(request("/global/event/interest?hold=1"))}).catch(() => {});
          return {id, promise};
        });
      })()
    `)
    while (heldUrgent < 4) {
      assert.ok(Date.now() < deadline, "four urgent requests must reach the test peer")
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const concurrentListeners = window.webContents.listenerCount("destroyed")
    assert.equal(concurrentListeners, baselineListeners, "urgent requests must reuse the renderer observer held by admissions")
    const start = performance.now()
    const result = await window.webContents.executeJavaScript(`
      require('electron').ipcRenderer.invoke('sidecar-control-fetch', require('node:crypto').randomUUID(), ${JSON.stringify(request("/global/event/interest"))})
    `)
    const elapsed = performance.now() - start
    assert.equal(result.status, 200)
    assert.equal(admissions, 6)
    const createStart = performance.now()
    const created = await window.webContents.executeJavaScript(`
      require('electron').ipcRenderer.invoke('sidecar-control-fetch', require('node:crypto').randomUUID(), ${JSON.stringify(request("/session"))})
    `)
    const createCompletionMs = performance.now() - createStart
    assert.equal(created.status, 200)
    assert.equal(admissions, 6)
    const located = await window.webContents.executeJavaScript(`
      require('electron').ipcRenderer.invoke('sidecar-control-fetch', require('node:crypto').randomUUID(), ${JSON.stringify({ url: origin + "/global/session/ses_gate", method: "GET", headers: {} })})
    `)
    assert.equal(located.status, 200, "session metadata must remain reachable under six stalled admissions")
    const abortStart = performance.now()
    const interrupted = await window.webContents.executeJavaScript(`
      require('electron').ipcRenderer.invoke('sidecar-control-fetch', require('node:crypto').randomUUID(), ${JSON.stringify(request("/session/ses_gate/abort"))})
    `)
    const abortCompletionMs = performance.now() - abortStart
    assert.equal(interrupted.status, 200)
    assert.equal(abortRequests, 1)
    assert.equal(admissions, 6)
    assert.ok(abortCompletionMs < 2000, `trusted abort should reach the reserved urgent lane while admissions remain held; took ${abortCompletionMs}ms`)
    // A different renderer has Electron IPC access in this fixture, but it is
    // deliberately absent from the app-renderer allowlist.
    const guest = new BrowserWindow({ show: false, webPreferences: { sandbox: false, nodeIntegration: true, contextIsolation: false } })
    try {
      await guest.loadURL("data:text/html,<title>untrusted%20IPC%20fixture</title>")
      const rejected = await guest.webContents.executeJavaScript(`
        require('electron').ipcRenderer.invoke('sidecar-control-fetch', require('node:crypto').randomUUID(), ${JSON.stringify(request("/session/ses_gate/abort"))})
          .then(() => false, error => error.message.includes('Untrusted sidecar control sender'))
      `)
      assert.equal(rejected, true)
    } finally { guest.destroy() }
    await window.webContents.executeJavaScript(`
      (() => { const {ipcRenderer} = require('electron'); for (const request of [...gateRequests, ...urgentRequests]) ipcRenderer.send('sidecar-control-fetch-abort', request.id); })()
    `)
    await window.webContents.executeJavaScript("Promise.all([...gateRequests, ...urgentRequests].map(request => request.promise))")
    assert.equal(window.webContents.listenerCount("destroyed"), baselineListeners - 1, "last request must release the shared observer")
    const evidence = { electron: process.versions.electron, urgentCompletionMs: elapsed, createCompletionMs, abortCompletionMs, abortRequests, heldAdmissionsAtCompletion: 6, untrustedRejected: true, abortedAdmissions: aborted, concurrentListeners, baselineListeners }
    await writeFile(process.env.OPENCODE_GATE_RESULT_PATH!, JSON.stringify(evidence))
  } catch (error) {
    writeFileSync(process.env.OPENCODE_GATE_RESULT_PATH!, JSON.stringify({ error: String(error), stack: (error as Error)?.stack }))
    throw error
  } finally {
    trust.unregister(window.webContents.id)
    window.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

run().then(() => app.exit(0), async error => {
  await writeFile(process.env.OPENCODE_GATE_RESULT_PATH!, JSON.stringify({ error: String(error), stack: error?.stack }))
  app.exit(1)
})
