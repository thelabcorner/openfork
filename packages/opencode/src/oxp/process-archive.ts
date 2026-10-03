import path from "node:path"
import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Option, Schedule, Schema, Semaphore } from "effect"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import * as Utf8 from "@/util/utf8"
import { OxpError } from "./error"
import { OxpSchema } from "./schema"

export const MAX_ARCHIVES = 128
export const MAX_ARCHIVE_OUTPUT_BYTES = 256 * 1024
export const MAX_ARCHIVE_TOTAL_BYTES = MAX_ARCHIVES * MAX_ARCHIVE_OUTPUT_BYTES
const SUBDIR = "oxp-process"

export const TerminationReason = Schema.Literals([
  "requested-kill",
  "request-cancelled",
  "authority-revoked",
  "root-changed",
  "runtime-dispose",
  "signal",
])
export type TerminationReason = Schema.Schema.Type<typeof TerminationReason>
const TerminationSignal = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(32),
  Schema.isPattern(/^SIG[A-Z0-9]+$/),
)

const Handle = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
  Schema.isPattern(/^proc_[A-Za-z0-9_-]+$/),
)

const MetadataSchema = Schema.Struct({
  version: Schema.Literal(1),
  handle: Handle,
  connectorID: OxpSchema.ConnectorID,
  rootID: OxpSchema.RootID,
  workdir: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  mode: Schema.Literals(["foreground", "background"]),
  startedAt: Schema.Number,
  endedAt: Schema.Number,
  exitCode: Schema.optionalKey(Schema.Int),
  terminationReason: Schema.optionalKey(TerminationReason),
  terminationSignal: Schema.optionalKey(TerminationSignal),
  outputBytes: Schema.Number,
  retainedBytes: Schema.Number,
  truncated: Schema.Boolean,
})

export type Metadata = Schema.Schema.Type<typeof MetadataSchema>

export interface Finish {
  readonly handle: string
  readonly connectorID: OxpSchema.ConnectorID
  readonly rootID: OxpSchema.RootID
  readonly workdir: string
  readonly mode: "foreground" | "background"
  readonly startedAt: number
  readonly endedAt: number
  readonly exitCode?: number
  readonly terminationReason?: TerminationReason
  readonly terminationSignal?: string
  readonly outputBytes: number
  readonly truncated: boolean
  readonly output: string
}

export interface Record extends Metadata {
  readonly output: string
  readonly recovered: true
}

export interface Interface {
  readonly finalize: (input: Finish) => Effect.Effect<Record, OxpError.Error>
  readonly get: (handle: string) => Effect.Effect<Record | undefined, OxpError.Error>
  readonly list: () => Effect.Effect<readonly Record[], OxpError.Error>
  /** Cheap process-local metadata snapshot for authority/lifecycle reconciliation. */
  readonly metadata: () => Effect.Effect<readonly Metadata[]>
  readonly remove: (handle: string) => Effect.Effect<void, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpProcessArchive") {}
export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const fs = yield* FSUtil.Service
    const flock = yield* EffectFlock.Service
    const directory = path.join(global.state, SUBDIR)
    const records = new Map<string, Record>()
    const localLock = Semaphore.makeUnsafe(1)
    const lockKey = "oxp-process-archive:" + directory

    const unavailable = (detail: string) => new OxpError.DependencyUnavailable({ detail })
    const paths = (handle: string) => ({
      meta: path.join(directory, handle + ".json"),
      log: path.join(directory, handle + ".log"),
    })

    const atomicWrite = Effect.fn("OxpProcessArchive.atomicWrite")(function* (
      filepath: string,
      content: string,
    ) {
      const temporary = filepath + "." + process.pid + "." + randomUUID() + ".tmp"
      yield* fs.makeDirectory(path.dirname(filepath), { recursive: true }).pipe(
        Effect.mapError(() => unavailable("Unable to create OXP process archive directory")),
      )
      yield* fs.writeFileString(temporary, content, { flag: "wx", mode: 0o600 }).pipe(
        Effect.mapError(() => unavailable("Unable to write OXP process archive temporary file")),
      )
      yield* fs.rename(temporary, filepath).pipe(
        Effect.retry({ times: 8, schedule: Schedule.spaced("20 millis") }),
        Effect.catch((cause) =>
          fs.remove(temporary).pipe(
            Effect.ignore,
            Effect.andThen(
              Effect.fail(unavailable("Unable to publish OXP process archive file: " + String(cause))),
            ),
          ),
        ),
      )
    })

    const removeFiles = Effect.fn("OxpProcessArchive.removeFiles")(function* (handle: string) {
      const file = paths(handle)
      yield* Effect.all(
        [
          fs.remove(file.meta).pipe(Effect.ignore),
          fs.remove(file.log).pipe(Effect.ignore),
        ],
        { concurrency: "unbounded", discard: true },
      )
    })

    const decode = (value: unknown) =>
      Schema.decodeUnknownEffect(MetadataSchema)(value, {
        errors: "all",
        onExcessProperty: "error",
      }).pipe(Effect.option)

    const metadataText = (meta: Metadata) => JSON.stringify(meta, null, 2) + "\n"

    const recordDiskBytes = (record: Record) => {
      const { output: _output, recovered: _recovered, ...meta } = record
      return record.retainedBytes + Utf8.byteLength(metadataText(meta))
    }

