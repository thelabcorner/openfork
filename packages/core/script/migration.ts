#!/usr/bin/env bun

import { $ } from "bun"
import { createHash, randomUUID } from "crypto"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { parseArgs } from "util"
import { Flock } from "../src/util/flock"

const root = path.resolve(import.meta.dirname, "../../..")
const snapshot = path.join(root, "packages/core/schema.json")
const tsDir = path.join(root, "packages/core/src/database/migration")
const registry = path.join(root, "packages/core/src/database/migration.gen.ts")
const schema = path.join(root, "packages/core/src/database/schema.gen.ts")
const transactionRoot = path.join(root, "tmp/core-migration-generator-transactions")
const args = parseArgs({
  args: process.argv.slice(2),
  options: {
    check: { type: "boolean" },
    adopt: { type: "boolean" },
    name: { type: "string" },
  },
})

if (args.values.check && args.values.adopt) throw new Error("--check and --adopt are mutually exclusive")

const action = args.values.check ? check : args.values.adopt ? adopt : generate
await Flock.withLock(`core-migration-generator:${root}`, async () => {
  await recoverGenerationTransactions()
  await action()
}, {
  dir: path.join(os.tmpdir(), "openfork-core-migration-locks"),
  staleMs: 5 * 60_000,
  timeoutMs: 5 * 60_000,
  baseDelayMs: 50,
  maxDelayMs: 1_000,
})

