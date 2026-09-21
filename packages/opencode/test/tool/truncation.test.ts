import { describe, test, expect } from "bun:test"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { filesystem } from "@opencode-ai/core/effect/app-node-platform"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, FileSystem, Layer } from "effect"
import { Truncate } from "@/tool/truncate"
import { Config } from "@/config/config"
import { Identifier } from "../../src/id/id"
import { Process } from "@/util/process"
import path from "path"
import { brotliDecompressSync } from "node:zlib"
import { testEffect } from "../lib/effect"
import { writeFileStringScoped } from "../lib/filesystem"
import { TestConfig } from "../fixture/config"

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures")
const ROOT = path.resolve(import.meta.dir, "..", "..")

const it = testEffect(LayerNode.compile(LayerNode.group([Truncate.node, FSUtil.node, filesystem])))

const configuredLayer = (cfg: ConfigV1.Info) =>
  LayerNode.compile(LayerNode.group([Truncate.node, FSUtil.node, filesystem, Config.node]), [
    [Config.node, TestConfig.layer({ get: () => Effect.succeed(cfg) })],
  ])
const configuredIt = (cfg: ConfigV1.Info) => testEffect(configuredLayer(cfg))
const failingFs = Layer.effect(
  FSUtil.Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return FSUtil.Service.of({
      ...fs,
      ensureDir: () =>
        Effect.fail(new FSUtil.FileSystemError({ method: "ensureDir", cause: new Error("retention unavailable") })),
    })
  }),
).pipe(Layer.provide(LayerNode.compile(LayerNode.group([FSUtil.node, filesystem]))))
const failingWriterIt = testEffect(LayerNode.compile(Truncate.node, [[FSUtil.node, failingFs]]))

