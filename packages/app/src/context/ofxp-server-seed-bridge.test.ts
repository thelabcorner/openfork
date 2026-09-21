import { describe, expect, test } from "bun:test"

const bridgeSource = () => Bun.file(new URL("./ofxp-server-seed-bridge.tsx", import.meta.url)).text()
const appSource = () => Bun.file(new URL("../app.tsx", import.meta.url)).text()
const settingsSource = () =>
  Bun.file(new URL("../components/settings-v2/settings-screen.tsx", import.meta.url)).text()
const healthSource = () => Bun.file(new URL("../utils/server-health.ts", import.meta.url)).text()

describe("OFXP configured-server seed bridge architecture", () => {
  test("targets only the scoped ServerSDK backend and adds no polling owner", async () => {
    const text = await bridgeSource()
    expect(text).toContain('from "./server-sdk"')
    expect(text).toContain("const serverSDK = useServerSDK()")
    expect(text).toContain("ServerConnection.key(scoped.server)")
    expect(text).toContain("collectOfxpServerSeeds(global.servers.list(), global.servers.health, destinationKey)")
    expect(text).toContain("scoped.client.ofxp.discovery.serverSeeds")
    expect(text).not.toContain("global.settings.server")
    expect(text).not.toContain("setInterval")
    expect(text).not.toContain("setTimeout")
  })

  test("mounts for the normal active backend and the explicit V2 Settings backend", async () => {
    const [app, settings] = await Promise.all([appSource(), settingsSource()])
    const activeProvider = app.slice(app.indexOf("function SelectedServerProviders"))
    expect(activeProvider).toContain("<ServerSDKProvider>")
    expect(activeProvider).toContain("<OfxpServerSeedBridge />")

    expect(settings).toContain("<ServerSDKProvider server={connection}>")
    expect(settings).toContain("<OfxpServerSeedBridge />")
    expect(settings).toContain("const key = search.server")
  })

  test("reuses the existing server-health cadence instead of creating another poll loop", async () => {
    const text = await healthSource()
    expect(text).toContain("probeConfiguredServerOfxp(conn, fetcher)")
    expect(text).toContain("const OFXP_SEED_REFRESH_MS = 20_000")
    expect(text.match(/setInterval\(/g)?.length).toBe(1)
  })

  test("includes destination process generation so a restarted backend is reconciled again", async () => {
    const text = await bridgeSource()
    expect(text).toContain('global.servers.health[destinationKey]?.instanceID ?? ""')
    expect(text).toContain("destinationInstanceID")
    expect(text).toContain("JSON.stringify(seeds)")
  })
})
