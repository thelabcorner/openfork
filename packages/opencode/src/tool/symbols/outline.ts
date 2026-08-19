import { Effect, Ref } from "effect"
import path from "path"
import type { Node } from "web-tree-sitter"
import { InstanceState } from "@/effect/instance-state"
import type { FSUtil } from "@opencode-ai/core/fs-util"
import { grammarForExtension, loadParsers } from "../tree-sitter"

/**
 * Per-file symbol outline: tree-sitter classification (design §5.2) plus a
 * regex declaration-scanner fallback for languages without a grammar or when
 * a parse fails. Walked once per file, cached by mtime in `InstanceState`
 * (design §3.2).
 */

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "const"
  | "method"
  | "property"
  | "parameter"
  | "import"
  | "module"

export interface OutlineSymbol {
  name: string
  kind: SymbolKind
  line: number
  col: number
  sig: string
  memberOf?: string
}

export interface IdentifierNode {
  name: string
  line: number
  col: number
  parentKind: string
  isDecl: boolean
  kind?: SymbolKind
  memberOf?: string
}

export interface FileImport {
  from: string
  /** Local binding names (alias-aware: `import { A as B }` → ["B"]). */
  bindings: string[]
  /** Imported names as written (`import { A as B }` → ["A"]). */
  sources: string[]
  line: number
}

export interface FileOutline {
  lang: string
  fallback: boolean
  parseErrors: number
  symbols: OutlineSymbol[]
  identifiers: IdentifierNode[]
  imports: FileImport[]
}

export interface CachedOutline {
  mtimeMs: number
  size: number
  outline: FileOutline
}

export const MAX_CACHE_ENTRIES = 500

/** Parent node kind → symbol kind for declarations (design §5.2 table). */
const DECLARATION_PARENTS: Record<string, SymbolKind> = {
  function_declaration: "function",
  generator_function_declaration: "function",
  function_signature: "function",
  class_declaration: "class",
  abstract_class_declaration: "class",
  interface_declaration: "interface",
  type_alias_declaration: "type",
  enum_declaration: "enum",
  method_definition: "method",
  abstract_method_signature: "method",
  method_signature: "method",
  public_field_definition: "property",
  property_signature: "property",
  class_property: "property",
  required_parameter: "parameter",
  optional_parameter: "parameter",
  import_specifier: "import",
  export_specifier: "import",
  internal_module: "module",
  module: "module",
  namespace_definition: "module",
}

const IDENTIFIER_TYPES = new Set(["identifier", "type_identifier", "property_identifier"])

const named = (node: Node): Node[] => node.namedChildren.filter((child): child is Node => Boolean(child))

const startPoint = (node: Node) => ({ line: node.startPosition.row + 1, col: node.startPosition.column + 1 })

/** Field name that holds a declaration's name, or "pattern" for parameters. */
function nameFieldOf(parent: Node): string {
  if (parent.type === "required_parameter" || parent.type === "optional_parameter") return "pattern"
  if (parent.type === "import_specifier" || parent.type === "export_specifier") {
    // binding = alias ?? name
    return parent.childForFieldName("alias") ? "alias" : "name"
  }
  return "name"
}

/** Name text for a declaration parent (name field, stripping string quotes for modules). */
function declarationName(parent: Node): string | undefined {
  const field = nameFieldOf(parent)
  const node = parent.childForFieldName(field)
  if (!node) return undefined
  if (node.type === "string") return node.text.slice(1, -1)
  return node.text
}

/** Signature text of a declaration node, trimmed to 80 chars, body stripped. */
function sigOf(node: Node): string {
  const text = node.text.replace(/\s+/g, " ").trim()
  const body = text.indexOf("{")
  const cut = body === -1 ? text : text.slice(0, body)
  return cut.length > 80 ? cut.slice(0, 77) + "..." : cut
}

/** Strip surrounding quotes from a string-literal node's text. */
function unquote(node: Node): string {
  const text = node.text
  if (text.length >= 2 && ((text[0] === '"' && text[text.length - 1] === '"') || (text[0] === "'" && text[text.length - 1] === "'")))
    return text.slice(1, -1)
  return text
}

function readImportStatement(node: Node): FileImport | undefined {
  const source = node.childForFieldName("source")
  if (!source) return undefined
  const bindings: string[] = []
  const sources: string[] = []
  const clause = named(node).find((child) => child.type === "import_clause")
  if (clause) {
    for (const child of named(clause)) {
      if (child.type === "named_imports") {
        for (const spec of named(child)) {
          if (spec.type === "import_specifier") {
            const imported = spec.childForFieldName("name")?.text
            if (imported) sources.push(imported)
            const binding = spec.childForFieldName("alias")?.text ?? imported
            if (binding) bindings.push(binding)
          }
        }
      } else if (child.type === "namespace_import") {
        const name = child.childForFieldName("name")?.text
        if (name) {
          sources.push("*")
          bindings.push(name)
        }
      } else if (child.type === "identifier") {
        sources.push("default")
        bindings.push(child.text)
      }
    }
  }
  return { from: unquote(source), bindings, sources, line: startPoint(node).line }
}