    const readRecord = Effect.fn("OxpProcessArchive.readRecord")(function* (metaPath: string) {
      const raw = yield* fs.readJson(metaPath).pipe(Effect.option)
      if (Option.isNone(raw)) return undefined
      const decoded = yield* decode(raw.value)
      if (Option.isNone(decoded)) return undefined
      const meta = decoded.value
      const rawOutput = yield* fs.readFileStringSafe(paths(meta.handle).log).pipe(
        Effect.orElseSucceed(() => undefined),
      )
      if (rawOutput === undefined) return undefined
      const bounded = Utf8.truncate(rawOutput, MAX_ARCHIVE_OUTPUT_BYTES)
      if (bounded.truncated) return undefined
      const retainedBytes = Utf8.byteLength(bounded.text)
      if (retainedBytes !== meta.retainedBytes) return undefined
      return {
        ...meta,
        output: bounded.text,
        recovered: true as const,
      } satisfies Record
    })

    const scan = Effect.fn("OxpProcessArchive.scan")(function* () {
      yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.catch(() => Effect.void))
      const entries = yield* fs.readDirectoryEntries(directory).pipe(
        Effect.catch(() => Effect.succeed([] as FSUtil.DirEntry[])),
      )
      const loaded = yield* Effect.forEach(
        entries.filter((entry) => entry.type === "file" && entry.name.endsWith(".json")),
        (entry) => readRecord(path.join(directory, entry.name)).pipe(Effect.catch(() => Effect.succeed(undefined))),
        { concurrency: 8 },
      )
      records.clear()
      for (const record of loaded) {
        if (record) records.set(record.handle, record)
      }
    })

    const prune = Effect.fn("OxpProcessArchive.prune")(function* () {
      const ordered = [...records.values()].sort(
        (left, right) =>
          left.endedAt - right.endedAt ||
          left.startedAt - right.startedAt,
      )
      let retained = ordered.reduce((total, record) => total + recordDiskBytes(record), 0)
      while (records.size > MAX_ARCHIVES || retained > MAX_ARCHIVE_TOTAL_BYTES) {
        const oldest = ordered.shift()
        if (!oldest) break
        records.delete(oldest.handle)
        retained -= recordDiskBytes(oldest)
        yield* removeFiles(oldest.handle)
      }
    })

    const reconcile = Effect.fn("OxpProcessArchive.reconcile")(function* () {
      yield* scan()
      const valid = new Set(records.keys())
      const entries = yield* fs.readDirectoryEntries(directory).pipe(
        Effect.catch(() => Effect.succeed([] as FSUtil.DirEntry[])),
      )
      yield* Effect.forEach(
        entries,
        (entry) => {
          if (entry.type !== "file") return Effect.void
          if (entry.name.endsWith(".tmp")) {
            return fs.remove(path.join(directory, entry.name)).pipe(Effect.ignore)
          }
          const match = /^(proc_[A-Za-z0-9_-]+)\.(json|log)$/.exec(entry.name)
          if (!match || valid.has(match[1]!)) return Effect.void
          return fs.remove(path.join(directory, entry.name)).pipe(Effect.ignore)
        },
        { concurrency: 8, discard: true },
      )
      yield* prune()
    })

    const locked = <A, E>(effect: Effect.Effect<A, E>) =>
      localLock.withPermit(
        effect.pipe(
          flock.withLock(lockKey),
          Effect.mapError((error) =>
            OxpError.isError(error) ? error : unavailable("Unable to lock OXP process archive"),
          ),
        ),
      )

    yield* reconcile().pipe(locked, Effect.catch(() => Effect.void))

    const finalize: Interface["finalize"] = (input) =>
      locked(
        Effect.gen(function* () {
          if (!/^proc_[A-Za-z0-9_-]+$/.test(input.handle)) {
            return yield* new OxpError.InvalidArgument({ detail: "Invalid OXP process archive handle" })
          }
          const bounded = Utf8.truncate(input.output, MAX_ARCHIVE_OUTPUT_BYTES)
          const retainedBytes = Utf8.byteLength(bounded.text)
          const meta: Metadata = {
            version: 1,
            handle: input.handle,
            connectorID: input.connectorID,
            rootID: input.rootID,
            workdir: input.workdir,
            mode: input.mode,
            startedAt: input.startedAt,
            endedAt: input.endedAt,
            ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
            ...(input.terminationReason === undefined
              ? {}
              : { terminationReason: input.terminationReason }),
            ...(input.terminationSignal === undefined
              ? {}
              : { terminationSignal: input.terminationSignal }),
            outputBytes: input.outputBytes,
            retainedBytes,
            truncated: input.truncated || bounded.truncated,
          }
          const file = paths(input.handle)
          // Output is published before metadata. Readers only discover a record
          // after the terminal metadata rename, so there is never a visible
          // terminal row pointing at a partial log.
          yield* atomicWrite(file.log, bounded.text)
          yield* atomicWrite(file.meta, metadataText(meta)).pipe(
            Effect.catch((error) =>
              fs.remove(file.log).pipe(
                Effect.ignore,
                Effect.andThen(Effect.fail(error)),
              ),
            ),
          )
          const record: Record = { ...meta, output: bounded.text, recovered: true }
          records.set(input.handle, record)
          yield* reconcile()
          return record
        }),
      )

    const get: Interface["get"] = (handle) =>
      locked(
        Effect.gen(function* () {
          yield* reconcile()
          return records.get(handle)
        }),
      )

    const list: Interface["list"] = () =>
      locked(
        Effect.gen(function* () {
          yield* reconcile()
          return [...records.values()]
        }),
      )

    const metadata: Interface["metadata"] = () =>
      localLock.withPermit(
        Effect.sync(() =>
          [...records.values()].map(({ output: _output, recovered: _recovered, ...meta }) => meta),
        ),
      )

    const remove: Interface["remove"] = (handle) =>
      locked(
        Effect.gen(function* () {
          records.delete(handle)
          yield* removeFiles(handle)
        }),
      )

    return Service.of({ finalize, get, list, metadata, remove })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Global.node, FSUtil.node, EffectFlock.node],
})

export * as OxpProcessArchive from "./process-archive"
