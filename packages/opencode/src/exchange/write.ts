export * as ExchangeWrite from "./write"

import { createHash } from "node:crypto"
import { createTwoFilesPatch } from "diff"
import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CodingActivity } from "@opencode-ai/core/coding-activity"
import { adaptWriteTerminators } from "@opencode-ai/core/line-ending"
import { ToolOutputProjection } from "@opencode-ai/core/tool-output-projection"
import * as Bom from "@/util/bom"
import { atomicWrite } from "@/tool/edit/commit"
import { withLock } from "@/tool/file-lock"
import { ExchangeAttribution } from "./attribution"
import { ExchangeError } from "./error"
import { ExchangeRead } from "./read"

const OUTPUT_BYTES = 96 * 1024
const OUTPUT_LINES = 500

export interface Input {
  /** Canonical Machine-B target path, already root-authorized by the caller. */
  readonly path: string
  /** Public/root-relative path safe to cross the exchange boundary. */
  readonly displayPath: string
  readonly content: string
  /** Optional stat fingerprint from a prior principal-specific read. */
  readonly expectedFingerprint?: string
  readonly signal?: AbortSignal
  readonly projectionMarker?: string
  /**
   * Optional boundary attribution folded into the single write record. It is
   * the only thing that can give this producer a `projectFolder`; the
   * display-path heuristic below names a project and never a directory.
   */
  readonly attribution?: ExchangeAttribution.Attribution
}

export interface CommitInfo {
  readonly targetRef: string
  readonly resultDigest: string
  readonly existed: boolean
}

export interface Hooks<RevalidateError, PrepareError = never> {
  /** Persist mutation intent/post-state before the commit boundary is crossed. */
  readonly beforeCommit?: (info: CommitInfo) => Effect.Effect<unknown, PrepareError>
  /** Re-check live authority immediately before the atomic replacement. */
  readonly revalidate: () => Effect.Effect<unknown, RevalidateError>
  /**
   * Runs strictly after atomic replacement. Failure here means the mutation may
   * already be durable, so it is translated to AmbiguousCommit and MUST NOT be
   * treated as a safe retry signal.
   */
  readonly onCommitted?: (info: CommitInfo) => Effect.Effect<unknown, unknown>
}

export interface Execution {
  readonly result: {
    readonly title: string
    readonly output: string
    readonly metadata: Readonly<Record<string, unknown>>
  }
  readonly mutation: { readonly attempted: boolean; readonly committed: boolean }
  readonly resultDigest: string
  readonly fingerprint?: string
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false
  return true
}

function decode(bytes: Uint8Array) {
  return Bom.split(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes))
}

