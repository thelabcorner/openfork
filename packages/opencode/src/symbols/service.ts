import path from "path"
import { Context, Effect, Layer, Ref, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { PositiveInt } from "@opencode-ai/core/schema"
import {
  getOutline,
  type CachedOutline,
  type OutlineCacheRef,
} from "@/tool/symbols/outline"
import { findDefinitions, validateQuery, wordPattern } from "@/tool/symbols/search"
import { usages, identifierAt, MAX_REF_SNIPPET } from "@/tool/symbols/usages"

/**
 * Protocol-neutral symbol intelligence shared by native agent tools and OXP.
 *
 * The caller supplies an explicit directory/worktree and cancellation signal.
 * Authorization deliberately stays in the adapter: native Tool.Context and OXP
 * have different principals and permission models and must never be conflated.
 */

export const Parameters = Schema.Struct({
  action: Schema.optional(Schema.Literals(["search", "outline", "usages"])),
  query: Schema.optional(Schema.String),
  file: Schema.optional(Schema.String),
  line: Schema.optional(PositiveInt),
  path: Schema.optional(Schema.String),
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
  ),
  lang: Schema.optional(Schema.Literals(["ts", "tsx", "js", "jsx"])),
  maxResults: Schema.optional(Schema.Int),
})
export type Input = Schema.Schema.Type<typeof Parameters>

export type Metadata = {
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

export interface Result {
  readonly title: string
  readonly output: string
  readonly metadata: Metadata
}

export interface ExecutionContext {
  readonly directory: string
  readonly worktree: string
  readonly abort?: AbortSignal
  /**
   * Adapter-owned secondary path authorization. Native tools use this for
   * external_directory prompts; OXP canonicalizes/authorizes paths before
   * entering the shared service and therefore does not need it.
   */
  readonly authorize?: (target: string, kind: "file" | "directory") => Effect.Effect<void>
  /**
   * Optional caller-owned overflow sink. Native tools use the existing
   * truncation store; OXP intentionally omits it so read-only symbol analysis
   * never creates an unapproved spill file.
   */
  readonly writeOverflow?: (content: string) => Effect.Effect<string>
}

export class InvalidInput extends Schema.TaggedErrorClass<InvalidInput>()("SymbolsInvalidInput", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail
  }
}

export interface Interface {
  readonly execute: (
    input: Input,
    context: ExecutionContext,
  ) => Effect.Effect<Result, InvalidInput | Ripgrep.Error | Ripgrep.InvalidPatternError | FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Symbols") {}
export const use = serviceUse(Service)

const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

const langGlob = (lang?: string) => {
  if (lang === "ts") return "*.ts"
  if (lang === "tsx") return "*.tsx"
  if (lang === "js") return "*.js"
  if (lang === "jsx") return "*.jsx"
  return "*.{ts,tsx,js,jsx}"
}

const resolvePath = (directory: string, input?: string) =>
  input ? (path.isAbsolute(input) ? input : path.join(directory, input)) : directory

const relativeToWorktree = Effect.fnUntraced(function* (worktree: string, abs: string) {
  const rel = path.relative(worktree, abs)
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return yield* new InvalidInput({ detail: `Refusing to access path outside the worktree: ${abs}` })
  }
  return rel
})

const requireQuery = Effect.fnUntraced(function* (query: string) {
  yield* Effect.try({
    try: () => {
      validateQuery(query)
    },
    catch: (cause) =>
      new InvalidInput({ detail: cause instanceof Error ? cause.message : String(cause) }),
  })
})

