import { FileSystem } from "@opencode-ai/core/filesystem"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { LSP } from "@/lsp/lsp"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"

export const FileQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  path: Schema.String,
  // Chunked listing for extremely huge repos. Without limit the handler
  // returns the full directory (backwards compatible). With limit/offset the
  // response is a paginated slice, letting the explorer stream 100k-entry
  // directories in 1k-item chunks instead of one 10 MB JSON payload that
  // times out as "Failed to fetch".
  limit: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(5000)),
  ),
  offset: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
})

export const FindTextQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  pattern: Schema.String,
})

export const FindFileQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  query: Schema.String,
  dirs: Schema.optional(Schema.Literals(["true", "false"])),
  type: Schema.optional(Schema.Literals(["file", "directory"])),
  limit: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(200)),
  ),
})

export const FindSearchQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  query: Schema.String,
  limit: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(1000)),
  ),
  offset: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  symbols: Schema.optional(Schema.Literals(["true", "false"])),
})

export const MentionResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("file"),
    path: Schema.String,
    type: Schema.optional(Schema.Literals(["file", "directory"])),
    score: Schema.Number,
    positions: Schema.optional(Schema.Array(Schema.Number)),
    baseOffset: Schema.optional(Schema.Number),
    size: Schema.optional(Schema.Number),
    mtime: Schema.optional(Schema.Number),
    lineCount: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    kind: Schema.Literal("symbol"),
    name: Schema.String,
    path: Schema.String,
    line: Schema.Number,
    symbolKind: Schema.String,
    score: Schema.Number,
    positions: Schema.optional(Schema.Array(Schema.Number)),
  }),
]).annotate({ identifier: "MentionResult" })

export const FindSearchResponse = Schema.Struct({
  results: Schema.Array(MentionResult),
  hasMore: Schema.Boolean,
  total: Schema.Number,
}).annotate({ identifier: "MentionSearchPage" })

export const FindSymbolQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  query: Schema.String,
})

export const ExternalListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  path: Schema.String,
  sessionID: Schema.String,
  query: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(200)),
  ),
})

export const ExternalEntry = Schema.Struct({
  name: Schema.String,
  absolute: Schema.String,
  type: Schema.Literals(["file", "directory", "symlink", "other"]),
}).annotate({ identifier: "ExternalPath.Entry" })

export const ExternalListResult = Schema.Struct({
  base: Schema.String,
  entries: Schema.Array(ExternalEntry),
}).annotate({ identifier: "ExternalPath.ListResult" })

export class ExternalPathError extends Schema.ErrorClass<ExternalPathError>("ExternalPathError")(
  {
    name: Schema.Literal("ExternalPathError"),
    data: Schema.Struct({
      message: Schema.String,
      code: Schema.Literals(["invalid_path", "not_found", "filesystem"]),
    }),
  },
  { httpApiStatus: 400 },
) {}

export class ExternalPermissionPendingError extends Schema.ErrorClass<ExternalPermissionPendingError>(
  "ExternalPermissionPendingError",
)(
  {
    name: Schema.Literal("ExternalPermissionPendingError"),
    data: Schema.Struct({
      message: Schema.String,
      glob: Schema.String,
    }),
  },
  { httpApiStatus: 409 },
) {}

export class ExternalPermissionDeniedError extends Schema.ErrorClass<ExternalPermissionDeniedError>(
  "ExternalPermissionDeniedError",
)(
  {
    name: Schema.Literal("ExternalPermissionDeniedError"),
    data: Schema.Struct({
      message: Schema.String,
      glob: Schema.String,
    }),
  },
  { httpApiStatus: 403 },
) {}

export const LegacyMatch = Schema.Struct({
  path: Schema.Struct({ text: Schema.String }),
  lines: Schema.Struct({ text: Schema.String }),
  line_number: NonNegativeInt,
  absolute_offset: NonNegativeInt,
  submatches: Schema.Array(
    Schema.Struct({
      match: Schema.Struct({ text: Schema.String }),
      start: NonNegativeInt,
      end: NonNegativeInt,
    }),
  ),
})

export const LegacyEntry = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  absolute: Schema.String,
  type: Schema.Literals(["file", "directory"]),
  ignored: Schema.Boolean,
  size: Schema.optional(Schema.Number),
  mtime: Schema.optional(Schema.Number),
}).annotate({ identifier: "FileNode" })

export const LegacyContent = Schema.Struct({
  type: Schema.Literals(["text", "binary"]),
  content: Schema.String,
  hash: Schema.String,
  diff: Schema.optional(Schema.String),
  patch: Schema.optional(
    Schema.Struct({
      oldFileName: Schema.String,
      newFileName: Schema.String,
      oldHeader: Schema.optional(Schema.String),
      newHeader: Schema.optional(Schema.String),
      hunks: Schema.Array(
        Schema.Struct({
          oldStart: NonNegativeInt,
          oldLines: NonNegativeInt,
          newStart: NonNegativeInt,
          newLines: NonNegativeInt,
          lines: Schema.Array(Schema.String),
        }),
      ),
      index: Schema.optional(Schema.String),
    }),
  ),
  encoding: Schema.optional(Schema.Literal("base64")),
  mimeType: Schema.optional(Schema.String),
}).annotate({ identifier: "FileContent" })

export const FileWritePayload = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
  expectedHash: Schema.optional(Schema.String),
})

