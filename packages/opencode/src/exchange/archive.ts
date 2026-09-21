export * as ExchangeArchive from "./archive"

import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import type { Schema } from "effect"
import type { FSUtil } from "@opencode-ai/core/fs-util"
import * as ArchiveCore from "@/tool/archive"
import * as ArchiveFormat from "@/tool/archive/format"
import { ArchiveSystem } from "@/tool/archive/system"
import { ExchangeError } from "./error"

export const Parameters = ArchiveCore.Parameters
export type Input = Schema.Schema.Type<typeof Parameters>
export const SYSTEM_OUTPUT_CAP = 4 * 1024 * 1024

export interface ApprovedPath {
  readonly native: string
  readonly virtual: string
  readonly rootPath: string
}

export interface Hooks<E> {
  readonly resolveRead: (inputPath: string) => Effect.Effect<ApprovedPath, ExchangeError.Error | E>
  readonly resolveWrite: (
    inputPath: string,
    allowMissing: boolean,
  ) => Effect.Effect<ApprovedPath, ExchangeError.Error | E>
  readonly runSystem: (
    tool: string,
    args: readonly string[],
    signal?: AbortSignal,
  ) => Effect.Effect<ArchiveSystem.RunResult, ExchangeError.Error | E>
  /** Called immediately before publishing a completed create temp file. */
  readonly beforeCreateCommit?: (destination: ApprovedPath) => Effect.Effect<void, ExchangeError.Error | E>
  /** Called immediately before every externally visible extraction mutation. */
  readonly beforeExtractMutation?: (
    destination: ApprovedPath,
    target: string,
    kind: "file" | "directory",
  ) => Effect.Effect<void, ExchangeError.Error | E>
}

export interface Result {
  readonly title: string
  readonly output: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly mutation: { readonly attempted: boolean; readonly committed: boolean }
  readonly targetRef?: string
}

function virtualize(text: string, replacements: readonly [string, string][] = []) {
  let detail = text
  for (const [native, virtual] of replacements) {
    if (!native) continue
    detail = detail.split(native).join(virtual)
    detail = detail.split(native.replaceAll("\\", "/")).join(virtual)
    detail = detail.split(native.replaceAll("/", "\\")).join(virtual)
  }
  return detail
}

function operationError(error: unknown, replacements: readonly [string, string][] = []) {
  const detail = virtualize(error instanceof Error ? error.message : String(error), replacements)
  return new ExchangeError.InvalidArgument({ detail: detail.slice(0, 1500) })
}

const ensureFile = Effect.fn("ExchangeArchive.ensureFile")(function* (
  fs: FSUtil.Interface,
  item: ApprovedPath,
) {
  const stat = yield* fs.stat(item.native).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!stat || stat.type !== "File") {
    return yield* new ExchangeError.NotFound({ detail: `Archive file does not exist: ${item.virtual}` })
  }
})