function readExportFrom(node: Node): FileImport | undefined {
  const source = node.childForFieldName("source")
  if (!source) return undefined
  const clause = node.childForFieldName("export_clause")
  if (!clause) return undefined
  const bindings: string[] = []
  const sources: string[] = []
  for (const spec of named(clause)) {
    if (spec.type === "export_specifier") {
      const imported = spec.childForFieldName("name")?.text
      if (imported) sources.push(imported)
      const binding = spec.childForFieldName("alias")?.text ?? imported
      if (binding) bindings.push(binding)
    }
  }
  return { from: unquote(source), bindings, sources, line: startPoint(node).line }
}

function readRequireOrDynamic(node: Node): FileImport | undefined {
  const fn = node.childForFieldName("function")
  if (!fn) return undefined
  const isRequire = fn.type === "identifier" && fn.text === "require"
  const isDynamicImport = (fn.type === "identifier" || fn.type === "import") && fn.text === "import"
  if (!isRequire && !isDynamicImport) return undefined
  const args = node.childForFieldName("arguments")
  const first = args?.namedChild(0)
  if (!first || first.type !== "string") return undefined
  // Binding is the enclosing variable declarator's name, or destructured keys.
  const bindings: string[] = []
  const parent = node.parent
  if (parent?.type === "variable_declarator") {
    const name = parent.childForFieldName("name")
    if (name?.type === "identifier") bindings.push(name.text)
    else if (name?.type === "object_pattern") {
      for (const key of named(name)) {
        const k = key.type === "pair" ? key.childForFieldName("key") : key
        if (k) bindings.push(k.text)
      }
    }
  }
  return { from: unquote(first), bindings, sources: bindings, line: startPoint(node).line }
}

function parseImports(node: Node, out: FileImport[]) {
  if (node.type === "import_statement") {
    const imp = readImportStatement(node)
    if (imp) out.push(imp)
  } else if (node.type === "export_statement" && node.childForFieldName("source")) {
    const imp = readExportFrom(node)
    if (imp) out.push(imp)
  } else if (node.type === "call_expression") {
    const imp = readRequireOrDynamic(node)
    if (imp) out.push(imp)
  }
}

/**
 * Recursive classification walk. Every identifier-family node is recorded with
 * its parent kind and whether it is a declaration name (parent kind from the
 * declaration table, or a variable declarator name).
 */
function collect(root: Node): Pick<FileOutline, "symbols" | "identifiers" | "imports" | "parseErrors"> {
  const symbols: OutlineSymbol[] = []
  const identifiers: IdentifierNode[] = []
  const imports: FileImport[] = []
  const parseErrors = root.descendantsOfType(["ERROR", "MISSING"]).filter(Boolean).length

  const walk = (node: Node, memberOf: string | undefined) => {
    parseImports(node, imports)
    for (const child of named(node)) {
      if (child.type === "comment") continue

      // Class body context for member classification.
      const className =
        child.type === "class_declaration" || child.type === "abstract_class_declaration"
          ? declarationName(child)
          : memberOf

      // Variable declarations: lexical_declaration / variable_declaration wrap
      // variable_declarator nodes; name lives on the declarator.
      if (child.type === "lexical_declaration" || child.type === "variable_declaration") {
        for (const declarator of named(child)) {
          if (declarator.type !== "variable_declarator") continue
          const name = declarator.childForFieldName("name")
          if (!name || !IDENTIFIER_TYPES.has(name.type)) continue
          const pos = startPoint(name)
          const kind: SymbolKind =
            child.type === "lexical_declaration" && child.text.trimStart().startsWith("const") ? "const" : "variable"
          const info: IdentifierNode = { ...pos, name: name.text, parentKind: child.type, isDecl: true, kind, memberOf }
          identifiers.push(info)
          symbols.push({ ...pos, name: name.text, kind, sig: sigOf(declarator), memberOf })
        }
      }

      // Declaration-parent kinds: name lives directly on the parent.
      const declKind = DECLARATION_PARENTS[child.type]
      if (declKind) {
        const field = nameFieldOf(child)
        const name = child.childForFieldName(field)
        if (name && IDENTIFIER_TYPES.has(name.type)) {
          const pos = startPoint(name)
          const info: IdentifierNode = {
            ...pos,
            name: name.text,
            parentKind: child.type,
            isDecl: true,
            kind: declKind,
            memberOf,
          }
          identifiers.push(info)
          symbols.push({ ...pos, name: name.text, kind: declKind, sig: sigOf(child), memberOf })
        } else if (child.type === "internal_module" || child.type === "module" || child.type === "namespace_definition") {
          // Module names may be quoted strings.
          const moduleName = declarationName(child)
          if (moduleName) {
            const pos = startPoint(child)
            identifiers.push({ ...pos, name: moduleName, parentKind: child.type, isDecl: true, kind: "module" })
            symbols.push({ ...pos, name: moduleName, kind: "module", sig: sigOf(child) })
          }
        }
      }

      // Reference identifiers: identifier-family nodes not classified above.
      if (IDENTIFIER_TYPES.has(child.type) && !isDeclarationName(child)) {
        const pos = startPoint(child)
        identifiers.push({ ...pos, name: child.text, parentKind: node.type, isDecl: false, memberOf })
      }

      walk(child, className)
    }
  }

  walk(root, undefined)
  return { symbols, identifiers, imports, parseErrors }
}

