import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(root, entry.name)
      if (entry.isDirectory()) return sourceFiles(target)
      return entry.isFile() && entry.name.endsWith(".ts") ? [target] : []
    }),
  )
  return nested.flat()
}

describe("model-tool backend boundary", () => {
  test("runtime/backend source never uses TaskTool or SessionTool as infrastructure", async () => {
    const src = path.resolve(import.meta.dir, "../../src")
    const toolRoot = path.join(src, "tool") + path.sep
    const adapterOnly = new Set(["cli/cmd/run/tool.ts"])
    const violations: string[] = []

    for (const file of await sourceFiles(src)) {
      if (file.startsWith(toolRoot)) continue
      const source = await readFile(file, "utf8")
      const relative = path.relative(src, file).replaceAll(path.sep, "/")
      if (adapterOnly.has(relative)) continue

      for (const match of source.matchAll(/(?:import|export)\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g)) {
        const specifier = match[1]!
        if (/(?:^|\/)tool\/(?:task|session)$/.test(specifier)) {
          violations.push(`${relative}: imports model tool facade ${specifier}`)
        }
      }

      if (/\b(?:TaskTool|SessionTool)\b/.test(source)) {
        violations.push(`${relative}: references model tool facade symbol`)
      }
      if (/registry\.named\(\)[\s\S]{0,120}\btask\b/.test(source)) {
        violations.push(`${relative}: retrieves Task through ToolRegistry.named()`)
      }
    }

    expect(violations).toEqual([])
  })

  test("ToolRegistry internal named handles do not expose Task", async () => {
    const registry = await readFile(new URL("../../src/tool/registry.ts", import.meta.url), "utf8")
    expect(registry).not.toContain("type TaskDef")
    expect(registry).not.toMatch(/readonly named:[^\n]+\btask\b/)
    expect(registry).not.toMatch(/return \{[^}]*\btask\s*:/)
  })
})
