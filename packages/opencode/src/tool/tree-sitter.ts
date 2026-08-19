import { fileURLToPath } from "url"
import { lazy } from "@/util/lazy"

/**
 * Shared tree-sitter wasm loading (design §3.1).
 *
 * Reuses `shell.ts`'s exact resolveWasm pattern. shell.ts may adopt this
 * module later; this lane does not touch shell.ts.
 */

export type GrammarID = "typescript" | "tsx" | "javascript"

export const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

/**
 * Lazy singleton: initializes web-tree-sitter once and builds one `Parser`
 * per grammar. First call loads all three wasm files; subsequent calls are
 * free. The returned parsers are safe to reuse across parses (parse is
 * synchronous on the current thread).
 */
export const loadParsers = lazy(async () => {
  const { Parser, Language } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const make = async (specifier: string) => {
    const { default: wasm } = await import(specifier, { with: { type: "wasm" } })
    const parser = new Parser()
    parser.setLanguage(await Language.load(resolveWasm(wasm)))
    return parser
  }
  return {
    typescript: await make("tree-sitter-typescript/tree-sitter-typescript.wasm"),
    tsx: await make("tree-sitter-typescript/tree-sitter-tsx.wasm"),
    javascript: await make("tree-sitter-javascript/tree-sitter-javascript.wasm"),
  }
})

/** Map a file extension to the grammar that parses it (design §5.5). */
export function grammarForExtension(ext: string): GrammarID | undefined {
  if (ext === "ts" || ext === "mts" || ext === "cts") return "typescript"
  if (ext === "tsx") return "tsx"
  if (ext === "js" || ext === "mjs" || ext === "cjs" || ext === "jsx") return "javascript"
  return undefined
}

export * as TreeSitter from "./tree-sitter"