describe("Truncate", () => {
  describe("output", () => {
    it.live("truncates large json file by bytes", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const fsys = yield* FSUtil.Service
        const content = yield* fsys.readFileString(path.join(FIXTURES_DIR, "models-api.json"))
        const result = yield* svc.output(content)

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("output truncated")
        expect(result.content).toContain("brotli compressed")
        if (result.truncated) expect(result.outputPath).toBeDefined()
      }),
    )

    it.live("returns content unchanged when under limits", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const content = "line1\nline2\nline3"
        const result = yield* svc.output(content)

        expect(result.truncated).toBe(false)
        expect(result.content).toBe(content)
      }),
    )

    it.live("truncates by line count", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 10 })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("line0")
        expect(result.content).toContain("line99")
        expect(result.content).toContain("output truncated")
        expect(result.content.split("\n").length).toBeLessThanOrEqual(10)
      }),
    )

    it.live("truncates by byte count", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const content = "a".repeat(1000)
        const result = yield* svc.output(content, { maxBytes: 100 })

        expect(result.truncated).toBe(true)
        expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThanOrEqual(100)
        if (result.truncated) expect(result.originalBytes).toBe(1000)
      }),
    )

    it.live("retains both head and tail by default", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 5, maxBytes: 10_000 })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("line0")
        expect(result.content).toContain("line9")
        if (result.truncated) expect(result.strategy).toBe("balanced")
      }),
    )

    it.live("truncates from head when direction is head", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 5, maxBytes: 10_000, direction: "head" })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("line0")
        expect(result.content).not.toContain("line9")
      }),
    )

    it.live("truncates from tail when direction is tail", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 5, maxBytes: 10_000, direction: "tail" })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("line9")
        expect(result.content).not.toContain("line0")
      }),
    )

    test("uses default MAX_LINES and MAX_BYTES", () => {
      expect(Truncate.MAX_LINES).toBe(2000)
      expect(Truncate.MAX_BYTES).toBe(50 * 1024)
    })

    it.live("metadata composition keeps producer and provider loss independent", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const projected = yield* svc.output("HEAD-" + "x".repeat(10_000) + "-TAIL", { maxBytes: 512 })
        expect(projected.truncated).toBe(true)
        if (!projected.truncated) throw new Error("expected provider projection")

        const producerPath = "/producer/full-output"
        const metadata = Truncate.mergeMetadata(
          { truncated: true, outputPath: producerPath, rows: 100 },
          projected,
        )
        expect(metadata.truncated).toBe(true)
        expect(metadata.producerTruncated).toBe(true)
        expect(metadata.providerTruncated).toBe(true)
        expect(metadata.outputPath).toBe(producerPath)
        expect(metadata.providerOutputPath).toBe(projected.outputPath)
        expect(metadata.outputProjection?.originalBytes).toBe(projected.originalBytes)
        expect(metadata.outputProjection?.segments).toEqual(projected.segments)
      }),
    )

    test("metadata composition reports a clean provider projection without inventing a spill", () => {
      const projected = { content: "ok", truncated: false } as const
      const metadata = Truncate.mergeMetadata({ truncated: false, rows: 1 }, projected)
      expect(metadata).toMatchObject({
        rows: 1,
        truncated: false,
        producerTruncated: false,
        providerTruncated: false,
      })
      expect("providerOutputPath" in metadata).toBe(false)
      expect("outputProjection" in metadata).toBe(false)
    })

    test("metadata composition represents lossy provider projection when retention is unavailable", () => {
      const projected: Truncate.Result = {
        content: "HEAD\n[retention unavailable]\nTAIL",
        truncated: true,
        originalLines: 100,
        originalBytes: 10_000,
        retainedBytes: 8,
        omittedBytes: 9_992,
        strategy: "balanced",
        segments: [
          { startByte: 0, endByte: 4 },
          { startByte: 9_996, endByte: 10_000 },
        ],
      }
      const metadata = Truncate.mergeMetadata({ rows: 1 }, projected)
      expect(metadata.truncated).toBe(true)
      expect(metadata.providerTruncated).toBe(true)
      expect("outputPath" in metadata).toBe(false)
      expect("providerOutputPath" in metadata).toBe(false)
      expect(metadata.outputProjection?.omittedBytes).toBe(9_992)
    })

    it.live("limits() falls back to MAX_LINES/MAX_BYTES when Config is not provided", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const resolved = yield* svc.limits()
        expect(resolved.maxLines).toBe(Truncate.MAX_LINES)
        expect(resolved.maxBytes).toBe(Truncate.MAX_BYTES)
      }),
    )

    describe("with tool_output config", () => {
      const limitsIt = configuredIt({ tool_output: { max_lines: 123, max_bytes: 456 } })
      limitsIt.live("limits() reflects config overrides", () =>
        Effect.gen(function* () {
          const resolved = yield* (yield* Truncate.Service).limits()
          expect(resolved.maxLines).toBe(123)
          expect(resolved.maxBytes).toBe(456)
        }),
      )

      // Huge byte budget isolates line truncation. 100 lines against max_lines: 10
      // proves the configured line limit is what `output()` enforces.
      const lineIt = configuredIt({ tool_output: { max_lines: 10, max_bytes: 1024 * 1024 } })
      lineIt.live("output() truncates to configured max_lines", () =>
        Effect.gen(function* () {
          const content = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
          const result = yield* (yield* Truncate.Service).output(content)
          expect(result.truncated).toBe(true)
          expect(result.content).toContain("line0")
          expect(result.content).toContain("line99")
          expect(result.content.split("\n").length).toBeLessThanOrEqual(10)
        }),
      )

      // Huge line budget isolates byte truncation.
      const byteIt = configuredIt({ tool_output: { max_lines: 1_000_000, max_bytes: 100 } })
      byteIt.live("output() truncates to configured max_bytes", () =>
        Effect.gen(function* () {
          const content = "a".repeat(1000)
          const result = yield* (yield* Truncate.Service).output(content)
          expect(result.truncated).toBe(true)
          expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThanOrEqual(100)
        }),
      )

      const overrideIt = configuredIt({ tool_output: { max_lines: 10, max_bytes: 100 } })
      overrideIt.live("per-call options still override config", () =>
        Effect.gen(function* () {
          const content = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n")
          const result = yield* (yield* Truncate.Service).output(content, {
            maxLines: 1000,
            maxBytes: 1024 * 1024,
          })
          expect(result.truncated).toBe(false)
        }),
      )
    })

    it.live("large single-line file preserves useful beginning and end within byte budget", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const content = "HEAD-" + "☃".repeat(40_000) + "-TAIL"
        const result = yield* svc.output(content, { maxLines: 3, maxBytes: 1024 })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("HEAD-")
        expect(result.content).toContain("-TAIL")
        expect(result.content).not.toContain("�")
        expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThanOrEqual(1024)
      }),
    )

    it.live("writes full output to file when truncated", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 10 })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("output truncated")
        expect(result.content).toContain("archive({action:")
        if (!result.truncated) throw new Error("expected truncated")
        expect(result.outputPath).toBeDefined()
        const outputPath = result.outputPath
        if (!outputPath) throw new Error("expected retained output path")
        expect(outputPath).toContain("tool_")
        expect(outputPath.endsWith(".br")).toBe(true)

        const fsys = yield* FSUtil.Service
        const written = yield* fsys.readFile(outputPath)
        expect(brotliDecompressSync(written as unknown as Buffer).toString("utf-8")).toBe(lines)
      }),
    )

    it.live("suggests Task tool when agent has task permission", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        const agent = { permission: [{ permission: "task", pattern: "*", action: "allow" as const }] }
        const result = yield* svc.output(lines, { maxLines: 10 }, agent as any)

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("archive inspection")
        expect(result.content).toContain("Task tool")
      }),
    )

    it.live("omits Task tool hint when agent lacks task permission", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        const agent = { permission: [{ permission: "task", pattern: "*", action: "deny" as const }] }
        const result = yield* svc.output(lines, { maxLines: 10 }, agent as any)

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("archive({action:")
        expect(result.content).not.toContain("Task tool")
      }),
    )

    it.live("does not write file when not truncated", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const content = "short content"
        const result = yield* svc.output(content)

        expect(result.truncated).toBe(false)
        if (result.truncated) throw new Error("expected not truncated")
        expect("outputPath" in result).toBe(false)
      }),
    )

    failingWriterIt.live("streaming retention initialization failure degrades to a disabled writer", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const writer = yield* svc.writer("initial output")
        expect(writer.healthy()).toBe(false)
        expect(writer.outputPath).toBeUndefined()
        yield* writer.write("later output")
        yield* writer.close
        expect(writer.healthy()).toBe(false)
      }),
    )

    test("loads truncate effect in a fresh process", async () => {
      const out = await Process.run([process.execPath, "run", path.join(ROOT, "src", "tool", "truncate.ts")], {
        cwd: ROOT,
      })

      expect(out.code).toBe(0)
    }, 20000)
  })

  describe("cleanup", () => {
    const DAY_MS = 24 * 60 * 60 * 1000

    it.live("uses file mtime when IDs wrap", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const fs = yield* FileSystem.FileSystem

        yield* fs.makeDirectory(Truncate.DIR, { recursive: true })

        const old = path.join(Truncate.DIR, Identifier.create("tool", "ascending", 2 ** 36 - 1))
        const recent = path.join(Truncate.DIR, Identifier.create("tool", "ascending", 2 ** 36 + 1))

        yield* writeFileStringScoped(old, "old content")
        yield* writeFileStringScoped(recent, "recent content")
        yield* fs.utimes(old, new Date(), new Date(Date.now() - 10 * DAY_MS))
        yield* fs.utimes(recent, new Date(), new Date(Date.now() - 3 * DAY_MS))
        yield* svc.cleanup()

        expect(yield* fs.exists(old)).toBe(false)
        expect(yield* fs.exists(recent)).toBe(true)
      }),
    )
  })
})
