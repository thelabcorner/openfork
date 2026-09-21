export * as ExchangeLsp from "./lsp"

import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Effect, Schema } from "effect"
import { Parameters as NativeParameters } from "@/tool/lsp"
import { ExchangeError } from "./error"
import { ExchangeRuntimeV1 } from "./runtime-v1"

export const Parameters = NativeParameters
export type Input = Schema.Schema.Type<typeof Parameters>

export interface Context {
  readonly rootPath: string
  readonly filePath: string
  readonly virtualPath: string
  readonly signal?: AbortSignal
  readonly toVirtualPath: (absolutePath: string) => string
  readonly revalidate: () => Effect.Effect<void, ExchangeError.Error>
}

export interface Result {
  readonly title: string
  readonly output: string
  readonly structured: Readonly<Record<string, unknown>>
  readonly metadata: Readonly<Record<string, unknown>>
}

function contained(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function projectString(value: string, context: Context): string {
  if (value.startsWith("file://")) {
    try {
      const native = fileURLToPath(value)
      return contained(context.rootPath, native) ? context.toVirtualPath(native) : "[outside-approved-root]"
    } catch {
      return "[invalid-file-uri]"
    }
  }
  if (path.isAbsolute(value)) {
    return contained(context.rootPath, value) ? context.toVirtualPath(value) : "[outside-approved-root]"
  }
  return value
}

function projectValue(value: unknown, context: Context, depth = 0): unknown {
  if (depth > 16) return "[projection-depth-redacted]"
  if (typeof value === "string") return projectString(value, context)
  if (Array.isArray(value)) return value.slice(0, 2048).map((item) => projectValue(item, context, depth + 1))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 2048)
      .map(([key, item]) => [key, projectValue(item, context, depth + 1)]),
  )
}

export const execute = Effect.fn("ExchangeLsp.execute")(function* (input: Input, context: Context) {
  if (context.signal?.aborted) return yield* new ExchangeError.Cancelled({ detail: "LSP operation was cancelled" })

  const result = yield* ExchangeRuntimeV1.enter(
    { directory: context.rootPath, signal: context.signal },
    async () => {
      const [{ LSP }, { FSUtil }] = await Promise.all([
        import("@/lsp/lsp"),
        import("@opencode-ai/core/fs-util"),
      ])
      return Effect.gen(function* () {
        const lsp = yield* LSP.Service
        const fs = yield* FSUtil.Service
        if (!(yield* fs.existsSafe(context.filePath))) return yield* Effect.fail(new Error("LSP target file does not exist"))
        if (!(yield* lsp.hasClients(context.filePath))) return yield* Effect.fail(new Error("No LSP server is available for this file type"))
        yield* lsp.touchFile(context.filePath, "document")
        const position = { file: context.filePath, line: input.line - 1, character: input.character - 1 }
        const uri = pathToFileURL(context.filePath).href
        switch (input.operation) {
          case "goToDefinition":
            return yield* lsp.definition(position)
          case "findReferences":
            return yield* lsp.references(position)
          case "hover":
            return yield* lsp.hover(position)
          case "documentSymbol":
            return yield* lsp.documentSymbol(uri)
          case "workspaceSymbol":
            return yield* lsp.workspaceSymbol(input.query ?? "")
          case "goToImplementation":
            return yield* lsp.implementation(position)
          case "prepareCallHierarchy":
            return yield* lsp.prepareCallHierarchy(position)
          case "incomingCalls":
            return yield* lsp.incomingCalls(position)
          case "outgoingCalls":
            return yield* lsp.outgoingCalls(position)
        }
      })
    },
    "OpenFork LSP runtime operation failed",
  ).pipe(
    Effect.mapError((error) => {
      if (context.signal?.aborted) return new ExchangeError.Cancelled({ detail: "LSP operation was cancelled" })
      if (/does not exist|No LSP server/.test(error.message)) return new ExchangeError.NotFound({ detail: error.message })
      return new ExchangeError.DependencyUnavailable({ detail: "OpenFork LSP runtime is unavailable" })
    }),
  )

  yield* context.revalidate()
  const projected = projectValue(result, context)
  return {
    title: `${input.operation} ${context.virtualPath}`,
    output: Array.isArray(projected) && projected.length === 0
      ? `No results found for ${input.operation}`
      : JSON.stringify(projected, null, 2),
    structured: { operation: input.operation, file: context.virtualPath, result: projected },
    metadata: { operation: input.operation, file: context.virtualPath },
  } satisfies Result
})

