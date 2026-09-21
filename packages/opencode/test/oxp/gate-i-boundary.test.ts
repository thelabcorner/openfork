import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"

const opencode = path.resolve(import.meta.dir, "../../src")
const core = path.resolve(import.meta.dir, "../../../core/src")

describe("OXP Gate I supervision architecture boundary", () => {
  test("keeps durable Session inspection at Tier 1 with Database as its only runtime owner", async () => {
    const source = await fs.readFile(path.join(core, "session/inspection.ts"), "utf8")
    expect(source).toContain("deps: [Database.node]")
    expect(source).not.toMatch(/LocationServiceMap|InstanceStore|SessionPrompt|Provider|Plugin|Tool\.Context|process\.cwd/)
  })

  test("keeps the OXP supervision read plane independent from V1 workspace/runtime owners", async () => {
    const source = await fs.readFile(path.join(opencode, "oxp/session.ts"), "utf8")
    expect(source).toContain('from "@opencode-ai/core/session/inspection"')
    expect(source).toContain('from "./session-control"')
    expect(source).not.toMatch(
      /@\/effect\/app-runtime|@\/project\/instance-store|@\/session\/prompt|@\/session\/session|LocationServiceMap|InstanceStore|SessionPrompt/,
    )
  })

  test("loads the V1 Tier-3 adapter only after an authorized control call", async () => {
    const [adapter, shim, runtime] = await Promise.all([
      fs.readFile(path.join(opencode, "oxp/session-control-v1.ts"), "utf8"),
      fs.readFile(path.join(opencode, "oxp/runtime-v1.ts"), "utf8"),
      fs.readFile(path.join(opencode, "exchange/runtime-v1.ts"), "utf8"),
    ])
    expect(shim).toContain('from "@/exchange/runtime-v1"')
    expect(runtime).toContain('import("@/effect/app-runtime")')
    expect(runtime).toContain('import("@/project/instance-store")')
    expect(adapter).toContain('import("@/session/prompt")')
    expect(adapter).toContain("OxpRuntimeV1.enter")
    expect(runtime).not.toMatch(/import\s+\{[^}]*AppRuntime[^}]*\}\s+from/)
    expect(runtime).not.toMatch(/import\s+\{[^}]*InstanceStore[^}]*\}\s+from/)
    expect(adapter).not.toMatch(/import\s+\{[^}]*SessionPrompt[^}]*\}\s+from/)
  })

  test("rejects non-language model primitives before OXP commits a Session model switch", async () => {
    const adapter = await fs.readFile(path.join(opencode, "oxp/session-control-v1.ts"), "utf8")
    expect(adapter).toContain('runtime.Provider.modelPrimitive(resolved) !== "language"')
    expect(adapter).toContain('new OxpSessionControl.SelectionUnavailable(')
    expect(adapter).toContain("Requested model is not a conversational language model")
  })

  test("binds the unbound runtime-control port at OXP host composition rather than inside the domain owner", async () => {
    const [port, requestPort, host] = await Promise.all([
      fs.readFile(path.join(opencode, "oxp/session-control.ts"), "utf8"),
      fs.readFile(path.join(opencode, "oxp/request-control.ts"), "utf8"),
      fs.readFile(path.join(opencode, "oxp/host.ts"), "utf8"),
    ])
    expect(port).toContain("LayerNode.unbound")
    expect(requestPort).toContain("LayerNode.unbound")
    expect(host).toContain("[OxpSessionControl.node, OxpSessionControlV1.layer]")
    expect(host).toContain("[OxpRequestControl.node, OxpRequestControlV1.layer]")
    expect(host).not.toContain('from "@/session/prompt"')
    expect(host).not.toContain('from "@/project/instance-store"')
  })

  test("does not proxy Session supervision through the generic OpenFork HTTP server", async () => {
    const [session, request] = await Promise.all([
      fs.readFile(path.join(opencode, "oxp/session.ts"), "utf8"),
      fs.readFile(path.join(opencode, "oxp/request.ts"), "utf8"),
    ])
    expect(session).not.toMatch(/fetch\(|HttpClient|OpenCodeHttpApi|@\/server|server\/routes|\/api\/|http:\/\//)
    expect(request).not.toMatch(/fetch\(|HttpClient|OpenCodeHttpApi|@\/server|server\/routes|\/api\/|http:\/\//)
  })

  test("keeps Permission/Question services behind the lazy Tier-3 request adapter", async () => {
    const [owner, adapter] = await Promise.all([
      fs.readFile(path.join(opencode, "oxp/request.ts"), "utf8"),
      fs.readFile(path.join(opencode, "oxp/request-control-v1.ts"), "utf8"),
    ])
    expect(owner).toContain('from "./request-control"')
    expect(owner).not.toMatch(/@\/permission|@\/question|InstanceStore|AppRuntime/)
    expect(adapter).toContain('import("@/permission")')
    expect(adapter).toContain('import("@/question")')
    expect(adapter).toContain("OxpRuntimeV1.enter")
  })

  test("fails closed on external_directory approval rather than widening approved-root authority", async () => {
    const adapter = await fs.readFile(path.join(opencode, "oxp/request-control-v1.ts"), "utf8")
    expect(adapter).toContain('request.permission === "external_directory"')
    expect(adapter).toContain('input.reply !== "reject"')
    expect(adapter).toContain("ExternalDirectoryBlocked")
  })
})
