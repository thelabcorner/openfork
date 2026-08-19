import { Effect, Schema, Scope } from "effect"
import path from "path"
import { PositiveInt } from "@opencode-ai/core/schema"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import * as Tool from "./tool"
import * as Truncate from "./truncate"
import DESCRIPTION from "./symbols.txt"
import { assertExternalDirectoryEffect } from "./external-directory"
import { makeOutlineCache, getOutline, type OutlineCacheRef } from "./symbols/outline"
import { findDefinitions, validateQuery, wordPattern } from "./symbols/search"
import { usages, identifierAt, MAX_REF_SNIPPET } from "./symbols/usages"

export const Parameters = Schema.Struct({
  action: Schema.optional(Schema.Literals(["search", "outline", "usages"])).annotate({
    description:
      "Operation (default search). search = find definitions; outline = all symbols in a file; usages = find all references (JetBrains Find Usages).",
  }),
  query: Schema.optional(Schema.String).annotate({
    description:
      "Symbol name (search/usages). Word-boundary matched; empty → error. Search ranks exact > prefix > substring > fuzzy.",
  }),
  file: Schema.optional(Schema.String).annotate({
    description:
      "outline: file to outline (required). usages: file whose identifier at `line` is the symbol (alternative to query).",
  }),
  line: Schema.optional(PositiveInt).annotate({
    description:
      "usages: 1-based line within `file`; the identifier there is resolved to the symbol name (requires file).",
  }),
  path: Schema.optional(Schema.String).annotate({
    description: "search: scope to search (dir or file; default project root).",
  }),
  kind: Schema.optional(
    Schema.Literals([
      "function",
      "class",
      "interface",
      "type",
      "variable",
      "const",
      "enum",
      "method",
      "property",
      "parameter",
      "import",
      "module",
    ]),
  ).annotate({ description: "search: restrict result kinds." }),
  lang: Schema.optional(Schema.Literals(["ts", "tsx", "js", "jsx"])).annotate({
    description: "search: restrict candidate files by language (default: auto from extensions ts/tsx/js/jsx).",
  }),
  maxResults: Schema.optional(Schema.Int).annotate({
    description: "search/usages: cap (default 50 search / 200 usages, max 500)",
  }),
})

const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

const langGlob = (lang?: string) => {
  if (lang === "ts") return "*.ts"
  if (lang === "tsx") return "*.tsx"
  if (lang === "js") return "*.js"
  if (lang === "jsx") return "*.jsx"
  return "*.{ts,tsx,js,jsx}"
}