export function execute<E>(
  fs: FSUtil.Interface,
  input: Input,
  hooks: Hooks<E>,
  signal?: AbortSignal,
): Effect.Effect<Result, ExchangeError.Error | E> {
  return Effect.gen(function* () {
    if (signal?.aborted) return yield* new ExchangeError.Cancelled({ detail: "Archive request was cancelled" })
    const action = input.action

    if (action === "create") {
      if (!input.source?.length) {
        return yield* new ExchangeError.InvalidArgument({ detail: "archive.create requires one or more source paths" })
      }
      const destination = yield* hooks.resolveWrite(input.path, true)
      const destinationStat = yield* fs.stat(destination.native).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (destinationStat?.type === "Directory") {
        return yield* new ExchangeError.InvalidArgument({ detail: "archive.create destination must be a file path" })
      }
      const sources: ApprovedPath[] = []
      for (const source of input.source) {
        const item = yield* hooks.resolveRead(source)
        const stat = yield* fs.stat(item.native).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!stat || (stat.type !== "File" && stat.type !== "Directory")) {
          return yield* new ExchangeError.NotFound({ detail: `Archive source does not exist: ${item.virtual}` })
        }
        sources.push(item)
      }
      const format = ArchiveFormat.createFormatForExt(destination.native)
      if (!format) {
        return yield* new ExchangeError.InvalidArgument({
          detail: "Cannot infer archive format. Supported create formats: .zip, .tar, .tar.gz/.tgz, .gz, .br, .zst, .tar.zst",
        })
      }
      if (
        format.kind === "7z" ||
        (format.kind === "compressed" && !ArchiveFormat.PURE_COMPRESSIONS.has(format.compression))
      ) {
        return yield* new ExchangeError.InvalidArgument({
          detail:
            "This archive format requires a system backend for creation; external exchange permits system backends only for read-only list/read operations",
        })
      }

      // Build beside the destination so the final publication is one rename on
      // the same filesystem. The temp name is internal/transient; the durable
      // mutation boundary is the destination publication immediately below.
      const temporary = `${destination.native}.openfork-${randomUUID()}.tmp`
      const replacements = [
        [destination.native, destination.virtual],
        ...sources.map((source) => [source.native, source.virtual] as [string, string]),
      ] as [string, string][]
      const summary = yield* Effect.gen(function* () {
        const created = yield* Effect.tryPromise({
          try: () => ArchiveCore.createPure(temporary, format, sources.map((source) => source.native)),
          catch: (error) => operationError(error, replacements),
        })
        if (hooks.beforeCreateCommit) yield* hooks.beforeCreateCommit(destination)
        yield* fs.rename(temporary, destination.native).pipe(
          Effect.mapError(
            () => new ExchangeError.DependencyUnavailable({ detail: "Unable to atomically publish created archive" }),
          ),
        )
        return created
      }).pipe(Effect.ensuring(fs.remove(temporary).pipe(Effect.ignore)))
      const visible = virtualize(summary, replacements)
      return {
        title: destination.virtual,
        output: visible,
        metadata: {
          action,
          format: ArchiveCore.formatLabel(format),
          count: sources.length,
          truncated: false,
          preview: visible.slice(0, 500),
        },
        mutation: { attempted: true, committed: true },
        targetRef: destination.virtual,
      }
    }

    const archive = yield* hooks.resolveRead(input.path)
    yield* ensureFile(fs, archive)
    const format = yield* Effect.tryPromise({
      try: () => ArchiveCore.detectArchive(archive.native),
      catch: (error) => operationError(error, [[archive.native, archive.virtual]]),
    })
    if (format.kind === "unknown") {
      return yield* new ExchangeError.InvalidArgument({ detail: "Unrecognized archive format" })
    }

    if (action === "list") {
      let entries: ArchiveCore.DisplayEntry[]
      let resolvedFormat = format
      if (ArchiveCore.isSystemFormat(format)) {
        const backend = yield* Effect.tryPromise({
          try: () => ArchiveSystem.resolveBackend(format),
          catch: (error) => operationError(error, [[archive.native, archive.virtual]]),
        })
        const args = ArchiveSystem.listArgs(backend, archive.native)
        let result = yield* hooks.runSystem(backend.tool, args, signal)
        // Windows system archive tools can occasionally exit 0 before any
        // piped listing bytes are observed by the parent under process load.
        // The direct ArchiveSystem path already retries this exact ambiguous
        // success once. Keep Exchange/OXP behavior identical: a second empty
        // success still represents a legitimate empty archive.
        if (result.code === 0 && result.stdout.length === 0) {
          result = yield* hooks.runSystem(backend.tool, args, signal)
        }
        if (result.code !== 0) {
          return yield* new ExchangeError.InvalidArgument({
            detail: `Archive backend failed: ${virtualize(result.stderr.trim() || new TextDecoder().decode(result.stdout).slice(0, 300), [[archive.native, archive.virtual]])}`,
          })
        }
        entries = ArchiveSystem.parseList(backend, result.stdout).map((entry) => ({ ...entry, unsafe: false }))
      } else {
        const resolved = yield* Effect.tryPromise({
          try: () => ArchiveCore.resolveEntries(archive.native, format),
          catch: (error) => operationError(error, [[archive.native, archive.virtual]]),
        })
        if (resolved.format.kind === "unknown") {
          return yield* new ExchangeError.InvalidArgument({ detail: "Unrecognized archive format after decompression" })
        }
        resolvedFormat = resolved.format
        entries = resolved.entries
      }
      const filtered = ArchiveCore.sortEntries(ArchiveCore.filterEntries(entries, input.entries ?? []))
      const output = ArchiveCore.renderList(archive.virtual, resolvedFormat, filtered, Boolean(input.entries?.length))
      return {
        title: archive.virtual,
        output,
        metadata: {
          action,
          format: ArchiveCore.formatLabel(resolvedFormat),
          count: filtered.length,
          truncated: filtered.length > 200,
          preview: output.slice(0, 500),
        },
        mutation: { attempted: false, committed: false },
      }
    }

    if (action === "read") {
      const entry = input.entry
      if (!entry && !(format.kind === "compressed" && format.container === "single")) {
        return yield* new ExchangeError.InvalidArgument({
          detail: "archive.read requires entry except for a single-file compressed stream",
        })
      }
      let name: string
      let data: Uint8Array
      if (ArchiveCore.isSystemFormat(format)) {
        const backend = yield* Effect.tryPromise({
          try: () => ArchiveSystem.resolveBackend(format),
          catch: (error) => operationError(error, [[archive.native, archive.virtual]]),
        })
        let result = yield* hooks.runSystem(
          backend.tool,
          ArchiveSystem.readArgs(
            backend,
            archive.native,
            format.kind === "compressed" && format.container === "single" ? "" : entry!,
          ),
          signal,
        )
        // On Windows, the same pipe-capture race that affects system archive
        // listings can also yield exit code 0 with an empty stdout buffer for
        // a real non-empty entry. Retry that ambiguous success exactly once.
        // Legitimately empty archive entries remain empty after the retry.
        if (result.code === 0 && result.stdout.length === 0) {
          result = yield* hooks.runSystem(
            backend.tool,
            ArchiveSystem.readArgs(
              backend,
              archive.native,
              format.kind === "compressed" && format.container === "single" ? "" : entry!,
            ),
            signal,
          )
        }
        if (result.code !== 0) {
          return yield* new ExchangeError.InvalidArgument({
            detail: `Archive backend could not read the entry: ${virtualize(result.stderr.trim() || "entry not found", [[archive.native, archive.virtual]])}`,
          })
        }
        const decoded = new TextDecoder("utf8", { fatal: false }).decode(result.stdout)
        if (decoded.includes("\uFFFD") || decoded.includes("\0")) {
          return yield* new ExchangeError.InvalidArgument({
            detail: "Archive entry appears binary; archive.read only returns bounded text entries",
          })
        }
        name = entry ?? ArchiveCore.stripCompressionExt(archive.virtual)
        data = result.stdout
      } else {
        const resolved = yield* Effect.tryPromise({
          try: () => ArchiveCore.readEntryData(archive.native, format, entry!),
          catch: (error) => operationError(error, [[archive.native, archive.virtual]]),
        })
        name = resolved.name
        data = resolved.data
      }
      const rendered = yield* Effect.try({
        try: () => ArchiveCore.renderRead(archive.virtual, name, data, input.offset ?? 1, input.limit),
        catch: (error) => operationError(error, [[archive.native, archive.virtual]]),
      })
      return {
        title: `${archive.virtual}:${name}`,
        output: rendered.output,
        metadata: {
          action,
          format: ArchiveCore.formatLabel(format),
          count: data.length,
          truncated: rendered.truncated,
          preview: rendered.output.slice(0, 500),
        },
        mutation: { attempted: false, committed: false },
      }
    }

    // extract
    const singleByExt = format.kind === "compressed" && format.container === "single"
    const pureSingle = singleByExt && ArchiveFormat.PURE_COMPRESSIONS.has(format.compression)
    let destinationInput = input.destination
    if (!destinationInput) {
      const nativeDefault = pureSingle
        ? path.join(path.dirname(archive.native), ArchiveCore.stripCompressionExt(archive.native))
        : ArchiveFormat.defaultDestination(archive.native)
      destinationInput = path.relative(archive.rootPath, nativeDefault).split(path.sep).join("/")
    }
    let destination = yield* hooks.resolveWrite(destinationInput, true)
    if (
      pureSingle &&
      (yield* Effect.tryPromise(() => ArchiveCore.isDirectory(destination.native)).pipe(Effect.catch(() => Effect.succeed(false))))
    ) {
      const child = path.join(destination.native, ArchiveCore.stripCompressionExt(archive.native))
      const childRel = path.relative(archive.rootPath, child).split(path.sep).join("/")
      destination = yield* hooks.resolveWrite(childRel, true)
    }
    if (ArchiveCore.isSystemFormat(format)) {
      return yield* new ExchangeError.InvalidArgument({
        detail:
          "External system-backed archive extraction is disabled until tar/7z link and traversal behavior is verified; list/read remain available with process authority",
      })
    }
    const resolved = yield* Effect.tryPromise({
      try: () => ArchiveCore.resolveEntries(archive.native, format),
      catch: (error) => operationError(error, [[archive.native, archive.virtual]]),
    })
    const isSingleFile = resolved.format.kind === "compressed" && resolved.format.container === "single"
    const selection = isSingleFile ? resolved.entries : ArchiveCore.filterEntries(resolved.entries, input.entries ?? [])
    const extractionDestination = destination
    const result = yield* Effect.tryPromise({
      try: () =>
        ArchiveCore.extractPure(
          archive.native,
          resolved.format,
          extractionDestination.native,
          selection,
          input.overwrite ?? false,
          signal ?? AbortSignal.any([]),
          hooks.beforeExtractMutation
            ? {
                beforeMutation: (target, kind) =>
                  Effect.runPromise(hooks.beforeExtractMutation!(extractionDestination, target, kind)),
              }
            : undefined,
        ),
      catch: (error) =>
        operationError(error, [
          [archive.native, archive.virtual],
          [extractionDestination.native, extractionDestination.virtual],
        ]),
    })
    const output = ArchiveCore.renderExtract(archive.virtual, extractionDestination.virtual, result)
    return {
      title: archive.virtual,
      output,
      metadata: {
        action,
        format: ArchiveCore.formatLabel(resolved.format),
        count: result.extracted,
        truncated: false,
        preview: output.slice(0, 500),
      },
      mutation: { attempted: true, committed: true },
      targetRef: extractionDestination.virtual,
    }
  })
}