const snippet = (text: string) => (text.length > MAX_REF_SNIPPET ? text.slice(0, MAX_REF_SNIPPET) + "…" : text)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    // One bounded cache is shared by native and OXP adapters. Absolute paths
    // are cache keys and every lookup still performs mtime+size validation.
    const cache: OutlineCacheRef = yield* Ref.make<Map<string, CachedOutline>>(new Map())

    const grepCandidates = (
      cwd: string,
      query: string,
      include: string,
      signal?: AbortSignal,
      file?: string,
      limit = 2000,
    ) =>
      ripgrep.grep({
        cwd,
        pattern: wordPattern(query),
        include,
        file,
        signal,
        limit,
      })

    const outlineAction = Effect.fn("Symbols.outline")(function* (
      context: ExecutionContext,
      fileParam: string,
      maxResults: number,
    ) {
      const abs = resolvePath(context.directory, fileParam)
      const rel = yield* relativeToWorktree(context.worktree, abs)
      if (context.authorize) yield* context.authorize(abs, "file")
      const info = yield* fs.stat(abs).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!info || info.type !== "File") return yield* new InvalidInput({ detail: `File not found: ${abs}` })
      if (info.size > 1024 * 1024) {
        return yield* new InvalidInput({
          detail: `File too large to outline (${info.size} bytes > 1 MB). Use Find with grep instead.`,
        })
      }
      const text = yield* fs.readFileStringSafe(abs)
      if (text === undefined) return yield* new InvalidInput({ detail: `File not found: ${abs}` })
      const outline = yield* getOutline(fs, cache, abs, text)
      if (outline === undefined) return yield* new InvalidInput({ detail: `File not found: ${abs}` })

      const classNames = new Set(outline.symbols.filter((s) => s.kind === "class").map((s) => s.name))
      const membersByClass = new Map<string, typeof outline.symbols>()
      for (const symbol of outline.symbols) {
        if (!symbol.memberOf || !classNames.has(symbol.memberOf)) continue
        const list = membersByClass.get(symbol.memberOf) ?? []
        list.push(symbol)
        membersByClass.set(symbol.memberOf, list)
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
          if (kind !== "class") continue
          for (const member of membersByClass.get(symbol.name) ?? []) {
            if (shown >= maxResults) break
            shown++
            lines.push(
              `    <symbol name="  ${escapeXml(member.name)}" kind="${member.kind}" line="${member.line}" sig="${escapeXml(member.sig)}" />`,
            )
          }
        }
        lines.push("  </group>")
      }
      const loose = topLevel.filter((s) => !(order as readonly string[]).includes(s.kind))
      if (loose.length > 0) {
        lines.push('  <group kind="members">')
        for (const symbol of loose) {
          if (shown >= maxResults) break
          shown++
          lines.push(
            `    <symbol name="${escapeXml(symbol.name)}" kind="${symbol.kind}" line="${symbol.line}" sig="${escapeXml(symbol.sig)}" />`,
          )
        }
        lines.push("  </group>")
      }

      const capped = outline.symbols.length > maxResults
      const out: string[] = [
        `<symbols-outline file="${escapeXml(rel)}" lang="${outline.lang}" symbols="${outline.symbols.length}" capped="${capped}"${outline.fallback ? ' fallback="regex"' : ""}>`,
        ...lines,
      ]
      if (outline.parseErrors > 0) {
        out.push(`  <note>parseErrors="${outline.parseErrors}" — file has syntax errors; symbols below are best-effort.</note>`)
      }
      if (capped) out.push(`  <next>… ${outline.symbols.length - shown} more symbols — narrow with Find grep or Read.</next>`)
      out.push("</symbols-outline>")
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
      } satisfies Result
    })

    const searchAction = Effect.fn("Symbols.search")(function* (
      context: ExecutionContext,
      params: Pick<Input, "query" | "path" | "kind" | "lang" | "maxResults">,
    ) {
      const query = params.query ?? ""
      yield* requireQuery(query)
      const scope = resolvePath(context.directory, params.path)
      const scopeInfo = yield* fs.stat(scope).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!scopeInfo) return yield* new InvalidInput({ detail: `Path not found: ${scope}` })
      const isFile = scopeInfo.type === "File"
      yield* relativeToWorktree(context.worktree, scope)
      if (context.authorize) yield* context.authorize(scope, isFile ? "file" : "directory")
      const cwd = isFile ? path.dirname(scope) : scope
      const maxResults = Math.min(Math.max(params.maxResults ?? 50, 1), 500)
      const matches = yield* grepCandidates(
        cwd,
        query,
        langGlob(params.lang),
        context.abort,
        isFile ? path.basename(scope) : undefined,
      )
      const result = yield* findDefinitions(fs, cache, cwd, matches, query, params.kind, maxResults)
      const lines: string[] = [
        `<symbols-search query="${escapeXml(query)}" kind="${params.kind ?? "all"}" files="${result.files}" results="${result.hits.length}" capped="${result.capped}"${result.skipped > 0 ? ` skipped="${result.skipped}"` : ""}>`,
      ]
      for (const hit of result.hits) {
        const rel = yield* relativeToWorktree(context.worktree, hit.file)
        lines.push(
          `  <def kind="${hit.symbol.kind}" name="${escapeXml(hit.symbol.name)}" sig="${escapeXml(hit.symbol.sig)}" file="${escapeXml(rel)}:${hit.symbol.line}" />`,
        )
      }
      if (result.hits.length === 0) {
        lines.push(
          `  <hint>No declarations found for '${escapeXml(query)}'. Try Find with grep using a looser pattern or substring query.</hint>`,
        )
      } else if (result.capped) {
        lines.push(`  <next>… more results (maxResults=${maxResults}). Narrow with path= or kind=.</next>`)
      }
      lines.push("</symbols-search>")
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
      } satisfies Result
    })

    const usagesAction = Effect.fn("Symbols.usages")(function* (
      context: ExecutionContext,
      params: Pick<Input, "query" | "file" | "line" | "path" | "maxResults">,
    ) {
      const scope = resolvePath(context.directory, params.path)
      const scopeInfo = yield* fs.stat(scope).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!scopeInfo) return yield* new InvalidInput({ detail: `Path not found: ${scope}` })
      const isFile = scopeInfo.type === "File"
      yield* relativeToWorktree(context.worktree, scope)
      if (context.authorize) yield* context.authorize(scope, isFile ? "file" : "directory")
      const cwd = isFile ? path.dirname(scope) : scope

      let query = params.query ?? ""
      if (!query) {
        if (!params.file || params.line === undefined) {
          return yield* new InvalidInput({ detail: "usages needs query or file+line" })
        }
        const fileAbs = resolvePath(context.directory, params.file)
        const rel = yield* relativeToWorktree(context.worktree, fileAbs)
        if (context.authorize) yield* context.authorize(fileAbs, "file")
        const outline = yield* getOutline(fs, cache, fileAbs)
        if (!outline) return yield* new InvalidInput({ detail: `File not found: ${fileAbs}` })
        const name = identifierAt(outline, params.line)
        if (!name) return yield* new InvalidInput({ detail: `no identifier at ${rel}:${params.line}` })
        query = name
      }
      yield* requireQuery(query)

      const maxResults = Math.min(Math.max(params.maxResults ?? 200, 1), 500)
      const matches = yield* grepCandidates(
        cwd,
        query,
        langGlob(),
        context.abort,
        isFile ? path.basename(scope) : undefined,
      )
      const defs = yield* findDefinitions(fs, cache, cwd, matches, query, undefined, 20)
      const defFiles = defs.hits.map((hit) => hit.file)
      const result = yield* usages(fs, cache, cwd, matches, query, defFiles)

      const lines: string[] = [
        `<symbols-usages query="${escapeXml(query)}" defs="${defs.hits.length}" files="${result.files}" refs="${result.refs}" unattributed="${result.unattributedRefs}" capped="false"${result.skipped > 0 ? ` skipped="${result.skipped}"` : ""}>`,
      ]
      if (defs.hits.length > 0) {
        lines.push("  <defs>")
        for (const hit of defs.hits) {
          const rel = yield* relativeToWorktree(context.worktree, hit.file)
          lines.push(
            `    <def kind="${hit.symbol.kind}" name="${escapeXml(hit.symbol.name)}" file="${escapeXml(rel)}:${hit.symbol.line}" />`,
          )
        }
        lines.push("  </defs>")
      } else {
        lines.push(`  <defs>no declarations found for '${escapeXml(query)}'</defs>`)
      }

      let totalShown = 0
      const spillable: string[] = []
      for (const group of result.groups) {
        const remaining = Math.max(0, maxResults - totalShown)
        const shown = group.refs.slice(0, Math.min(20, remaining))
        totalShown += shown.length
        lines.push(`  <group file="${escapeXml(group.relFile)}" refs="${group.refs.length}" attributed="true">`)
        for (const ref of shown) {
          lines.push(`    <ref line="${ref.line}" col="${ref.col}">${escapeXml(snippet(ref.text))}</ref>`)
        }
        if (group.refs.length > shown.length) lines.push(`    <next>… ${group.refs.length - shown.length} more refs in this file</next>`)
        lines.push("  </group>")
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
        if (context.writeOverflow) {
          const file = yield* context.writeOverflow(spillable.join("\n"))
          output += `\n  <next>Full output saved to: ${file} — Read with offset/limit to inspect.</next>`
        } else {
          output += `\n  <next>Results exceed maxResults=${maxResults}; narrow path/query or increase maxResults.</next>`
        }
      }
      output += "\n</symbols-usages>"
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
      } satisfies Result
    })

    const execute: Interface["execute"] = Effect.fn("Symbols.execute")(function* (
      input: Input,
      context: ExecutionContext,
    ) {
      if (context.abort?.aborted) return yield* new InvalidInput({ detail: "symbol operation was cancelled" })
      const action = input.action ?? "search"
      if (action === "outline") {
        if (!input.file) return yield* new InvalidInput({ detail: "outline requires file" })
        return yield* outlineAction(context, input.file, Math.min(Math.max(input.maxResults ?? 200, 1), 500))
      }
      if (action === "usages") return yield* usagesAction(context, input)
      return yield* searchAction(context, input)
    })

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Ripgrep.node],
})

export * as Symbols from "./service"