const relToWorktree = (worktree: string, abs: string) => {
  const rel = path.relative(worktree, abs)
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Refusing to access path outside the worktree: ${abs}`)
  return rel
}

const resolvePath = (directory: string, input?: string) => {
  if (!input) return directory
  return path.isAbsolute(input) ? input : path.join(directory, input)
}

const snippet = (text: string) => (text.length > MAX_REF_SNIPPET ? text.slice(0, MAX_REF_SNIPPET) + "…" : text)

type SymbolsMetadata = {
  action: string
  query?: string
  file?: string
  lang?: string
  symbols?: number
  parseErrors?: number
  files?: number
  results?: number
  defs?: number
  refs?: number
  unattributed?: number
  truncated?: boolean
}

export const SymbolsTool = Tool.define<
  typeof Parameters,
  SymbolsMetadata,
  FSUtil.Service | Ripgrep.Service | Truncate.Service | Scope.Scope
>(
  "symbols",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    const truncate = yield* Truncate.Service
    const cacheState = yield* makeOutlineCache()

    const grepCandidates = (
      cwd: string,
      query: string,
      include: string,
      file?: string,
      limit = 2000,
    ) =>
      ripgrep.grep({
        cwd,
        pattern: wordPattern(query),
        include,
        file,
        limit,
      })

    const outlineAction = (
      ctx: Tool.Context,
      instance: { directory: string; worktree: string },
      cache: OutlineCacheRef,
      fileParam: string,
      maxResults: number,
    ) =>
      Effect.gen(function* () {
        const abs = resolvePath(instance.directory, fileParam)
        relToWorktree(instance.worktree, abs)
        yield* assertExternalDirectoryEffect(ctx, abs, { kind: "file" })
        const info = yield* fs.stat(abs).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!info || info.type !== "File") throw new Error(`File not found: ${abs}`)
        if (info.size > 1024 * 1024) {
          throw new Error(`File too large to outline (${info.size} bytes > 1 MB). Use grep with a pattern instead.`)
        }
        const text = yield* fs.readFileStringSafe(abs)
        if (text === undefined) throw new Error(`File not found: ${abs}`)
        const cached = yield* getOutline(fs, cache, abs, text)
        if (cached === undefined) throw new Error(`File not found: ${abs}`)
        const outline = cached

        const rel = relToWorktree(instance.worktree, abs)
        const classNames = new Set(outline.symbols.filter((s) => s.kind === "class").map((s) => s.name))
        const membersByClass = new Map<string, typeof outline.symbols>()
        for (const symbol of outline.symbols) {
          if (symbol.memberOf && classNames.has(symbol.memberOf)) {
            const list = membersByClass.get(symbol.memberOf) ?? []
            list.push(symbol)
            membersByClass.set(symbol.memberOf, list)
          }
        }
        const topLevel = outline.symbols.filter((s) => !s.memberOf || !classNames.has(s.memberOf))

        const order = ["function", "class", "interface", "type", "enum", "variable", "const", "import", "module"] as const
        const lines: string[] = []
        let shown = 0
        for (const kind of order) {
          const inGroup = topLevel.filter((s) => s.kind === kind)
          if (inGroup.length === 0) continue
          lines.push(`  <group kind="${kind}">`)
          for (const symbol of inGroup) {
            if (shown >= maxResults) break
            shown++
            lines.push(
              `    <symbol name="${escapeXml(symbol.name)}" kind="${symbol.kind}" line="${symbol.line}" sig="${escapeXml(symbol.sig)}" />`,
            )
            if (kind === "class") {
              for (const member of membersByClass.get(symbol.name) ?? []) {
                if (shown >= maxResults) break
                shown++
                lines.push(
                  `    <symbol name="  ${escapeXml(member.name)}" kind="${member.kind}" line="${member.line}" sig="${escapeXml(member.sig)}" />`,
                )
              }
            }
          }
          lines.push(`  </group>`)
        }
        const loose = topLevel.filter((s) => !(order as readonly string[]).includes(s.kind))
        if (loose.length > 0) {
          lines.push(`  <group kind="members">`)
          for (const symbol of loose) {
            if (shown >= maxResults) break
            shown++
            lines.push(
              `    <symbol name="${escapeXml(symbol.name)}" kind="${symbol.kind}" line="${symbol.line}" sig="${escapeXml(symbol.sig)}" />`,
            )
          }
          lines.push(`  </group>`)
        }

        const capped = outline.symbols.length > maxResults
        const out: string[] = [
          `<symbols-outline file="${escapeXml(rel)}" lang="${outline.lang}" symbols="${outline.symbols.length}" capped="${capped}"${outline.fallback ? ` fallback="regex"` : ""}>`,
          ...lines,
        ]
        if (outline.parseErrors > 0)
          out.push(`  <note>parseErrors="${outline.parseErrors}" — file has syntax errors; symbols below are best-effort.</note>`)
        if (capped) out.push(`  <next>… ${outline.symbols.length - shown} more symbols — narrow with grep or Read.</next>`)
        out.push(`</symbols-outline>`)

        return {
          title: `outline ${rel}`,
          metadata: {
            action: "outline",
            file: rel,
            lang: outline.lang,
            symbols: outline.symbols.length,
            parseErrors: outline.parseErrors,
            truncated: capped,
          },
          output: out.join("\n"),
        }
      })

    const searchAction = (
      ctx: Tool.Context,
      instance: { directory: string; worktree: string },
      cache: OutlineCacheRef,
      params: { query?: string; path?: string; kind?: string; lang?: string; maxResults?: number },
    ) =>
      Effect.gen(function* () {
        const query = params.query ?? ""
        validateQuery(query)
        const scope = resolvePath(instance.directory, params.path)
        const scopeInfo = yield* fs.stat(scope).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!scopeInfo) throw new Error(`Path not found: ${scope}`)
        const isFile = scopeInfo.type === "File"
        relToWorktree(instance.worktree, scope)
        yield* assertExternalDirectoryEffect(ctx, scope, { kind: isFile ? "file" : "directory" })

        const cwd = isFile ? path.dirname(scope) : scope
        const maxResults = Math.min(params.maxResults ?? 50, 500)
        const matches = yield* grepCandidates(cwd, query, langGlob(params.lang), isFile ? path.basename(scope) : undefined)
        const result = yield* findDefinitions(fs, cache, cwd, matches, query, params.kind, maxResults)

        const lines: string[] = [
          `<symbols-search query="${escapeXml(query)}" kind="${params.kind ?? "all"}" files="${result.files}" results="${result.hits.length}" capped="${result.capped}"${result.skipped > 0 ? ` skipped="${result.skipped}"` : ""}>`,
        ]
        for (const hit of result.hits) {
          const rel = relToWorktree(instance.worktree, hit.file)
          lines.push(
            `  <def kind="${hit.symbol.kind}" name="${escapeXml(hit.symbol.name)}" sig="${escapeXml(hit.symbol.sig)}" file="${escapeXml(rel)}:${hit.symbol.line}" />`,
          )
        }
        if (result.hits.length === 0) {
          lines.push(
            `  <hint>No declarations found for '${escapeXml(query)}'. Try the grep tool with a looser pattern or a substring query.</hint>`,
          )
        } else if (result.capped) {
          lines.push(`  <next>… more results (maxResults=${maxResults}). Narrow with path= or kind=.</next>`)
        }
        lines.push(`</symbols-search>`)

        return {
          title: `search ${query}`,
          metadata: {
            action: "search",
            query,
            files: result.files,
            results: result.hits.length,
            truncated: result.capped,
          },
          output: lines.join("\n"),
        }
      })

    const usagesAction = (
      ctx: Tool.Context,
      instance: { directory: string; worktree: string },
      cache: OutlineCacheRef,
      params: { query?: string; file?: string; line?: number; path?: string; maxResults?: number },
    ) =>
      Effect.gen(function* () {
        const scope = resolvePath(instance.directory, params.path)
        const scopeInfo = yield* fs.stat(scope).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!scopeInfo) throw new Error(`Path not found: ${scope}`)
        const isFile = scopeInfo.type === "File"
        relToWorktree(instance.worktree, scope)
        yield* assertExternalDirectoryEffect(ctx, scope, { kind: isFile ? "file" : "directory" })
        const cwd = isFile ? path.dirname(scope) : scope

        let query = params.query ?? ""
        if (!query) {
          if (!params.file || params.line === undefined) throw new Error("usages needs query or file+line")
          const fileAbs = resolvePath(instance.directory, params.file)
          relToWorktree(instance.worktree, fileAbs)
          yield* assertExternalDirectoryEffect(ctx, fileAbs, { kind: "file" })
          const outline = yield* getOutline(fs, cache, fileAbs)
          if (!outline) throw new Error(`File not found: ${fileAbs}`)
          const name = identifierAt(outline, params.line)
          if (!name) throw new Error(`no identifier at ${relToWorktree(instance.worktree, fileAbs)}:${params.line}`)
          query = name
        }
        validateQuery(query)

        const maxResults = Math.min(params.maxResults ?? 200, 500)
        const matches = yield* grepCandidates(cwd, query, langGlob(), isFile ? path.basename(scope) : undefined)

        // Defs: declarations of the name, top 20.
        const defs = yield* findDefinitions(fs, cache, cwd, matches, query, undefined, 20)
        const defFiles = defs.hits.map((hit) => hit.file)

        const result = yield* usages(fs, cache, cwd, matches, query, defFiles)

        const lines: string[] = [
          `<symbols-usages query="${escapeXml(query)}" defs="${defs.hits.length}" files="${result.files}" refs="${result.refs}" unattributed="${result.unattributedRefs}" capped="false"${result.skipped > 0 ? ` skipped="${result.skipped}"` : ""}>`,
        ]
        if (defs.hits.length > 0) {
          lines.push(`  <defs>`)
          for (const hit of defs.hits) {
            const rel = relToWorktree(instance.worktree, hit.file)
            lines.push(`    <def kind="${hit.symbol.kind}" name="${escapeXml(hit.symbol.name)}" file="${escapeXml(rel)}:${hit.symbol.line}" />`)
          }
          lines.push(`  </defs>`)
        } else {
          lines.push(`  <defs>no declarations found for '${escapeXml(query)}'</defs>`)
        }

        let totalShown = 0
        const spillable: string[] = []
        for (const group of result.groups) {
          const shown = group.refs.slice(0, 20)
          totalShown += shown.length
          lines.push(`  <group file="${escapeXml(group.relFile)}" refs="${group.refs.length}" attributed="true">`)
          for (const ref of shown) {
            lines.push(`    <ref line="${ref.line}" col="${ref.col}">${escapeXml(snippet(ref.text))}</ref>`)
          }
          if (group.refs.length > 20) lines.push(`    <next>… ${group.refs.length - 20} more refs in this file</next>`)
          lines.push(`  </group>`)
          spillable.push(`# ${group.relFile} (${group.refs.length} refs)`)
          for (const ref of group.refs) spillable.push(`${group.relFile}:${ref.line}:${ref.col} ${ref.text}`)
        }
        for (const un of result.unattributed) {
          lines.push(
            `  <unattributed file="${escapeXml(un.relFile)}" refs="${un.refs.length}" note="${escapeXml(un.note)}" />`,
          )
          spillable.push(`# ${un.relFile} (unattributed, ${un.refs.length}) ${un.note}`)
          for (const ref of un.refs) spillable.push(`${un.relFile}:${ref.line}:${ref.col} ${ref.text}`)
        }

        const capped = result.refs > maxResults || totalShown >= maxResults
        let output = lines.join("\n")
        if (capped || result.refs > maxResults) {
          const file = yield* truncate.write(spillable.join("\n"))
          output += `\n  <next>Full output saved to: ${file} — Read with offset/limit to inspect.</next>`
        }
        output += `\n</symbols-usages>`

        return {
          title: `usages ${query}`,
          metadata: {
            action: "usages",
            query,
            defs: defs.hits.length,
            files: result.files,
            refs: result.refs,
            unattributed: result.unattributedRefs,
            truncated: capped,
          },
          output,
        }
      })

    return () =>
      Effect.gen(function* () {
        return {
          description: DESCRIPTION,
          parameters: Parameters,
          execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const instance = yield* InstanceState.context
              const action = params.action ?? "search"
              yield* ctx.ask({
                permission: "grep",
                patterns: [params.query ?? "outline", params.path ?? "."],
                always: ["*"],
                metadata: { action, query: params.query, file: params.file, path: params.path },
              })
              const cache = yield* InstanceState.get(cacheState)
              if (action === "outline") {
                if (!params.file) throw new Error("outline requires file")
                return yield* outlineAction(ctx, instance, cache, params.file, Math.min(params.maxResults ?? 200, 500))
              }
              if (action === "usages") {
                return yield* usagesAction(ctx, instance, cache, {
                  query: params.query,
                  file: params.file,
                  line: params.line,
                  path: params.path,
                  maxResults: params.maxResults,
                })
              }
              return yield* searchAction(ctx, instance, cache, {
                query: params.query,
                path: params.path,
                kind: params.kind,
                lang: params.lang,
                maxResults: params.maxResults,
              })
            }).pipe(Effect.orDie),
        }
      })
  }),
)