/** True when this identifier-family node is the name/pattern of a declaration parent. */
function isDeclarationName(node: Node): boolean {
  const parent = node.parent
  if (!parent) return false
  if (parent.type === "variable_declarator") return parent.childForFieldName("name")?.equals(node) ?? false
  if (parent.type === "lexical_declaration" || parent.type === "variable_declaration") return false
  const kind = DECLARATION_PARENTS[parent.type]
  if (!kind) return false
  const field = nameFieldOf(parent)
  return parent.childForFieldName(field)?.equals(node) ?? false
}

/** Regex declaration-scanner fallback (design §5.2) — declarations only, best-effort. */
const DECL_PATTERNS: Array<[RegExp, SymbolKind]> = [
  [/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/, "function"],
  [/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/, "class"],
  [/^(?:export\s+)?interface\s+(\w+)/, "interface"],
  [/^(?:export\s+)?type\s+(\w+)\s*=/, "type"],
  [/^(?:export\s+)?(?:const|let|var)\s+(\w+)/, "variable"],
  [/^(?:export\s+)?enum\s+(\w+)/, "enum"],
]

export function scanRegex(source: string): FileOutline {
  const symbols: OutlineSymbol[] = []
  const lines = source.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    for (const [re, kind] of DECL_PATTERNS) {
      const match = trimmed.match(re)
      if (!match) continue
      const name = match[1]
      symbols.push({
        name,
        kind,
        line: i + 1,
        col: line.indexOf(name) + 1,
        sig: trimmed.slice(0, 80),
      })
      break
    }
  }
  return { lang: "regex", fallback: true, parseErrors: 0, symbols, identifiers: [], imports: [] }
}

/** Parse a file's text into an outline; tree-sitter first, regex fallback on failure. */
export async function outlineFor(text: string, ext: string): Promise<FileOutline> {
  const grammar = grammarForExtension(ext)
  if (!grammar) return scanRegex(text)
  try {
    const parsers = await loadParsers()
    const parser = parsers[grammar]
    const tree = parser.parse(text)
    if (!tree) return scanRegex(text)
    try {
      const collected = collect(tree.rootNode)
      // Parse failed to yield any identifiers → regex fallback (design edge case).
      if (collected.identifiers.length === 0) return scanRegex(text)
      return {
        lang: ext === "tsx" || ext === "jsx" ? ext : grammar === "typescript" ? "ts" : "js",
        fallback: false,
        parseErrors: collected.parseErrors,
        symbols: collected.symbols,
        identifiers: collected.identifiers,
        imports: collected.imports,
      }
    } finally {
      tree.delete()
    }
  } catch {
    return scanRegex(text)
  }
}

export const extOf = (file: string) => path.extname(file).slice(1).toLowerCase()

export type OutlineCacheRef = Ref.Ref<Map<string, CachedOutline>>

export const makeOutlineCache = () =>
  InstanceState.make<OutlineCacheRef>(
    Effect.fn("Symbols.outlineCache")(function* () {
      return yield* Ref.make(new Map<string, CachedOutline>())
    }),
  )

/**
 * Read-then-parse-on-miss outline access, keyed by mtime+size (design §3.2).
 * Returns undefined when the file is missing. When `source` is provided the
 * file is not re-read; staleness is still detected via stat.
 */
export const getOutline = (fs: FSUtil.Interface, cache: OutlineCacheRef, file: string, source?: string) =>
  Effect.gen(function* () {
    const info = yield* fs.stat(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!info || info.type !== "File") return undefined
    const mtimeMs = info.mtime._tag === "Some" ? info.mtime.value.getTime() : 0
    const size = Number(info.size)
    const map = yield* Ref.get(cache)
    const hit = map.get(file)
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.outline

    const text = source ?? (yield* fs.readFileStringSafe(file).pipe(Effect.catch(() => Effect.succeed(undefined))))
    if (text === undefined) return undefined
    const outline = yield* Effect.promise(() => outlineFor(text, extOf(file)))
    yield* Ref.update(cache, (current) => {
      const next = new Map(current)
      next.set(file, { mtimeMs, size, outline })
      while (next.size > MAX_CACHE_ENTRIES) {
        const oldest = next.keys().next().value
        if (oldest === undefined) break
        next.delete(oldest)
      }
      return next
    })
    return outline
  })

export * as Outline from "./outline"
