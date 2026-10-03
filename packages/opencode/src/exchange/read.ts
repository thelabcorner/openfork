import { Effect, Option } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CodingActivity } from "@opencode-ai/core/coding-activity"
import { ToolOutputProjection } from "@opencode-ai/core/tool-output-projection"
import { ReadFilesystem } from "@/read/filesystem"
import { isPdfAttachment, sniffAttachmentMime } from "@/util/media"
import { ExchangeAttribution } from "./attribution"
import { ExchangeError } from "./error"

const OUTPUT_BYTES = 96 * 1024
const OUTPUT_LINES = 500
const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])

export const InvalidArgument = ExchangeError.InvalidArgument
export const Cancelled = ExchangeError.Cancelled
export const DependencyUnavailable = ExchangeError.DependencyUnavailable
export const Conflict = ExchangeError.Conflict
export type Error = ExchangeError.Error

export interface Attachment {
  readonly kind: "file" | "resource"
  readonly handle: string
  readonly mediaType?: string
  readonly name?: string
  readonly bytes?: number
}

export interface Result {
  readonly title?: string
  readonly output: string
  readonly attachments?: readonly Attachment[]
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface Input {
  /** Already-authorized canonical local target. Never resolved from caller cwd. */
  readonly path: string
  /** Public/root-relative spelling safe to cross the external boundary. */
  readonly displayPath: string
  readonly action?: "read" | "tail"
  readonly offset?: number
  readonly limit?: number
  readonly signal?: AbortSignal
  readonly projectionMarker?: string
  /**
   * Optional boundary attribution folded into the single read record. It is the
   * only thing that can give this producer a `projectFolder`; the display-path
   * heuristic below names a project and never a directory.
   */
  readonly attribution?: ExchangeAttribution.Attribution
}

export interface Execution {
  readonly result: Result
  /** Stable text-file stat fingerprint for principal-specific edit grounding. */
  readonly fingerprint?: string
}

export interface Hooks<E> {
  /** Re-check principal authority immediately before any local bytes escape. */
  readonly revalidate: () => Effect.Effect<unknown, E>
}

function positive(value: number | undefined, fallback: number) {
  if (value === undefined) return Effect.succeed(fallback)
  if (!Number.isSafeInteger(value) || value <= 0) {
    return Effect.fail(new InvalidArgument({ detail: "offset/limit must be positive integers" }))
  }
  return Effect.succeed(value)
}

export function statFingerprint(stat: { readonly mtime: Option.Option<Date>; readonly size: unknown }) {
  return `${Option.getOrElse(stat.mtime, () => new Date(0)).getTime()}:${Number(stat.size)}`
}

/**
 * Display-name-only project heuristic for producers no boundary attributed.
 *
 * It derives a *name*, so it can never supply a project folder. Attributed
 * boundaries carry their own canonical root instead; see `ExchangeAttribution`.
 */
function projectName(entity: string, displayPath: string) {
  const canonical = entity.replace(/\\/g, "/")
  const relative = displayPath.replace(/\\/g, "/").replace(/^\.\//, "")
  if (relative && canonical.endsWith(`/${relative}`)) {
    const root = canonical.slice(0, canonical.length - relative.length - 1)
    const name = root.slice(root.lastIndexOf("/") + 1)
    if (name) return name
  }
  const segments = canonical.split("/").filter(Boolean)
  return segments.length > 1 ? segments[segments.length - 2] : segments[0]
}

const recordRead = (input: Input) =>
  CodingActivity.record({
    entity: input.path,
    kind: "read",
    ...ExchangeAttribution.apply(input.attribution, { project: projectName(input.path, input.displayPath) }),
  }).pipe(Effect.ignore)

function dependency(error: unknown): Error {
  if (error instanceof ReadFilesystem.Aborted || (error instanceof globalThis.Error && error.name === "AbortError")) {
    return new Cancelled({ detail: "Read was cancelled" })
  }
  return new DependencyUnavailable({ detail: "Read dependency is unavailable" })
}

function renderWindow(displayPath: string, file: ReadFilesystem.LineResult) {
  const last = file.raw.length === 0 ? file.offset - 1 : file.offset + file.raw.length - 1
  const next = last + 1
  let output = `<path lines="${file.count}">${displayPath}</path>\n<type>file</type>\n<content>\n`
  output += file.raw.map((line, index) => `${index + file.offset}: ${line}`).join("\n")
  if (file.clamped && file.requestedOffset !== undefined) {
    output += `\n\n(offset ${file.requestedOffset} is past end of file — ${file.count} lines. Showing last page ${file.offset}-${Math.max(file.offset, last)}.)`
  } else if (file.cut || file.more) {
    output += `\n\n(Showing lines ${file.offset}-${last} of ${file.count}. Use offset=${next} to continue.)`
  } else {
    output += `\n\n(End of file - total ${file.count} lines)`
  }
  output += "\n</content>"
  const truncated = file.cut || file.more
  return {
    output,
    truncated,
    ...(truncated ? { nextOffset: next } : {}),
  }
}

function project(result: Result, marker: string) {
  const projected = ToolOutputProjection.project(result.output, {
    maxLines: OUTPUT_LINES,
    maxBytes: OUTPUT_BYTES,
    strategy: "head",
    marker,
  })
  const metadata: Record<string, unknown> = {
    ...result.metadata,
    projectionTruncated: projected.truncated,
    truncated:
      projected.truncated || result.metadata?.truncated === true,
  }
  if (
    projected.truncated &&
    typeof result.metadata?.offset === "number"
  ) {
    const retryOffset = result.metadata.offset
    const nextOffset = result.metadata.nextOffset
    const span =
      typeof nextOffset === "number" && nextOffset > retryOffset
        ? nextOffset - retryOffset
        : undefined
    const retainedRatio =
      projected.originalBytes > 0
        ? projected.retainedBytes / projected.originalBytes
        : 0
    const recommendedLimit =
      span === undefined
        ? Math.max(1, OUTPUT_LINES - 16)
        : Math.max(
            1,
            Math.min(
              OUTPUT_LINES - 16,
              Math.floor(span * retainedRatio * 0.8),
            ),
          )
    delete metadata.nextOffset
    metadata.retryOffset = retryOffset
    metadata.recommendedLimit = recommendedLimit
  }
  return {
    ...result,
    output: projected.content,
    metadata,
  } satisfies Result
}

/**
 * Principal-neutral read execution. The caller owns trust/root resolution and
 * supplies a live egress guard; this function owns filesystem semantics only.
 */
export function execute<E>(
  fs: FSUtil.Interface,
  input: Input,
  hooks: Hooks<E>,
): Effect.Effect<Execution, Error | E> {
  return Effect.gen(function* () {
    if (input.signal?.aborted) return yield* new Cancelled({ detail: "Read was cancelled" })
    const action = input.action ?? "read"
    const before = yield* fs.stat(input.path).pipe(Effect.mapError(dependency))

    if (before.type === "Directory") {
      const items = yield* ReadFilesystem.list(fs, input.path).pipe(Effect.mapError(dependency))
      const limit = yield* positive(
        input.limit,
        action === "tail" ? ReadFilesystem.DEFAULT_TAIL : ReadFilesystem.DEFAULT_READ_LIMIT,
      )
      let offset = yield* positive(input.offset, 1)
      let start = offset - 1
      if (start >= items.length && items.length > 0) {
        offset = Math.max(1, items.length - Math.min(limit, items.length) + 1)
        start = offset - 1
      }
      const rows = action === "tail" ? items.slice(Math.max(0, items.length - limit)) : items.slice(start, start + limit)
      const usedOffset = action === "tail" ? Math.max(1, items.length - rows.length + 1) : offset
      const truncated = usedOffset - 1 + rows.length < items.length
      yield* hooks.revalidate().pipe(Effect.asVoid)
      return {
        result: project(
          {
            title: input.displayPath,
            output: `<path entries="${items.length}">${input.displayPath}</path>\n<type>directory</type>\n<entries>\n${rows.join("\n")}\n${truncated ? `(Showing ${rows.length} of ${items.length} entries. Use offset to continue.)` : `(${items.length} entries.)`}\n</entries>`,
            metadata: {
              action,
              path: input.displayPath,
              directory: true,
              entries: items.length,
              offset: usedOffset,
              ...(truncated ? { nextOffset: usedOffset + rows.length } : {}),
              truncated,
            },
          },
          input.projectionMarker ?? "<note>Read output truncated; narrow the read window</note>",
        ),
      }
    }

    if (before.type !== "File") {
      return yield* new InvalidArgument({ detail: "Read supports files and directories only" })
    }

    const sample = yield* ReadFilesystem.readSample(
      fs,
      input.path,
      Number(before.size),
      ReadFilesystem.SAMPLE_BYTES,
      input.signal,
    ).pipe(Effect.mapError(dependency))
    const mime = sniffAttachmentMime(sample, FSUtil.mimeType(input.path))
    if (SUPPORTED_IMAGE_MIMES.has(mime) || isPdfAttachment(mime)) {
      yield* hooks.revalidate().pipe(Effect.asVoid)
      yield* recordRead(input)
      return {
        result: project(
          {
            title: input.displayPath,
            output: isPdfAttachment(mime) ? "PDF attachment available" : "Image attachment available",
            attachments: [
              {
                kind: "file",
                handle: input.displayPath,
                mediaType: mime,
                name: input.displayPath.split("/").at(-1),
                bytes: Number(before.size),
              },
            ],
            metadata: { action: "read", path: input.displayPath, attachment: true, truncated: false },
          },
          input.projectionMarker ?? "<note>Read output truncated; narrow the read window</note>",
        ),
      }
    }

    if (!input.path.toLowerCase().endsWith(".br") && ReadFilesystem.isBinary(input.path, sample)) {
      return yield* new InvalidArgument({ detail: "This binary file type is not supported by the read surface" })
    }

    const limit = yield* positive(
      input.limit,
      action === "tail" ? ReadFilesystem.DEFAULT_TAIL : ReadFilesystem.DEFAULT_READ_LIMIT,
    )
    const offset = yield* positive(input.offset, 1)
    const file = yield* (action === "tail"
      ? ReadFilesystem.tail(fs, input.path, limit, input.signal)
      : ReadFilesystem.clampRead(fs, input.path, { limit, offset, signal: input.signal })
    ).pipe(Effect.mapError(dependency))

    const after = yield* fs.stat(input.path).pipe(Effect.mapError(dependency))
    if (after.type !== "File" || statFingerprint(before) !== statFingerprint(after)) {
      return yield* new Conflict({ detail: "File changed while it was being read; retry before relying on this content" })
    }
    yield* hooks.revalidate().pipe(Effect.asVoid)
    yield* recordRead(input)
    const rendered = renderWindow(input.displayPath, file)
    return {
      result: project(
        {
          title: input.displayPath,
          output: rendered.output,
          metadata: {
            action,
            path: input.displayPath,
            lines: file.count,
            offset: file.offset,
            ...(rendered.nextOffset === undefined ? {} : { nextOffset: rendered.nextOffset }),
            truncated: rendered.truncated,
          },
        },
        input.projectionMarker ?? "<note>Read output truncated; narrow the read window</note>",
      ),
      fingerprint: statFingerprint(after),
    }
  })
}

export * as ExchangeRead from "./read"
