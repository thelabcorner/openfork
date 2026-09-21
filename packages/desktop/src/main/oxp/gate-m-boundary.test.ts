import { describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import path from "node:path"

const oxp = import.meta.dir
const main = path.resolve(oxp, "..")
const desktop = path.resolve(oxp, "../../..")

describe("OXP Gate M standalone-replacement boundary", () => {
  test("owns close-to-tray, start-hidden, tray Quit, and platform login startup in Electron main", async () => {
    const [lifecycle, windows, mainSource] = await Promise.all([
      fs.readFile(path.join(oxp, "lifecycle.ts"), "utf8"),
      fs.readFile(path.join(main, "windows.ts"), "utf8"),
      fs.readFile(path.join(main, "index.ts"), "utf8"),
    ])
    expect(lifecycle).toContain('START_HIDDEN_ARG = "--openfork-start-hidden"')
    expect(lifecycle).toContain("setInitialWindowsHidden(hiddenLoginLaunch)")
    expect(lifecycle).toContain("app.setLoginItemSettings")
    expect(lifecycle).toContain("openfork-oxp.desktop")
    expect(lifecycle).toContain("new Tray(")
    expect(lifecycle).toContain("setAppQuitting()")
    expect(lifecycle).toContain("app.quit()")
    expect(windows).toContain("if (appQuitting || !closeToTray) return")
    expect(windows).toContain("win.hide()")
    expect(mainSource.indexOf("await oxpController.initialize()")).toBeLessThan(
      mainSource.indexOf("restoreMainWindows()"),
    )
  })

  test("explicit application Quit fences new work and waits for tunnel then local endpoint retirement", async () => {
    const [controller, mainSource] = await Promise.all([
      fs.readFile(path.join(oxp, "controller.ts"), "utf8"),
      fs.readFile(path.join(main, "index.ts"), "utf8"),
    ])
    const shutdown = controller.slice(controller.indexOf("private async shutdownNow()"))
    expect(shutdown.indexOf("this.shuttingDown = true")).toBeGreaterThan(-1)
    expect(shutdown.indexOf("await this.operation.catch")).toBeGreaterThan(shutdown.indexOf("this.shuttingDown = true"))
    expect(shutdown.indexOf("await this.stopTunnelOnly()")).toBeGreaterThan(shutdown.indexOf("await this.operation.catch"))
    expect(shutdown.indexOf('sidecar.request({ action: "stop" })')).toBeGreaterThan(shutdown.indexOf("await this.stopTunnelOnly()"))
    const quit = mainSource.slice(mainSource.indexOf('app.on("before-quit"'), mainSource.indexOf('app.on("will-quit"'))
    expect(quit).toContain("event.preventDefault()")
    expect(quit).toContain("stopSidecars()")
    expect(quit).toContain(".finally(() => app.quit())")
  })

  test("legacy import is one-way, rejects unknown secret-bearing fields, and retirement requires verified OXP", async () => {
    const [migration, controller] = await Promise.all([
      fs.readFile(path.join(oxp, "migration.ts"), "utf8"),
      fs.readFile(path.join(oxp, "controller.ts"), "utf8"),
    ])
    expect(migration).toContain("rejectExtra(raw, ALLOWED_TOP_LEVEL")
    expect(migration).toContain("unknown/plaintext secret fields are never recopied")
    expect(migration).not.toMatch(/openaiApiKey|CONTROL_PLANE_API_KEY|tunnelApiKey/)
    expect(migration).toContain("launchAtLogin: false")
    expect(migration).toContain("autoConnect: false")
    expect(controller).toContain("if (!current.migration.canRetire)")
    expect(controller).toContain("Verify a live OXP tunnel connection before disabling")
    expect(controller).toContain("this.tunnelReport.state === \"connected\"")
  })

  test("packaging carries one pinned tunnel runtime plus license/SBOM verification", async () => {
    const [builder, verifier, fetcher] = await Promise.all([
      fs.readFile(path.join(desktop, "electron-builder.config.ts"), "utf8"),
      fs.readFile(path.join(desktop, "scripts/verify-oxp-package.ts"), "utf8"),
      fs.readFile(path.join(desktop, "scripts/fetch-tunnel-client.ts"), "utf8"),
    ])
    expect(builder).toContain('from: "resources/tunnel/"')
    expect(builder).toContain('to: "tunnel/"')
    expect(verifier).toContain("Expected exactly one packaged OXP")
    expect(verifier).toContain('["VERSION", "LICENSE", "NOTICE"]')
    expect(verifier).toContain(".spdx.json")
    expect(verifier).toContain('["--version"]')
    expect(fetcher).toContain('const VERSION = "v0.0.14"')
  })
})
