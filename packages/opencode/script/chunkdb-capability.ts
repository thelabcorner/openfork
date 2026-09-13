import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { CHUNKDB_MAX_USER_VERSION } from "@opencode-ai/core/database/chunkdb"

export type ChunkDbCapabilityResult = {
  readonly userVersion: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Prove that a compiled OpenCode executable can actually open the newest
 * ChunkDB representation supported by this source tree.
 *
 * `--version` is not sufficient for release/install validation: it never opens
 * SQLite and therefore cannot catch a stale bundled storage module. The probe
 * uses an isolated temporary database stamped at the maximum supported
 * `user_version`, enables the representation features, disables background
 * maintenance, and runs a DB-backed command through the compiled executable.
 *
 * No user database is opened or mutated by this check.
 */
export async function validateChunkDbCapability(binaryPath: string): Promise<ChunkDbCapabilityResult> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-chunkdb-capability-"))
  const dbPath = path.join(tempDir, "capability.db")

  try {
    const baseEnv = {
      ...process.env,
      OPENCODE_DB: dbPath,
      // Capability validation must never start maintenance work. The only
      // thing under test here is whether this executable can open/read the
      // newest durable representation epoch.
      OPENCODE_SEAL_BACKFILL: "0",
      OPENCODE_SEAL_WORKERS: "0",
      OPENCODE_SEAL_DELTA: "0",
      OPENCODE_SEAL_COMPACT: "0",
      OPENCODE_SEAL_REBUILD: "0",
      OPENCODE_OPCL: "0",
      OPENCODE_SEARCH_INDEX: "0",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    }

    const run = async (env: NodeJS.ProcessEnv) => {
      const child = Bun.spawn(
        [binaryPath, "--pure", "session", "list", "--max-count", "1", "--format", "json"],
        {
          cwd: tempDir,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env,
        },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      return { code, stdout, stderr }
    }

    // First let THIS executable create the normal schema it expects, with
    // ChunkDB disabled. Stamping an otherwise-empty SQLite file is insufficient:
    // fresh-database bootstrap can take a different path than reopening an
    // existing install, which is exactly the scenario this probe must model.
    const bootstrap = await run({
      ...baseEnv,
      OPENCODE_SEAL_ENABLED: "0",
      OPENCODE_SEAL_DEDUP: "0",
    })
    if (bootstrap.code !== 0) {
      throw new Error(
        [
          "Compiled OpenCode failed to bootstrap the isolated ChunkDB capability fixture.",
          `binary: ${binaryPath}`,
          `exit: ${bootstrap.code}`,
          bootstrap.stderr.trim() ? `stderr:\n${bootstrap.stderr.trim()}` : undefined,
          bootstrap.stdout.trim() ? `stdout:\n${bootstrap.stdout.trim()}` : undefined,
        ]
          .filter(Boolean)
          .join("\n"),
      )
    }

    // Now turn that fixture into an already-existing database from the newest
    // durable representation epoch. The second launch must prove the binary's
    // fail-closed gate actually accepts that epoch.
    const db = new Database(dbPath)
    try {
      db.exec(`PRAGMA user_version = ${CHUNKDB_MAX_USER_VERSION}`)
    } finally {
      db.close()
    }

    const { code, stdout, stderr } = await run({
      ...baseEnv,
      OPENCODE_SEAL_ENABLED: "1",
      OPENCODE_SEAL_DEDUP: "1",
      OPENCODE_SEAL_PRUNE: "1",
    })

    if (code !== 0) {
      throw new Error(
        [
          `Compiled OpenCode failed ChunkDB capability probe for user_version ${CHUNKDB_MAX_USER_VERSION}.`,
          `binary: ${binaryPath}`,
          `exit: ${code}`,
          stderr.trim() ? `stderr:\n${stderr.trim()}` : undefined,
          stdout.trim() ? `stdout:\n${stdout.trim()}` : undefined,
        ]
          .filter(Boolean)
          .join("\n"),
      )
    }

    return {
      userVersion: CHUNKDB_MAX_USER_VERSION,
      stdout,
      stderr,
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}
