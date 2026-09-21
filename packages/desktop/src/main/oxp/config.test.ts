import { afterEach, describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { OxpDesktopConfigStore, isValidTunnelID } from "./config"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function store() {
  const root = path.join(os.tmpdir(), `openfork-oxp-desktop-${randomUUID()}`)
  roots.push(root)
  await fs.mkdir(root, { recursive: true })
  const value = new OxpDesktopConfigStore(root)
  await value.initialize()
  return { root, value }
}

describe("OXP desktop config", () => {
  test("defaults to disabled background behavior and no tunnel identity", async () => {
    const { value } = await store()
    expect(value.get()).toEqual({
      version: 1,
      tunnelID: "",
      lifecycle: { autoConnect: false, launchAtLogin: false, startHidden: false, closeToTray: false },
      migration: {},
    })
  })

  test("persists validated non-secret tunnel and lifecycle settings atomically", async () => {
    const { root, value } = await store()
    const tunnelID = `tunnel_${"a".repeat(32)}`
    await value.setTunnelID(tunnelID)
    await value.setLifecycle({ autoConnect: true, closeToTray: true })
    const reloaded = new OxpDesktopConfigStore(root)
    await reloaded.initialize()
    expect(reloaded.get().tunnelID).toBe(tunnelID)
    expect(reloaded.get().lifecycle.autoConnect).toBe(true)
    expect(reloaded.get().lifecycle.closeToTray).toBe(true)
    expect(JSON.parse(await fs.readFile(path.join(root, "oxp-desktop.json"), "utf8"))).not.toHaveProperty("apiKey")
  })

  test("rejects malformed tunnel identifiers", async () => {
    const { value } = await store()
    expect(isValidTunnelID(`tunnel_${"0".repeat(32)}`)).toBe(true)
    await expect(value.setTunnelID("not-a-tunnel")).rejects.toThrow(/Tunnel ID/)
  })

  test("serializes the full read-modify-write transaction for concurrent settings changes", async () => {
    const { value } = await store()
    const tunnelID = `tunnel_${"b".repeat(32)}`
    await Promise.all([
      value.setTunnelID(tunnelID),
      value.setLifecycle({ autoConnect: true }),
      value.setLifecycle({ closeToTray: true }),
    ])
    expect(value.get()).toEqual({
      version: 1,
      tunnelID,
      lifecycle: { autoConnect: true, launchAtLogin: false, startHidden: false, closeToTray: true },
      migration: {},
    })
  })

  test("persists migration provenance without ever embedding credentials", async () => {
    const { root, value } = await store()
    const sourceFile = path.join(root, "localmcp-chat.json")
    const tunnelID = `tunnel_${"c".repeat(32)}`
    await value.applyLegacyMigration({
      sourceFile,
      tunnelID,
      lifecycle: { autoConnect: true, launchAtLogin: true, startHidden: true, closeToTray: true },
      importedAt: 1234,
    })
    await value.markLegacyRetired(5678)

    const current = value.get()
    expect(current.tunnelID).toBe(tunnelID)
    expect(current.migration).toEqual({ localMcpConfigPath: sourceFile, importedAt: 1234, retiredAt: 5678 })
    const bytes = await fs.readFile(path.join(root, "oxp-desktop.json"), "utf8")
    expect(bytes).not.toMatch(/apiKey|secret|token/i)
  })
})