async function generate() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-core-migration-"))
  const incremental = path.join(temporary, "incremental")
  const full = path.join(temporary, "full")
  const before = await sourceFingerprint()
  try {
    await fs.mkdir(incremental)
    await fs.mkdir(path.join(incremental, "baseline"))
    await fs.copyFile(snapshot, path.join(incremental, "baseline/snapshot.json"))
    await drizzle(temporary, incremental, args.values.name)

    const generated = await generatedMigrations(incremental)
    if (generated.length > 1) throw new Error(`Expected one generated migration, found ${generated.length}.`)
    const name = generated[0]
    const outputs = new Map<string, string>()
    const sourceOverrides = new Map<string, string>()
    let pendingSql: string | undefined
    let pendingSnapshot: string | undefined
    if (name) {
      const target = path.join(tsDir, `${name}.ts`)
      if (await Bun.file(target).exists()) throw new Error(`Database migration already exists: ${name}`)
      pendingSql = await Bun.file(path.join(incremental, name, "migration.sql")).text()
      pendingSnapshot = await Bun.file(path.join(incremental, name, "snapshot.json")).text()
      const overlaps = await alreadyTrackedCreates(pendingSql)
      if (overlaps.length > 0) {
        throw new Error(
          `Refusing to generate duplicate schema objects already owned by tracked migrations: ${overlaps.join(", ")}. ` +
            "If those migrations intentionally predate the Drizzle snapshot, run `bun script/migration.ts --adopt` after review.",
        )
      }
      const migrationSource = await formatTypescript(renderMigration(name, pendingSql))
      outputs.set(target, migrationSource)
      sourceOverrides.set(name, migrationSource)
      outputs.set(snapshot, pendingSnapshot)
    }

    await fs.mkdir(full)
    await drizzle(temporary, full, "schema")
    outputs.set(schema, await formatTypescript(renderSchema(await generatedSql(full))))
    const migrationNames = await typescriptMigrations()
    if (name) migrationNames.push(name)
    migrationNames.sort()
    outputs.set(
      registry,
      await formatTypescript(await renderRegistry([...new Set(migrationNames)], sourceOverrides)),
    )

    if ((await sourceFingerprint()) !== before) {
      throw new Error(
        "Core database schema or migration inputs changed while generation was running. No generated files were written; retry against the new repository state.",
      )
    }
    await commitGeneration(outputs, before)
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

async function adopt() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-core-migration-adopt-"))
  const incremental = path.join(temporary, "incremental")
  const full = path.join(temporary, "full")
  const before = await sourceFingerprint()
  try {
    await fs.mkdir(incremental)
    await fs.mkdir(path.join(incremental, "baseline"))
    await fs.copyFile(snapshot, path.join(incremental, "baseline/snapshot.json"))
    await drizzle(temporary, incremental, "adopt")

    const generated = await generatedMigrations(incremental)
    if (generated.length > 1) throw new Error(`Expected one generated migration, found ${generated.length}.`)
    const name = generated[0]
    const outputs = new Map<string, string>()
    if (name) {
      const sql = await Bun.file(path.join(incremental, name, "migration.sql")).text()
      const statements = migrationStatements(sql)
      const unsupported = statements.filter((statement) => !/^CREATE\s+/i.test(statement))
      if (unsupported.length > 0) {
        throw new Error(
          "--adopt only accepts already-tracked CREATE drift; pending ALTER/DROP/data changes require a real migration: " +
            unsupported.map((statement) => statement.split(/\s+/).slice(0, 8).join(" ")).join(" | "),
        )
      }

      const creates = createObjects(sql)
      if (creates.length === 0) throw new Error("--adopt found pending SQL but no CREATE objects to verify")
      const tracked = await trackedCreateObjects()
      const missing = creates.filter((object) => !tracked.has(objectKey(object)))
      if (missing.length > 0) {
        throw new Error(
          "Refusing to adopt schema changes without tracked migration ownership: " +
            missing.map((object) => `${object.kind} ${object.name}`).join(", "),
        )
      }

      outputs.set(snapshot, await Bun.file(path.join(incremental, name, "snapshot.json")).text())
      console.log(
        "Adopted already-migrated schema objects into the Drizzle snapshot: " +
          creates.map((object) => `${object.kind} ${object.name}`).join(", "),
      )
    }

    await fs.mkdir(full)
    await drizzle(temporary, full, "schema")
    outputs.set(schema, await formatTypescript(renderSchema(await generatedSql(full))))
    outputs.set(registry, await formatTypescript(await renderRegistry(await typescriptMigrations())))
    if ((await sourceFingerprint()) !== before) {
      throw new Error(
        "Core database schema or migration inputs changed while snapshot adoption was running. No generated files were written; retry against the new repository state.",
      )
    }
    await commitGeneration(outputs, before)
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

async function check() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-core-migration-check-"))
  const incremental = path.join(temporary, "incremental")
  const full = path.join(temporary, "full")
  const before = await sourceFingerprint()
  try {
    await fs.mkdir(incremental)
    await fs.mkdir(path.join(incremental, "baseline"))
    await fs.copyFile(snapshot, path.join(incremental, "baseline/snapshot.json"))
    await drizzle(temporary, incremental)
    if ((await generatedMigrations(incremental)).length > 0) {
      throw new Error(
        "Core schema has ungenerated database migrations. Run `bun script/migration.ts` from packages/core.",
      )
    }

    await fs.mkdir(full)
    await drizzle(temporary, full, "schema")
    if ((await Bun.file(schema).text()) !== (await formatTypescript(renderSchema(await generatedSql(full))))) {
      throw new Error("Current database schema is stale. Run `bun script/migration.ts` from packages/core.")
    }

    const migrations = await typescriptMigrations()
    if ((await Bun.file(registry).text()) !== (await formatTypescript(await renderRegistry(migrations)))) {
      throw new Error("Database migration registry is stale. Run `bun script/migration.ts` from packages/core.")
    }
    if ((await sourceFingerprint()) !== before) {
      throw new Error("Core database schema or migration inputs changed while migration consistency was being checked; retry.")
    }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

async function drizzle(temporary: string, output: string, name?: string) {
  const config = path.join(temporary, `${path.basename(output)}.config.ts`)
  await Bun.write(
    config,
    `import config from ${JSON.stringify(pathToFileURL(path.join(root, "packages/core/drizzle.config.ts")).href)}

export default { ...config, out: ${JSON.stringify(output)} }
`,
  )
  await $`bun drizzle-kit generate --config ${config} ${name ? ["--name", name] : []}`.cwd(
    path.join(root, "packages/core"),
  )
}

async function generatedMigrations(directory: string) {
  return (await Array.fromAsync(new Bun.Glob("*/migration.sql").scan({ cwd: directory })))
    .map((file) => file.split(/[\\/]/)[0])
    .filter((name): name is string => name !== undefined)
    .sort()
}

async function generatedSql(directory: string) {
  const generated = await generatedMigrations(directory)
  if (generated.length !== 1) throw new Error(`Expected one full schema migration, found ${generated.length}.`)
  return Bun.file(path.join(directory, generated[0]!, "migration.sql")).text()
}

async function typescriptMigrations() {
  const names = (await Array.fromAsync(new Bun.Glob("*.ts").scan({ cwd: tsDir })))
    .map((file) => path.basename(file, ".ts"))
    .sort()
  const byTimestamp = new Map<string, string>()
  for (const name of names) {
    const match = /^(\d{14})_.+$/.exec(name)
    if (!match) throw new Error("Invalid database migration filename: " + name)
    const timestamp = match[1]!
    const previous = byTimestamp.get(timestamp)
    if (previous) {
      throw new Error(
        "Duplicate database migration timestamp " +
          timestamp +
          ": " +
          previous +
          " and " +
          name +
          ". Migration timestamps are durable journal identity and must be unique across processes.",
      )
    }
    byTimestamp.set(timestamp, name)
  }
  return names
}

async function sourceFingerprint() {
  const digest = createHash("sha256")
  const files = new Set<string>([
    snapshot,
    path.join(root, "packages/core/drizzle.config.ts"),
    path.join(root, "packages/core/package.json"),
    path.join(root, "packages/core/script/migration.ts"),
    path.join(root, "bun.lock"),
  ])
  const core = path.join(root, "packages/core")
  for (const pattern of ["src/**/*.sql.ts", "src/**/sql.ts", "src/database/migration/*.ts"]) {
    for await (const file of new Bun.Glob(pattern).scan({ cwd: core })) files.add(path.join(core, file))
  }
  for (const file of [...files].sort()) {
    digest.update(path.relative(root, file))
    digest.update("\0")
    digest.update(new Uint8Array(await Bun.file(file).arrayBuffer()))
    digest.update("\0")
  }
  return digest.digest("hex")
}

type CreateObject = {
  kind: "TABLE" | "VIRTUAL TABLE" | "INDEX" | "TRIGGER"
  name: string
}

function migrationStatements(input: string) {
  return input
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}

function createObjects(input: string): CreateObject[] {
  const pattern =
    /CREATE\s+(?:UNIQUE\s+)?(?:(VIRTUAL)\s+)?(TABLE|INDEX|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([A-Za-z0-9_]+)[`"']?/gi
  const result: CreateObject[] = []
  for (const match of input.matchAll(pattern)) {
    const base = match[2]!.toUpperCase() as "TABLE" | "INDEX" | "TRIGGER"
    result.push({
      kind: match[1] ? "VIRTUAL TABLE" : base,
      name: match[3]!,
    })
  }
  return result
}

function objectKey(object: CreateObject) {
  return `${object.kind}:${object.name.toLowerCase()}`
}

async function trackedCreateObjects() {
  const result = new Set<string>()
  for (const migration of await typescriptMigrations()) {
    const source = await Bun.file(path.join(tsDir, `${migration}.ts`)).text()
    for (const object of createObjects(source)) result.add(objectKey(object))
  }
  return result
}

async function alreadyTrackedCreates(sql: string) {
  const tracked = await trackedCreateObjects()
  return createObjects(sql)
    .filter((object) => tracked.has(objectKey(object)))
    .map((object) => `${object.kind} ${object.name}`)
}

async function atomicWrite(target: string, content: string | Uint8Array) {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await Bun.write(temporary, content)
    await fs.rename(temporary, target)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

type GenerationEntry = {
  target: string
  staged: string
  backup: string
  oldExists: boolean
  oldHash: string | null
  newHash: string
}

type GenerationManifest = {
  version: 1
  entries: GenerationEntry[]
}

async function commitGeneration(outputs: Map<string, string>, expectedSourceFingerprint: string) {
  if (outputs.size === 0) return
  await fs.mkdir(transactionRoot, { recursive: true })
  const transaction = path.join(transactionRoot, randomUUID())
  await fs.mkdir(transaction, { recursive: true })
  const entries: GenerationEntry[] = []
  let replacementStarted = false

  try {
    let index = 0
    for (const [target, content] of outputs) {
      const staged = path.join(transaction, `${index}.new`)
      const backup = path.join(transaction, `${index}.old`)
      const oldExists = await Bun.file(target).exists()
      if (oldExists) await fs.copyFile(target, backup)
      await fs.writeFile(staged, content)
      entries.push({
        target,
        staged,
        backup,
        oldExists,
        oldHash: oldExists ? await fileHash(backup) : null,
        newHash: hash(new TextEncoder().encode(content)),
      })
      index += 1
    }

    const manifest: GenerationManifest = { version: 1, entries }
    await atomicWrite(path.join(transaction, "manifest.json"), JSON.stringify(manifest, null, 2))

    // Close the gap between the caller's post-generation fingerprint check and
    // the first replacement. The cross-process generator lease only serializes
    // this script; an editor/agent can still mutate schema inputs independently.
    // Revalidate both the complete input generation and every output preimage
    // immediately before replacement so a stale generation never commits.
    if ((await sourceFingerprint()) !== expectedSourceFingerprint) {
      throw new Error(
        "Core database schema or migration inputs changed immediately before migration output commit. No generated files were written; retry against the new repository state.",
      )
    }
    for (const entry of entries) {
      const state = await generationEntryState(entry)
      // A target may already equal the intended output (the common no-op
      // regeneration case). That is safe and the replacement loop below skips
      // it. Only a third state proves somebody wrote bytes that belong to
      // neither side of this transaction.
      if (state === "unknown") throw new Error(`Migration generation target changed concurrently: ${entry.target}`)
    }

    for (const entry of entries) {
      const state = await generationEntryState(entry)
      if (state === "new") continue
      if (state !== "old") throw new Error(`Migration generation target changed concurrently: ${entry.target}`)
      replacementStarted = true
      await atomicWrite(entry.target, new Uint8Array(await Bun.file(entry.staged).arrayBuffer()))
    }
    await fs.rm(transaction, { recursive: true, force: true })
  } catch (error) {
    if (!replacementStarted) {
      await fs.rm(transaction, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    // If replacement started, restore the complete pre-generation set. This is
    // the in-process half of the transaction protocol; recoverGenerationTransactions
    // performs the same rollback after a crash or forced termination.
    try {
      await restoreGeneration({ version: 1, entries })
      await fs.rm(transaction, { recursive: true, force: true })
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        `Migration generation failed and rollback could not safely complete. Recovery state was retained at ${transaction}.`,
      )
    }
    throw error
  }
}

async function recoverGenerationTransactions() {
  await fs.mkdir(transactionRoot, { recursive: true })
  for (const name of await fs.readdir(transactionRoot)) {
    const transaction = path.join(transactionRoot, name)
    const manifestPath = path.join(transaction, "manifest.json")
    if (!(await Bun.file(manifestPath).exists())) {
      await fs.rm(transaction, { recursive: true, force: true })
      continue
    }
    const manifest = (await Bun.file(manifestPath).json()) as GenerationManifest
    const states = await Promise.all(manifest.entries.map(generationEntryState))
    if (states.some((state) => state === "unknown")) {
      throw new Error(
        `Refusing to recover migration generation transaction ${transaction}: a target changed outside the transaction.`,
      )
    }
    const fullyCommitted = states.every((state) => state === "new")
    if (!fullyCommitted) await restoreGeneration(manifest)
    await fs.rm(transaction, { recursive: true, force: true })
  }
}

async function restoreGeneration(manifest: GenerationManifest) {
  const states = await Promise.all(manifest.entries.map(generationEntryState))
  if (states.some((state) => state === "unknown")) {
    throw new Error("Refusing to roll back migration generation: a target changed outside the transaction")
  }
  for (const entry of manifest.entries) {
    const state = await generationEntryState(entry)
    if (state === "old") continue
    if (state !== "new") {
      throw new Error(`Refusing to roll back migration generation: target changed concurrently: ${entry.target}`)
    }
    if (!entry.oldExists) {
      await fs.rm(entry.target, { force: true })
      continue
    }
    if (!(await Bun.file(entry.backup).exists()) || (await fileHash(entry.backup)) !== entry.oldHash) {
      throw new Error(`Cannot recover migration generation transaction: invalid backup for ${entry.target}`)
    }
    await atomicWrite(entry.target, new Uint8Array(await Bun.file(entry.backup).arrayBuffer()))
  }
}

async function generationEntryState(entry: GenerationEntry): Promise<"old" | "new" | "unknown"> {
  const exists = await Bun.file(entry.target).exists()
  if (!exists) return entry.oldExists ? "unknown" : "old"
  const current = await fileHash(entry.target)
  if (current === entry.newHash) return "new"
  if (entry.oldExists && current === entry.oldHash) return "old"
  return "unknown"
}

function hash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}

async function fileHash(file: string) {
  return hash(new Uint8Array(await Bun.file(file).arrayBuffer()))
}

function renderMigration(name: string, sql: string) {
  return `import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: ${JSON.stringify(name)},
  up(tx) {
    return Effect.gen(function* () {
${renderStatements(sql)}
    })
  },
} satisfies DatabaseMigration.Migration
`
}

function renderSchema(sql: string) {
  return `import { Effect } from "effect"
import type { DatabaseMigration } from "./migration"

export default {
  up(tx) {
    return Effect.gen(function* () {
${renderStatements(sql)}
    })
  },
} satisfies Omit<DatabaseMigration.Migration, "id">
`
}

function renderStatements(sql: string) {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map(renderRun)
    .join("\n")
}

function renderRun(statement: string) {
  const lines = statement.replaceAll("\t", "  ").split("\n")
  if (lines.length === 1) return `      yield* tx.run(\`${escapeTemplate(lines[0])}\`)`
  return `      yield* tx.run(\`\n${lines.map((line) => `        ${escapeTemplate(line)}`).join("\n")}\n      \`)`
}

function escapeTemplate(line: string) {
  return line.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${")
}

async function formatTypescript(input: string) {
  const prettier = await import("prettier")
  const typescript = await import("prettier/plugins/typescript")
  const estree = await import("prettier/plugins/estree")
  return prettier.format(input, {
    parser: "typescript",
    plugins: [typescript.default, estree.default],
    semi: false,
    printWidth: 120,
  })
}

async function renderRegistry(names: string[], sourceOverrides = new Map<string, string>()) {
  const checksums = await Promise.all(
    names.map(async (name) =>
      createHash("sha256")
        .update(sourceOverrides.get(name) ?? (await Bun.file(path.join(tsDir, `${name}.ts`)).text()))
        .digest("hex"),
    ),
  )
  return `import type { DatabaseMigration } from "./migration"

const checksums = ${JSON.stringify(checksums, null, 2)} as const

export const migrations = (
  await Promise.all([
${names.map((name) => `    import("./migration/${name}"),`).join("\n")}
  ])
).map((module, index) => ({
  ...module.default,
  checksum: checksums[index]!,
})) satisfies DatabaseMigration.Migration[]
`
}
