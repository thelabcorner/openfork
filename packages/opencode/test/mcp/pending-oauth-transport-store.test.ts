import { describe, expect, test } from "bun:test"
import { PendingOAuthTransportStore } from "../../src/mcp/pending-oauth-transport-store"

function transport(onClose: () => void) {
  return { close: async () => onClose() }
}

describe("pending MCP OAuth transport ownership", () => {
  test("replacement, explicit removal, and service teardown close each transport", async () => {
    const store = new PendingOAuthTransportStore<ReturnType<typeof transport>, { marker: string }>()
    let closed = 0
    const first = transport(() => closed++)
    const second = transport(() => closed++)

    await store.replace("server", { transport: first, provider: { marker: "first" } })
    await store.replace("server", { transport: second, provider: { marker: "second" } })
    expect(closed).toBe(1)
    expect(store.get("server")?.transport).toBe(second)

    await store.close("server")
    expect(closed).toBe(2)
    expect(store.get("server")).toBeUndefined()

    await store.replace("other", { transport: transport(() => closed++) })
    await store.replace("third", { transport: transport(() => closed++) })
    await store.closeAll()
    expect(closed).toBe(4)
    expect(store.get("other")).toBeUndefined()
    expect(store.get("third")).toBeUndefined()
  })

  test("isolates independent MCP service lifetimes", async () => {
    const first = new PendingOAuthTransportStore<ReturnType<typeof transport>, undefined>()
    const second = new PendingOAuthTransportStore<ReturnType<typeof transport>, undefined>()
    let closed = 0

    await first.replace("server", { transport: transport(() => closed++) })
    await second.replace("server", { transport: transport(() => closed++) })
    await first.closeAll()

    expect(closed).toBe(1)
    expect(first.get("server")).toBeUndefined()
    expect(second.get("server")).toBeDefined()
  })
})
