import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { LEGACY_USER_DATA_NAMES, USER_DATA_NAMES, migrateLegacyUserData } from "./user-data"

describe("OpenFork desktop user data", () => {
  test("uses OpenFork-owned app data names", () => {
    expect(USER_DATA_NAMES).toEqual({
      dev: "ai.openfork.desktop.dev",
      beta: "ai.openfork.desktop.beta",
      prod: "ai.openfork.desktop",
    })
  })

  test("imports legacy desktop state once without mutating OpenCode or overwriting current state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfork-desktop-user-data-"))
    try {
      const legacy = path.join(root, LEGACY_USER_DATA_NAMES.dev)
      const current = path.join(root, USER_DATA_NAMES.dev)
      await fs.mkdir(legacy, { recursive: true })
      await fs.mkdir(current, { recursive: true })
      await fs.writeFile(path.join(legacy, "old.json"), "legacy")
      await fs.writeFile(path.join(legacy, "conflict.json"), "legacy")
      await fs.writeFile(path.join(current, "conflict.json"), "openfork")

      expect(await migrateLegacyUserData(root, "dev")).toBe(current)
      expect(await fs.readFile(path.join(current, "old.json"), "utf8")).toBe("legacy")
      expect(await fs.readFile(path.join(current, "conflict.json"), "utf8")).toBe("openfork")
      expect(await fs.readFile(path.join(legacy, "old.json"), "utf8")).toBe("legacy")
      expect(await fs.readFile(path.join(legacy, "conflict.json"), "utf8")).toBe("legacy")

      await fs.writeFile(path.join(legacy, "late.json"), "do-not-import-later")
      expect(await migrateLegacyUserData(root, "dev")).toBe(current)
      await expect(fs.stat(path.join(current, "late.json"))).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
