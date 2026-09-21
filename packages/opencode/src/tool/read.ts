import { Effect, Option, Schema, Scope } from "effect"
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
import { getOutline, makeOutlineCache } from "./symbols/outline"
import {
  coerceFilePaths,
  isPosixAbsoluteOnWindows,
  posixSuffixes,
  resolveReadPath,
  statPath,
  type GlobSearch,
} from "./read/path"
import { AROUND_MAX, renderGrep, renderHeal, renderOutline, aroundWindow } from "./read/inspect"
import { globalReadCache } from "./edit/prior-read"
import { ReadFilesystem } from "@/read/filesystem"

const DEFAULT_READ_LIMIT = ReadFilesystem.DEFAULT_READ_LIMIT
const MAX_BYTES = ReadFilesystem.MAX_BYTES
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024} KB`
const SAMPLE_BYTES = ReadFilesystem.SAMPLE_BYTES
const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])
const MAX_BULK_FILES = 8
const DEFAULT_TAIL = ReadFilesystem.DEFAULT_TAIL
const HINT =
  'Tip: action="outline" for a symbol TOC, pattern="name" to search this file, symbol="name" to jump to a definition.'

const BatchRead = Schema.Struct({
  filePath: Schema.String.annotate({
    description: "Path for this read window. Relative paths resolve from the project directory.",
  }),
  offset: Schema.optional(NonNegativeInt).annotate({
    description: "1-based start line for this target (default 1).",
  }),
  limit: Schema.optional(NonNegativeInt).annotate({
    description: "Maximum lines for this target (default 2000).",
  }),
})

// Prior-read grounding (D47): every successful file-content read records
// mtime+size so edit/patch can refuse targets that moved under the model.
// Directory listings are not recorded — they ground no edit.
const noteRead = (
  sessionID: string,
  filepath: string,
  stat: { type: string; mtime: Option.Option<Date>; size: unknown } | undefined,
) => {
  if (!stat || stat.type === "Directory") return
  globalReadCache.recordRead(
    sessionID,
    filepath,
    Option.getOrElse(stat.mtime, () => new Date(0)).getTime(),
    Number(stat.size),
  )
}

export const Parameters = Schema.Struct({
  filePath: Schema.optional(Schema.String).annotate({
    description:
      "Single-target path. If 2-8 read targets are already known, batch them with filePaths[] or reads[] instead of making separate read calls.",
  }),
  file_path: Schema.optional(Schema.String).annotate({
    description: "Alias for filePath",
  }),
  filePaths: Schema.optional(Schema.Union([Schema.Array(Schema.String), Schema.String])).annotate({
    description:
      "ECONOMY: batch 2-8 known text files into ONE plain-read call when they can share the same offset/limit. Prefer a JSON array. Use reads[] when targets need different windows. Mutually exclusive with filePath/reads.",
  }),
  reads: Schema.optional(Schema.Array(BatchRead)).annotate({
    description:
      "ECONOMY: batch up to 8 known text-file windows into ONE plain-read call. Each item has its own filePath and optional offset/limit, so different ranges do not require separate tool calls. Mutually exclusive with filePath/filePaths and top-level offset/limit.",
  }),
  offset: Schema.optional(NonNegativeInt).annotate({
    description:
      "The line number to start reading from (1-indexed). Past EOF clamps to the last page. Applies to filePath/filePaths; reads[] carries per-target offsets.",
  }),
  limit: Schema.optional(NonNegativeInt).annotate({
    description:
      "The maximum number of lines to read (defaults to 2000). Applies to filePath/filePaths; reads[] carries per-target limits.",
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

const hasText = (value: string | undefined) => typeof value === "string" && value.trim().length > 0

const resolveSinglePathInput = (params: Schema.Schema.Type<typeof Parameters>) => {
  const primary = hasText(params.filePath) ? params.filePath : undefined
  const alias = hasText(params.file_path) ? params.file_path : undefined
  if (primary && alias && primary !== alias) {
    throw new Error("filePath and file_path disagree. Provide only one path value, or make the aliases identical.")
  }
  return primary ?? alias
}

const hasFilePathsInput = (value: Schema.Schema.Type<typeof Parameters>["filePaths"]) =>
  typeof value === "string" ? hasText(value) : (value?.some(hasText) ?? false)

const hasTopLevelWindow = (value: number | undefined) => typeof value === "number" && value > 0

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

type LineResult = ReadFilesystem.LineResult

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
        new Error(`File not found: ${filepath}${posix}\nNo unique same-name file to open. Use Find with glob for the basename.`),
      )
    })

    const list = (filepath: string) => ReadFilesystem.list(fs, filepath)

    const warm = Effect.fn("ReadTool.warm")(function* (filepath: string) {
      yield* lsp.touchFile(filepath).pipe(Effect.ignoreCause, Effect.forkIn(scope))
    })

    const readSample = (filepath: string, fileSize: number, sampleSize: number) =>
      ReadFilesystem.readSample(fs, filepath, fileSize, sampleSize)
    const clampRead = (filepath: string, opts: { limit: number; offset: number }) =>
      ReadFilesystem.clampRead(fs, filepath, opts)

    const grepFile = Effect.fn("ReadTool.grepFile")(function* (filepath: string, pattern: string) {
      return yield* ReadFilesystem.grep(fs, ripgrep, filepath, pattern)
    })
    const tailFile = (filepath: string, limit: number) => ReadFilesystem.tail(fs, filepath, limit)
    const isBinaryFile = ReadFilesystem.isBinary

    const normalizeInput = (input: string | undefined, directory: string) => {
      let filepath = input
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

      const singlePathInput = resolveSinglePathInput(params)
      const hasSinglePath = singlePathInput !== undefined
      let filePathsInput: string[] = []
      if (hasFilePathsInput(params.filePaths)) {
        try {
          filePathsInput = coerceFilePaths(params.filePaths!).filter(hasText)
        } catch (error) {
          throw error instanceof Error ? error : new Error(String(error))
        }
      }
      const readsInput = Array.isArray(params.reads) ? params.reads.filter((item) => hasText(item.filePath)) : []
      const hasFilePaths = filePathsInput.length > 0
      const hasReads = readsInput.length > 0
      const singlePathIsBatchEcho =
        hasSinglePath && hasFilePaths && filePathsInput.some((filePath) => filePath === singlePathInput)
      const hasIndependentSinglePath = hasSinglePath && !singlePathIsBatchEcho
      if (Number(hasIndependentSinglePath) + Number(hasFilePaths) + Number(hasReads) > 1) {
        throw new Error(
          "Choose exactly one read pathway: filePath/file_path for one target, filePaths[] for 2-8 targets sharing one offset/limit, or reads[] for 2-8 targets with per-target windows.",
        )
      }
      const hasWindowDefaults = hasTopLevelWindow(params.offset) || hasTopLevelWindow(params.limit)
      const topLevelWindowDuplicatesReads =
        hasReads &&
        readsInput.every(
          (item) =>
            (!hasTopLevelWindow(params.offset) || item.offset === params.offset) &&
            (!hasTopLevelWindow(params.limit) || item.limit === params.limit),
        )
      if (hasReads && hasWindowDefaults && !topLevelWindowDuplicatesReads) {
        throw new Error(
          "Top-level offset/limit cannot be combined with reads[]. Put offset/limit on each reads[] item instead.",
        )
      }
      if (
        (hasFilePaths || hasReads) &&
        (hasText(params.pattern) ||
          hasText(params.symbol) ||
          (params.action !== undefined && params.action !== "read"))
      ) {
        throw new Error(
          "filePaths[]/reads[] are plain text-window batch pathways. pattern, symbol, outline, grep, around, and tail are single-target operations; use filePath for those, then batch the resulting known ranges if needed.",
        )
      }

      if (hasFilePaths || hasReads) {
        let requests: Array<{ filePath: string; offset?: number; limit?: number }>
        if (hasReads) {
          requests = readsInput.map((item) => ({ filePath: item.filePath, offset: item.offset, limit: item.limit }))
        } else {
          requests = filePathsInput.map((filePath) => ({ filePath, offset: params.offset, limit: params.limit }))
        }
        if (requests.length === 0) {
          throw new Error("Provide at least one target in filePaths[] or reads[].")
        }
        const overflow = requests.length > MAX_BULK_FILES ? requests.slice(MAX_BULK_FILES) : []
        const batch = requests.slice(0, MAX_BULK_FILES)
        const blocks: string[] = []
        let truncated = false
        for (const request of batch) {
          const input = request.filePath
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
          const file = yield* clampRead(filepath, {
            limit: request.limit ?? DEFAULT_READ_LIMIT,
            offset: request.offset || 1,
          })
          noteRead(ctx.sessionID, filepath, resolved.stat)
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
            `<remaining count="${overflow.length}">Read ${batch.length} of ${requests.length}. Remaining:\n${overflow
              .map((item) => item.filePath)
              .join("\n")}\nCall again with these, or use Find with glob/grep.</remaining>`,
          )
        }
        return {
          title: `read ${batch.length} targets`,
          output: blocks.join("\n\n"),
          metadata: {
            preview: blocks[0]?.slice(0, 20) ?? "",
            truncated,
            loaded: [] as string[],
            action: "read",
          },
        }
      }

      const filepathIn = normalizeInput(singlePathInput, instance.directory)
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
              ? `\n(Showing ${sliced.length} of ${items.length} entries. Use offset to continue. This is a directory listing — for patterns use Find with glob.)`
              : `\n(${items.length} entries. This is a directory listing — for patterns use Find with glob.)`,
            clamped ? `\n(offset ${params.offset} past end — ${items.length} entries. Showing last page.)` : "",
            action === "outline" || action === "grep" || action === "around"
              ? `\n<note>${action} needs a file. This is a directory listing — use Find with glob for paths or Find with grep for contents.</note>`
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

      noteRead(ctx.sessionID, filepath, stat)

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
