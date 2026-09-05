import { Effect, Option, Schema, Scope, Stream } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import * as path from "path"
import * as Tool from "./tool"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { LSP } from "@/lsp/lsp"
import DESCRIPTION from "./read.txt"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { Instruction } from "../session/instruction"
import { isPdfAttachment, sniffAttachmentMime } from "@/util/media"
import z from "node:zlib"
import { getOutline, makeOutlineCache } from "./symbols/outline"
import {
  coerceFilePaths,
  isPosixAbsoluteOnWindows,
  posixSuffixes,
  resolveReadPath,
  statPath,
  type GlobSearch,
} from "./read/path"
import { AROUND_MAX, compilePattern, GREP_MAX, renderGrep, renderHeal, renderOutline, aroundWindow } from "./read/inspect"

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const MAX_BYTES = 50 * 1024
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024} KB`
const SAMPLE_BYTES = 4096
const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])
const MAX_BULK_FILES = 8
const DEFAULT_TAIL = 80
const HINT =
  'Tip: action="outline" for a symbol TOC, pattern="name" to search this file, symbol="name" to jump to a definition.'

class ReadStop extends Schema.TaggedErrorClass<ReadStop>()("ReadStop", {}) {}

export const Parameters = Schema.Struct({
  filePath: Schema.optional(Schema.String).annotate({
    description: "The absolute path to the file or directory to read",
  }),
  file_path: Schema.optional(Schema.String).annotate({
    description: "Alias for filePath",
  }),
  filePaths: Schema.optional(Schema.Union([Schema.Array(Schema.String), Schema.String])).annotate({
    description:
      "Bulk read: up to 8 files in one call, each rendered as its own <file> block. Mutually exclusive with filePath. JSON array, not a string.",
  }),
  offset: Schema.optional(NonNegativeInt).annotate({
    description: "The line number to start reading from (1-indexed). Past EOF clamps to the last page.",
  }),
  limit: Schema.optional(NonNegativeInt).annotate({
    description: "The maximum number of lines to read (defaults to 2000)",
  }),
  action: Schema.optional(Schema.Literals(["read", "outline", "grep", "around", "tail"])).annotate({
    description:
      "read = file window (default). outline = symbol TOC. grep = search this file. around = jump to symbol. tail = last N lines.",
  }),
  pattern: Schema.optional(Schema.String).annotate({
    description: "Regex to search inside this file (implies action=grep unless action is set). Prefer this over paging.",
  }),
  symbol: Schema.optional(Schema.String).annotate({
    description: "Symbol name to jump to (implies action=around unless action is set).",
  }),
})

type Display =
  | {
      type: "directory"
      path: string
      entries: string[]
      offset: number
      totalEntries: number
      truncated: boolean
    }
  | {
      type: "file"
      path: string
      text: string
      lineStart: number
      lineEnd: number
      totalLines: number
      truncated: boolean
    }

type Metadata = {
  preview: string
  truncated: boolean
  loaded: string[]
  display?: Display
  action?: string
  matches?: number
  clamped?: boolean
  requested?: string
  healed?: boolean
}

type LineResult = {
  raw: string[]
  count: number
  cut: boolean
  more: boolean
  offset: number
  clamped?: boolean
  requestedOffset?: number
}

export const ReadTool = Tool.define<
  typeof Parameters,
  Metadata,
  FSUtil.Service | Instruction.Service | LSP.Service | Ripgrep.Service | Scope.Scope
>(
  "read",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const instruction = yield* Instruction.Service
    const lsp = yield* LSP.Service
    const ripgrep = yield* Ripgrep.Service
    const scope = yield* Scope.Scope
    const cacheState = yield* makeOutlineCache()

    const glob: GlobSearch = (input) =>
      ripgrep.glob({ cwd: input.cwd, pattern: input.pattern, limit: input.limit }).pipe(
        Effect.catch(() => Effect.succeed([] as Array<{ path: string }>)),
      )

    const miss = Effect.fn("ReadTool.miss")(function* (filepath: string, directory: string, candidates: string[]) {
      const labeled: string[] = []
      for (const item of candidates.slice(0, 8)) {
        const abs = item.endsWith("/") ? item.slice(0, -1) : item
        const info = yield* statPath(fs, abs)
        labeled.push(info?.type === "Directory" || item.endsWith("/") ? `${abs}/  (directory — not opened)` : abs)
      }
      const posix =
        isPosixAbsoluteOnWindows(filepath)
          ? `\nPOSIX path on Windows. CWD is ${directory}. Tried: ${posixSuffixes(directory, filepath).slice(0, 3).join(", ")}`
          : ""
      if (labeled.length > 0) {
        return yield* Effect.fail(
          new Error(
            `File not found: ${filepath}${posix}\n\nDid you mean one of these? (not opened — same name, more than one hit)\n${labeled.join("\n")}`,
          ),
        )
      }
      return yield* Effect.fail(
        new Error(`File not found: ${filepath}${posix}\nNo unique same-name file to open. Use glob for the basename.`),
      )
    })

    const list = Effect.fn("ReadTool.list")(function* (filepath: string) {
      const items = yield* fs.readDirectoryEntries(filepath)
      return yield* Effect.forEach(
        items,
        Effect.fnUntraced(function* (item) {
          if (item.type === "directory") return item.name + "/"
          if (item.type !== "symlink") return item.name

          const target = yield* fs.stat(path.join(filepath, item.name)).pipe(Effect.catch(() => Effect.void))
          if (target?.type === "Directory") return item.name + "/"
          return item.name
        }),
        { concurrency: 16 },
      ).pipe(Effect.map((items: string[]) => items.sort((a, b) => a.localeCompare(b))))
    })

    const warm = Effect.fn("ReadTool.warm")(function* (filepath: string) {
      yield* lsp.touchFile(filepath).pipe(Effect.ignoreCause, Effect.forkIn(scope))
    })

    const readSample = Effect.fn("ReadTool.readSample")(function* (
      filepath: string,
      fileSize: number,
      sampleSize: number,
    ) {
      if (fileSize === 0) return new Uint8Array()

      return yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(filepath, { flag: "r" })
          return Option.getOrElse(yield* file.readAlloc(Math.min(sampleSize, fileSize)), () => new Uint8Array())
        }),
      )
    })

    const lines = Effect.fn("ReadTool.lines")(function* (filepath: string, opts: { limit: number; offset: number }) {
      const start = opts.offset - 1
      const raw: string[] = []
      const flags = { bytes: 0, count: 0, cut: false, more: false, done: false }

      const decoder = new TextDecoder("utf-8")
      yield* fs.stream(filepath).pipe(
        Stream.map((bytes) => decoder.decode(bytes, { stream: true })),
        Stream.splitLines,
        Stream.runForEach((text) =>
          Effect.gen(function* () {
            if (flags.done) return yield* new ReadStop()
            flags.count += 1
            if (flags.count <= start) return

            if (raw.length >= opts.limit) {
              flags.more = true
              return
            }

            const line = text.length > MAX_LINE_LENGTH ? text.substring(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : text
            const size = Buffer.byteLength(line, "utf-8") + (raw.length > 0 ? 1 : 0)
            if (flags.bytes + size <= MAX_BYTES) {
              raw.push(line)
              flags.bytes += size
              return
            }

            flags.cut = true
            flags.more = true
            flags.done = true
            return yield* new ReadStop()
          }),
        ),
        Effect.catchTag("ReadStop", () => Effect.void),
      )

      return { raw, count: flags.count, cut: flags.cut, more: flags.more, offset: opts.offset }
    })

    const brotliLines = Effect.fn("ReadTool.brotliLines")(function* (
      filepath: string,
      opts: { limit: number; offset: number },
    ) {
      const compressed = yield* fs.readFile(filepath)
      let text: string
      try {
        text = z.brotliDecompressSync(Buffer.from(compressed)).toString("utf8")
      } catch (error) {
        return yield* Effect.fail(
          new Error(`Unable to decompress Brotli file ${filepath}: ${error instanceof Error ? error.message : String(error)}`),
        )
      }

      try {
        text = JSON.stringify(JSON.parse(text), null, 2)
      } catch {
      }

      const all = text.split(/\r?\n/)
      const start = Math.max(0, opts.offset - 1)
      const raw = all.slice(start, start + opts.limit).map((line) =>
        line.length > MAX_LINE_LENGTH ? line.substring(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : line,
      )
      return {
        raw,
        count: all.length,
        cut: false,
        more: start + raw.length < all.length,
        offset: opts.offset,
      }
    })

    const readLines = Effect.fn("ReadTool.readLines")(function* (
      filepath: string,
      opts: { limit: number; offset: number },
    ) {
      return path.extname(filepath).toLowerCase() === ".br" ? yield* brotliLines(filepath, opts) : yield* lines(filepath, opts)
    })

    const clampRead = Effect.fn("ReadTool.clampRead")(function* (
      filepath: string,
      opts: { limit: number; offset: number },
    ) {
      const file = yield* readLines(filepath, opts)
      if (file.raw.length > 0 || (file.count === 0 && opts.offset <= 1)) {
        return { ...file, clamped: false } satisfies LineResult
      }
      if (file.count === 0) {
        return { ...file, clamped: true, requestedOffset: opts.offset } satisfies LineResult
      }
      const offset = Math.max(1, file.count - Math.min(opts.limit, file.count) + 1)
      const next = yield* readLines(filepath, { limit: opts.limit, offset })
      return { ...next, clamped: true, requestedOffset: opts.offset } satisfies LineResult
    })

    const grepFile = Effect.fn("ReadTool.grepFile")(function* (filepath: string, pattern: string) {
      if (path.extname(filepath).toLowerCase() === ".br") {
        const file = yield* brotliLines(filepath, { offset: 1, limit: Number.MAX_SAFE_INTEGER })
        const re = compilePattern(pattern)
        const hits: Array<{ line: number; text: string }> = []
        for (let i = 0; i < file.raw.length; i++) {
          if (!re.test(file.raw[i])) continue
          hits.push({ line: i + 1, text: file.raw[i] })
          if (hits.length >= GREP_MAX) break
        }
        return { hits, truncated: hits.length >= GREP_MAX, count: file.count }
      }

      const result = yield* ripgrep
        .grep({
          cwd: path.dirname(filepath),
          pattern,
          file: path.basename(filepath),
          limit: GREP_MAX,
        })
        .pipe(
          Effect.catchTag("Ripgrep.InvalidPatternError", () =>
            ripgrep.grep({
              cwd: path.dirname(filepath),
              pattern: pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
              file: path.basename(filepath),
              limit: GREP_MAX,
            }),
          ),
        )
      return {
        hits: result.map((item) => ({ line: item.line, text: item.text.trimEnd() })),
        truncated: result.length >= GREP_MAX,
        count: result.length,
      }
    })

    const tailFile = Effect.fn("ReadTool.tailFile")(function* (filepath: string, limit: number) {
      const ring: string[] = []
      let count = 0
      const decoder = new TextDecoder("utf-8")
      yield* fs.stream(filepath).pipe(
        Stream.map((bytes) => decoder.decode(bytes, { stream: true })),
        Stream.splitLines,
        Stream.runForEach((text) =>
          Effect.sync(() => {
            count += 1
            const line = text.length > MAX_LINE_LENGTH ? text.substring(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : text
            if (ring.length === limit) ring.shift()
            ring.push(line)
          }),
        ),
      )
      const offset = count === 0 ? 1 : Math.max(1, count - ring.length + 1)
      return { raw: ring, count, cut: false, more: false, offset, clamped: false } satisfies LineResult
    })

    const isBinaryFile = (filepath: string, bytes: Uint8Array) => {
      const ext = path.extname(filepath).toLowerCase()
      switch (ext) {
        case ".zip":
        case ".tar":
        case ".gz":
        case ".exe":
        case ".dll":
        case ".so":
        case ".class":
        case ".jar":
        case ".war":
        case ".7z":
        case ".doc":
        case ".docx":
        case ".xls":
        case ".xlsx":
        case ".ppt":
        case ".pptx":
        case ".odt":
        case ".ods":
        case ".odp":
        case ".bin":
        case ".dat":
        case ".obj":
        case ".o":
        case ".a":
        case ".lib":
        case ".wasm":
        case ".pyc":
        case ".pyo":
          return true
      }

      if (bytes.length === 0) return false

      let nonPrintableCount = 0
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 0) return true
        if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
          nonPrintableCount++
        }
      }

      return nonPrintableCount / bytes.length > 0.3
    }

    const normalizeInput = (params: Schema.Schema.Type<typeof Parameters>, directory: string) => {
      let filepath = params.filePath ?? params.file_path
      if (filepath && !path.isAbsolute(filepath) && !isPosixAbsoluteOnWindows(filepath)) {
        filepath = path.resolve(directory, filepath)
      }
      if (filepath && process.platform === "win32" && path.isAbsolute(filepath)) {
        filepath = FSUtil.normalizePath(filepath)
      }
      return filepath
    }

    const resolveAction = (params: Schema.Schema.Type<typeof Parameters>) => {
      if (params.action) return params.action
      if (params.pattern) return "grep" as const
      if (params.symbol) return "around" as const
      return "read" as const
    }

    const renderWindow = (filepath: string, file: LineResult, extra?: string) => {
      const last = file.raw.length === 0 ? file.offset - 1 : file.offset + file.raw.length - 1
      const next = last + 1
      const truncated = file.more || file.cut
      let output = [`<path lines="${file.count}">${filepath}</path>`, `<type>file</type>`, "<content>\n"].join("\n")
      output += file.raw.map((line, i) => `${i + file.offset}: ${line}`).join("\n")
      if (file.clamped && file.requestedOffset !== undefined) {
        output += `\n\n(offset ${file.requestedOffset} is past end of file — ${file.count} lines. Showing last page ${file.offset}-${Math.max(file.offset, last)}.)`
      } else if (file.cut) {
        output += `\n\n(Output capped at ${MAX_BYTES_LABEL}. Showing lines ${file.offset}-${last}. Use offset=${next} to continue. ${HINT})`
      } else if (file.more) {
        output += `\n\n(Showing lines ${file.offset}-${last} of ${file.count}. Use offset=${next} to continue. ${HINT})`
      } else {
        output += `\n\n(End of file - total ${file.count} lines)`
      }
      if (extra) output += `\n${extra}`
      output += "\n</content>"
      return { output, last, truncated }
    }

    const run = Effect.fn("ReadTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const instance = yield* InstanceState.context
      const action = resolveAction(params)

      if (params.filePaths != null) {
        let paths: string[]
        try {
          paths = coerceFilePaths(params.filePaths)
        } catch (error) {
          throw error instanceof Error ? error : new Error(String(error))
        }
        if (paths.length === 0) {
          throw new Error("Provide filePath or filePaths[] to read.")
        }
        const overflow = paths.length > MAX_BULK_FILES ? paths.slice(MAX_BULK_FILES) : []
        const batch = paths.slice(0, MAX_BULK_FILES)
        const blocks: string[] = []
        let truncated = false
        for (const input of batch) {
          let filepath = input
          if (!path.isAbsolute(filepath) && !isPosixAbsoluteOnWindows(filepath)) {
            filepath = path.resolve(instance.directory, filepath)
          }
          if (process.platform === "win32" && path.isAbsolute(filepath)) {
            filepath = FSUtil.normalizePath(filepath)
          }
          const resolved = yield* resolveReadPath(fs, { filepath, directory: instance.directory, glob })
          filepath = resolved.filepath
          yield* ctx.ask({
            permission: "read",
            patterns: [path.relative(instance.worktree, filepath)],
            always: ["*"],
            metadata: {},
          })
          yield* assertExternalDirectoryEffect(ctx, filepath, { kind: "file" })
          if (!resolved.stat) {
            const hint = resolved.candidates.length
              ? `\nDid you mean:\n${resolved.candidates.slice(0, 5).join("\n")}`
              : ""
            blocks.push(`<file path="${filepath}">\n<missing />${hint}\n</file>`)
            continue
          }
          const file = yield* clampRead(filepath, { limit: params.limit ?? DEFAULT_READ_LIMIT, offset: params.offset || 1 })
          const heal = resolved.repaired ? renderHeal(input, filepath, resolved.repaired) : ""
          const block = [
            heal,
            `<file path="${filepath}" lines="${file.count}">`,
            "<content>",
            file.raw.map((line, i) => `${i + file.offset}: ${line}`).join("\n"),
            file.more || file.cut
              ? `\n(Showing lines ${file.offset}-${file.offset + file.raw.length - 1} of ${file.count}. Use offset=${file.offset + file.raw.length} to continue.)`
              : "",
            "</content>",
            "</file>",
          ]
            .filter((line) => line !== "")
            .join("\n")
          blocks.push(block)
          truncated = truncated || file.more || file.cut
        }
        if (overflow.length > 0) {
          blocks.push(
            `<remaining count="${overflow.length}">Read ${batch.length} of ${paths.length}. Remaining:\n${overflow.join("\n")}\nCall again with these, or glob + grep.</remaining>`,
          )
        }
        return {
          title: `read ${batch.length} files`,
          output: blocks.join("\n\n"),
          metadata: {
            preview: blocks[0]?.slice(0, 20) ?? "",
            truncated,
            loaded: [] as string[],
            action: "read",
          },
        }
      }

      const filepathIn = normalizeInput(params, instance.directory)
      if (!filepathIn) {
        throw new Error("Provide filePath or filePaths[] to read.")
      }

      const resolved = yield* resolveReadPath(fs, { filepath: filepathIn, directory: instance.directory, glob })
      const filepath = resolved.filepath
      const title = resolved.repaired
        ? `${path.relative(instance.worktree, filepath)} (healed)`
        : path.relative(instance.worktree, filepath)
      const stat = resolved.stat

      yield* assertExternalDirectoryEffect(ctx, filepath, {
        bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
        kind: stat?.type === "Directory" ? "directory" : "file",
      })

      yield* ctx.ask({
        permission: "read",
        patterns: [path.relative(instance.worktree, filepath)],
        always: ["*"],
        metadata: {},
      })

      if (!stat) return yield* miss(filepath, instance.directory, resolved.candidates)

      const repairNote = resolved.repaired
        ? renderHeal(resolved.requested ?? filepathIn, filepath, resolved.repaired)
        : ""
      const healMeta = resolved.repaired
        ? { requested: resolved.requested ?? filepathIn, healed: true as const }
        : {}

      if (stat.type === "Directory") {
        const items = yield* list(filepath)
        const limit = params.limit ?? DEFAULT_READ_LIMIT
        let offset = params.offset || 1
        let start = offset - 1
        let clamped = false
        if (start >= items.length && items.length > 0) {
          offset = Math.max(1, items.length - Math.min(limit, items.length) + 1)
          start = offset - 1
          clamped = true
        }
        const sliced = action === "tail" ? items.slice(Math.max(0, items.length - (params.limit ?? DEFAULT_TAIL))) : items.slice(start, start + limit)
        const usedOffset = action === "tail" ? Math.max(1, items.length - sliced.length + 1) : offset
        const truncated = usedOffset - 1 + sliced.length < items.length

        return {
          title,
          output: [
            repairNote,
            `<path entries="${items.length}">${filepath}</path>`,
            `<type>directory</type>`,
            `<entries>`,
            sliced.join("\n"),
            truncated
              ? `\n(Showing ${sliced.length} of ${items.length} entries. Use offset to continue. This is a directory listing — for patterns use glob.)`
              : `\n(${items.length} entries. This is a directory listing — for patterns use glob.)`,
            clamped ? `\n(offset ${params.offset} past end — ${items.length} entries. Showing last page.)` : "",
            action === "outline" || action === "grep" || action === "around"
              ? `\n<note>${action} needs a file. This is a directory listing — for patterns use glob, for contents use grep.</note>`
              : "",
            `</entries>`,
          ]
            .filter((line) => line !== "")
            .join("\n"),
          metadata: {
            preview: sliced.slice(0, 20).join("\n"),
            truncated,
            loaded: [] as string[],
            action: action === "tail" ? "tail" : "read",
            clamped,
            ...healMeta,
            display: {
              type: "directory" as const,
              path: filepath,
              entries: sliced,
              offset: usedOffset,
              totalEntries: items.length,
              truncated,
            },
          },
        }
      }

      const loaded = yield* instruction.resolve(ctx.messages, filepath, ctx.messageID)
      const sample = yield* readSample(filepath, Number(stat.size), SAMPLE_BYTES)

      const mime = sniffAttachmentMime(sample, FSUtil.mimeType(filepath))
      const isImage = SUPPORTED_IMAGE_MIMES.has(mime)

      if (isImage || isPdfAttachment(mime)) {
        const bytes = yield* fs.readFile(filepath)
        const msg = isPdfAttachment(mime) ? "PDF read successfully" : "Image read successfully"
        return {
          title,
          output: repairNote + msg,
          metadata: {
            preview: msg,
            truncated: false,
            loaded: loaded.map((item) => item.filepath),
            action: "read",
            ...healMeta,
          },
          attachments: [
            {
              type: "file" as const,
              mime,
              url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
            },
          ],
        }
      }

      if (path.extname(filepath).toLowerCase() !== ".br" && isBinaryFile(filepath, sample)) {
        return yield* Effect.fail(new Error(`Cannot read binary file: ${filepath}`))
      }

      if (action === "outline") {
        const cache = yield* InstanceState.get(cacheState)
        const outline = yield* getOutline(fs, cache, filepath)
        const output =
          repairNote +
          (outline
            ? renderOutline(filepath, undefined, outline)
            : `<outline path="${filepath}">unable to outline</outline>`)
        return {
          title: `outline ${title}`,
          output,
          metadata: {
            preview: output.slice(0, 200),
            truncated: false,
            loaded: loaded.map((item) => item.filepath),
            action: "outline",
            ...healMeta,
          },
        }
      }

      if (action === "grep") {
        const pattern = params.pattern ?? params.symbol
        if (!pattern) throw new Error(`grep requires pattern. Example: {"filePath":"${filepath}","pattern":"TODO"}`)
        const found = yield* grepFile(filepath, pattern)
        const output = repairNote + renderGrep(filepath, pattern, found.hits, found.truncated)
        return {
          title: `grep ${title}`,
          output,
          metadata: {
            preview: output.slice(0, 200),
            truncated: found.truncated,
            loaded: loaded.map((item) => item.filepath),
            action: "grep",
            matches: found.hits.length,
            ...healMeta,
          },
        }
      }

      if (action === "around") {
        const name = params.symbol ?? params.pattern
        if (!name) throw new Error(`around requires symbol. Example: {"filePath":"${filepath}","symbol":"ReadTool"}`)
        const cache = yield* InstanceState.get(cacheState)
        const outline = yield* getOutline(fs, cache, filepath)
        const window = outline ? aroundWindow(outline, name) : undefined
        if (!window) {
          const found = yield* grepFile(filepath, name)
          if (found.hits.length === 0) {
            throw new Error(`Symbol '${name}' not found in ${filepath}. Try action="outline" or pattern="${name}".`)
          }
          const hit = found.hits[0]
          const file = yield* clampRead(filepath, {
            offset: Math.max(1, hit.line - 2),
            limit: params.limit ?? AROUND_MAX,
          })
          const rendered = renderWindow(
            filepath,
            file,
            `<note>No outline hit for '${name}'; showing first grep match at L${hit.line}.</note>`,
          )
          yield* warm(filepath)
          return {
            title: `around ${title}`,
            output: repairNote + rendered.output,
            metadata: {
              preview: file.raw.slice(0, 20).join("\n"),
              truncated: rendered.truncated,
              loaded: loaded.map((item) => item.filepath),
              action: "around",
              ...healMeta,
              display: {
                type: "file" as const,
                path: filepath,
                text: file.raw.join("\n"),
                lineStart: file.offset,
                lineEnd: rendered.last,
                totalLines: file.count,
                truncated: rendered.truncated,
              },
            },
          }
        }
        const file = yield* clampRead(filepath, {
          offset: window.offset,
          limit: params.limit ?? window.limit,
        })
        const rendered = renderWindow(
          filepath,
          file,
          `<note>symbol ${window.symbol.kind} ${window.symbol.name} L${window.symbol.line}</note>`,
        )
        yield* warm(filepath)
        return {
          title: `around ${title}`,
          output: repairNote + rendered.output,
          metadata: {
            preview: file.raw.slice(0, 20).join("\n"),
            truncated: rendered.truncated,
            loaded: loaded.map((item) => item.filepath),
            action: "around",
            ...healMeta,
            display: {
              type: "file" as const,
              path: filepath,
              text: file.raw.join("\n"),
              lineStart: file.offset,
              lineEnd: rendered.last,
              totalLines: file.count,
              truncated: rendered.truncated,
            },
          },
        }
      }

      const file =
        action === "tail"
          ? yield* tailFile(filepath, params.limit ?? DEFAULT_TAIL)
          : yield* clampRead(filepath, { limit: params.limit ?? DEFAULT_READ_LIMIT, offset: params.offset || 1 })

      const rendered = renderWindow(filepath, file)
      yield* warm(filepath)

      let output = repairNote + rendered.output
      if (loaded.length > 0) {
        output += `\n\n<system-reminder>\n${loaded.map((item) => item.content).join("\n\n")}\n</system-reminder>`
      }

      return {
        title,
        output,
        metadata: {
          preview: file.raw.slice(0, 20).join("\n"),
          truncated: rendered.truncated,
          loaded: loaded.map((item) => item.filepath),
          action: action === "tail" ? "tail" : "read",
          clamped: Boolean(file.clamped),
          ...healMeta,
          display: {
            type: "file" as const,
            path: filepath,
            text: file.raw.join("\n"),
            lineStart: file.offset,
            lineEnd: rendered.last,
            totalLines: file.count,
            truncated: rendered.truncated,
          },
        },
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      formatValidationError: (error) => {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes("filePaths")) {
          return 'filePaths must be a JSON array of strings, not a string. Example: {"filePaths":["C:\\\\proj\\\\a.ts","C:\\\\proj\\\\b.ts"]}'
        }
        return message
      },
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
