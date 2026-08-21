export * as Symbols from "./symbols"

export interface SymbolEntry {
  readonly name: string
  readonly kind: string
  readonly path: string
  readonly line: number
}

type Extractor = (source: string, path: string) => SymbolEntry[]

const declaration = /\b(?:export\s+)?(?:async\s+)?(function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/g
const method = /^\s*(?:(?:public|private|protected|static|async|readonly|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>\n]*>)?\s*\([^\n)]*\)\s*(?::[^\n{]+)?\s*\{/g

/**
 * Extracts TypeScript/JavaScript declarations with a single line-oriented
 * pass. This intentionally avoids AST dependencies; tree-sitter can replace
 * this registry implementation in a later symbol-index epoch.
 */
export function extractTypeScriptSymbols(source: string, path: string): SymbolEntry[] {
  const out: SymbolEntry[] = []
  const lines = source.split(/\r?\n/)
  lines.forEach((line, index) => {
    declaration.lastIndex = 0
    for (let match = declaration.exec(line); match !== null; match = declaration.exec(line))
      out.push({ name: match[2]!, kind: match[1]!, path, line: index + 1 })

    method.lastIndex = 0
    const methodMatch = method.exec(line)
    if (methodMatch !== null && !out.some((entry) => entry.line === index + 1 && entry.name === methodMatch[1]))
      out.push({ name: methodMatch[1]!, kind: "method", path, line: index + 1 })
  })
  return out
}

const registry = new Map<string, Extractor>([
  [".ts", extractTypeScriptSymbols],
  [".tsx", extractTypeScriptSymbols],
  [".js", extractTypeScriptSymbols],
  [".jsx", extractTypeScriptSymbols],
  [".mjs", extractTypeScriptSymbols],
  [".cjs", extractTypeScriptSymbols],
])

export function extractSymbols(path: string, source: string): SymbolEntry[] {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase()
  return registry.get(extension)?.(source, path) ?? []
}

export function registerExtractor(extension: string, extractor: Extractor): void {
  registry.set(extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`, extractor)
}
