export * as ExchangeJson from "./json"

import { Effect } from "effect"
import type { Schema } from "effect"
import type { FSUtil } from "@opencode-ai/core/fs-util"
import { JsonEngine } from "@/json/engine"
import { atomicWrite } from "@/tool/edit/commit"
import { withLock } from "@/tool/file-lock"
import { ExchangeError } from "./error"
import type { ExchangeGrounding } from "./grounding"
import { ExchangeRead } from "./read"

export const Parameters = JsonEngine.Parameters
export type Input = Schema.Schema.Type<typeof Parameters>

export interface ApprovedPath {
  readonly native: string
  readonly virtual: string
  readonly rootID: string
}

type LoadedFile = {
  readonly document: JsonEngine.Document
  readonly approved: ApprovedPath
  readonly fingerprint: string
  readonly bytes: Uint8Array
}

export interface Hooks<E> {
  readonly resolveRead: (inputPath: string) => Effect.Effect<ApprovedPath, ExchangeError.Error | E>
  readonly resolveWrite: (inputPath: string) => Effect.Effect<ApprovedPath, ExchangeError.Error | E>
  readonly revalidateRead: (target: ApprovedPath) => Effect.Effect<void, ExchangeError.Error | E>
  readonly revalidateWrite: (target: ApprovedPath) => Effect.Effect<void, ExchangeError.Error | E>
  /** Called only after stale-safe replan proves bytes will actually change. */
  readonly beforeWriteMutation?: (target: ApprovedPath) => Effect.Effect<void, ExchangeError.Error | E>
  readonly grounding?: ExchangeGrounding.Scoped
}

export interface Result {
  readonly title: string
  readonly output: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly mutation: { readonly attempted: boolean; readonly committed: boolean }
  readonly targetRef?: string
}

function cancelled(signal?: AbortSignal) {
  return signal?.aborted
    ? Effect.fail<ExchangeError.Error>(new ExchangeError.Cancelled({ detail: "JSON request was cancelled" }))
    : Effect.void
}

function bytesOf(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? Buffer.from(value, "utf8") : value
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index++) if (left[index] !== right[index]) return false
  return true
}

function virtualize(text: string, replacements: readonly [string, string][] = []) {
  let detail = text
  for (const [nativePath, virtualPath] of replacements) {
    if (!nativePath) continue
    detail = detail.split(nativePath).join(virtualPath)
    detail = detail.split(nativePath.replaceAll("\\", "/")).join(virtualPath)
    detail = detail.split(nativePath.replaceAll("/", "\\")).join(virtualPath)
  }
  return detail
}

function engineError(error: unknown, replacements: readonly [string, string][] = []) {
  const detail = virtualize(error instanceof Error ? error.message : String(error), replacements)
  return new ExchangeError.InvalidArgument({ detail: detail.length > 1000 ? `${detail.slice(0, 997)}...` : detail })
}

function withoutWrite(result: JsonEngine.Result): Omit<JsonEngine.Result, "write"> {
  const { write: _write, ...visible } = result
  return visible
}

const loadFile = Effect.fn("ExchangeJson.loadFile")(function* <E>(
  fs: FSUtil.Interface,
  approved: ApprovedPath,
  writable: boolean,
  maxBytes: number,
  signal?: AbortSignal,
) {
  yield* cancelled(signal)
  const before = yield* fs.stat(approved.native).pipe(
    Effect.mapError(() => new ExchangeError.NotFound({ detail: `JSON file does not exist: ${approved.virtual}` })),
  )
  if (before.type !== "File") {
    return yield* new ExchangeError.InvalidArgument({ detail: `JSON input is not a file: ${approved.virtual}` })
  }
  const size = Number(before.size)
  if (size > maxBytes) {
    return yield* new ExchangeError.InvalidArgument({
      detail: `JSON file exceeds maxBytes (${size} > ${maxBytes}): ${approved.virtual}`,
    })
  }
  const bytes = yield* fs.readFile(approved.native).pipe(
    Effect.mapError(() => new ExchangeError.DependencyUnavailable({ detail: "Unable to read JSON input" })),
  )
  yield* cancelled(signal)
  const after = yield* fs.stat(approved.native).pipe(
    Effect.mapError(() => new ExchangeError.Conflict({ detail: `${approved.virtual} changed while being read` })),
  )
  const beforeFingerprint = ExchangeRead.statFingerprint(before)
  const afterFingerprint = ExchangeRead.statFingerprint(after)
  if (beforeFingerprint !== afterFingerprint) {
    return yield* new ExchangeError.Conflict({
      detail: `${approved.virtual} changed while being read; retry before relying on this JSON result`,
    })
  }
  return {
    document: {
      raw: bytes,
      source: approved.virtual,
      fileHint: approved.virtual,
      writable,
    },
    approved,
    fingerprint: afterFingerprint,
    bytes,
  } satisfies LoadedFile
})

const inline = (text: string, source: string): JsonEngine.Document => ({
  raw: Buffer.from(text, "utf8"),
  source,
  writable: false,
})

