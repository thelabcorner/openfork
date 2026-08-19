import { Effect } from "effect"
import path from "path"
import type { FSUtil } from "@opencode-ai/core/fs-util"
import type { Match } from "@opencode-ai/schema/filesystem"
import type { FileOutline, OutlineCacheRef } from "./outline"
import { getOutline } from "./outline"

/**
 * `usages` action (design §5.4): defs first, then per-file reference groups
 * with import-aware attribution, and an honest `unattributed` bucket for
 * same-name-different-binding / unresolvable-import files.
 *
 * Attribution rules (design §5.4 + honesty rule):
 *  - a ref is ATTRIBUTED when an import in this file binds/sources the name
 *    and that import's module resolves to a file that declares the name;
 *  - a ref is ATTRIBUTED when this file declares the name, the definition is
 *    import-reached (some file imports it), and the ref follows the
 *    declaration (same-file usage);
 *  - otherwise the ref is UNATTRIBUTED — a file declaring its own same-name
 *    binding (but never imported) or an unresolvable import is ALWAYS reported
 *    under `unattributed`, never counted as refs.
 */

export const MAX_USAGE_FILES = 200
export const MAX_REF_SNIPPET = 120
const IMPORT_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]

export interface UsageRef {
  line: number
  col: number
  text: string
}

export interface UsageFileGroup {
  relFile: string
  attributed: boolean
  refs: UsageRef[]
}

export interface UsageResult {
  groups: UsageFileGroup[]
  unattributed: { relFile: string; note: string; refs: UsageRef[] }[]
  files: number
  refs: number
  unattributedRefs: number
  skipped: number
}

/** Normalize a candidate path for def-file comparison (case-fold on win32). */
function normalize(p: string): string {
  const resolved = path.resolve(p)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

/** Try to resolve an import `from` to concrete file paths (design §5.4). */
function resolveImportTargets(from: string, fileDir: string): string[] {
  if (from.startsWith(".")) {
    const base = path.resolve(fileDir, from)
    const candidates = [base, ...IMPORT_EXTS.map((ext) => base + ext)]
    for (const ext of IMPORT_EXTS) candidates.push(path.join(base, `index${ext}`))
    return candidates.map(normalize)
  }
  // Bare/absolute specifier: compare best-effort against def-file module paths.
  return [normalize(from)]
}

/** Best-effort bare/absolute specifier match against a def file. */
function bareSpecifierMatches(from: string, defFile: string, cwd: string): boolean {
  const stripped = from.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "").replace(/^@[^/]+\//, "")
  const defRel = path.relative(cwd, defFile).replace(/\\/g, "/").replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "")
  if (defRel === stripped) return true
  if (defRel.endsWith("/" + stripped)) return true
  return defRel.replace(/\/index$/, "") === stripped.replace(/\/index$/, "")
}

/** Whether this file's imports bind/source the name and resolve to a def file. */
function importResolvesToDef(imp: { from: string; bindings: string[]; sources: string[] }, abs: string, defSet: Set<string>, defFiles: string[], cwd: string) {
  const targets = resolveImportTargets(imp.from, path.dirname(abs))
  if (targets.some((t) => defSet.has(t))) return true
  if (!imp.from.startsWith(".")) {
    for (const defFile of defFiles) {
      if (bareSpecifierMatches(imp.from, defFile, cwd)) return true
    }
  }
  return false
}

