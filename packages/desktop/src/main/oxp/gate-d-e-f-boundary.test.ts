import { describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import path from "node:path"

const main = path.resolve(import.meta.dir, "..")
const preload = path.resolve(import.meta.dir, "../../preload")
const desktop = path.resolve(import.meta.dir, "../../..")

describe("OXP Gate D/E/F boundaries", () => {
  test("renderer API never exposes secret endpoint or credential getters", async () => {
    const [types, preloadSource] = await Promise.all([
      fs.readFile(path.join(preload, "types.ts"), "utf8"),
      fs.readFile(path.join(preload, "index.ts"), "utf8"),
    ])
    expect(types).not.toMatch(/get(?:OpenAi)?ApiKey/i)
    expect(types).not.toMatch(/(?:get|read|resolve)(?:Oxp)?Credential/i)
    expect(types).not.toMatch(/metadataUrl|endpointUrl|localMcpUrl/i)
    expect(preloadSource).not.toMatch(/oxp-get-secret|oxp-get-endpoint/i)
    expect(preloadSource).not.toMatch(/oxp-(?:get|read|resolve)-credential/i)
    expect(types).not.toMatch(/CredentialAPI|credentialRef|saveCredential|removeCredential/)
    expect(preloadSource).not.toMatch(/credential-prompt|credentials:\s*\{/)
  })

  test("OXP renderer state is push-driven without polling or secret transport environment names", async () => {
    const [preloadSource, settings, controller, lifecycle] = await Promise.all([
      fs.readFile(path.join(preload, "index.ts"), "utf8"),
      fs.readFile(path.resolve(desktop, "../app/src/components/settings-v2/oxp.tsx"), "utf8"),
      fs.readFile(path.join(import.meta.dir, "controller.ts"), "utf8"),
      fs.readFile(path.join(import.meta.dir, "lifecycle.ts"), "utf8"),
    ])
    expect(preloadSource).toContain('ipcRenderer.on("oxp-state", oxpHandler)')
    expect(preloadSource).toContain('ipcRenderer.invoke("oxp-subscribe")')
    expect(preloadSource).toContain('ipcRenderer.invoke("oxp-unsubscribe")')
    expect(settings).not.toContain("setInterval(")
    expect(controller).not.toContain("setInterval(")
    expect(lifecycle).not.toContain("setInterval(")
    expect(`${preloadSource}\n${settings}`).not.toMatch(/MCP_SERVER_URL|CONTROL_PLANE_API_KEY|metadataUrl/)
  })

  test("sidecar control remains a closed typed request union rather than arbitrary message forwarding", async () => {
    const source = await fs.readFile(path.join(main, "sidecar-protocol.ts"), "utf8")
    expect(source).toContain('type: "oxp-request"')
    expect(source).toContain("isSidecarOxpState")
    expect(source).toContain("parseSidecarGrantPatch")
    expect(source).not.toMatch(/action:\s*string/)
    expect(source).not.toMatch(/argv:\s*string\[\]/)
  })

  test("desktop controller strips privileged endpoint URLs from the renderer projection", async () => {
    const source = await fs.readFile(path.join(import.meta.dir, "controller.ts"), "utf8")
    expect(source).toContain("schemaFingerprint")
    expect(source).not.toMatch(/endpoint:\s*sidecar\.endpoint/)
    expect(source).toContain("const endpointUrl = started.endpoint.url")
    expect(source).toContain("OxpEndpointGenerationTracker")
    expect(source).toContain("this.sidecarEpoch !== epoch")
  })

  test("disconnect is transport-only and proven tunnel retirement is required before ownership is forgotten", async () => {
    const source = await fs.readFile(path.join(import.meta.dir, "controller.ts"), "utf8")
    const disconnect = source.slice(source.indexOf("disconnect()"), source.indexOf("private async stopTunnelOnly"))
    expect(disconnect).not.toContain('action: "stop"')
    expect(source).toContain("await tunnel.stop()")
    expect(source).toContain("if (this.tunnel === tunnel) this.tunnel = undefined")
    expect(source).not.toMatch(/tunnel\.stop\(\)\.catch/)
  })

  test("live endpoint identity changes invalidate and reconverge the bound tunnel", async () => {
    const source = await fs.readFile(path.join(import.meta.dir, "controller.ts"), "utf8")
    expect(source).toContain("observed.endpointChanged && (this.tunnel !== undefined || activeTunnel(this.tunnelReport.state))")
    expect(source).toContain("this.connectionGeneration += 1")
    expect(source).toContain("await this.stopTunnelOnly()")
    expect(source).toContain("await this.connectNow()")
    expect(source).toContain("endpointGeneration !== this.endpointGeneration.current()")
    expect(source).toContain("Keep ownership of an unproven stale tree")
  })

  test("shutdown closes OXP admission before draining prior controller work", async () => {
    const source = await fs.readFile(path.join(import.meta.dir, "controller.ts"), "utf8")
    expect(source).toContain("private shuttingDown = false")
    expect(source).toContain("if (this.shuttingDown) return Promise.reject")
    expect(source).toContain("return this.enqueue(() => this.attachSidecarNow(sidecar))")
    const shutdown = source.slice(source.indexOf("private async shutdownNow()"), source.lastIndexOf("}"))
    const fence = shutdown.indexOf("this.shuttingDown = true")
    const drain = shutdown.indexOf("await this.operation.catch")
    const tunnelStop = shutdown.indexOf("await this.stopTunnelOnly()")
    expect(fence).toBeGreaterThan(-1)
    expect(drain).toBeGreaterThan(fence)
    expect(tunnelStop).toBeGreaterThan(drain)
  })

  test("privileged OXP startup/control failures are not reflected verbatim into logs", async () => {
    const controller = await fs.readFile(path.join(import.meta.dir, "controller.ts"), "utf8")
    const sidecar = await fs.readFile(path.join(main, "sidecar.ts"), "utf8")
    const mainSource = await fs.readFile(path.join(main, "index.ts"), "utf8")
    expect(controller).not.toContain('could not read OXP state from sidecar", { error:')
    expect(sidecar).not.toContain('console.warn("failed to restore OXP endpoint", serializeError(error).message)')
    expect(mainSource).not.toContain('failed to attach OXP sidecar bridge", { error:')
    expect(sidecar).toContain("redactOxpControlError(serialized.message)")
  })

  test("diagnostic export strips native approved-root paths and the tunnel identifier", async () => {
    const source = await fs.readFile(path.join(import.meta.dir, "controller.ts"), "utf8")
    const diagnostics = source.slice(source.indexOf("async exportDiagnostics()"), source.indexOf("async shutdown()"))
    expect(diagnostics).toContain("roots: state.roots.map(({ path: _path, ...root }) => root)")
    expect(diagnostics).toContain('tunnelID: state.tunnel.tunnelID ? "[configured]" : ""')
    expect(diagnostics).not.toContain("endpoint.url")
    expect(diagnostics).toContain("shell.showItemInFolder(file)")
    expect(diagnostics).toContain("return true")
    expect(diagnostics).not.toContain("return file")
  })

  test("renderer settings expose implemented augmentation and live agent controls without stale policy-only labels", async () => {
    const appRoot = path.resolve(desktop, "../app/src")
    const [surface, english] = await Promise.all([
      fs.readFile(path.join(appRoot, "components/settings-v2/oxp.tsx"), "utf8"),
      fs.readFile(path.join(appRoot, "i18n/en-desktop-network-settings.ts"), "utf8"),
    ])
    const active = surface.slice(surface.indexOf("const activeAugmentationRows"), surface.indexOf("const lifecycleRows"))
    for (const key of ["read", "automation", "write", "process", "git", "integrations", "browser", "filesReceive", "filesSend"]) {
      expect(active).toContain(`"${key}"`)
    }
    expect(surface).not.toContain("const plannedAugmentationRows")
    expect(surface).not.toContain('language.t("settings.oxp.capability.planned")')
    expect(surface).not.toContain('language.t("settings.oxp.policyOnly")')
    expect(english).not.toContain('"settings.oxp.policyOnly"')
    expect(english).toContain('"settings.oxp.capability.automation.title": "Scheduled automation"')
    expect(english).toMatch(/Scheduled Tasks inside approved folders.*disabled by default/)
    expect(english).toMatch(/Configure live OXP supervision, request mediation, and delegated-worker authority/)
  })

  test("scheduled automation grant is one default-off authority from OXP schema through desktop Settings", async () => {
    const opencode = path.resolve(desktop, "../opencode/src/oxp")
    const app = path.resolve(desktop, "../app/src")
    const [
      schema,
      config,
      server,
      protocol,
      contracts,
      ipc,
      preloadTypes,
      preloadSource,
      platform,
      settings,
    ] = await Promise.all([
      fs.readFile(path.join(opencode, "schema.ts"), "utf8"),
      fs.readFile(path.join(opencode, "config.ts"), "utf8"),
      fs.readFile(path.join(opencode, "server.ts"), "utf8"),
      fs.readFile(path.join(main, "sidecar-protocol.ts"), "utf8"),
      fs.readFile(path.join(import.meta.dir, "contracts.ts"), "utf8"),
      fs.readFile(path.join(import.meta.dir, "ipc.ts"), "utf8"),
      fs.readFile(path.join(preload, "types.ts"), "utf8"),
      fs.readFile(path.join(preload, "index.ts"), "utf8"),
      fs.readFile(path.join(app, "oxp/platform.ts"), "utf8"),
      fs.readFile(path.join(app, "components/settings-v2/oxp.tsx"), "utf8"),
    ])

    expect(schema).toContain("automation: false")
    expect(schema).toContain("automation: Schema.optional(Schema.Boolean)")
    expect(config).toContain("automation: config.grant.automation ?? false")
    expect(server).toContain("automation: state.grant.automation ?? false")

    expect(protocol).toContain("automation: boolean")
    expect(protocol).toContain('"automation",')
    expect(contracts).toContain("automation: false")
    expect(ipc).toContain('"automation",')
    expect(preloadTypes).toContain("setGrant: (patch: Partial<SidecarOxpGrant>)")
    expect(preloadSource).toContain('ipcRenderer.invoke("oxp-set-grant", patch)')

    expect(platform).toContain("automation: boolean")
    expect(settings).toContain('["automation", "settings.oxp.capability.automation.title"')
    expect(settings).toContain('["browser", "settings.oxp.capability.browser.title"')
    expect(settings).toContain("onChange={(value) => setGrant(key, value)}")
    expect(settings).toContain("checked={current().grant[key] === true}")
  })

  test("failed live tunnel-setting mutations restore the previous desired connection rather than projecting a dead tunnel as connected", async () => {
    const source = await fs.readFile(path.join(import.meta.dir, "controller.ts"), "utf8")
    const id = source.slice(source.indexOf("async setTunnelID"), source.indexOf("async setOpenAiApiKey"))
    const key = source.slice(source.indexOf("async setOpenAiApiKey"), source.indexOf("async clearOpenAiApiKey"))
    expect(id).toContain("await this.connectNow().catch")
    expect(key).toContain("await this.connectNow().catch")
  })

  test("replacement sidecar remains observable when old tunnel retirement fails closed", async () => {
    const source = await fs.readFile(path.join(import.meta.dir, "controller.ts"), "utf8")
    const attach = source.slice(source.indexOf("async attachSidecar"), source.indexOf("private enqueue"))
    expect(attach).toContain("let retirementBlocked = false")
    expect(attach).toContain("retirementBlocked = true")
    expect(attach).toContain("this.sidecarSubscription = sidecar.subscribe")
    expect(attach).toContain("!retirementBlocked && accepted.enabled")
  })

  test("sidecar request publication cleans pending ownership on synchronous IPC failure", async () => {
    const source = await fs.readFile(path.join(main, "server.ts"), "utf8")
    const request = source.slice(source.indexOf("request(request)"), source.indexOf("subscribe(listener)"))
    expect(request).toContain("try {")
    expect(request).toContain("child.postMessage")
    expect(request).toContain("clearTimeout(timer)")
    expect(request).toContain("pending.delete(id)")
  })

  test("application quit waits for bounded OXP/sidecar teardown instead of fire-and-forget shutdown", async () => {
    const source = await fs.readFile(path.join(main, "index.ts"), "utf8")
    const beforeQuit = source.slice(source.indexOf('app.on("before-quit"'), source.indexOf('app.on("will-quit"'))
    expect(beforeQuit).toContain("event.preventDefault()")
    expect(beforeQuit).toContain("stopSidecars()")
    expect(beforeQuit).toContain(".finally(() => app.quit())")
    expect(source).toContain("stopSidecarsInFlight")
  })

  test("close-to-tray hides normal closes but explicit Quit crosses the global quitting fence", async () => {
    const [windows, lifecycle] = await Promise.all([
      fs.readFile(path.join(main, "windows.ts"), "utf8"),
      fs.readFile(path.join(import.meta.dir, "lifecycle.ts"), "utf8"),
    ])
    expect(windows).toContain("if (appQuitting || !closeToTray) return")
    expect(windows).toContain("event.preventDefault()")
    expect(windows).toContain("win.hide()")
    const quit = lifecycle.slice(lifecycle.indexOf('label: nativeT("desktop.oxp.tray.quit")'), lifecycle.indexOf("],", lifecycle.indexOf('label: nativeT("desktop.oxp.tray.quit")')))
    expect(quit).toContain("setAppQuitting()")
    expect(quit).toContain("app.quit()")
  })

  test("secure credentials use async safeStorage and reject Linux basic_text ciphertext", async () => {
    const [adapter, store] = await Promise.all([
      fs.readFile(path.join(import.meta.dir, "credentials.ts"), "utf8"),
      fs.readFile(path.join(import.meta.dir, "credentials-store.ts"), "utf8"),
    ])
    expect(adapter).toContain("isAsyncEncryptionAvailable")
    expect(adapter).toContain("encryptStringAsync")
    expect(adapter).toContain("decryptStringAsync")
    expect(store).toContain('Buffer.from("v10", "ascii")')
    expect(`${adapter}\n${store}`).not.toMatch(/storeSet|storeGet/)
  })

  test("restores OXP only after ordinary sidecar readiness and keeps failures optional", async () => {
    const source = await fs.readFile(path.join(main, "sidecar.ts"), "utf8")
    const ready = source.indexOf('parentPort.postMessage({ type: "ready" })')
    const restore = source.indexOf(".restore()")
    expect(ready).toBeGreaterThan(-1)
    expect(restore).toBeGreaterThan(ready)
    expect(source.slice(restore, restore + 500)).toContain(".catch")
  })

  test("backend dev rebuilds stage a candidate without using electron-vite main-watch activation", async () => {
    const [vite, devElectron, watcher, packageJson] = await Promise.all([
      fs.readFile(path.join(desktop, "electron.vite.config.ts"), "utf8"),
      fs.readFile(path.join(desktop, "scripts/dev-electron.ts"), "utf8"),
      fs.readFile(path.join(desktop, "scripts/watch-node-sidecar.ts"), "utf8"),
      fs.readFile(path.join(desktop, "package.json"), "utf8"),
    ])
    expect(vite).not.toContain("nodeSidecarDevSync")
    expect(vite).not.toContain("collectNodeSidecarWatchFiles")
    expect(devElectron).toContain("./scripts/watch-node-sidecar.ts")
    expect(watcher).toContain("script/build-node.ts")
    expect(watcher).toContain("activation remains explicit via OXP runtime.refresh")
    expect(watcher).not.toMatch(/electron-vite|app\.relaunch|process\.exit\(1\)/)
    expect(packageJson).toContain('"@parcel/watcher": "2.5.1"')
  })

  test("every Node backend build serializes against the runtime artifact transaction", async () => {
    const [builder, watcher] = await Promise.all([
      fs.readFile(path.resolve(desktop, "../opencode/script/build-node.ts"), "utf8"),
      fs.readFile(path.join(desktop, "scripts/watch-node-sidecar.ts"), "utf8"),
    ])
    expect(builder).toContain(".oxp-runtime-refresh.lock")
    expect(builder).toContain("build:${process.pid}")
    expect(builder).toContain('flag: "wx"')
    expect(builder).toContain("process.exit(75)")
    expect(watcher).toContain("code === 75")
    expect(watcher).not.toContain('flag: "wx"')
  })

  test("runtime refresh keeps module selection host-owned and never accepts a caller path", async () => {
    const [runtime, bridge, node] = await Promise.all([
      fs.readFile(path.join(import.meta.dir, "runtime-refresh.ts"), "utf8"),
      fs.readFile(path.resolve(desktop, "../opencode/src/oxp/runtime-refresh.ts"), "utf8"),
      fs.readFile(path.resolve(desktop, "../opencode/src/node.ts"), "utf8"),
    ])
    expect(runtime).toContain("runtimeModuleUrl")
    expect(runtime).toContain("dist/node/node.js")
    expect(runtime).toContain("expectedRuntimeID")
    expect(runtime).not.toMatch(/input\.(?:path|module|url)/)
    expect(bridge).not.toMatch(/path:\s*Schema|moduleUrl|runtimeModuleUrl/)
    expect(node).toContain("export const runtimeModuleUrl = import.meta.url")
  })

  test("packages the pinned tunnel runtime outside app.asar", async () => {
    const [builder, fetcher] = await Promise.all([
      fs.readFile(path.join(desktop, "electron-builder.config.ts"), "utf8"),
      fs.readFile(path.join(desktop, "scripts/fetch-tunnel-client.ts"), "utf8"),
    ])
    expect(builder).toContain('"!resources/tunnel/**/*"')
    expect(builder).toContain('from: "resources/tunnel/"')
    expect(fetcher).toContain('const VERSION = "v0.0.14"')
    expect(fetcher).toContain("sha256")
    expect(fetcher).toContain('["--version"]')
  })
})
