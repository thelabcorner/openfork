import { describe, expect, test } from "bun:test"

const source = () => Bun.file(new URL("./ofxp-network.tsx", import.meta.url)).text()

describe("OFXP settings architecture", () => {
  test("uses the scoped Settings server as the sole backend authority", async () => {
    const text = await source()

    expect(text).toContain('from "@/context/server-sdk"')
    expect(text).toContain('from "@/context/server-sync"')
    expect(text).toContain("const scopedServer = createMemo(() => serverSDK().server)")
    expect(text).toContain("const api = () => serverSDK().client.ofxp")
    expect(text).toContain("serverSync().data.project")
    expect(text).toContain("ServerConnection.local(scopedServer())")

    expect(text).not.toContain("global.settings.server.selected")
    expect(text).not.toContain("SettingsServerPicker")
    expect(text).not.toContain('from "@/context/local"')
    expect(text).not.toContain('from "@/context/sdk"')
    expect(text).not.toContain("useLocal()")
    expect(text).not.toContain("useSDK()")
    expect(text).not.toContain('from "@/tool/ofxp"')
    expect(text).not.toContain(".capability(")
    expect(text).not.toContain(".describe(")
    expect(text).not.toContain(".receipt(")
    expect(text).not.toContain(".call(")
  })

  test("fences stale reads across mutations and scoped-backend changes", async () => {
    const text = await source()

    expect(text).toContain("let stateRequestID = 0")
    expect(text).toContain("let busyRequestID = 0")
    expect(text).toContain("const requestID = ++stateRequestID")
    expect(text).toContain("requestID === stateRequestID")
    expect(text).toContain("if (requestID !== stateRequestID) return false")

    const serverSwitch = text.slice(text.indexOf("createEffect(() => {\n    scopedServerKey()"))
    expect(serverSwitch).toContain("stateRequestID += 1")
    expect(serverSwitch).toContain("busyRequestID += 1")
  })

  test("carries the operator-viewed authority generation on every fenced mutation", async () => {
    const text = await source()
    expect(text).toContain("ofxpSettingsIdentityMutationPayload: { expectedPeerID: peerID }")
    expect(text).toContain("expectedRevision: peer.info.grantRevision")
    expect(text).toContain("ofxpSettingsRevokePayload: { expectedRevision: peer.info.grantRevision }")
  })
})
