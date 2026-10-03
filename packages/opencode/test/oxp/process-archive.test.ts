import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { OxpProcessArchive } from "@/oxp/process-archive"
import { OxpSchema } from "@/oxp/schema"

async function withArchive<A>(
  stateDir: string,
  run: (archive: OxpProcessArchive.Interface) => Effect.Effect<A, any>,
): Promise<A> {
  const layer = AppNodeBuilder.build(
    OxpProcessArchive.node,
    [[Global.node, Global.layerWith({ state: stateDir, config: path.join(stateDir, "config") })]],
  )
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(Layer.fresh(layer))
        const archive = Context.get(context, OxpProcessArchive.Service)
        return yield* run(archive)
      }),
    ),
  )
}

function ids() {
  return {
    connectorID: OxpSchema.ConnectorID.make(randomUUID()),
    rootID: OxpSchema.RootID.make(randomUUID()),
  }
}

function finished(handle: string, startedAt = Date.now(), output = "hello") {
  const identity = ids()
  return {
    handle,
    ...identity,
    workdir: "/repo",
    mode: "background" as const,
    startedAt,
    endedAt: startedAt + 10,
    exitCode: 0,
    outputBytes: Buffer.byteLength(output, "utf8"),
    truncated: false,
    output,
  }
}

describe("OxpProcessArchive", () => {
  test("persists only bounded secret-free terminal metadata and retained output", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "oxp-process-archive-"))
    try {
      const handle = "proc_" + randomUUID().replaceAll("-", "")
      const record = finished(handle, 100, "hello")
      await withArchive(stateDir, (archive) =>
        Effect.gen(function* () {
          const saved = yield* archive.finalize(record)
          expect(saved.output).toBe("hello")
          expect(saved.exitCode).toBe(0)
          expect(saved.recovered).toBe(true)
        }),
      )

      const dir = path.join(stateDir, "oxp-process")
      const metaText = await fs.readFile(path.join(dir, handle + ".json"), "utf8")
      const logText = await fs.readFile(path.join(dir, handle + ".log"), "utf8")
      expect(logText).toBe("hello")
      expect(metaText).not.toContain("command")
      expect(metaText).not.toContain("shell")
      expect(metaText).not.toContain("env")
      expect(metaText).not.toContain("pid")
      expect(metaText).not.toContain("credential")
      expect(metaText).not.toContain("token")
      expect(JSON.parse(metaText)).toEqual({
        version: 1,
        handle,
        connectorID: record.connectorID,
        rootID: record.rootID,
        workdir: "/repo",
        mode: "background",
        startedAt: 100,
        endedAt: 110,
        exitCode: 0,
        outputBytes: 5,
        retainedBytes: 5,
        truncated: false,
      })
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true })
    }
  })

  test("rehydrates a finalized process across fresh archive runtimes", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "oxp-process-archive-restart-"))
    try {
      const handle = "proc_" + randomUUID().replaceAll("-", "")
      const record = finished(handle, 100, "persisted")
      await withArchive(stateDir, (archive) => archive.finalize({ ...record, exitCode: 7 }).pipe(Effect.asVoid))

      await withArchive(stateDir, (archive) =>
        Effect.gen(function* () {
          const recovered = yield* archive.get(handle)
          expect(recovered).toMatchObject({
            handle,
            endedAt: 110,
            exitCode: 7,
            output: "persisted",
            recovered: true,
          })
        }),
      )
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true })
    }
  })

  test("never invents terminal truth from an unfinished or malformed disk row", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "oxp-process-archive-uncommitted-"))
    try {
      const dir = path.join(stateDir, "oxp-process")
      await fs.mkdir(dir, { recursive: true })
      const handle = "proc_" + randomUUID().replaceAll("-", "")
      const identity = ids()
      await fs.writeFile(
        path.join(dir, handle + ".json"),
        JSON.stringify({
          version: 1,
          handle,
          ...identity,
          workdir: "/repo",
          mode: "background",
          startedAt: 100,
          outputBytes: 7,
          truncated: false,
        }),
      )
      await fs.writeFile(path.join(dir, handle + ".log"), "partial")

      await withArchive(stateDir, (archive) =>
        Effect.gen(function* () {
          expect(yield* archive.get(handle)).toBeUndefined()
          expect(yield* archive.list()).toEqual([])
        }),
      )
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true })
    }
  })

  test("cleans orphan log/temp files while malformed metadata grants no recovered capability", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "oxp-process-archive-orphan-"))
    try {
      const dir = path.join(stateDir, "oxp-process")
      await fs.mkdir(dir, { recursive: true })
      const handle = "proc_" + randomUUID().replaceAll("-", "")
      const orphan = "proc_" + randomUUID().replaceAll("-", "")
      await fs.writeFile(path.join(dir, handle + ".json"), "{broken")
      await fs.writeFile(path.join(dir, orphan + ".log"), "orphan")
      await fs.writeFile(path.join(dir, "junk.tmp"), "temp")

      await withArchive(stateDir, (archive) =>
        Effect.gen(function* () {
          expect(yield* archive.list()).toEqual([])
        }),
      )

      await expect(fs.stat(path.join(dir, orphan + ".log"))).rejects.toBeDefined()
      await expect(fs.stat(path.join(dir, "junk.tmp"))).rejects.toBeDefined()
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true })
    }
  })

  test("hard-bounds terminal archive count and prunes the oldest committed files", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "oxp-process-archive-retention-"))
    try {
      const handles: string[] = []
      await withArchive(stateDir, (archive) =>
        Effect.gen(function* () {
          for (let index = 0; index < OxpProcessArchive.MAX_ARCHIVES + 2; index++) {
            const handle = "proc_" + randomUUID().replaceAll("-", "")
            handles.push(handle)
            yield* archive.finalize(finished(handle, index + 1, ""))
          }
          const records = yield* archive.list()
          expect(records).toHaveLength(OxpProcessArchive.MAX_ARCHIVES)
          expect(records.some((record) => record.handle === handles[0])).toBe(false)
          expect(records.some((record) => record.handle === handles.at(-1))).toBe(true)
        }),
      )

      const dir = path.join(stateDir, "oxp-process")
      await expect(fs.stat(path.join(dir, handles[0]! + ".json"))).rejects.toBeDefined()
      await expect(fs.stat(path.join(dir, handles[0]! + ".log"))).rejects.toBeDefined()
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true })
    }
  }, 30_000)

  test("retention evicts by terminal age so a newly-finished long-running process survives", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "oxp-process-archive-ended-at-"))
    try {
      const longRunning = "proc_" + randomUUID().replaceAll("-", "")
      const firstShort = "proc_" + randomUUID().replaceAll("-", "")
      await withArchive(stateDir, (archive) =>
        Effect.gen(function* () {
          yield* archive.finalize({
            ...finished(longRunning, 1, ""),
            endedAt: 100_000,
          })
          yield* archive.finalize({
            ...finished(firstShort, 100, ""),
            endedAt: 100,
          })
          for (let index = 1; index < OxpProcessArchive.MAX_ARCHIVES; index++) {
            const handle = "proc_" + randomUUID().replaceAll("-", "")
            yield* archive.finalize({
              ...finished(handle, 100 + index, ""),
              endedAt: 100 + index,
            })
          }
          const records = yield* archive.list()
          expect(records).toHaveLength(OxpProcessArchive.MAX_ARCHIVES)
          expect(records.some((record) => record.handle === longRunning)).toBe(true)
          expect(records.some((record) => record.handle === firstShort)).toBe(false)
        }),
      )
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true })
    }
  }, 30_000)

  test("hard-bounds total committed archive bytes, not just record count", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "oxp-process-archive-bytes-"))
    try {
      const output = "x".repeat(OxpProcessArchive.MAX_ARCHIVE_OUTPUT_BYTES)
      const writes = Math.ceil(
        OxpProcessArchive.MAX_ARCHIVE_TOTAL_BYTES / OxpProcessArchive.MAX_ARCHIVE_OUTPUT_BYTES,
      ) + 2
      await withArchive(stateDir, (archive) =>
        Effect.gen(function* () {
          for (let index = 0; index < writes; index++) {
            const handle = "proc_" + randomUUID().replaceAll("-", "")
            yield* archive.finalize(finished(handle, index + 1, output))
          }
        }),
      )

      const dir = path.join(stateDir, "oxp-process")
      const entries = await fs.readdir(dir)
      let bytes = 0
      for (const entry of entries) {
        const stat = await fs.stat(path.join(dir, entry))
        bytes += stat.size
      }
      expect(bytes).toBeLessThanOrEqual(OxpProcessArchive.MAX_ARCHIVE_TOTAL_BYTES)
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true })
    }
  }, 60_000)

  test("serializes concurrent writers over one durable state directory without lost rows", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "oxp-process-archive-concurrent-"))
    try {
      const first = "proc_" + randomUUID().replaceAll("-", "")
      const second = "proc_" + randomUUID().replaceAll("-", "")
      await Promise.all([
        withArchive(stateDir, (archive) => archive.finalize(finished(first, 100, "first")).pipe(Effect.asVoid)),
        withArchive(stateDir, (archive) => archive.finalize(finished(second, 200, "second")).pipe(Effect.asVoid)),
      ])
      await withArchive(stateDir, (archive) =>
        Effect.gen(function* () {
          const rows = yield* archive.list()
          expect(rows.some((row) => row.handle === first)).toBe(true)
          expect(rows.some((row) => row.handle === second)).toBe(true)
        }),
      )
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true })
    }
  })
})
