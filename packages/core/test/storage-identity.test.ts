import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  DATABASE_BASENAME,
  LEGACY_IMPORT_MARKER_FILENAME,
  RUNTIME_LOCK_DIRNAME,
  STORAGE_NAMESPACE,
  migrateLegacyDatabaseNames,
  migrateLegacyStorageDirectory,
  migratedDatabaseFilename,
} from "@opencode-ai/core/storage-identity"

async function temporary() {
  return fs.mkdtemp(path.join(os.tmpdir(), "openfork-storage-test-"))
}

describe("OpenFork storage identity", () => {
  test("owns its filesystem and database names", () => {
    expect(STORAGE_NAMESPACE).toBe("openfork")
    expect(DATABASE_BASENAME).toBe("openfork.db")
    expect(RUNTIME_LOCK_DIRNAME).toBe(".openfork-runtime-locks")
    expect(migratedDatabaseFilename("opencode.db")).toBe("openfork.db")
    expect(migratedDatabaseFilename("opencode-main.db-wal")).toBe("openfork-main.db-wal")
    expect(migratedDatabaseFilename("opencode-dev.db.pre-123")).toBe("openfork-dev.db.pre-123")
    expect(migratedDatabaseFilename("other.db")).toBeUndefined()
  })

  test("imports a legacy root once without mutating OpenCode or overwriting OpenFork-owned files", async () => {
    const root = await temporary()
    try {
      const legacy = path.join(root, "opencode")
      const current = path.join(root, "openfork")
      await fs.mkdir(path.join(legacy, "nested"), { recursive: true })
      await fs.mkdir(current, { recursive: true })
      await fs.writeFile(path.join(legacy, "auth.json"), "legacy-auth")
      await fs.writeFile(path.join(legacy, "nested", "moved.txt"), "moved")
      await fs.writeFile(path.join(legacy, "conflict.txt"), "legacy")
      await fs.writeFile(path.join(current, "conflict.txt"), "openfork")

      await migrateLegacyStorageDirectory(legacy, current)

      expect(await fs.readFile(path.join(current, "auth.json"), "utf8")).toBe("legacy-auth")
      expect(await fs.readFile(path.join(current, "nested", "moved.txt"), "utf8")).toBe("moved")
      expect(await fs.readFile(path.join(current, "conflict.txt"), "utf8")).toBe("openfork")
      expect(await fs.readFile(path.join(legacy, "auth.json"), "utf8")).toBe("legacy-auth")
      expect(await fs.readFile(path.join(legacy, "nested", "moved.txt"), "utf8")).toBe("moved")
      expect(await fs.readFile(path.join(legacy, "conflict.txt"), "utf8")).toBe("legacy")
      expect(await fs.stat(path.join(current, LEGACY_IMPORT_MARKER_FILENAME))).toBeDefined()

      await fs.writeFile(path.join(legacy, "late.json"), "do-not-import-later")
      await migrateLegacyStorageDirectory(legacy, current)
      await expect(fs.stat(path.join(current, "late.json"))).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("renames legacy database files after the data-root migration", async () => {
    const root = await temporary()
    try {
      await fs.writeFile(path.join(root, "opencode.db"), "db")
      await fs.writeFile(path.join(root, "opencode-main.db-wal"), "wal")
      await fs.writeFile(path.join(root, "unrelated.db"), "other")

      await migrateLegacyDatabaseNames(root)

      expect(await fs.readFile(path.join(root, "openfork.db"), "utf8")).toBe("db")
      expect(await fs.readFile(path.join(root, "openfork-main.db-wal"), "utf8")).toBe("wal")
      expect(await fs.readFile(path.join(root, "unrelated.db"), "utf8")).toBe("other")
      await expect(fs.stat(path.join(root, "opencode.db"))).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
