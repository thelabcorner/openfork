import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"

const sources = [
  path.resolve(import.meta.dir, "../../src/oxp/capability.ts"),
  path.resolve(import.meta.dir, "../../src/oxp/find.ts"),
  path.resolve(import.meta.dir, "../../src/oxp/grounding.ts"),
  path.resolve(import.meta.dir, "../../src/oxp/model-selection.ts"),
  path.resolve(import.meta.dir, "../../src/oxp/project.ts"),
  path.resolve(import.meta.dir, "../../src/oxp/read.ts"),
  path.resolve(import.meta.dir, "../../src/project/inspection.ts"),
  path.resolve(import.meta.dir, "../../src/read/filesystem.ts"),
]

describe("OXP Gate B read-only boundary", () => {
  test("does not depend on Session, Tool.Context, provider, plugin, MCP, HTTP, or workspace runtime owners", async () => {
    const forbidden = [
      /InstanceState/,
      /@\/session\//,
      /@\/provider\//,
      /@\/agent\//,
      /@\/plugin(?:\/|\")/,
      /workbuddy/i,
      /@\/mcp(?:\/|\")/,
      /Tool\.Context/,
      /ToolRegistry/,
      /node:http/,
      /from ["']electron(?:["'/]|$)/,
    ]
    for (const source of sources) {
      const text = await fs.readFile(source, "utf8")
      for (const pattern of forbidden) expect(text).not.toMatch(pattern)
    }
  })

  test("has one owner for provider-account model-id lowering", async () => {
    const oxpDir = path.resolve(import.meta.dir, "../../src/oxp")
    const files = (await fs.readdir(oxpDir)).filter((name) => name.endsWith(".ts"))
    for (const file of files) {
      if (file === "model-selection.ts") continue
      const text = await fs.readFile(path.join(oxpDir, file), "utf8")
      expect(text).not.toMatch(/model-select\/account-identity/)
      expect(text).not.toMatch(/joinAccountModelID|splitModelIDForProvider/)
    }
  })
})
