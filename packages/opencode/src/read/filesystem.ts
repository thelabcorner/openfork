import path from "path"
import z from "node:zlib"
import { Effect, Option, Stream } from "effect"
import type { FSUtil } from "@opencode-ai/core/fs-util"
import type { Ripgrep } from "@opencode-ai/core/ripgrep"

export const DEFAULT_READ_LIMIT = 2000
export const DEFAULT_TAIL = 80
export const MAX_LINE_LENGTH = 2000
export const MAX_BYTES = 50 * 1024
export const SAMPLE_BYTES = 4096
export const GREP_MAX = 50

const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`

class ReadStop extends Error {}

export class Aborted extends Error {
  override name = "AbortError"
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new Aborted("Read cancelled")
}

export interface LineResult {
  readonly raw: readonly string[]
  readonly count: number
  readonly cut: boolean
  readonly more: boolean
  readonly offset: number
  readonly clamped?: boolean
  readonly requestedOffset?: number
}

export const list = Effect.fn("ReadFilesystem.list")(function* (fs: FSUtil.Interface, filepath: string) {
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
  ).pipe(Effect.map((entries: string[]) => entries.sort((a, b) => a.localeCompare(b))))
})

export const readSample = Effect.fn("ReadFilesystem.readSample")(function* (
  fs: FSUtil.Interface,
  filepath: string,
  fileSize: number,
  sampleSize = SAMPLE_BYTES,
  signal?: AbortSignal,
) {
  checkAbort(signal)
  if (fileSize === 0) return new Uint8Array()
  const bytes = yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(filepath, { flag: "r" })
      return Option.getOrElse(yield* file.readAlloc(Math.min(sampleSize, fileSize)), () => new Uint8Array())
    }),
  )
  checkAbort(signal)
  return bytes
})

const lines = Effect.fn("ReadFilesystem.lines")(function* (
  fs: FSUtil.Interface,
  filepath: string,
  opts: { readonly limit: number; readonly offset: number; readonly signal?: AbortSignal },
) {
  checkAbort(opts.signal)
  const start = opts.offset - 1
  const raw: string[] = []
  const flags = { bytes: 0, count: 0, cut: false, more: false, done: false }
  const decoder = new TextDecoder("utf-8")
  yield* fs.stream(filepath).pipe(
    Stream.map((bytes) => decoder.decode(bytes, { stream: true })),
    Stream.splitLines,
    Stream.runForEach((text) =>
      Effect.gen(function* () {
        if (opts.signal?.aborted) return yield* Effect.fail(new Aborted("Read cancelled"))
        if (flags.done) return yield* Effect.fail(new ReadStop())
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
        return yield* Effect.fail(new ReadStop())
      }),
    ),
    Effect.catchIf((error) => error instanceof ReadStop, () => Effect.void),
  )
  return { raw, count: flags.count, cut: flags.cut, more: flags.more, offset: opts.offset } satisfies LineResult
})

const brotliLines = Effect.fn("ReadFilesystem.brotliLines")(function* (
  fs: FSUtil.Interface,
  filepath: string,
  opts: { readonly limit: number; readonly offset: number; readonly signal?: AbortSignal },
) {
  checkAbort(opts.signal)
  const compressed = yield* fs.readFile(filepath)
  checkAbort(opts.signal)
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
  } satisfies LineResult
})

export const readLines = Effect.fn("ReadFilesystem.readLines")(function* (
  fs: FSUtil.Interface,
  filepath: string,
  opts: { readonly limit: number; readonly offset: number; readonly signal?: AbortSignal },
) {
  return path.extname(filepath).toLowerCase() === ".br"
    ? yield* brotliLines(fs, filepath, opts)
    : yield* lines(fs, filepath, opts)
})

export const clampRead = Effect.fn("ReadFilesystem.clampRead")(function* (
  fs: FSUtil.Interface,
  filepath: string,
  opts: { readonly limit: number; readonly offset: number; readonly signal?: AbortSignal },
) {
  const file = yield* readLines(fs, filepath, opts)
  if (file.raw.length > 0 || (file.count === 0 && opts.offset <= 1)) return { ...file, clamped: false } satisfies LineResult
  if (file.count === 0) return { ...file, clamped: true, requestedOffset: opts.offset } satisfies LineResult
  const offset = Math.max(1, file.count - Math.min(opts.limit, file.count) + 1)
  const next = yield* readLines(fs, filepath, { limit: opts.limit, offset, signal: opts.signal })
  return { ...next, clamped: true, requestedOffset: opts.offset } satisfies LineResult
})

export const tail = Effect.fn("ReadFilesystem.tail")(function* (
  fs: FSUtil.Interface,
  filepath: string,
  limit: number,
  signal?: AbortSignal,
) {
  checkAbort(signal)
  const ring: string[] = []
  let count = 0
  const decoder = new TextDecoder("utf-8")
  yield* fs.stream(filepath).pipe(
    Stream.map((bytes) => decoder.decode(bytes, { stream: true })),
    Stream.splitLines,
    Stream.runForEach((text) =>
      Effect.gen(function* () {
        if (signal?.aborted) return yield* Effect.fail(new Aborted("Read cancelled"))
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

export const grep = Effect.fn("ReadFilesystem.grep")(function* (
  fs: FSUtil.Interface,
  ripgrep: Ripgrep.Interface,
  filepath: string,
  pattern: string,
  signal?: AbortSignal,
) {
  checkAbort(signal)
  if (path.extname(filepath).toLowerCase() === ".br") {
    const file = yield* brotliLines(fs, filepath, { offset: 1, limit: Number.MAX_SAFE_INTEGER, signal })
    let expression: RegExp
    try {
      expression = new RegExp(pattern)
    } catch {
      expression = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    }
    const hits: Array<{ line: number; text: string }> = []
    for (let index = 0; index < file.raw.length; index++) {
      if (!expression.test(file.raw[index]!)) continue
      hits.push({ line: index + 1, text: file.raw[index]! })
      if (hits.length >= GREP_MAX) break
    }
    return { hits, truncated: hits.length >= GREP_MAX, count: file.count }
  }
  const result = yield* ripgrep.grep({ cwd: path.dirname(filepath), pattern, file: path.basename(filepath), limit: GREP_MAX, signal }).pipe(
    Effect.catchTag("Ripgrep.InvalidPatternError", () =>
      ripgrep.grep({
        cwd: path.dirname(filepath),
        pattern: pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        file: path.basename(filepath),
        limit: GREP_MAX,
        signal,
      }),
    ),
  )
  return {
    hits: result.map((item) => ({ line: item.line, text: item.text.trimEnd() })),
    truncated: result.length >= GREP_MAX,
    count: result.length,
  }
})

export function isBinary(filepath: string, bytes: Uint8Array) {
  const ext = path.extname(filepath).toLowerCase()
  if ([
    ".zip", ".tar", ".gz", ".exe", ".dll", ".so", ".class", ".jar", ".war", ".7z",
    ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp",
    ".bin", ".dat", ".obj", ".o", ".a", ".lib", ".wasm", ".pyc", ".pyo",
  ].includes(ext)) return true
  if (bytes.length === 0) return false
  let nonPrintable = 0
  for (const byte of bytes) {
    if (byte === 0) return true
    if (byte < 9 || (byte > 13 && byte < 32)) nonPrintable++
  }
  return nonPrintable / bytes.length > 0.3
}

export * as ReadFilesystem from "./filesystem"