export const FileWriteResult = Schema.Struct({
  hash: Schema.String,
}).annotate({ identifier: "FileWriteResult" })

export const FileDeletePayload = Schema.Struct({
  path: Schema.String,
})

export const FileRenamePayload = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
})

export const FileMkdirPayload = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literals(["file", "directory"]),
})

export const FileMutationResult = Schema.Struct({}).annotate({ identifier: "FileMutationResult" })

export class FileMutationError extends Schema.ErrorClass<FileMutationError>("FileMutationError")(
  {
    name: Schema.Literal("FileMutationError"),
    data: Schema.Struct({
      message: Schema.String,
      path: Schema.optional(Schema.String),
      code: Schema.Literals(["conflict", "invalid_path", "filesystem"]),
    }),
  },
  { httpApiStatus: 409 },
) {}

export const LegacyStatus = Schema.Struct({
  path: Schema.String,
  added: NonNegativeInt,
  removed: NonNegativeInt,
  status: Schema.Literals(["added", "deleted", "modified"]),
}).annotate({ identifier: "File" })

export const FilePaths = {
  findText: "/find",
  findFile: "/find/file",
  findSearch: "/find/search",
  findSymbol: "/find/symbol",
  externalList: "/fs/external-list",
  list: "/file",
  content: "/file/content",
  write: "/file/write",
  delete: "/file/delete",
  rename: "/file/rename",
  mkdir: "/file/mkdir",
  status: "/file/status",
} as const

export const FileApi = HttpApi.make("file")
  .add(
    HttpApiGroup.make("file")
      .add(
        HttpApiEndpoint.get("findText", FilePaths.findText, {
          query: FindTextQuery,
          success: described(Schema.Array(LegacyMatch), "Matches"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "find.text",
            summary: "Find text",
            description: "Search for text patterns across files in the project using ripgrep.",
          }),
        ),
        HttpApiEndpoint.get("findFile", FilePaths.findFile, {
          query: FindFileQuery,
          success: described(Schema.Array(Schema.String), "File paths"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "find.files",
            summary: "Find files",
            description: "Search for files or directories by name or pattern in the project directory.",
          }),
        ),
        HttpApiEndpoint.get("findSearch", FilePaths.findSearch, {
          query: FindSearchQuery,
          success: described(FindSearchResponse, "Mention search page"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "find.search",
            summary: "Fuzzy mention search",
            description:
              "Fuzzy-search files, directories, and symbols for @mention typeahead. Returns one merged score-ranked list with match highlight positions and offset pagination.",
          }),
        ),
        HttpApiEndpoint.get("findSymbol", FilePaths.findSymbol, {
          query: FindSymbolQuery,
          success: described(Schema.Array(LSP.Symbol), "Symbols"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "find.symbols",
            summary: "Find symbols",
            description: "Search for workspace symbols like functions, classes, and variables using LSP.",
          }),
        ),
        HttpApiEndpoint.get("list", FilePaths.list, {
          query: FileQuery,
          success: described(Schema.Array(LegacyEntry), "Files and directories"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.list",
            summary: "List files",
            description: "List files and directories in a specified path.",
          }),
        ),
        HttpApiEndpoint.get("content", FilePaths.content, {
          query: FileQuery,
          success: described(LegacyContent, "File content"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.read",
            summary: "Read file",
            description: "Read the content of a specified file.",
          }),
        ),
        HttpApiEndpoint.post("write", FilePaths.write, {
          query: WorkspaceRoutingQuery,
          payload: FileWritePayload,
          success: described(FileWriteResult, "File write result"),
          error: FileMutationError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.write",
            summary: "Write file",
            description: "Write the content of a specified file using optimistic concurrency.",
          }),
        ),
        HttpApiEndpoint.post("delete", FilePaths.delete, {
          query: WorkspaceRoutingQuery,
          payload: FileDeletePayload,
          success: described(FileMutationResult, "File delete result"),
          error: FileMutationError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.delete",
            summary: "Delete file",
            description: "Delete a specified file or directory.",
          }),
        ),
        HttpApiEndpoint.post("rename", FilePaths.rename, {
          query: WorkspaceRoutingQuery,
          payload: FileRenamePayload,
          success: described(FileMutationResult, "File rename result"),
          error: FileMutationError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.rename",
            summary: "Rename file",
            description: "Rename or move a specified file or directory.",
          }),
        ),
        HttpApiEndpoint.post("mkdir", FilePaths.mkdir, {
          query: WorkspaceRoutingQuery,
          payload: FileMkdirPayload,
          success: described(FileMutationResult, "File create result"),
          error: FileMutationError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.mkdir",
            summary: "Create file or directory",
            description: "Create an empty file or directory.",
          }),
        ),
        HttpApiEndpoint.get("status", FilePaths.status, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(LegacyStatus), "File status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.status",
            summary: "Get file status",
            description: "Get the git status of all files in the project.",
          }),
        ),
        HttpApiEndpoint.get("externalList", FilePaths.externalList, {
          query: ExternalListQuery,
          success: described(ExternalListResult, "External directory listing"),
          error: [ExternalPathError, ExternalPermissionPendingError, ExternalPermissionDeniedError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "fs.external.list",
            summary: "List external directory",
            description:
              "List entries of an arbitrary local directory outside the project for @mention typeahead. Gated by the external_directory permission; first access to a subtree prompts the user.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "file",
          description: "Experimental HttpApi file routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
