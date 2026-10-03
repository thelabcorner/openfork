const { app, BrowserWindow } = require("electron") as typeof import("electron")
import { configureElectronFixtureProfile } from "./electron-fixture-profile"

async function run() {
  const profile = configureElectronFixtureProfile(app, process.env.OPENFORK_FIXTURE_PROFILE_ROOT)
  await app.whenReady()
  const url = process.env.OPENFORK_SDK_MARKDOWN_GATE_URL
  if (!url) throw new Error("SDK Markdown gate URL missing")
  const window = new BrowserWindow({
    show: true,
    x: -16_000,
    y: -16_000,
    width: 1200,
    height: 900,
    frame: false,
    webPreferences: { sandbox: true, contextIsolation: true },
  })
  window.webContents.on("console-message", (_event, level, message, line, source) => {
    console.error(`renderer[${level}] ${source}:${line} ${message}`)
  })
  window.webContents.on("render-process-gone", (_event, details) => console.error("renderer gone", details))
  window.webContents.setBackgroundThrottling(false)
  window.showInactive()
  await window.loadURL(url)
  const state = await window.webContents.executeJavaScript("document.visibilityState")
  const evidence = await window.webContents.executeJavaScript("window.__sdkMarkdownGate.run()")
  console.log(`ELECTRON_SDK_MARKDOWN_GATE_RESULT ${JSON.stringify({
    electron: process.versions.electron,
    node: process.versions.node,
    chromium: process.versions.chrome,
    visibilityState: state,
    profile,
    ...evidence,
  })}`)
  window.destroy()
  app.exit(0)
}

void run().catch((error) => {
  console.error(error)
  app.exit(1)
})
