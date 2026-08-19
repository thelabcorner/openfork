import { FileSystem } from "@opencode-ai/schema/filesystem"
import { Location } from "@opencode-ai/schema/location"
import { PositiveInt, RelativePath } from "@opencode-ai/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, InvalidRequestError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

const ListQuery = Schema.Struct({
  ...LocationQuery.fields,
  path: RelativePath.pipe(Schema.optional),
})

const FindQuery = Schema.Struct({
  ...LocationQuery.fields,
  query: FileSystem.FindInput.fields.query,
  type: FileSystem.FindInput.fields.type,
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt), Schema.optional),
})

const WritePayload = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
  expectedHash: Schema.String.pipe(Schema.optional),
})

const WriteResult = Schema.Struct({
  hash: Schema.String,
}).annotate({ identifier: "FileSystem.WriteResult" })

const EmptyResult = Schema.Struct({}).annotate({ identifier: "FileSystem.EmptyResult" })

const DeletePayload = Schema.Struct({
  path: Schema.String,
})

const RenamePayload = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
})

const MkdirPayload = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literals(["file", "directory"]),
})

export const FileSystemGroup = HttpApiGroup.make("server.fs")
  .add(
    HttpApiEndpoint.get("fs.read", "/api/fs/read/*", {
      query: LocationQuery,
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.read",
          summary: "Read file",
          description: "Serve one file relative to the requested location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("fs.list", "/api/fs/list", {
      query: ListQuery,
      success: Location.response(Schema.Array(FileSystem.Entry)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.list",
          summary: "List directory",
          description: "List direct children of one directory relative to the requested location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("fs.find", "/api/fs/find", {
      query: FindQuery,
      success: Location.response(Schema.Array(FileSystem.Entry)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.find",
          summary: "Find files",
          description: "Find recursively ranked filesystem entries relative to the requested location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("fs.write", "/api/fs/write", {
      payload: WritePayload,
      success: Location.response(WriteResult),
      error: [ConflictError, InvalidRequestError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.write",
          summary: "Write file",
          description: "Write one file relative to the requested location with optional hash concurrency.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("fs.delete", "/api/fs/delete", {
      payload: DeletePayload,
      success: Location.response(EmptyResult),
      error: [ConflictError, InvalidRequestError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.delete",
          summary: "Delete path",
          description: "Delete one file or directory relative to the requested location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("fs.rename", "/api/fs/rename", {
      payload: RenamePayload,
      success: Location.response(EmptyResult),
      error: [ConflictError, InvalidRequestError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.rename",
          summary: "Rename path",
          description: "Rename or move one file or directory relative to the requested location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("fs.mkdir", "/api/fs/mkdir", {
      payload: MkdirPayload,
      success: Location.response(EmptyResult),
      error: [ConflictError, InvalidRequestError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.mkdir",
          summary: "Create path",
          description: "Create one empty file or directory relative to the requested location.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "filesystem",
      description: "Experimental location-scoped filesystem routes.",
    }),
  )
