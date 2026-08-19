import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit } from "effect"
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import type { Tool } from "../../src/tool/tool"
import { ArchiveTool } from "../../src/tool/archive"
import { ZipFile } from "../../src/tool/archive/zipfile"
import { ArchiveSystem } from "../../src/tool/archive/system"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(LayerNode.compile(LayerNode.group([ToolRegistry.node])))

const asks = () => {
  const items: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  return {
    items,
    ctx: {
      ...baseCtx,
      ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
        Effect.sync(() => {
          items.push(req)
        }),
    } satisfies Tool.Context,
  }
}

const write = (dir: string, name: string, content: string) => Effect.promise(() => Bun.write(path.join(dir, name), content))
const readText = (p: string) => Effect.promise(() => Bun.file(p).text())

const toolByID = (registry: ToolRegistry.Interface, id: string) =>
  registry
    .tools({
      providerID: "opencode" as any,
      modelID: "gpt-5" as any,
      agent: { name: "build", mode: "primary" as const, permission: [], options: {} },
    })
    .pipe(Effect.map((list) => list.find((t) => t.id === id)))

describe("tool.archive", () => {
  it.instance("create then list a zip", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* write(test.directory, "a.txt", "hello\n".repeat(20))
      yield* write(test.directory, "nested/b.txt", "nested content")
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, ArchiveTool.id)
      if (!tool) throw new Error("archive tool not found")

      const { items, ctx } = asks()
      const create = yield* tool.execute(
        { action: "create", path: path.join(test.directory, "bundle.zip"), source: [path.join(test.directory, "a.txt"), path.join(test.directory, "nested")] },
        ctx,
      )
      expect(create.metadata.format).toBe("ZIP")
      expect(create.metadata.count).toBe(2)
      expect(create.output).toContain("bundle.zip")
      expect(items.map((i) => i.permission)).toEqual(["edit", "read", "read"])

      const list = yield* tool.execute({ action: "list", path: path.join(test.directory, "bundle.zip") }, ctx)
      expect(list.metadata.format).toBe("ZIP")
      expect(list.output).toContain("a.txt")
      expect(list.output).toContain("nested/b.txt")
      expect(list.output).toContain("[D] nested")
    }),
  )

  it.instance("extract a zip and read an entry", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* write(test.directory, "src/main.ts", "export const x = 1\nline two\nline three\n")
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, ArchiveTool.id)
      if (!tool) throw new Error("archive tool not found")
      const { ctx } = asks()

      yield* tool.execute(
        { action: "create", path: path.join(test.directory, "src.zip"), source: [path.join(test.directory, "src")] },
        ctx,
      )

      const read = yield* tool.execute({ action: "read", path: path.join(test.directory, "src.zip"), entry: "src/main.ts" }, ctx)
      expect(read.metadata.format).toBe("ZIP")
      expect(read.output).toContain("export const x = 1")
      expect(read.output).toContain("(End of entry - total 3 lines)")

      const extract = yield* tool.execute({ action: "extract", path: path.join(test.directory, "src.zip") }, ctx)
      expect(extract.output).toContain("Extracted 1 files")
      const content = yield* readText(path.join(test.directory, "src", "main.ts"))
      expect(content).toContain("line two")
    }),
  )

  it.instance("blocks path traversal entries on extract", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const zip = yield* Effect.promise(() =>
        ZipFile.zipToBuffer([
          { name: "../evil.txt", data: new TextEncoder().encode("pwned"), date: new Date() },
          { name: "ok.txt", data: new TextEncoder().encode("fine"), date: new Date() },
        ]),
      )
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "malicious.zip"), zip))

      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, ArchiveTool.id)
      if (!tool) throw new Error("archive tool not found")

      const extract = yield* tool.execute(
        { action: "extract", path: path.join(test.directory, "malicious.zip"), destination: path.join(test.directory, "out") },
        asks().ctx,
      )
      expect(extract.output).toContain("1 unsafe paths")
      const content = yield* readText(path.join(test.directory, "out", "ok.txt"))
      expect(content).toBe("fine")
      const escaped = yield* Effect.promise(() => Bun.file(path.join(test.directory, "evil.txt")).exists().catch(() => false))
      expect(escaped).toBe(false)
    }),
  )

  it.instance("tar.gz roundtrip via create and extract", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* write(test.directory, "docs/readme.md", "# Docs\n")
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, ArchiveTool.id)
      if (!tool) throw new Error("archive tool not found")
      const { ctx } = asks()

      const create = yield* tool.execute(
        { action: "create", path: path.join(test.directory, "docs.tar.gz"), source: [path.join(test.directory, "docs")] },
        ctx,
      )
      expect(create.metadata.format).toBe("gzip (tar)")

      const list = yield* tool.execute({ action: "list", path: path.join(test.directory, "docs.tar.gz") }, ctx)
      expect(list.metadata.format).toBe("gzip (tar)")
      expect(list.output).toContain("docs/readme.md")

      // Extract into a fresh destination so the assertion can't accidentally
      // read the original source file.
      yield* tool.execute(
        { action: "extract", path: path.join(test.directory, "docs.tar.gz"), destination: path.join(test.directory, "out-tgz") },
        ctx,
      )
      const content = yield* readText(path.join(test.directory, "out-tgz", "docs", "readme.md"))
      expect(content).toBe("# Docs\n")
      // Regular files must not be misclassified as symlinks.
      const again = yield* tool.execute({ action: "extract", path: path.join(test.directory, "docs.tar.gz"), destination: path.join(test.directory, "out-tgz2") }, ctx)
      expect(again.output).not.toContain("symlinks skipped")
      expect(again.output).toContain("Extracted 1 files")
    }),
  )

  it.instance("single-file gzip create, list, extract, read", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* write(test.directory, "log.txt", "line1\nline2\nline3\n")
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, ArchiveTool.id)
      if (!tool) throw new Error("archive tool not found")
      const { ctx } = asks()

      const create = yield* tool.execute(
        { action: "create", path: path.join(test.directory, "log.txt.gz"), source: [path.join(test.directory, "log.txt")] },
        ctx,
      )
      expect(create.metadata.format).toBe("gzip")

      const list = yield* tool.execute({ action: "list", path: path.join(test.directory, "log.txt.gz") }, ctx)
      expect(list.metadata.format).toBe("gzip")
      expect(list.output).toContain("log.txt")

      const read = yield* tool.execute({ action: "read", path: path.join(test.directory, "log.txt.gz") }, ctx)
      expect(read.output).toContain("line2")

      const extract = yield* tool.execute(
        { action: "extract", path: path.join(test.directory, "log.txt.gz"), destination: path.join(test.directory, "restored.txt") },
        ctx,
      )
      expect(extract.output).toContain("Extracted 1 files")
      const content = yield* readText(path.join(test.directory, "restored.txt"))
      expect(content).toBe("line1\nline2\nline3\n")
    }),
  )

  it.instance("entries filter narrows list and extract", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* write(test.directory, "a.txt", "A")
      yield* write(test.directory, "b.ts", "B")
      yield* write(test.directory, "c.txt", "C")
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, ArchiveTool.id)
      if (!tool) throw new Error("archive tool not found")
      const { ctx } = asks()

      yield* tool.execute(
        { action: "create", path: path.join(test.directory, "mix.zip"), source: [path.join(test.directory, "a.txt"), path.join(test.directory, "b.ts"), path.join(test.directory, "c.txt")] },
        ctx,
      )

      const list = yield* tool.execute(
        { action: "list", path: path.join(test.directory, "mix.zip"), entries: ["*.txt"] },
        ctx,
      )
      expect(list.output).toContain("a.txt")
      expect(list.output).toContain("c.txt")
      expect(list.output).not.toContain("b.ts")

      yield* tool.execute(
        { action: "extract", path: path.join(test.directory, "mix.zip"), destination: path.join(test.directory, "out"), entries: ["*.txt"] },
        ctx,
      )
      expect(yield* readText(path.join(test.directory, "out", "a.txt"))).toBe("A")
      expect(yield* readText(path.join(test.directory, "out", "c.txt"))).toBe("C")
      expect(yield* Effect.promise(() => Bun.file(path.join(test.directory, "out", "b.ts")).exists())).toBe(false)
    }),
  )

  it.instance("reads a bzip2 single-file archive", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        Bun.spawn(["python", "-c", "import bz2,pathlib,sys; pathlib.Path(sys.argv[1]).write_bytes(bz2.compress(b'hello bzip2 world' * 5))", path.join(test.directory, "data.bz2")]).exited,
      )
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, ArchiveTool.id)
      if (!tool) throw new Error("archive tool not found")

      const read = yield* tool.execute({ action: "read", path: path.join(test.directory, "data.bz2") }, asks().ctx)
      expect(read.output).toContain("hello bzip2 world")
    }),
  )

  it.instance("lists and extracts tar.xz via the system tar fallback", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      if (!Bun.which("python") || !Bun.which("tar")) return
      yield* write(test.directory, "payload.txt", "xz content\n")
      const code = yield* Effect.promise(() =>
        Bun.spawn([
          "python",
          "-c",
          "import tarfile,sys; t=tarfile.open(sys.argv[1],'w:xz'); t.add(sys.argv[2], arcname='folder/payload.txt'); t.close()",
          path.join(test.directory, "data.tar.xz"),
          path.join(test.directory, "payload.txt"),
        ]).exited,
      )
      expect(code).toBe(0)

      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, ArchiveTool.id)
      if (!tool) throw new Error("archive tool not found")
      const { ctx } = asks()

      const list = yield* tool.execute({ action: "list", path: path.join(test.directory, "data.tar.xz") }, ctx)
      expect(list.metadata.format).toBe("xz (tar)")
      expect(list.output).toContain("folder/payload.txt")

      yield* tool.execute({ action: "extract", path: path.join(test.directory, "data.tar.xz") }, ctx)
      expect(yield* readText(path.join(test.directory, "data", "folder", "payload.txt"))).toBe("xz content\n")
    }),
  )

  it.instance("uses 7-Zip for .7z archives when installed", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const seven = yield* Effect.promise(() => ArchiveSystem.findTool("7z"))
      if (!seven) return
      yield* write(test.directory, "seven.txt", "7z payload\n")
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, ArchiveTool.id)
      if (!tool) throw new Error("archive tool not found")
      const { ctx } = asks()

      const create = yield* tool.execute(
        { action: "create", path: path.join(test.directory, "bundle.7z"), source: [path.join(test.directory, "seven.txt")] },
        ctx,
      )
      expect(create.metadata.format).toBe("7z")

      const list = yield* tool.execute({ action: "list", path: path.join(test.directory, "bundle.7z") }, ctx)
      expect(list.output).toContain("seven.txt")

      yield* tool.execute({ action: "extract", path: path.join(test.directory, "bundle.7z"), destination: path.join(test.directory, "out7z") }, ctx)
      expect(yield* readText(path.join(test.directory, "out7z", "seven.txt"))).toBe("7z payload\n")
    }),
  )

  it.instance("reports a clear error for unknown formats", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* write(test.directory, "data.bin", "not an archive at all")
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, ArchiveTool.id)
      if (!tool) throw new Error("archive tool not found")

      const exit = yield* tool
        .execute({ action: "list", path: path.join(test.directory, "data.bin") }, asks().ctx)
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error instanceof Error ? error.message : String(error)).toContain("Unrecognized file format")
      }
    }),
  )
})
