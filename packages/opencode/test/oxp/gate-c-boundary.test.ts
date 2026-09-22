import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { OxpSurface } from "@/oxp/surface"

describe("OXP Gate C endpoint boundary", () => {
  test("keeps MCP ingress independent from native Sessions, providers, plugins, and the outbound MCP client", async () => {
    const files = ["server.ts", "surface.ts"].map((name) => path.resolve(import.meta.dir, `../../src/oxp/${name}`))
    const forbidden = [
      /@\/session\//,
      /@\/provider\//,
      /@\/agent\//,
      /@\/plugin(?:\/|\")/,
      /@\/mcp(?:\/|\")/,
      /Tool\.Context/,
      /ToolRegistry/,
      /InstanceState/,
      /workbuddy/i,
    ]
    for (const file of files) {
      const text = await fs.readFile(file, "utf8")
      for (const pattern of forbidden) expect(text).not.toMatch(pattern)
    }
  })

  test("surface instructions encode support-not-initiation semantics and no implicit workspace", async () => {
    const text = await fs.readFile(path.resolve(import.meta.dir, "../../src/oxp/surface.ts"), "utf8")
    expect(text).toMatch(/serves the current ChatGPT\/OpenAI agent/)
    expect(text).toMatch(/no backing OpenFork Session/)
    expect(text).toMatch(/no implicit ChatGPT workspace/i)
    expect(text).toMatch(/Upstream may reject model-authored authentication before OXP receives it/i)
    expect(text).toMatch(/call openai_files directly/i)
    expect(text).toMatch(/OXP owns the OpenAI connection/i)
    expect(text).toMatch(/Never read secrets or build auth in process/i)
    expect(text).not.toMatch(/credentialRef|use .*credential capability/i)
  })

  test("model-facing prose explains the upstream boundary and routes auth to purpose-specific capabilities", async () => {
    const text = await fs.readFile(path.resolve(import.meta.dir, "../../src/oxp/prose.ts"), "utf8")
    expect(text).toMatch(/Upstream may reject model-authored authentication before OXP receives it/i)
    expect(text).toMatch(/purpose-specific direct tool/i)
    expect(text).toMatch(/Do not route authenticated work through this generic broker/i)
    expect(text).toMatch(/trusted OpenAI connection/i)
    expect(text).not.toMatch(/credentialRef|stored-credential HTTPS/i)
  })

  test("generic credential product is absent from the OXP model-visible surface", async () => {
    const [surface, prose, capability] = await Promise.all([
      fs.readFile(path.resolve(import.meta.dir, "../../src/oxp/surface.ts"), "utf8"),
      fs.readFile(path.resolve(import.meta.dir, "../../src/oxp/prose.ts"), "utf8"),
      fs.readFile(path.resolve(import.meta.dir, "../../src/oxp/capability.ts"), "utf8"),
    ])
    const text = `${surface}\n${prose}\n${capability}`
    expect(text).not.toMatch(/credentialRef|OxpCredential|id:\s*["']credential["']/)
    expect(text).not.toMatch(/headerName|Bearer prefix|credential registry/i)
  })

  test("projects OpenAI Files as a direct semantic operation with no model-authored auth fields", async () => {
    const tool = OxpSurface.TOOLS.find((item) => item.name === "openai_files")
    expect(tool).toBeDefined()
    expect(tool?.description).toMatch(/OXP's trusted OpenAI connection/i)
    const schema = JSON.stringify(tool?.inputSchema)
    expect(schema).toContain('"list"')
    expect(schema).toContain('"upload"')
    expect(schema).not.toMatch(
      /credential|secret|token|authorization|header|origin|apiKey/i,
    )
  })

  test("publishes ChatGPT-native descriptor metadata and structured output contracts", () => {
    for (const tool of OxpSurface.TOOLS) {
      expect(tool.title).toBeTruthy()
      expect(tool.outputSchema).toEqual(OxpSurface.OUTPUT_SCHEMA)
      expect(tool.annotations?.readOnlyHint).toBeBoolean()
      expect(tool.annotations?.destructiveHint).toBeBoolean()
      expect(tool.annotations?.openWorldHint).toBeBoolean()
      expect(tool._meta?.securitySchemes).toEqual([{ type: "noauth" }])
      expect(tool._meta?.["openai/toolInvocation/invoking"]).toBeTruthy()
      expect(tool._meta?.["openai/toolInvocation/invoked"]).toBeTruthy()
    }
  })

  test("publishes self-contained input schemas with no dangling local refs", () => {
    for (const tool of OxpSurface.TOOLS) {
      const schema = tool.inputSchema as Record<string, unknown>
      expect(schema.type).toBe("object")
      const refs = JSON.stringify(schema).match(/#\/\$defs\/[^"\\]+/g) ?? []
      const defs = (schema.$defs ?? {}) as Record<string, unknown>
      for (const ref of refs) {
        const name = ref.slice("#/$defs/".length)
        expect(defs[name]).toBeDefined()
      }
    }
  })

  test("projects edit/process as strict strategy/action unions instead of ambiguous optional-field bags", () => {
    type Branch = {
      properties?: Record<string, { enum?: unknown[]; minimum?: number }>
      required?: string[]
      additionalProperties?: boolean
    }
    const branches = (name: string) => {
      const tool = OxpSurface.TOOLS.find((item) => item.name === name)
      expect(tool).toBeDefined()
      const anyOf = (tool!.inputSchema as { anyOf?: Branch[] }).anyOf
      expect(anyOf).toBeArray()
      expect(anyOf!.length).toBeGreaterThan(1)
      for (const branch of anyOf!) expect(branch.additionalProperties).toBe(false)
      return anyOf!
    }

    const edit = branches("edit")
    expect(edit.some((branch) => branch.required?.includes("oldString") && branch.required.includes("newString"))).toBe(true)
    expect(
      edit.some(
        (branch) =>
          branch.properties?.startLine &&
          branch.properties?.newText &&
          branch.required?.includes("oldText"),
      ),
    ).toBe(true)
    expect(
      edit.some((branch) => branch.properties?.oldString && branch.properties?.startLine),
    ).toBe(false)
    expect(
      edit.some(
        (branch) =>
          branch.properties?.insertAt?.enum?.includes(0) &&
          !branch.required?.includes("oldText"),
      ),
    ).toBe(true)
    expect(
      edit.some(
        (branch) =>
          branch.properties?.insertAt?.minimum === 1 &&
          branch.required?.includes("oldText"),
      ),
    ).toBe(true)

    const process = branches("process")
    const starts = process.filter((branch) => branch.properties?.action?.enum?.includes("start"))
    expect(starts).toHaveLength(2)
    expect(starts.some((branch) => branch.required?.includes("argv"))).toBe(true)
    expect(starts.some((branch) => branch.required?.includes("command"))).toBe(true)
    expect(starts.some((branch) => branch.properties?.argv && branch.properties?.command)).toBe(false)
    const poll = process.find((branch) => branch.properties?.action?.enum?.includes("poll"))
    expect(poll?.required).toContain("handle")

    const find = branches("find")
    expect(find).toHaveLength(2)
    expect(find.some((branch) => branch.required?.includes("glob"))).toBe(true)
    expect(find.some((branch) => branch.required?.includes("grep"))).toBe(true)
    expect(find.some((branch) => branch.properties?.glob && branch.properties?.grep)).toBe(false)
  })

  test("keeps authenticated OpenAI Files actions out of the generic capability broker", async () => {
    const text = await fs.readFile(path.resolve(import.meta.dir, "../../src/oxp/capability.ts"), "utf8")
    const start = text.indexOf('"file.transfer"')
    const fileTransfer = text.slice(start, text.indexOf('"read"', start))
    expect(fileTransfer).toContain("OxpFileExchange.ChatGptParameters")
    expect(fileTransfer).not.toContain("OxpFileExchange.OpenAiParameters")
  })

  test("disabled host state stays on the config/root graph until endpoint activation", async () => {
    const text = await fs.readFile(path.resolve(import.meta.dir, "../../src/oxp/host.ts"), "utf8")
    const idle = text.slice(text.indexOf("const idleLayer"), text.indexOf("const activeLayer"))
    const active = text.slice(text.indexOf("const activeLayer"), text.indexOf("const makeIdleRuntime"))
    expect(idle).toContain("LayerNode.group([OxpConfig.node, OxpRoot.node])")
    expect(idle).not.toContain("OxpServer.node")
    expect(idle).not.toContain("CrossSpawnSpawner.node")
    expect(active).toMatch(
      /LayerNode\.group\(\[\s*CrossSpawnSpawner\.node,\s*OxpConfig\.node,\s*OxpRoot\.node,\s*OxpAgentCatalog\.node,\s*OxpServer\.node,\s*\]\)/,
    )
    expect(text).toContain("if (!activeRuntime) await retireIdleRuntime()")
    expect(text).toContain("There must never be two live OxpConfig caches")
  })

  test("fixed info schema advertises only actions with live Gate C owners", async () => {
    const text = await fs.readFile(path.resolve(import.meta.dir, "../../src/oxp/surface.ts"), "utf8")
    const info = text.slice(text.indexOf("export const InfoParameters"), text.indexOf("export type InfoInput"))
    expect(info).toContain('["status", "capabilities"]')
    expect(info).not.toMatch(/providers|models|agents|limits|usage/)
  })

  test("capability broker advertises only the fixed live OpenFork and external-MCP namespaces", async () => {
    const text = await fs.readFile(path.resolve(import.meta.dir, "../../src/oxp/capability.ts"), "utf8")
    const params = text.slice(text.indexOf("export const Parameters"), text.indexOf("export type Input"))
    expect(params).toContain('Schema.Literals(["openfork", "mcp"])')
    expect(params).not.toContain('"integration"')
  })

  test("OXP is not mounted into the generic OpenFork HTTP route tree", async () => {
    const serverRoot = path.resolve(import.meta.dir, "../../src/server")
    const files = [
      "server.ts",
      "routes/instance/httpapi/server.ts",
      "routes/instance/httpapi/api.ts",
    ]
    for (const relative of files) {
      const text = await fs.readFile(path.join(serverRoot, relative), "utf8")
      // Gate P may expose bootstrap-free Core OXP activity inspection through
      // the generic root API. Gate C's boundary is narrower: the dedicated OXP
      // MCP host/transport itself must never be mounted into this route tree.
      expect(text).not.toMatch(/from ["']@\/oxp\//)
      expect(text).not.toContain("OxpServer")
      expect(text).not.toContain("OxpHost")
    }
  })
})