export const usages = (
  fs: FSUtil.Interface,
  cache: OutlineCacheRef,
  cwd: string,
  matches: readonly Match[],
  query: string,
  defFiles: string[],
): Effect.Effect<UsageResult> =>
  Effect.gen(function* () {
    const defSet = new Set(defFiles.map(normalize))
    const byFile = new Map<string, Match[]>()
    for (const match of matches) {
      const file = match.entry.path
      const list = byFile.get(file) ?? []
      list.push(match)
      byFile.set(file, list)
    }

    // Pre-load outlines so the import-reached pass sees every candidate file.
    const outlines = new Map<string, FileOutline | undefined>()
    let loaded = 0
    for (const relFile of byFile.keys()) {
      if (loaded >= MAX_USAGE_FILES) break
      loaded++
      outlines.set(relFile, yield* getOutline(fs, cache, path.join(cwd, ...relFile.split("/"))))
    }

    // Import-reached defs: a def file is a real target when some candidate
    // file imports the name from it. Def files never imported are treated as
    // their own same-name bindings → their refs are unattributed.
    const importReached = new Set<string>()
    for (const [relFile, outline] of outlines) {
      if (!outline) continue
      const abs = path.join(cwd, ...relFile.split("/"))
      for (const imp of outline.imports) {
        if (!(imp.bindings.includes(query) || imp.sources.includes(query))) continue
        if (!importResolvesToDef(imp, abs, defSet, defFiles, cwd)) continue
        for (const target of resolveImportTargets(imp.from, path.dirname(abs))) {
          if (defSet.has(target)) importReached.add(normalize(target))
        }
      }
    }

    const groups: UsageFileGroup[] = []
    const unattributed: UsageResult["unattributed"] = []
    let files = 0
    let refs = 0
    let unattributedRefs = 0
    let skipped = 0

    for (const [relFile, fileMatches] of byFile) {
      if (files >= MAX_USAGE_FILES) {
        skipped += byFile.size - files
        break
      }
      files++
      const abs = path.join(cwd, ...relFile.split("/"))
      const outline = outlines.get(relFile)
      if (!outline) continue

      const texts = new Map<number, string>()
      for (const match of fileMatches) {
        if (!texts.has(match.line)) texts.set(match.line, match.text.trim())
      }

      // Import declarations do not make a file "declare its own" binding —
      // they are how the file reaches the symbol (attributed via importResolves).
      const fileDecls = outline.symbols.filter((s) => s.name === query && s.kind !== "import" && s.kind !== "module")
      const firstDeclLine = fileDecls.length > 0 ? Math.min(...fileDecls.map((d) => d.line)) : Infinity
      const selfDeclImportReached = importReached.has(normalize(abs))
      const importsBounding = outline.imports.filter(
        (imp) => imp.bindings.includes(query) || imp.sources.includes(query),
      )
      const importResolves = importsBounding.some((imp) => importResolvesToDef(imp, abs, defSet, defFiles, cwd))

      const refRows: UsageRef[] = []
      const unattrRows: UsageRef[] = []
      for (const id of outline.identifiers) {
        if (id.name !== query || id.isDecl) continue
        const ref = { line: id.line, col: id.col, text: texts.get(id.line) ?? id.name }
        // Attributed: import binds/sources the name and resolves to a def
        // file, OR the file declares the name, its definition is
        // import-reached, and the ref follows the declaration.
        if (importResolves || (fileDecls.length > 0 && selfDeclImportReached && id.line > firstDeclLine)) {
          refRows.push(ref)
        } else {
          unattrRows.push(ref)
        }
      }
      if (refRows.length > 0) {
        refs += refRows.length
        groups.push({ relFile, attributed: true, refs: refRows })
      }
      if (unattrRows.length > 0) {
        unattributedRefs += unattrRows.length
        const note = fileDecls.length > 0
          ? `declares its own '${query}'; matches may be unrelated`
          : importsBounding.length > 0
            ? `imports '${query}' but the module could not be resolved to a definition`
            : `no import or declaration for '${query}'; matches may be unrelated`
        unattributed.push({ relFile, note, refs: unattrRows })
      }
    }

    return { groups, unattributed, files, refs, unattributedRefs, skipped }
  })

/** Resolve the symbol name from a file+line (design §5.4). */
export const identifierAt = (outline: FileOutline | undefined, line: number): string | undefined => {
  if (!outline) return undefined
  const at = outline.identifiers
    .filter((id) => id.line === line)
    .sort((a, b) => a.col - b.col)
  return at[0]?.name
}

export * as SymbolsUsages from "./usages"
