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
    expect(text).toMatch(/Upstream may reject model-authored authentication before OXP/i)
    expect(text).toMatch(/purpose-specific tools/i)
    expect(text).toMatch(/Do not route authenticated work through this generic broker/i)
    expect(text).toMatch(/trusted OpenAI connection/i)
    expect(text).not.toMatch(/credentialRef|stored-credential HTTPS/i)
  })

  test("model-facing mutation routing prefers typed file tools while keeping process unrestricted", () => {
    expect(OxpSurface.SERVER_INSTRUCTIONS).toMatch(/write creates\/replaces whole files/i)
    expect(OxpSurface.SERVER_INSTRUCTIONS).toMatch(/edit handles surgical changes/i)
    expect(OxpSurface.SERVER_INSTRUCTIONS).toMatch(/self-heal through atomic write semantics/i)
    expect(OxpSurface.SERVER_INSTRUCTIONS).toMatch(/process remains general-purpose/i)

    const edit = OxpSurface.TOOLS.find((item) => item.name === "edit")
    const write = OxpSurface.TOOLS.find((item) => item.name === "write")
    const process = OxpSurface.TOOLS.find((item) => item.name === "process")
    const session = OxpSurface.TOOLS.find((item) => item.name === "openfork_session")
    expect(edit).toMatchObject({ title: "Edit workspace text" })
    expect(edit?.description).toMatch(/For create\/full-replace, pass content here/i)
    expect(edit?.description).toMatch(/self-heal through atomic write/i)
    expect(write).toMatchObject({ title: "Create or replace workspace file" })
    expect(write?.description).toMatch(/Create or fully replace text files atomically/i)
    expect(write?.description).toMatch(/Markdown\/code\/config/i)
    expect(process?.description).toMatch(/process remains unrestricted/i)
    expect(process?.description).toMatch(/opaque handle/i)
    expect(process?.description).toMatch(/never PID/i)
    expect(session?.description).toMatch(/root-scoped search/i)
    expect(session?.description).toMatch(/tool:read term/i)
    expect(session?.description).toMatch(/no hydration/i)
    expect(session?.description).toMatch(/list\/get/i)
    expect(session?.description).toMatch(/send\/turn/i)
    expect(session?.description).toMatch(/todos\/goals/i)
    expect(session?.description).toMatch(/checkpoints/i)
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
    const input = tool!.inputSchema as {
      type?: string
      oneOf?: Array<{
        properties?: Record<string, { const?: unknown }>
        required?: string[]
        additionalProperties?: boolean
      }>
      properties?: Record<string, unknown>
      additionalProperties?: boolean
    }
    const schema = JSON.stringify(input)
    expect(schema).toContain('"list"')
    expect(schema).toContain('"upload"')
    expect(schema).not.toMatch(
      /credential|secret|token|authorization|header|origin|apiKey/i,
    )
    expect(input.type).toBe("object")
    expect(input.additionalProperties).toBe(false)
    const actions = input.oneOf ?? []
    expect(actions).toHaveLength(4)
    const list = actions.find((branch) => branch.properties?.action?.const === "list")
    expect(list?.required).toEqual(["action"])
    expect(list?.properties).toHaveProperty("limit")
    expect(list?.properties).not.toHaveProperty("rootID")
    expect(list?.properties).not.toHaveProperty("path")
    const get = actions.find((branch) => branch.properties?.action?.const === "get")
    expect(get?.required).toEqual(["action", "fileID"])
    expect(get?.properties).not.toHaveProperty("path")
    const upload = actions.find((branch) => branch.properties?.action?.const === "upload")
    expect(upload?.required).toEqual(["action", "rootID", "path"])
    expect(upload?.properties).not.toHaveProperty("fileID")
    const download = actions.find((branch) => branch.properties?.action?.const === "download")
    expect(download?.required).toEqual(["action", "rootID", "path", "fileID"])
    for (const branch of actions) expect(branch.additionalProperties).toBe(false)
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

  test("projects read/edit/find as constrained envelopes and process as a compatibility-safe flat envelope", () => {
    type Branch = {
      properties?: Record<string, { enum?: unknown[]; minimum?: number; maximum?: number; const?: unknown }>
      required?: string[]
      anyOf?: Array<{ required?: string[] }>
      additionalProperties?: boolean
    }

    const edit = OxpSurface.TOOLS.find((item) => item.name === "edit")
    expect(edit).toBeDefined()
    const editSchema = edit!.inputSchema as {
      type?: string
      anyOf?: unknown[]
      oneOf?: Branch[]
      properties?: Record<string, unknown>
      required?: string[]
      additionalProperties?: boolean
    }
    expect(editSchema.type).toBe("object")
    expect(editSchema.anyOf).toBeUndefined()
    expect(editSchema.required).toEqual(["path"])
    expect(editSchema.additionalProperties).toBe(false)
    for (const field of [
      "path",
      "rootID",
      "content",
      "oldString",
      "newString",
      "replaceAll",
      "edits",
      "line",
      "startLine",
      "endLine",
      "oldText",
      "newText",
      "delete",
      "insertAt",
      "insertAfter",
      "appendFile",
      "nearText",
      "occurrence",
    ]) {
      expect(editSchema.properties).toHaveProperty(field)
    }
    const editBranches = editSchema.oneOf ?? []
    expect(editBranches).toHaveLength(11)
    const content = editBranches.find((branch) => branch.required?.includes("content"))
    expect(content?.required).toEqual(["path", "content"])
    expect(content?.properties).not.toHaveProperty("oldString")
    const exact = editBranches.find((branch) => branch.required?.includes("oldString"))
    expect(exact?.required).toEqual(["path", "oldString", "newString"])
    expect(exact?.properties).not.toHaveProperty("line")
    const prepend = editBranches.find(
      (branch) => branch.required?.includes("insertAt") && branch.properties?.insertAt?.const === 0,
    )
    expect(prepend?.properties).not.toHaveProperty("oldText")
    const insertAt = editBranches.find(
      (branch) => branch.required?.includes("insertAt") && branch.properties?.insertAt?.minimum === 1,
    )
    expect(insertAt?.required).toContain("oldText")

    const process = OxpSurface.TOOLS.find((item) => item.name === "process")
    expect(process).toBeDefined()
    const processSchema = process!.inputSchema as {
      type?: string
      anyOf?: unknown[]
      oneOf?: Branch[]
      properties?: Record<string, { enum?: unknown[] }>
      required?: string[]
      additionalProperties?: boolean
    }
    expect(processSchema.type).toBe("object")
    expect(processSchema.anyOf).toBeUndefined()
    expect(processSchema.required).toEqual(["action"])
    expect(processSchema.additionalProperties).toBe(false)
    expect(processSchema.properties?.action?.enum).toEqual(["start", "list", "status", "poll", "write", "wait", "kill", "remove"])
    expect(processSchema.properties).toHaveProperty("rootID")
    expect(processSchema.properties).toHaveProperty("workdir")
    expect(processSchema.properties).toHaveProperty("argv")
    expect(processSchema.properties).toHaveProperty("command")
    expect(processSchema.properties).toHaveProperty("shell")
    expect(processSchema.properties).toHaveProperty("handle")
    expect(processSchema.properties).toHaveProperty("chars")
    expect(processSchema.properties).toHaveProperty("timeoutMs")
    expect(processSchema.properties).toHaveProperty("offset")
    expect(processSchema.properties).toHaveProperty("maxBytes")

    // Process deliberately has no conditional oneOf grammar. ChatGPT has
    // historically dropped those constraints while retaining the flat fields,
    // which made host-valid calls fail at runtime. The flat envelope is the
    // compatibility contract; OXP canonicalizes action-local semantics itself.
    expect(processSchema.oneOf).toBeUndefined()
    const find = OxpSurface.TOOLS.find((item) => item.name === "find")
    expect(find).toBeDefined()
    const findSchema = find!.inputSchema as {
      type?: string
      anyOf?: unknown[]
      oneOf?: Branch[]
      properties?: Record<string, unknown>
      additionalProperties?: boolean
    }
    expect(findSchema.type).toBe("object")
    expect(findSchema.anyOf).toBeUndefined()
    expect(findSchema.additionalProperties).toBe(false)
    expect(findSchema.properties).toHaveProperty("path")
    expect(findSchema.properties).toHaveProperty("rootID")
    expect(findSchema.properties).toHaveProperty("glob")
    expect(findSchema.properties).toHaveProperty("grep")
    expect(findSchema.properties).toHaveProperty("include")
    expect(findSchema.properties).toHaveProperty("syntax")
    expect(findSchema.properties).toHaveProperty("offset")
    expect(findSchema.properties).toHaveProperty("limit")
    const findBranches = findSchema.oneOf ?? []
    expect(findBranches).toHaveLength(2)
    const glob = findBranches.find((branch) => branch.required?.includes("glob"))
    const grep = findBranches.find((branch) => branch.required?.includes("grep"))
    expect(glob?.properties).not.toHaveProperty("grep")
    expect(glob?.properties).not.toHaveProperty("include")
    expect(glob?.anyOf?.map((item) => item.required)).toEqual([["rootID"], ["path"]])
    expect(grep?.properties).toHaveProperty("glob")
    expect(grep?.properties).toHaveProperty("include")
    expect(grep?.properties).toHaveProperty("syntax")
    expect(grep?.properties).toHaveProperty("offset")
    expect(grep?.properties).toHaveProperty("limit")

    const read = OxpSurface.TOOLS.find((item) => item.name === "read")
    expect(read).toBeDefined()
    const readSchema = read!.inputSchema as {
      type?: string
      oneOf?: Branch[]
      properties?: Record<string, { minimum?: number; maximum?: number; minItems?: number; maxItems?: number }>
      additionalProperties?: boolean
    }
    expect(readSchema.type).toBe("object")
    expect(readSchema.additionalProperties).toBe(false)
    expect(readSchema.properties?.offset?.minimum).toBe(1)
    expect(readSchema.properties?.offset?.maximum).toBe(10_000_000)
    expect(readSchema.properties?.limit?.minimum).toBe(1)
    expect(readSchema.properties?.limit?.maximum).toBe(10_000)
    expect(readSchema.properties?.reads?.minItems).toBe(1)
    expect(readSchema.properties?.reads?.maxItems).toBe(8)
    const readBranches = readSchema.oneOf ?? []
    expect(readBranches).toHaveLength(2)
    const singleRead = readBranches.find((branch) => branch.required?.includes("path"))
    const batchRead = readBranches.find((branch) => branch.required?.includes("reads"))
    expect(singleRead?.properties?.action?.enum).toEqual(["read", "tail"])
    expect(singleRead?.properties).toHaveProperty("offset")
    expect(batchRead?.properties?.action?.const).toBe("read")
    expect(batchRead?.properties).not.toHaveProperty("path")
    expect(batchRead?.properties).not.toHaveProperty("offset")
    expect(batchRead?.properties).not.toHaveProperty("limit")

    const git = OxpSurface.TOOLS.find((item) => item.name === "git")
    expect(git).toBeDefined()
    const gitSchema = git!.inputSchema as {
      type?: string
      oneOf?: Branch[]
      properties?: Record<string, unknown>
      required?: string[]
      additionalProperties?: boolean
    }
    expect(gitSchema.type).toBe("object")
    expect(gitSchema.required).toEqual(["rootID"])
    expect(gitSchema.additionalProperties).toBe(false)
    const gitBranches = gitSchema.oneOf ?? []
    expect(gitBranches).toHaveLength(11)
    const status = gitBranches.find((branch) => branch.properties?.mode?.const === "status")
    expect(status?.required).toEqual(["rootID"])
    expect(status?.properties).toHaveProperty("paths")
    expect(status?.properties).not.toHaveProperty("message")
    const show = gitBranches.find((branch) => branch.properties?.mode?.const === "show")
    expect(show?.required).toEqual(["rootID", "mode", "ref"])
    const commit = gitBranches.find((branch) => branch.properties?.mode?.const === "commit")
    expect(commit?.required).toEqual(["rootID", "mode", "message"])
    expect(commit?.properties).not.toHaveProperty("paths")
    const shell = gitBranches.find((branch) => branch.properties?.mode?.const === "shell")
    expect(shell?.required).toEqual(["rootID", "mode", "argv"])
    expect(shell?.properties).not.toHaveProperty("message")
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
      /LayerNode\.group\(\[\s*CrossSpawnSpawner\.node,\s*OxpConfig\.node,\s*OxpRoot\.node,\s*OxpAgentCatalog\.node,\s*OxpModelCatalog\.node,\s*OxpServer\.node,\s*\]\)/,
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
