import { describe, expect, test } from "bun:test"

const read = (name: string) => Bun.file(new URL(name, import.meta.url)).text()

describe("Servers settings OFXP separation", () => {
  test("keeps OpenFork Network primary and app-server management subordinate", async () => {
    const source = await read("./servers.tsx")
    const network = source.slice(source.indexOf("export const SettingsServersV2"))

    expect(network).toContain("<OfxpNetworkSettingsV2>")
    expect(network).toContain("<ServerConnectionsPanel />")
    expect(source).toContain('language.t("settings.ofxp.connections.title")')
    expect(source).toContain('language.t("settings.ofxp.connections.description")')
    expect(source).toContain("useServerManagementController()")
    expect(source).toContain("<ServerRowMenu")
  })

  test("keeps backend-management ownership out of the peer-trust component", async () => {
    const network = await read("./ofxp-network.tsx")

    expect(network).not.toContain("useServerManagementController")
    expect(network).not.toContain("ServerRowMenu")
    expect(network).not.toContain("DialogServerV2")
    expect(network).not.toContain("AddServerMenu")
    expect(network).toContain("serverSDK().client.ofxp")
  })

  test("consumes the existing OFXP projection without creating another poll owner", async () => {
    const source = await read("./servers.tsx")
    expect(source).toContain("useOfxpServerConnectionsUi()")
    expect(source).toContain("const networkState = () => ofxp?.state()")
    expect(source).toContain("const identity = () => health()?.ofxp")
    expect(source).not.toContain(".client.ofxp.state(")
    expect(source).not.toContain("setInterval")
    expect(source).not.toContain("setTimeout")
  })

  test("keeps backend transport, identity pairing, and capability authority separate", async () => {
    const source = await read("./servers.tsx")
    expect(source).toContain("ofxp.beginPairing(id)")
    expect(source).toContain("ofxp.focusPeer(id)")
    expect(source).toContain("controller.select(item)")
    expect(source).toContain("setSearch({ server: key })")
    expect(source).not.toContain(".peer.grant(")
    expect(source).not.toContain(".peer.root.")
    expect(source).not.toContain(".peer.revoke(")
    expect(source).not.toContain("ofxpSeed.endpoint")
  })

  test("gives WSL the same backend-scope and OFXP relationship surfaces", async () => {
    const [source, wsl] = await Promise.all([read("./servers.tsx"), Bun.file(new URL("../../wsl/settings.tsx", import.meta.url)).text()])
    expect(source).toContain("renderNetwork={(key) => <ServerConnectionNetworkStrip")
    expect(source).toContain("onManage={(key) => setSearch({ server: key })}")
    expect(source).toContain("onUse={(key) =>")
    expect(wsl).toContain("renderNetwork?: (key: ServerConnection.Key) => JSX.Element")
    expect(wsl).toContain("props.renderNetwork?.(key)")
    expect(wsl).toContain('language.t("settings.ofxp.connections.manage")')
    expect(wsl).toContain('language.t("settings.ofxp.connections.use")')
  })

  test("previews OFXP identity before save with a stale-request fence and no polling", async () => {
    const [controller, dialog] = await Promise.all([
      Bun.file(new URL("../dialog-select-server.tsx", import.meta.url)).text(),
      read("./dialog-server-v2.tsx"),
    ])
    expect(controller).toContain("probeConfiguredServerOfxp(connection, fetcher")
    expect(controller).toContain("let generation = 0")
    expect(controller).toContain("let pending: AbortController | undefined")
    expect(controller).toContain("pending?.abort()")
    expect(controller).toContain("const requestID = ++generation")
    expect(controller.match(/requestID !== generation/g)?.length).toBeGreaterThanOrEqual(2)
    expect(controller).toContain("retryCount: 0")
    expect(controller).toContain("controller.signal")
    expect(controller).toContain("formOfxp:")
    expect(controller).not.toContain("setInterval")
    expect(dialog).toContain("controller.formOfxp()")
    expect(dialog).toContain('language.t("settings.ofxp.connections.previewNotice")')
    expect(dialog).not.toContain("beginPairing")
    expect(dialog).not.toContain(".peer.grant")
  })

  test("states explicitly that app servers do not grant OFXP trust or authority", async () => {
    const i18n = await Bun.file(new URL("../../i18n/en.ts", import.meta.url)).text()
    expect(i18n).toContain('"settings.ofxp.connections.title": "App server connections"')
    expect(i18n).toContain("They are separate from OFXP peer trust and never grant peer capabilities by themselves.")
  })
})
