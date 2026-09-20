import { createHash, randomUUID } from "crypto"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { expect, test } from "bun:test"

const root = path.resolve(import.meta.dirname, "../../..")
const core = path.join(root, "packages/core")
const transactionRoot = path.join(root, "tmp/core-migration-generator-transactions")

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const exists = (value: string) => fs.stat(value).then(
  () => true,
  () => false,
)

test("migration generator recovers a partially committed output transaction", async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "openfork-migration-recovery-"))
  const stage = path.join(root, "tmp", `.migration-recovery-stage-${randomUUID()}`)
  const transaction = path.join(transactionRoot, `test-${randomUUID()}`)

  const first = path.join(scratch, "first.txt")
  const second = path.join(scratch, "second.txt")
  const created = path.join(scratch, "created.txt")
  const firstOld = "first:old"
  const firstNew = "first:new"
  const secondOld = "second:old"
  const secondNew = "second:new"
  const createdNew = "created:new"

  try {
    await fs.mkdir(transactionRoot, { recursive: true })
    await fs.mkdir(stage, { recursive: true })
    await fs.writeFile(first, firstNew)
    await fs.writeFile(second, secondOld)
    await fs.writeFile(created, createdNew)

    const entries = [
      {
        target: first,
        staged: path.join(stage, "0.new"),
        backup: path.join(stage, "0.old"),
        oldExists: true,
        oldHash: hash(firstOld),
        newHash: hash(firstNew),
      },
      {
        target: second,
        staged: path.join(stage, "1.new"),
        backup: path.join(stage, "1.old"),
        oldExists: true,
        oldHash: hash(secondOld),
        newHash: hash(secondNew),
      },
      {
        target: created,
        staged: path.join(stage, "2.new"),
        backup: path.join(stage, "2.old"),
        oldExists: false,
        oldHash: null,
        newHash: hash(createdNew),
      },
    ]

    await fs.writeFile(entries[0]!.backup, firstOld)
    await fs.writeFile(entries[0]!.staged, firstNew)
    await fs.writeFile(entries[1]!.backup, secondOld)
    await fs.writeFile(entries[1]!.staged, secondNew)
    await fs.writeFile(entries[2]!.staged, createdNew)

    // Construct the recovery record off to the side, then publish the directory
    // atomically so another generator process cannot observe a half-written
    // transaction. Paths in the manifest must point at the published directory.
    const publishedEntries = entries.map((entry) => ({
      ...entry,
      staged: path.join(transaction, path.basename(entry.staged)),
      backup: path.join(transaction, path.basename(entry.backup)),
    }))
    await fs.writeFile(
      path.join(stage, "manifest.json"),
      JSON.stringify({ version: 1, entries: publishedEntries }, null, 2),
    )
    await fs.rename(stage, transaction)

    const process = Bun.spawn(["bun", "script/migration.ts", "--check"], {
      cwd: core,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ])

    // Recovery happens before the selected generator action. The repository can
    // legitimately become schema-dirty while this black-box test is running
    // (especially in multi-agent development), so do not couple recovery to the
    // later --check result. A recovery failure itself must still be observable.
    if (exitCode !== 0) expect(stderr).not.toContain("Refusing to recover migration generation transaction")
    expect(await Bun.file(first).text()).toBe(firstOld)
    expect(await Bun.file(second).text()).toBe(secondOld)
    expect(await Bun.file(created).exists()).toBe(false)
    expect(await exists(transaction)).toBe(false)
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined)
    await fs.rm(transaction, { recursive: true, force: true }).catch(() => undefined)
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}, 30_000)

test("migration generator refuses crash recovery over an external edit", async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "openfork-migration-recovery-external-"))
  const stage = path.join(root, "tmp", `.migration-recovery-external-stage-${randomUUID()}`)
  const transaction = path.join(transactionRoot, `test-external-${randomUUID()}`)
  const target = path.join(scratch, "target.txt")
  const oldValue = "target:old"
  const generatedValue = "target:generated"
  const externalValue = "target:external-editor"

  try {
    await fs.mkdir(transactionRoot, { recursive: true })
    await fs.mkdir(stage, { recursive: true })
    await fs.writeFile(target, externalValue)
    await fs.writeFile(path.join(stage, "0.old"), oldValue)
    await fs.writeFile(path.join(stage, "0.new"), generatedValue)

    const published = {
      target,
      staged: path.join(transaction, "0.new"),
      backup: path.join(transaction, "0.old"),
      oldExists: true,
      oldHash: hash(oldValue),
      newHash: hash(generatedValue),
    }
    await fs.writeFile(
      path.join(stage, "manifest.json"),
      JSON.stringify({ version: 1, entries: [published] }, null, 2),
    )
    await fs.rename(stage, transaction)

    const process = Bun.spawn(["bun", "script/migration.ts", "--check"], {
      cwd: core,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ])

    expect(exitCode).not.toBe(0)
    expect(stderr).toContain("Refusing to recover migration generation transaction")
    // Recovery must never turn a third-party edit back into either side of the
    // generator transaction. Retain both the edit and recovery evidence so a
    // human/agent can reconcile them deliberately.
    expect(await Bun.file(target).text()).toBe(externalValue)
    expect(await exists(transaction)).toBe(true)
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined)
    await fs.rm(transaction, { recursive: true, force: true }).catch(() => undefined)
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}, 30_000)