export function execute<E>(
  fs: FSUtil.Interface,
  input: Input,
  hooks: Hooks<E>,
  signal?: AbortSignal,
): Effect.Effect<Result, ExchangeError.Error | E> {
  return Effect.gen(function* () {
    yield* cancelled(signal)
    const limits = JsonEngine.limits(input)
    const mode = input.mode ?? "scaffold"
    const primaryUsesFile = input.jsonText === undefined && input.filePath !== undefined
    const wantsWrite = primaryUsesFile && (mode === "format" || mode === "patch") && input.dryRun === false
    const primaryApproved = primaryUsesFile
      ? yield* (wantsWrite ? hooks.resolveWrite(input.filePath!) : hooks.resolveRead(input.filePath!))
      : undefined
    const primary = primaryApproved
      ? yield* loadFile(fs, primaryApproved, wantsWrite, limits.maxBytes, signal)
      : undefined
    if (!primary && input.jsonText === undefined) {
      return yield* new ExchangeError.InvalidArgument({ detail: "Either filePath or jsonText is required" })
    }
    const document = primary?.document ?? inline(input.jsonText!, "jsonText")

    const compareUsesFile = mode === "diff" && input.compareJsonText === undefined && input.compareFilePath !== undefined
    const compareApproved = compareUsesFile ? yield* hooks.resolveRead(input.compareFilePath!) : undefined
    const compareFile = compareApproved
      ? yield* loadFile(fs, compareApproved, false, limits.maxBytes, signal)
      : undefined
    const compareDocument =
      mode !== "diff"
        ? undefined
        : compareFile?.document ??
          (input.compareJsonText !== undefined ? inline(input.compareJsonText, "compareJsonText") : undefined)

    const replacements: [string, string][] = [
      ...(primary ? [[primary.approved.native, primary.approved.virtual] as [string, string]] : []),
      ...(compareFile ? [[compareFile.approved.native, compareFile.approved.virtual] as [string, string]] : []),
    ]
    const planned = yield* Effect.try({
      try: () => JsonEngine.execute(input, document, compareDocument),
      catch: (error) => engineError(error, replacements),
    })

    if (primary && !planned.write) hooks.grounding?.note(primary.approved.rootID, primary.approved.native, primary.fingerprint)
    if (compareFile) hooks.grounding?.note(compareFile.approved.rootID, compareFile.approved.native, compareFile.fingerprint)

    if (!planned.write) {
      if (primary) yield* hooks.revalidateRead(primary.approved)
      if (compareFile) yield* hooks.revalidateRead(compareFile.approved)
      const visible = withoutWrite(planned)
      return {
        title: visible.title,
        output: visible.output,
        metadata: visible.metadata,
        mutation: { attempted: false, committed: false },
      }
    }

    if (!primary) {
      return yield* new ExchangeError.InvalidArgument({
        detail: "JSON write modes require a file-backed input inside an approved root",
      })
    }

    const committed = yield* withLock(
      primary.approved.native,
      Effect.gen(function* () {
        yield* cancelled(signal)
        const currentBytes = yield* fs.readFile(primary.approved.native).pipe(
          Effect.mapError(
            () => new ExchangeError.Conflict({ detail: `${primary.approved.virtual} disappeared before JSON commit` }),
          ),
        )
        const currentStat = yield* fs.stat(primary.approved.native).pipe(
          Effect.mapError(
            () => new ExchangeError.Conflict({ detail: `${primary.approved.virtual} disappeared before JSON commit` }),
          ),
        )

        let active = planned
        if (!sameBytes(primary.bytes, currentBytes)) {
          active = yield* Effect.try({
            try: () =>
              JsonEngine.execute(
                input,
                {
                  raw: currentBytes,
                  source: primary.approved.virtual,
                  fileHint: primary.approved.virtual,
                  writable: true,
                },
                compareDocument,
              ),
            catch: (error) => engineError(error, replacements),
          })
          if (!active.write) {
            return yield* new ExchangeError.Conflict({
              detail: `Concurrent change made the JSON write unsafe for ${primary.approved.virtual}`,
            })
          }
        }

        yield* hooks.revalidateWrite(primary.approved)
        const nextBytes = bytesOf(active.write!.content)
        if (sameBytes(currentBytes, nextBytes)) {
          hooks.grounding?.note(
            primary.approved.rootID,
            primary.approved.native,
            ExchangeRead.statFingerprint(currentStat),
          )
          return { result: active, committed: false }
        }

        if (hooks.beforeWriteMutation) yield* hooks.beforeWriteMutation(primary.approved)
        yield* cancelled(signal)
        yield* atomicWrite(fs, primary.approved.native, active.write!.content).pipe(
          Effect.mapError(() => new ExchangeError.DependencyUnavailable({ detail: "Unable to atomically commit JSON write" })),
        )
        const after = yield* fs.stat(primary.approved.native).pipe(
          Effect.mapError(
            () => new ExchangeError.DependencyUnavailable({ detail: "Unable to verify committed JSON write" }),
          ),
        )
        hooks.grounding?.note(primary.approved.rootID, primary.approved.native, ExchangeRead.statFingerprint(after))
        return { result: active, committed: true }
      }),
    )

    const visible = withoutWrite(committed.result)
    const output = committed.committed
      ? visible.output
      : visible.output
          .replace('written="true"', 'written="false"')
          .replace(
            "write applied after authorization and commit-time revalidation",
            "no write was needed after commit-time revalidation; bytes already matched",
          )
    return {
      title: visible.title,
      output,
      metadata: { ...visible.metadata, written: committed.committed },
      mutation: { attempted: true, committed: committed.committed },
      targetRef: primary.approved.virtual,
    }
  })
}
