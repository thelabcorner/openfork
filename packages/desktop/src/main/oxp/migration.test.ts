import { afterEach, describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { findLocalMcpMigrationFile, readLocalMcpMigration, retireLocalMcpConfig } from "./migration"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function fixture(value: unknown) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openfork-oxp-localmcp-"))
  dirs.push(dir)
  const file = path.join(dir, "localmcp-chat.json")
  await fs.writeFile(file, JSON.stringify(value, null, 2))
  return file
}

describe("OXP standalone localMCP migration", () => {
  test("auto-discovers the standalone config from Electron appData without scanning credentials", async () => {
    const appData = await fs.mkdtemp(path.join(os.tmpdir(), "openfork-oxp-appdata-"))
    dirs.push(appData)
    const standalone = path.join(appData, "localMCP-chat")
    await fs.mkdir(standalone, { recursive: true })
    const file = path.join(standalone, "localmcp-chat.json")
    await fs.writeFile(file, JSON.stringify({ roots: [], permissions: {}, tunnel: {}, preferences: {} }))
    await fs.writeFile(path.join(standalone, "secrets.bin"), "must-not-be-inspected")

    expect(await findLocalMcpMigrationFile(appData)).toBe(file)
  })

  test("auto-discovery fails with a manual-import hint when standalone config is absent", async () => {
    const appData = await fs.mkdtemp(path.join(os.tmpdir(), "openfork-oxp-appdata-empty-"))
    dirs.push(appData)
    await expect(findLocalMcpMigrationFile(appData)).rejects.toThrow(/Manual import/)
  })

  test("maps the documented standalone authority and lifecycle semantics without credentials", async () => {
    const file = await fixture({
      connectorName: "localMCP-chat",
      roots: [
        { name: "alpha", path: path.join(os.tmpdir(), "alpha") },
        { name: "beta", path: path.join(os.tmpdir(), "beta") },
      ],
      permissions: {
        read: true,
        write: false,
        shell: true,
        git: false,
        plugins: true,
        filesReceive: true,
        filesSend: true,
      },
      tunnel: { kind: "openai", tunnelId: `tunnel_${"a".repeat(32)}`, binaryPath: "ignored.exe" },
      preferences: { launchAtLogin: true, startHidden: true, autoConnect: true, closeToTray: true },
    })

    const plan = await readLocalMcpMigration(file)
    expect(plan.sidecar.roots.map((root) => root.alias)).toEqual(["alpha", "beta"])
    expect(plan.sidecar.grant).toMatchObject({
      read: true,
      write: false,
      process: true,
      git: false,
      integrations: true,
      browser: false,
      filesReceive: true,
      filesSend: true,
      automation: false,
      sessionSupervision: "none",
      requestSupervision: false,
      delegation: "disabled",
      nestedDelegation: false,
    })
    expect(plan.tunnelID).toBe(`tunnel_${"a".repeat(32)}`)
    expect(plan.lifecycle).toEqual({ launchAtLogin: true, startHidden: true, autoConnect: true, closeToTray: true })
    expect(JSON.stringify(plan)).not.toMatch(/binaryPath|apiKey|secret|token/i)
  })

  test("matches legacy defaults while keeping file egress opt-in", async () => {
    const file = await fixture({ roots: [], permissions: {}, tunnel: {}, preferences: {} })
    const plan = await readLocalMcpMigration(file)
    expect(plan.sidecar.grant).toMatchObject({
      read: true,
      write: true,
      process: true,
      git: true,
      integrations: true,
      filesReceive: true,
      filesSend: false,
    })
    expect(plan.tunnelID).toBeUndefined()
  })

  test("rejects unknown fields rather than copying a possible plaintext secret", async () => {
    const file = await fixture({
      roots: [],
      permissions: {},
      tunnel: {},
      preferences: {},
      openaiApiKey: "plaintext-must-never-migrate",
    })
    await expect(readLocalMcpMigration(file)).rejects.toThrow(/Unsupported localMCP configuration field/)
  })

  test("retirement preserves documented configuration but disables every autonomous startup behavior", async () => {
    const file = await fixture({
      connectorName: "legacy-box",
      roots: [{ name: "repo", path: path.join(os.tmpdir(), "repo") }],
      permissions: { read: true, filesSend: true },
      tunnel: { kind: "openai", tunnelId: `tunnel_${"b".repeat(32)}`, binaryPath: "" },
      preferences: { launchAtLogin: true, startHidden: true, autoConnect: true, closeToTray: true },
    })
    await retireLocalMcpConfig(file)
    const retired = JSON.parse(await fs.readFile(file, "utf8"))
    expect(retired.preferences).toEqual({
      launchAtLogin: false,
      startHidden: false,
      autoConnect: false,
      closeToTray: false,
    })
    expect(retired.roots).toHaveLength(1)
    expect(retired.tunnel.tunnelId).toBe(`tunnel_${"b".repeat(32)}`)
    expect(retired.permissions.filesSend).toBe(true)
  })
})
