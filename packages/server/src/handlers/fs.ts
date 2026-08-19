import { FileMutation } from "@opencode-ai/core/file-mutation"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { RelativePath } from "@opencode-ai/core/schema"
import { Hash } from "@opencode-ai/core/util/hash"
import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"
import { ConflictError, InvalidRequestError } from "@opencode-ai/protocol/errors"

export const FileSystemHandler = HttpApiBuilder.group(Api, "server.fs", (handlers) =>
  Effect.gen(function* () {
    const expectedBytes = Effect.fn("FileSystemHandler.expectedBytes")(function* (
      target: FileMutation.Target,
      expectedHash: string | undefined,
    ) {
      if (!expectedHash) return undefined
      const filesystem = yield* FSUtil.Service
      const current = yield* filesystem.readFile(target.canonical).pipe(
        Effect.catchReason("PlatformError", "NotFound", () =>
          Effect.fail(new FileMutation.StaleContentError({ path: target.canonical })),
        ),
      )
      if (Hash.sha256(Buffer.from(current)) !== expectedHash) {
        return yield* new FileMutation.StaleContentError({ path: target.canonical })
      }
      return current
    })

    const write = Effect.fn("FileSystemHandler.write")(function* (ctx: {
      payload: { path: string; content: string; expectedHash?: string }
    }) {
      const mutations = yield* LocationMutation.Service
      const files = yield* FileMutation.Service
      const target = yield* mutations.resolve({ path: ctx.payload.path, kind: "file" })
      const expected = yield* expectedBytes(target, ctx.payload.expectedHash)
      if (expected) {
        yield* files.writeIfUnchanged({ target, content: ctx.payload.content, expected })
      } else {
        yield* files.create({ target, content: ctx.payload.content })
      }
      return { hash: Hash.sha256(Buffer.from(ctx.payload.content)) }
    }, Effect.mapError(fileError))

    const remove = Effect.fn("FileSystemHandler.delete")(function* (ctx: { payload: { path: string } }) {
      const mutations = yield* LocationMutation.Service
      const files = yield* FileMutation.Service
      yield* files.remove({
        target: yield* mutations.resolve({ path: ctx.payload.path }),
        recursive: true,
      })
      return {}
    }, Effect.mapError(fileError))

    const rename = Effect.fn("FileSystemHandler.rename")(function* (ctx: {
      payload: { from: string; to: string }
    }) {
      const mutations = yield* LocationMutation.Service
      const files = yield* FileMutation.Service
      yield* files.rename({
        from: yield* mutations.resolve({ path: ctx.payload.from }),
        to: yield* mutations.resolve({ path: ctx.payload.to }),
      })
      return {}
    }, Effect.mapError(fileError))

    const mkdir = Effect.fn("FileSystemHandler.mkdir")(function* (ctx: {
      payload: { path: string; kind: "file" | "directory" }
    }) {
      const mutations = yield* LocationMutation.Service
      const files = yield* FileMutation.Service
      const target = yield* mutations.resolve({ path: ctx.payload.path, kind: ctx.payload.kind })
      if (ctx.payload.kind === "file") {
        yield* files.create({ target, content: "" })
        return {}
      }
      yield* files.mkdir({ target })
      return {}
    }, Effect.mapError(fileError))

    return handlers
      .handleRaw("fs.read", (ctx) =>
        Effect.gen(function* () {
          const file = yield* (yield* FileSystem.Service).read({
            path: RelativePath.make(
              decodeURIComponent(new URL(ctx.request.url, "http://localhost").pathname.slice(13)),
            ),
          })
          return HttpServerResponse.uint8Array(file.content, { contentType: file.mime })
        }),
      )
      .handle("fs.list", (ctx) =>
        response(
          Effect.gen(function* () {
            const fs = yield* FileSystem.Service
            return yield* fs.list(ctx.query)
          }),
        ),
      )
      .handle("fs.find", (ctx) =>
        response(
          Effect.gen(function* () {
            const fs = yield* FileSystem.Service
            return yield* fs.find(ctx.query)
          }),
        ),
      )
      .handle("fs.write", (ctx) => response(write(ctx)))
      .handle("fs.delete", (ctx) => response(remove(ctx)))
      .handle("fs.rename", (ctx) => response(rename(ctx)))
      .handle("fs.mkdir", (ctx) => response(mkdir(ctx)))
  }),
)

function fileError(error: FileMutation.StaleContentError | FileMutation.TargetExistsError | LocationMutation.PathError | FSUtil.Error) {
  if (error instanceof FileMutation.StaleContentError) {
    return new ConflictError({ message: "File changed on disk", resource: error.path })
  }
  if (error instanceof FileMutation.TargetExistsError) {
    return new ConflictError({ message: "Target already exists", resource: error.path })
  }
  if (error instanceof LocationMutation.PathError) {
    return new InvalidRequestError({ message: `Invalid path: ${error.path}`, kind: "Path" })
  }
  return new InvalidRequestError({ message: error.message || "Filesystem operation failed", kind: "Filesystem" })
}
