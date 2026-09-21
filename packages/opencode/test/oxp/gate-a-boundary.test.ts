import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"

const source = path.resolve(import.meta.dir, "../../src/oxp")
const gateAFiles = ["authority.ts", "config.ts", "context.ts", "error.ts", "result.ts", "root.ts", "schema.ts"]

describe("OXP Gate A architecture boundary", () => {
  test("retains the complete no-runtime Gate A production surface as later gates add siblings", async () => {
    const actual = (await fs.readdir(source)).filter((name) => name.endsWith(".ts")).sort()
    expect(actual.filter((name) => gateAFiles.includes(name))).toEqual(gateAFiles)
  })

  test("does not import runtime, Session, provider, MCP-server, HTTP, Electron, or workspace owners", async () => {
    const forbidden = [
      /InstanceState/,
      /@\/project\//,
      /@\/session\//,
      /@\/provider\//,
      /@\/agent\//,
      /@\/mcp(?:\/|\")/,
      /@\/lsp\//,
      /@\/snapshot\//,
      /ToolRegistry/,
      /electron/,
      /node:http/,
      /node:net/,
      /HttpApi/,
      /ServerApi/,
    ]

    for (const file of gateAFiles) {
      const text = await fs.readFile(path.join(source, file), "utf8")
      for (const pattern of forbidden) expect(text).not.toMatch(pattern)
    }
  })

  test("keeps post-Gate-C production exposure behind the explicit package composition boundary", async () => {
    const packageRoot = path.resolve(source, "..")
    const queue = [packageRoot]
    const consumers: string[] = []
    while (queue.length) {
      const directory = queue.pop()!
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.name === "oxp") continue
        const target = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          queue.push(target)
          continue
        }
        if (!entry.isFile() || !entry.name.endsWith(".ts")) continue
        const text = await fs.readFile(target, "utf8")
        if (/from ["'][^"']*\/oxp\//.test(text)) consumers.push(path.relative(packageRoot, target))
      }
    }
    // Gate C/D intentionally exports the OXP host through node.ts for the
    // privileged desktop sidecar. Gate A still must not leak into arbitrary
    // Session/provider/runtime modules as later gates grow around it.
    expect(consumers).toEqual(["node.ts"])
  })
})
