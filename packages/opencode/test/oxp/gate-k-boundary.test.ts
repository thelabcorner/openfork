import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { OxpSurface } from "@/oxp/surface"

const source = path.resolve(import.meta.dir, "../../src")

describe("OXP Gate K architecture boundary", () => {
  test("reuses native MCP.Service through one lazy location-scoped adapter", async () => {
    const [control, adapter, domain] = await Promise.all([
      fs.readFile(path.join(source, "oxp/mcp-control.ts"), "utf8"),
      fs.readFile(path.join(source, "oxp/mcp-control-v1.ts"), "utf8"),
      fs.readFile(path.join(source, "oxp/mcp.ts"), "utf8"),
    ])

    expect(control).not.toMatch(
      /@modelcontextprotocol|@\/mcp|InstanceStore|AppRuntime/,
    )
    expect(adapter).toContain('import("@/mcp")')
    expect(adapter).toContain("runtime.MCP.Service")
    expect(adapter).toContain("OxpRuntimeV1.enter")
    expect(adapter).not.toMatch(
      /import\s+\{[^}]*MCP[^}]*\}\s+from\s+["']@\/mcp["']/,
    )
    expect(domain).not.toMatch(
      /@modelcontextprotocol|@\/mcp|InstanceStore|AppRuntime|Client\(/,
    )
  })

  test("keeps exact MCP server/tool identity at the native owner rather than reconstructing flattened keys", async () => {
    const native = await fs.readFile(path.join(source, "mcp/index.ts"), "utf8")
    const domain = await fs.readFile(path.join(source, "oxp/mcp.ts"), "utf8")

    expect(native).toContain("exactTools")
    expect(native).toContain("invokeTool")
    expect(native).toContain("server: clientName")
    expect(domain).not.toMatch(/McpCatalog\.sanitize|toolName\(/)
  })

  test("does not expose MCP prompts/resources or add another top-level tool", async () => {
    const control = await fs.readFile(
      path.join(source, "oxp/mcp-control.ts"),
      "utf8",
    )
    const domain = await fs.readFile(path.join(source, "oxp/mcp.ts"), "utf8")

    expect(control).not.toMatch(/prompts|resources|readResource|getPrompt/)
    expect(domain).not.toMatch(/readResource|getPrompt|resourceTemplates/)
    expect(OxpSurface.TOOLS.map((tool) => tool.name)).not.toContain(
      "openfork_mcp",
    )
    expect(OxpSurface.TOOLS.map((tool) => tool.name)).toContain("capability")
  })

  test("routes dynamic MCP through the fixed capability namespace and integrations authority", async () => {
    const [capability, authority] = await Promise.all([
      fs.readFile(path.join(source, "oxp/capability.ts"), "utf8"),
      fs.readFile(path.join(source, "oxp/authority.ts"), "utf8"),
    ])

    expect(capability).toContain('Schema.Literals(["openfork", "mcp"])')
    expect(capability).toContain('namespace === "mcp"')
    expect(capability).toContain("mcp.describe")
    expect(capability).toContain("mcp.call")
    expect(authority).toContain('operation.startsWith("integration.")')
  })

  test("contains no retry loop in the OXP external-MCP call path", async () => {
    const [domain, adapter] = await Promise.all([
      fs.readFile(path.join(source, "oxp/mcp.ts"), "utf8"),
      fs.readFile(path.join(source, "oxp/mcp-control-v1.ts"), "utf8"),
    ])

    expect(domain).not.toMatch(
      /Effect\.retry|while\s*\(|for\s*\([^)]*attempt/i,
    )
    expect(adapter).not.toMatch(
      /Effect\.retry|while\s*\(|for\s*\([^)]*attempt/i,
    )
    expect(domain).toContain("OxpError.AmbiguousExternalResult")
    expect(domain).toContain("declaredReadOnlyHint")
    expect(domain).not.toMatch(/if\s*\([^)]*readOnlyHint[^)]*\)/)
  })
})
