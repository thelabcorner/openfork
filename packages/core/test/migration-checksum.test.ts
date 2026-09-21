import { createHash } from "crypto"
import path from "path"
import { fileURLToPath } from "url"
import { expect, test } from "bun:test"
import { migrations } from "@opencode-ai/core/database/migration.gen"

const migrationDirectory = fileURLToPath(new URL("../src/database/migration/", import.meta.url))

test("generated migration checksums match the exact tracked source bytes", async () => {
  const mismatches: Array<{ id: string; registry: string | undefined; source: string }> = []

  for (const migration of migrations) {
    const source = await Bun.file(path.join(migrationDirectory, `${migration.id}.ts`)).text()
    const checksum = createHash("sha256").update(source).digest("hex")
    if (migration.checksum !== checksum) {
      mismatches.push({ id: migration.id, registry: migration.checksum, source: checksum })
    }
  }

  expect(mismatches).toEqual([])
})