function digest(bytes: Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

function diff(displayPath: string, before: string, after: string, marker: string) {
  const raw = createTwoFilesPatch(displayPath, displayPath, before, after)
  const projected = ToolOutputProjection.project(raw, {
    maxLines: OUTPUT_LINES,
    maxBytes: OUTPUT_BYTES,
    strategy: "head",
    marker,
  })
  return { content: projected.content, truncated: projected.truncated }
}

function lineCount(text: string) {
  if (text.length === 0) return 0
  let lines = 1
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) lines += 1
  return text.endsWith("\n") ? lines - 1 : lines
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

function dependency(detail: string) {
  return new ExchangeError.DependencyUnavailable({ detail })
}

function cancelled(signal?: AbortSignal) {
  return signal?.aborted
    ? Effect.fail(new ExchangeError.Cancelled({ detail: "Write was cancelled" }))
    : Effect.void
}

/**
 * Principal-neutral full-content write semantics shared by OXP and OFXP.
 * Trust/root resolution is intentionally outside this owner.
 */
export function execute<RevalidateError, PrepareError = never>(
  fs: FSUtil.Interface,
  input: Input,
  hooks: Hooks<RevalidateError, PrepareError>,
): Effect.Effect<Execution, ExchangeError.Error | RevalidateError | PrepareError> {
  return Effect.gen(function* () {
    yield* cancelled(input.signal)
    const initialStat = yield* fs.stat(input.path).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (initialStat?.type === "Directory") {
      return yield* new ExchangeError.InvalidArgument({ detail: `${input.displayPath} is a directory` })
    }
    if (
      input.expectedFingerprint !== undefined &&
      (!initialStat || ExchangeRead.statFingerprint(initialStat) !== input.expectedFingerprint)
    ) {
      return yield* new ExchangeError.Conflict({
        detail: `${input.displayPath} changed after it was last read; read it again before writing`,
      })
    }

    const initialBytes = initialStat
      ? yield* fs.readFile(input.path).pipe(Effect.mapError(() => dependency("Unable to read the write target")))
      : new Uint8Array()
    const initialSource = initialStat ? decode(initialBytes) : { bom: false, text: "" }
    const requested = Bom.split(input.content)
    const initialText = initialStat ? adaptWriteTerminators(initialSource.text, requested.text) : requested.text
    const initialBom = initialSource.bom || requested.bom
    const initialDesired = new TextEncoder().encode(Bom.join(initialText, initialBom))
    if (initialStat && sameBytes(initialBytes, initialDesired)) {
      return {
        result: {
          title: input.displayPath,
          output: `No changes to apply: ${input.displayPath} already matches the requested content.`,
          metadata: { path: input.displayPath, exists: true, changed: false, diff: "", diffTruncated: false },
        },
        mutation: { attempted: false, committed: false },
        resultDigest: digest(initialDesired),
        fingerprint: ExchangeRead.statFingerprint(initialStat),
      }
    }

    const committed = yield* withLock(
      input.path,
      Effect.gen(function* () {
        yield* cancelled(input.signal)
        const currentStat = yield* fs.stat(input.path).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (currentStat?.type === "Directory") {
          return yield* new ExchangeError.Conflict({ detail: `${input.displayPath} became a directory before commit` })
        }
        if (
          input.expectedFingerprint !== undefined &&
          (!currentStat || ExchangeRead.statFingerprint(currentStat) !== input.expectedFingerprint)
        ) {
          return yield* new ExchangeError.Conflict({
            detail: `${input.displayPath} changed after the grounded read; read it again before writing`,
          })
        }
        const currentBytes = currentStat
          ? yield* fs.readFile(input.path).pipe(Effect.mapError(() => dependency("Unable to re-read the write target")))
          : new Uint8Array()
        const currentSource = currentStat ? decode(currentBytes) : { bom: false, text: "" }
        const text = currentStat ? adaptWriteTerminators(currentSource.text, requested.text) : requested.text
        const bom = currentSource.bom || requested.bom
        const desired = new TextEncoder().encode(Bom.join(text, bom))
        const resultDigest = digest(desired)
        if (currentStat && sameBytes(currentBytes, desired)) {
          return {
            before: currentSource.text,
            after: text,
            existed: true,
            wrote: false,
            resultDigest,
            fingerprint: ExchangeRead.statFingerprint(currentStat),
          }
        }

        if (hooks.beforeCommit) {
          yield* hooks.beforeCommit({ targetRef: input.displayPath, resultDigest, existed: currentStat !== undefined }).pipe(
            Effect.asVoid,
          )
        }
        yield* hooks.revalidate().pipe(Effect.asVoid)
        yield* atomicWrite(fs, input.path, desired).pipe(
          Effect.mapError(() => dependency("Unable to atomically commit the write")),
        )
        if (hooks.onCommitted) {
          yield* hooks.onCommitted({ targetRef: input.displayPath, resultDigest, existed: currentStat !== undefined }).pipe(
            Effect.mapError(
              () =>
                new ExchangeError.AmbiguousCommit({
                  detail: `Write committed to ${input.displayPath}, but durable commit bookkeeping failed; reconcile before retrying`,
                  targetRef: input.displayPath,
                  resultDigest,
                }),
            ),
          )
        }
        const after = yield* fs.stat(input.path).pipe(Effect.catch(() => Effect.succeed(undefined)))
        return {
          before: currentSource.text,
          after: text,
          existed: currentStat !== undefined,
          wrote: true,
          resultDigest,
          ...(after ? { fingerprint: ExchangeRead.statFingerprint(after) } : {}),
        }
      }),
    )

    if (committed.wrote) {
      yield* CodingActivity.record({
        entity: input.path,
        kind: "write",
        aiLineChanges: lineCount(committed.after) - lineCount(committed.before),
        ...ExchangeAttribution.apply(input.attribution, { project: projectName(input.path, input.displayPath) }),
      }).pipe(Effect.ignore)
    }

    const projectedDiff = committed.wrote
      ? diff(
          input.displayPath,
          committed.before,
          committed.after,
          input.projectionMarker ?? "<note>Write diff truncated; inspect the file for complete post-state</note>",
        )
      : { content: "", truncated: false }
    return {
      result: {
        title: input.displayPath,
        output: committed.wrote
          ? `Wrote ${input.displayPath} successfully.`
          : `No changes to apply after commit-time revalidation: ${input.displayPath}.`,
        metadata: {
          path: input.displayPath,
          exists: committed.existed,
          changed: committed.wrote,
          diff: projectedDiff.content,
          diffTruncated: projectedDiff.truncated,
        },
      },
      mutation: { attempted: true, committed: committed.wrote },
      resultDigest: committed.resultDigest,
      ...(committed.fingerprint ? { fingerprint: committed.fingerprint } : {}),
    }
  })
}
