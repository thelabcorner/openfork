import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Vcs } from "@/project/vcs"
import { FileMutation } from "@opencode-ai/core/file-mutation"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { FileIndex } from "@opencode-ai/core/filesystem/index"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { Hash } from "@opencode-ai/core/util/hash"
import { Effect, Layer, Option } from "effect"
import ignore from "ignore"
import path from "path"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  FileDeletePayload,
  FileMkdirPayload,
  FileMutationError,
  FileRenamePayload,
  FileWritePayload,
} from "../groups/file"

const IGNORE_CACHE_TTL_MS = 2_000
type IgnoreMatcher = ReturnType<typeof ignore>

export const fileHandlers = HttpApiBuilder.group(InstanceHttpApi, "file", (handlers) =>
  Effect.gen(function* () {
    const ripgrep = yield* Ripgrep.Service
    const locations = yield* LocationServiceMap.Service
    const events = yield* EventV2Bridge.Service
    const ignoreCache = new Map<string, { matcher: IgnoreMatcher; expiresAt: number }>()

    const filesystem = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
      return yield* effect.pipe(
        Effect.provide(
          locations.get(Location.Ref.make({ directory: AbsolutePath.make((yield* InstanceState.context).directory) })),
        ),
      )
    })

    const fileMutationError = (error: FileMutation.StaleContentError | FileMutation.TargetExistsError | LocationMutation.PathError | FSUtil.Error) =>
      new FileMutationError({
        name: "FileMutationError",
        data:
          error instanceof FileMutation.StaleContentError
            ? { message: "File changed on disk", path: error.path, code: "conflict" as const }
            : error instanceof FileMutation.TargetExistsError
              ? { message: "Target already exists", path: error.path, code: "conflict" as const }
              : error instanceof LocationMutation.PathError
                ? { message: `Invalid path: ${error.path}`, path: error.path, code: "invalid_path" as const }
                : { message: error.message || "Filesystem operation failed", code: "filesystem" as const },
      })

    const expectedBytes = Effect.fn("FileHttpApi.expectedBytes")(function* (
      target: FileMutation.Target,
      expectedHash: string | undefined,
    ) {
      if (!expectedHash) return undefined
      const fs = yield* FSUtil.Service
      const current = yield* fs.readFile(target.canonical).pipe(
        Effect.catchReason("PlatformError", "NotFound", () =>
          Effect.fail(new FileMutation.StaleContentError({ path: target.canonical })),
        ),
      )
      if (Hash.sha256(Buffer.from(current)) !== expectedHash) {
        return yield* new FileMutation.StaleContentError({ path: target.canonical })
      }
      return current
    })

    const publishMutation = Effect.fnUntraced(function* (
      file: string,
      event: "add" | "change" | "unlink",
      edited: boolean,
    ) {
      if (edited) yield* events.publish(FileSystem.Event.Edited, { file })
      yield* events.publish(Watcher.Event.Updated, { file, event })
    })

    const ignoredFiles = Effect.fn("FileHttpApi.ignoredFiles")(function* (projectDirectory: string) {
      const cached = ignoreCache.get(projectDirectory)
      if (cached && cached.expiresAt > Date.now()) return cached.matcher

      const fs = yield* FSUtil.Service
      const matcher = ignore()
      const gitignore = yield* fs
        .readFileString(path.join(projectDirectory, ".gitignore"))
        .pipe(Effect.catch(() => Effect.succeed("")))
      if (gitignore) matcher.add(gitignore)

      const ignorefile = yield* fs
        .readFileString(path.join(projectDirectory, ".ignore"))
        .pipe(Effect.catch(() => Effect.succeed("")))
      if (ignorefile) matcher.add(ignorefile)

      ignoreCache.set(projectDirectory, { matcher, expiresAt: Date.now() + IGNORE_CACHE_TTL_MS })
      return matcher
    })

    const findText = Effect.fn("FileHttpApi.findText")(function* (ctx: { query: { pattern: string } }) {
      return (yield* ripgrep
        .grep({ cwd: (yield* InstanceState.context).directory, pattern: ctx.query.pattern, limit: 10 })
        .pipe(Effect.orDie)).map((match) => ({
        path: { text: match.entry.path },
        lines: { text: match.text },
        line_number: match.line,
        absolute_offset: match.offset,
        submatches: match.submatches.map((submatch) => ({
          match: { text: submatch.text },
          start: submatch.start,
          end: submatch.end,
        })),
      }))
    })

    const findFile = Effect.fn("FileHttpApi.findFile")(function* (ctx: {
      query: { query: string; dirs?: "true" | "false"; type?: "file" | "directory"; limit?: number }
    }) {
      const directory = (yield* InstanceState.context).directory
      const limit = ctx.query.limit ?? 30
      const type = ctx.query.type ?? (ctx.query.dirs === "false" ? "file" : undefined)
      const started = performance.now()
      const found = yield* filesystem(FileSystem.Service.use((fs) => fs.find({ query: ctx.query.query, limit, type })))
      yield* Effect.logInfo("find file", {
        query: ctx.query.query,
        type,
        directory,
        limit,
        results: found.length,
        duration: Math.round(performance.now() - started),
      })
      return found.map((item) => item.path)
    })

    const findSymbol = Effect.fn("FileHttpApi.findSymbol")(function* () {
      return []
    })

    const list = Effect.fn("FileHttpApi.list")(function* (ctx: { query: { path: string } }) {
      return yield* filesystem(
        Effect.gen(function* () {
          const index = yield* FileIndex.Service
          const location = yield* Location.Service
          const ignored = yield* ignoredFiles(location.project.directory)
          return (yield* index.list(RelativePath.make(ctx.query.path))).map((item) => {
            const absolute = path.resolve(location.directory, item.path)
            return {
              name: path.basename(item.path),
              path: item.path,
              absolute,
              type: item.type,
              ignored: ignored.ignores(
                path.relative(location.project.directory, absolute) + (item.type === "directory" ? "/" : ""),
              ),
            }
          })
        }),
      )
    })

    const content = Effect.fn("FileHttpApi.content")(function* (ctx: { query: { path: string } }) {
      const directory = (yield* InstanceState.context).directory
      const file = path.resolve(directory, ctx.query.path)
      if (!FSUtil.contains(directory, file)) return yield* Effect.die(new Error("Path escapes the location"))
      if (!(yield* FSUtil.Service.use((fs) => fs.existsSafe(file))))
        return { type: "text" as const, content: "", hash: Hash.sha256(Buffer.from("")) }
      return yield* filesystem(
        FileSystem.Service.use((fs) => fs.read({ path: RelativePath.make(ctx.query.path) })),
      ).pipe(
        Effect.flatMap((item) =>
          Effect.gen(function* () {
            const text = item.content.includes(0)
              ? Option.none<string>()
              : yield* Effect.sync(() => new TextDecoder("utf-8", { fatal: true }).decode(item.content)).pipe(
                  Effect.option,
                )
            return { item, text }
          }),
        ),
        Effect.map(({ item, text }) =>
          Option.isSome(text)
            ? { type: "text" as const, content: text.value, hash: Hash.sha256(Buffer.from(item.content)) }
            : {
                type: "binary" as const,
                content: Buffer.from(item.content).toString("base64"),
                hash: Hash.sha256(Buffer.from(item.content)),
                encoding: "base64" as const,
                mimeType: item.mime,
              },
        ),
      )
    })

    const write = Effect.fn("FileHttpApi.write")(function* (ctx: { payload: typeof FileWritePayload.Type }) {
      return yield* filesystem(
        Effect.gen(function* () {
          const mutations = yield* LocationMutation.Service
          const files = yield* FileMutation.Service
          const target = yield* mutations.resolve({ path: ctx.payload.path, kind: "file" })
          const expected = yield* expectedBytes(target, ctx.payload.expectedHash)
          const result = expected
            ? yield* files.writeIfUnchanged({ target, content: ctx.payload.content, expected })
            : yield* files.create({ target, content: ctx.payload.content })
          yield* publishMutation(result.target, result.existed ? "change" : "add", true)
          return { hash: Hash.sha256(Buffer.from(ctx.payload.content)) }
        }),
      ).pipe(Effect.mapError(fileMutationError))
    })

    const remove = Effect.fn("FileHttpApi.delete")(function* (ctx: { payload: typeof FileDeletePayload.Type }) {
      return yield* filesystem(
        Effect.gen(function* () {
          const mutations = yield* LocationMutation.Service
          const files = yield* FileMutation.Service
          const result = yield* files.remove({
            target: yield* mutations.resolve({ path: ctx.payload.path }),
            recursive: true,
          })
          if (result.existed) yield* publishMutation(result.target, "unlink", false)
          return {}
        }),
      ).pipe(Effect.mapError(fileMutationError))
    })

    const rename = Effect.fn("FileHttpApi.rename")(function* (ctx: { payload: typeof FileRenamePayload.Type }) {
      return yield* filesystem(
        Effect.gen(function* () {
          const mutations = yield* LocationMutation.Service
          const files = yield* FileMutation.Service
          const result = yield* files.rename({
            from: yield* mutations.resolve({ path: ctx.payload.from }),
            to: yield* mutations.resolve({ path: ctx.payload.to }),
          })
          yield* publishMutation(result.from, "unlink", false)
          yield* publishMutation(result.to, "add", false)
          return {}
        }),
      ).pipe(Effect.mapError(fileMutationError))
    })

    const mkdir = Effect.fn("FileHttpApi.mkdir")(function* (ctx: { payload: typeof FileMkdirPayload.Type }) {
      return yield* filesystem(
        Effect.gen(function* () {
          const mutations = yield* LocationMutation.Service
          const files = yield* FileMutation.Service
          const target = yield* mutations.resolve({ path: ctx.payload.path, kind: ctx.payload.kind })
          const result =
            ctx.payload.kind === "file"
              ? yield* files.create({ target, content: "" })
              : yield* files.mkdir({ target })
          yield* publishMutation(result.target, "add", ctx.payload.kind === "file")
          return {}
        }),
      ).pipe(Effect.mapError(fileMutationError))
    })

    const status = Effect.fn("FileHttpApi.status")(function* () {
      const vcs = yield* Vcs.Service
      const list = yield* vcs.status()
      return list.map((item) => ({
        path: item.file,
        added: item.additions,
        removed: item.deletions,
        status: item.status,
      }))
    })

    return handlers
      .handle("findText", findText)
      .handle("findFile", findFile)
      .handle("findSymbol", findSymbol)
      .handle("list", list)
      .handle("content", content)
      .handle("write", write)
      .handle("delete", remove)
      .handle("rename", rename)
      .handle("mkdir", mkdir)
      .handle("status", status)
  }),
).pipe(Layer.provide(locationServiceMapLayer))
