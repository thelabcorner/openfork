const { app, BrowserWindow } = require("electron")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const id = `${process.pid}-${Date.now()}`
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "openfork-vite-module-probe-"))
const resultFile = path.join(os.tmpdir(), `openfork-vite-module-probe-result-${id}.json`)
app.setPath("userData", profile)
for (const name of ["sessionData", "logs", "crashDumps"]) {
  const ownedPath = path.join(profile, name)
  fs.mkdirSync(ownedPath, { recursive: true })
  app.setPath(name, ownedPath)
}
let done = false
let win
const finish = (result) => {
  if (done) return
  done = true
  fs.writeFileSync(resultFile, JSON.stringify(result, null, 2))
  process.stdout.write(JSON.stringify(result) + "\n")
  if (win && !win.isDestroyed()) win.destroy()
  app.quit()
  setTimeout(() => process.exit(result.ok ? 0 : 2), 300)
}
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, webPreferences: { partition: `module-probe-${id}`, contextIsolation: true, nodeIntegration: false, sandbox: true } })
  const consoleErrors = []
  win.webContents.on("console-message", (_event, details) => {
    if (details.level >= 2) consoleErrors.push({ text: details.message, source: details.sourceId, line: details.lineNumber })
  })
  win.webContents.on("did-fail-load", (_event, code, description, url) => {
    if (url.includes("probe-module-graph.html")) finish({ ok: false, phase: "fixture-load", code, description, url })
  })
  const fixture = "http://localhost:5173/@fs/C:/Users/slooshied/WebstormProjects/opencode/packages/app/probe-module-graph.html"
  const moduleUrl = "http://localhost:5173/@fs/C:/Users/slooshied/WebstormProjects/opencode/packages/app/src/pages/session.tsx"
  try {
    await win.loadURL(fixture)
    const result = await win.webContents.executeJavaScript(`import(${JSON.stringify(moduleUrl)}).then(() => ({ ok: true }), (error) => ({ ok: false, name: error?.name, message: error?.message, stack: error?.stack }))`)
    finish({ ...result, phase: "module-import", consoleErrors })
  } catch (error) {
    finish({ ok: false, phase: "probe", message: error?.message, stack: error?.stack, consoleErrors })
  }
})
