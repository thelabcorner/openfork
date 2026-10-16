import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { PluginLoader } from "../../src/plugin/loader"

const temporary: string[] = []

async function packageFixture(name: string, compiled: boolean) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openfork-plugin-runtime-"))
  temporary.push(dir)
  const mod = path.join(dir, "node_modules", name)
  const source = path.join(mod, "src", "index.ts")
  const output = path.join(mod, "dist", "index.js")
  await fs.mkdir(path.dirname(source), { recursive: true })
  if (compiled) await fs.mkdir(path.dirname(output), { recursive: true })

  const json = {
    name,
    type: "module",
    main: "./src/index.ts",
  }
  const pkg = path.join(mod, "package.json")
  await fs.writeFile(pkg, JSON.stringify(json))
  await fs.writeFile(source, "export const source = true\n")
  if (compiled) await fs.writeFile(output, "export const compiled = true\n")

  return {
    source: pathToFileURL(source).href,
    output: pathToFileURL(output).href,
    row: {
      spec: `${name}@1.0.0`,
      options: undefined,
      deprecated: false,
      source: "npm" as const,
      target: mod,
      entry: pathToFileURL(source).href,
      pkg: { dir: mod, pkg, json },
    },
  }
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe("Node npm plugin runtime entry", () => {
  test("uses a package-contained dist fallback for a TypeScript entry", async () => {
    const fixture = await packageFixture("acme-plugin", true)
    const resolved = await PluginLoader.runtimeEntry(fixture.row, true)
    expect(fileURLToPath(resolved).toLowerCase()).toBe((await fs.realpath(fileURLToPath(fixture.output))).toLowerCase())
    expect(await PluginLoader.runtimeEntry(fixture.row, false)).toBe(fixture.source)
  })

  test("fails clearly when only a TypeScript entry is published", async () => {
    const fixture = await packageFixture("source-only-plugin", false)
    await expect(PluginLoader.runtimeEntry(fixture.row, true)).rejects.toThrow(
      /Node runtime cannot execute TypeScript dependencies.*no compiled JavaScript sibling was found/,
    )
  })
})
