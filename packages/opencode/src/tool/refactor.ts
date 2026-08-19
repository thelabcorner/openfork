import { Effect, Schema } from "effect"
import path from "path"
import fs from "node:fs/promises"
import crypto from "node:crypto"
import { createRequire } from "node:module"
import * as Tool from "./tool"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AppProcess } from "@opencode-ai/core/process"
import { TypecheckScope } from "./typecheck-scope"
import DESCRIPTION from "./refactor.txt"

// ---------------------------------------------------------------------------
// Plan model. A plan is the ONLY thing that can write: applying requires the
// saved plan id + confirm:"REFACTOR"; args alone are never enough (R9).
// ---------------------------------------------------------------------------

export type TextEdit = {
  start: number
  end: number
  newText: string
}

export type Change = {
  file: string
  rel: string
  kind: "modify" | "create" | "delete"
  before: string
  after: string
  edits: TextEdit[]
}

export type Fingerprint = {
  exists: boolean
  sha256: string
  size: number
  mtimeMs: number
}

export type RefactorPlan = {
  id: string
  mode: string
  summary: string
  createdAt: number
  changes: Change[]
  fingerprints: Record<string, Fingerprint>
}

const CACHE_REL = path.join(".opencode", "cache", "refactor-preview")
const PLAN_TTL_MS = 6 * 60 * 60 * 1000
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".git",
  ".turbo",
  "__pycache__",
])
const GENERATED = [/\.generated\.(ts|tsx)$/, /__generated__/, /\.d\.ts$/]

export const Parameters = Schema.Struct({
  mode: Schema.Literals(["resolveSymbol", "findReferences", "renameSymbol", "organizeImports", "updateImportSource", "moveFileUpdateImports", "preview"]).annotate({
    description: "Refactoring operation",
  }),
  filePath: Schema.optional(Schema.String).annotate({ description: "Target file (required for most modes)" }),
  files: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "Files for organizeImports/updateImportSource" }),
  line: Schema.optional(Schema.Int).annotate({ description: "1-based line of the symbol" }),
  column: Schema.optional(Schema.Int).annotate({ description: "1-based column of the symbol" }),
  newName: Schema.optional(Schema.String).annotate({
    description: "renameSymbol: the new identifier (must match ^[A-Za-z_$][A-Za-z0-9_$]*$)",
  }),
  from: Schema.optional(Schema.String).annotate({ description: "updateImportSource: old module specifier; moveFileUpdateImports: source file" }),
  to: Schema.optional(Schema.String).annotate({ description: "updateImportSource: new module specifier; moveFileUpdateImports: destination file" }),
  scope: Schema.optional(Schema.Literals(["file", "files", "changed", "project"])).annotate({
    description: "Scope for organizeImports (default project)",
  }),
  includeComments: Schema.optional(Schema.Boolean).annotate({ description: "renameSymbol: also rename in comments" }),
  includeStrings: Schema.optional(Schema.Boolean).annotate({ description: "renameSymbol: also rename in strings" }),
  dryRun: Schema.optional(Schema.Boolean).annotate({ description: "Produce a plan only (default true)" }),
  confirm: Schema.optional(Schema.String).annotate({ description: "Apply gate: must be exactly \"REFACTOR\"" }),
  previewId: Schema.optional(Schema.String).annotate({
    description: "Saved-plan id to apply or re-preview (8-80 chars [A-Za-z0-9_-])",
  }),
  runTypecheck: Schema.optional(Schema.Boolean).annotate({ description: "Gate apply on diagnostic delta (default true)" }),
  rollbackOnFailure: Schema.optional(Schema.Boolean).annotate({ description: "Roll back if diagnostics increase (default true)" }),
  allowGenerated: Schema.optional(Schema.Boolean).annotate({ description: "Allow touching generated files (default false)" }),
  overwrite: Schema.optional(Schema.Boolean).annotate({ description: "moveFileUpdateImports: overwrite existing destination" }),
  maxFiles: Schema.optional(Schema.Int).annotate({ description: "Cap touched files (default 80)" }),
  maxEdits: Schema.optional(Schema.Int).annotate({ description: "Cap edits per plan (default 1500)" }),
  maxDiffBytes: Schema.optional(Schema.Int).annotate({ description: "Cap preview diff bytes (default 60000)" }),
})

// Fields are string-typed (not literal unions) so generator returns don't
// widen against the declared metadata — same convention as json.ts JsonMeta.
type Metadata = {
  mode: string
  status: string
  previewId?: string
  changedFiles: number
  edits: number
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable): fingerprints, plan I/O, path safety, edits.
// ---------------------------------------------------------------------------

export function fingerprintText(text: string): Fingerprint {
  return {
    exists: true,
    sha256: crypto.createHash("sha256").update(text, "utf8").digest("hex"),
    size: Buffer.byteLength(text, "utf8"),
    mtimeMs: 0,
  }
}

export function applyTextEdits(text: string, edits: TextEdit[]): string {
  // Overlap safety (R7): reject overlapping spans; apply in descending start.
  const sorted = [...edits].toSorted((a, b) => b.start - a.start || b.end - a.end)
  let lastStart = Number.POSITIVE_INFINITY
  for (const edit of sorted) {
    if (edit.start < 0 || edit.end < edit.start || edit.end > text.length) {
      throw new Error(`Edit span out of range: ${edit.start}..${edit.end} (text length ${text.length})`)
    }
    if (edit.end > lastStart) throw new Error(`Overlapping edits rejected: ${edit.start}..${edit.end}`)
    lastStart = edit.start
    text = text.slice(0, edit.start) + edit.newText + text.slice(edit.end)
  }
  return text
}

export function isGeneratedPath(rel: string): boolean {
  return GENERATED.some((re) => re.test(rel))
}

export function safeResolve(worktree: string, file: string): string {
  const abs = path.isAbsolute(file) ? file : path.resolve(worktree, file)
  const rel = path.relative(worktree, abs)
  if (rel.startsWith("..") || path.isAbsolute(rel) || rel === "") {
    throw new Error(`Path is outside the worktree (or is the worktree root): ${file}`)
  }
  const parts = rel.split(path.sep)
  if (parts.some((part) => SKIP_DIRS.has(part))) {
    throw new Error(`Refusing to refactor inside a skipped directory: ${rel}`)
  }
  if (rel.endsWith(".d.ts")) throw new Error(`Refusing to write a .d.ts file: ${rel}`)
  if (isGeneratedPath(rel)) throw new Error(`Refusing to touch generated file: ${rel}`)
  return abs
}

export function planCacheDir(worktree: string): string {
  return path.join(worktree, CACHE_REL)
}

export async function savePlan(worktree: string, plan: RefactorPlan): Promise<string> {
  const dir = planCacheDir(worktree)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${plan.id}.json`)
  await fs.writeFile(file, JSON.stringify(plan, null, 2), "utf8")
  return file
}

export async function loadPlan(worktree: string, id: string): Promise<RefactorPlan | undefined> {
  const file = path.join(planCacheDir(worktree), `${id}.json`)
  const text = await fs.readFile(file, "utf8").catch(() => undefined)
  if (!text) return undefined
  const parsed = JSON.parse(text) as RefactorPlan
  if (Date.now() - parsed.createdAt > PLAN_TTL_MS) {
    await fs.rm(file, { force: true }).catch(() => undefined)
    return undefined
  }
  return parsed
}

// Verify the plan is still fresh: every touched file must have the same
// content hash as at preview time (R6 stale-check).
export function assertPlanFresh(plan: RefactorPlan, current: Record<string, string | undefined>): void {
  for (const change of plan.changes) {
    const expected = plan.fingerprints[change.file]
    if (!expected) continue
    const now = current[change.file]
    if (expected.exists) {
      if (now === undefined) throw new Error(`Preview is stale: file deleted since preview — ${change.rel}. Re-run the dry-run to produce a fresh plan.`)
      const actual = fingerprintText(now)
      if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) {
        throw new Error(`Preview is stale: file changed since preview — ${change.rel}. Re-run the dry-run to produce a fresh plan.`)
      }
    } else if (now !== undefined) {
      throw new Error(`Preview is stale: file created since preview — ${change.rel}. Re-run the dry-run to produce a fresh plan.`)
    }
  }
}

export function changeDiff(change: Change): string {
  const before = change.before.split("\n")
  const after = change.after.split("\n")
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < before.length || j < after.length) {
    if (before[i] === after[j]) {
      out.push(`  ${before[i]}`)
      i++
      j++
      continue
    }
    const removed = before[i]
    const added = after[j]
    if (removed !== undefined) {
      out.push(`- ${removed}`)
      i++
    }
    if (added !== undefined) {
      out.push(`+ ${added}`)
      j++
    }
  }
  return out.slice(0, 300).join("\n")
}

export const RefactorTool = Tool.define<typeof Parameters, Metadata, AppProcess.Service | FSUtil.Service>(
  "refactor",
  Effect.gen(function* () {
    const app = yield* AppProcess.Service
    const fsutil = yield* FSUtil.Service

    // Resolve typescript from the worktree (root node_modules, then the
    // worktree's own node_modules, then bare via createRequire).
    const loadTs = Effect.fn("RefactorTool.loadTs")(function* (worktree: string) {
      for (const base of [process.cwd(), worktree]) {
        const req = createRequire(path.join(base, "noop.js"))
        try {
          return req("typescript") as typeof import("typescript")
        } catch {
          // fall through
        }
      }
      throw new Error("refactor requires the `typescript` package resolvable from the worktree.")
    })

    // Build a language service over the given files, reading source from disk.
    // An explicit host is required here — `createLanguageService(program)`
    // without a host is not supported by the installed TypeScript version.
    // File IO goes through ts.sys so Windows 8.3 short-path normalization in
    // the compiler cannot miss files that were resolved to long paths.
    const makeLanguageService = Effect.fn("RefactorTool.makeLS")(function* (
      files: string[],
      ts: typeof import("typescript"),
    ) {
      const host: import("typescript").LanguageServiceHost = {
        getScriptFileNames: () => files,
        getScriptVersion: () => "0",
        getScriptSnapshot: (fileName) => {
          const text = ts.sys.readFile(fileName)
          return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
        },
        getCurrentDirectory: () => files[0] ? path.dirname(files[0]!) : process.cwd(),
        getCompilationSettings: () => ({
          allowJs: true,
          noEmit: true,
          skipLibCheck: true,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
        }),
        getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
        fileExists: (fileName) => ts.sys.fileExists(fileName),
        readFile: (fileName) => ts.sys.readFile(fileName),
        getScriptKind: (fileName) => {
          if (fileName.endsWith(".tsx") || fileName.endsWith(".jsx")) return ts.ScriptKind.TSX
          if (fileName.endsWith(".ts") || fileName.endsWith(".mts") || fileName.endsWith(".cts")) return ts.ScriptKind.TS
          return ts.ScriptKind.Unknown
        },
      }
      const service = ts.createLanguageService(host)
      return { service, contents: new Map<string, string>() }
    })

    const lineStartsOf = (text: string) => {
      const starts = [0]
      for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1)
      return starts
    }

    const readAll = Effect.fn("RefactorTool.readAll")(function* (files: string[]) {
      const out = new Map<string, string>()
      for (const file of files) {
        const text = yield* Effect.promise(() => fs.readFile(file, "utf8")).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (text !== undefined) out.set(file, text)
      }
      return out
    })

    // Simple import-specifier rewrite via the TS AST (never text search).
    // Preserves the original literal's quote style (single vs double).
    const rewriteImportSource = Effect.fn("RefactorTool.rewriteImports")(function* (
      text: string,
      from: string,
      to: string,
      ts: typeof import("typescript"),
    ) {
      const quote = (literal: import("typescript").StringLiteral) =>
        literal.getText().startsWith('"') ? JSON.stringify(to) : `'${to.replace(/'/g, "\\'")}'`
      const edits: TextEdit[] = []
      const sf = ts.createSourceFile("_rewrite.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      const visit = (node: import("typescript").Node): void => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
          const spec = node.moduleSpecifier
          if (spec && ts.isStringLiteral(spec) && spec.text === from) {
            edits.push({ start: spec.getStart(sf), end: spec.getEnd(), newText: quote(spec) })
          }
        }
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const arg = node.arguments[0]
          if (arg && ts.isStringLiteral(arg) && arg.text === from) {
            edits.push({ start: arg.getStart(sf), end: arg.getEnd(), newText: quote(arg) })
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(sf)
      return applyTextEdits(text, edits)
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          // The project directory is the resolve base (worktree may be unset in
          // non-git contexts); rel paths are computed against it for display.
          const worktree = instance.directory
          const mode = params.mode
          const maxFiles = params.maxFiles ?? 80
          const maxEdits = params.maxEdits ?? 1500

          // --- preview: re-render a saved plan ---------------------------------
          if (mode === "preview") {
            const id = params.previewId
            if (!id) throw new Error("preview mode requires previewId")
            const plan = yield* Effect.promise(() => loadPlan(worktree, id))
            if (!plan) throw new Error(`Plan ${id} not found or expired (TTL 6h). Re-run the dry-run.`)
            yield* ctx.ask({ permission: "read", patterns: ["*"], always: ["*"], metadata: { previewId: id } })
            const diff = plan.changes.map((c) => `--- ${c.rel} (${c.kind})\n${changeDiff(c)}`).join("\n\n")
            return {
              title: `refactor preview ${id}`,
              output: `<refactor status="preview" previewId="${id}" mode="${plan.mode}">\n${diff.slice(0, params.maxDiffBytes ?? 60_000)}\n</refactor>`,
              metadata: { mode, status: "preview", previewId: id, changedFiles: plan.changes.length, edits: plan.changes.reduce((n, c) => n + c.edits.length, 0) },
            }
          }

          // --- read-only probe modes --------------------------------------------
          if (mode === "resolveSymbol" || mode === "findReferences") {
            if (!params.filePath || !params.line || !params.column) {
              throw new Error(`${mode} requires filePath, line, and column`)
            }
            const file = safeResolve(worktree, params.filePath)
            yield* ctx.ask({ permission: "read", patterns: [params.filePath], always: [params.filePath], metadata: { filepath: file } })
            const ts = yield* loadTs(worktree)
            const text = yield* Effect.promise(() => fs.readFile(file, "utf8"))
            const lineStarts = lineStartsOf(text)
            const pos = lineStarts[Math.min(params.line - 1, lineStarts.length - 1)]! + Math.max(0, params.column - 1)
            const { service } = yield* makeLanguageService([file], ts)
            const quick = service.getQuickInfoAtPosition(file, pos)
            const rename = service.getRenameInfo(file, pos)
            const references = mode === "findReferences" ? service.findReferences(file, pos) : undefined

            if (mode === "resolveSymbol") {
              const output = [
                `<symbol file="${params.filePath}" line="${params.line}" column="${params.column}">`,
                `  <name>${quick?.displayParts?.map((p) => p.text).join("") ?? "unknown"}</name>`,
                `  <kind>${quick?.kind ?? "unknown"}</kind>`,
                `  <canRename>${Boolean(rename.canRename)}</canRename>`,
                ...(rename.canRename ? [`  <renameDisplay>${rename.displayName}</renameDisplay>`] : []),
                `</symbol>`,
              ]
              return { title: `resolve ${params.filePath}:${params.line}`, output: output.join("\n"), metadata: { mode, status: "preview", changedFiles: 0, edits: 0 } }
            }

            const byFile = new Map<string, { refs: number; defs: number }>()
            for (const ref of references ?? []) {
              // TS 5.8: ReferencedSymbol.definition is a single
              // ReferencedSymbolDefinitionInfo (not an array).
              const def = ref.definition
              const isDef = (entry: import("typescript").ReferencedSymbolEntry) =>
                entry.fileName === def.fileName && entry.textSpan.start === def.textSpan.start
              for (const entry of ref.references) {
                const hit = byFile.get(entry.fileName) ?? { refs: 0, defs: 0 }
                if (isDef(entry)) hit.defs++
                else hit.refs++
                byFile.set(entry.fileName, hit)
              }
            }
            const lines = [
              `<references symbol="${params.filePath}:${params.line}:${params.column}" total="${[...byFile.values()].reduce((n, v) => n + v.refs + v.defs, 0)}">`,
              ...[...byFile.entries()].toSorted((a, b) => a[0].localeCompare(b[0])).map(([file, counts]) => {
                const rel = path.relative(worktree, file)
                return `  <file path="${rel}" references="${counts.refs}" definitions="${counts.defs}" />`
              }),
              "</references>",
            ]
            return { title: `references ${params.filePath}:${params.line}`, output: lines.join("\n"), metadata: { mode, status: "preview", changedFiles: byFile.size, edits: 0 } }
          }

          // --- write-capable modes: build a plan, dry-run by default -------------
          const changes: Change[] = []
          const planFiles = new Set<string>()
          const ts = yield* loadTs(worktree)

          if (mode === "renameSymbol") {
            if (!params.filePath || !params.line || !params.column) throw new Error("renameSymbol requires filePath, line, column")
            if (!params.newName) throw new Error("renameSymbol requires newName")
            if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(params.newName)) {
              throw new Error(`newName must be a valid identifier: ${params.newName}`)
            }
            const file = safeResolve(worktree, params.filePath)
            yield* ctx.ask({ permission: "read", patterns: [params.filePath], always: [params.filePath], metadata: { filepath: file } })
            const text = yield* Effect.promise(() => fs.readFile(file, "utf8"))
            const lineStarts = lineStartsOf(text)
            const pos = lineStarts[Math.min(params.line - 1, lineStarts.length - 1)]! + Math.max(0, params.column - 1)
            const { service } = yield* makeLanguageService([file], ts)
            const renameInfo = service.getRenameInfo(file, pos)
            if (!renameInfo.canRename) throw new Error("The symbol at that position cannot be renamed (no renameable identifier found).")
            const locations = service.findRenameLocations(file, pos, params.includeStrings ?? false, params.includeComments ?? false) ?? []
            if (locations.length === 0) throw new Error("No rename locations found for the symbol.")
            const byFileLoc = new Map<string, TextEdit[]>()
            for (const loc of locations) {
              const list = byFileLoc.get(loc.fileName) ?? []
              list.push({ start: loc.textSpan.start, end: loc.textSpan.start + loc.textSpan.length, newText: params.newName })
              byFileLoc.set(loc.fileName, list)
            }
            if (byFileLoc.size > maxFiles) throw new Error(`Rename would touch ${byFileLoc.size} files (max ${maxFiles}).`)
            let totalEdits = 0
            const contents = yield* readAll([...byFileLoc.keys()])
            for (const [target, edits] of byFileLoc) {
              const rel = path.relative(worktree, target)
              safeResolve(worktree, target)
              const before = contents.get(target) ?? ""
              const after = applyTextEdits(before, edits)
              totalEdits += edits.length
              changes.push({ file: target, rel, kind: "modify", before, after, edits })
              planFiles.add(target)
            }
            if (totalEdits > maxEdits) throw new Error(`Rename exceeds maxEdits (${totalEdits} > ${maxEdits}).`)
          }

          if (mode === "organizeImports") {
            const targets =
              params.files?.length
                ? params.files.map((f) => safeResolve(worktree, f))
                : params.filePath
                  ? [safeResolve(worktree, params.filePath)]
                  : []
            if (targets.length === 0) throw new Error("organizeImports requires filePath or files[]")
            if (targets.length > maxFiles) throw new Error(`organizeImports would touch ${targets.length} files (max ${maxFiles}).`)
            const { service } = yield* makeLanguageService(targets, ts)
            const contents = yield* readAll(targets)
            for (const file of targets) {
              yield* ctx.ask({ permission: "read", patterns: [path.relative(worktree, file)], always: [path.relative(worktree, file)], metadata: { filepath: file } })
              const before = contents.get(file) ?? ""
              const textChanges = service.organizeImports({ type: "file", fileName: file }, {}, {})
              const edits: TextEdit[] = []
              for (const tc of textChanges) {
                for (const te of tc.textChanges) edits.push({ start: te.span.start, end: te.span.start + te.span.length, newText: te.newText })
              }
              const after = edits.length ? applyTextEdits(before, edits) : before
              if (after !== before) {
                changes.push({ file, rel: path.relative(worktree, file), kind: "modify", before, after, edits })
                planFiles.add(file)
              }
            }
          }

          if (mode === "updateImportSource") {
            if (!params.from || !params.to) throw new Error("updateImportSource requires from (old specifier) and to (new specifier)")
            if (params.from === params.to) throw new Error("from and to are identical — nothing to change.")
            const targets =
              params.files?.length
                ? params.files.map((f) => safeResolve(worktree, f))
                : params.filePath
                  ? [safeResolve(worktree, params.filePath)]
                  : []
            if (targets.length === 0) throw new Error("updateImportSource requires filePath or files[]")
            if (targets.length > maxFiles) throw new Error(`updateImportSource would touch ${targets.length} files (max ${maxFiles}).`)
            const contents = yield* readAll(targets)
            for (const file of targets) {
              yield* ctx.ask({ permission: "read", patterns: [path.relative(worktree, file)], always: [path.relative(worktree, file)], metadata: { filepath: file } })
              const before = contents.get(file) ?? ""
              const after = yield* rewriteImportSource(before, params.from, params.to, ts)
              if (after !== before) {
                changes.push({ file, rel: path.relative(worktree, file), kind: "modify", before, after, edits: [] })
                planFiles.add(file)
              }
            }
          }

          if (mode === "moveFileUpdateImports") {
            if (!params.filePath && !params.from) throw new Error("moveFileUpdateImports requires filePath (source) and to (destination)")
            if (!params.to) throw new Error("moveFileUpdateImports requires to (destination path)")
            const source = safeResolve(worktree, params.filePath ?? params.from!)
            const dest = safeResolve(worktree, params.to)
            const destExists = yield* Effect.promise(() => fs.stat(dest).then((s) => s.isFile()).catch(() => false))
            if (destExists && !params.overwrite) throw new Error(`Destination exists: ${params.to}. Pass overwrite:true to replace it.`)
            const sourceText = yield* Effect.promise(() => fs.readFile(source, "utf8"))
            const sourceRel = path.relative(worktree, source)
            // Rewrite the moved file's own relative imports for the new location.
            const newRelative = (spec: string) => {
              if (!spec.startsWith(".")) return spec
              const abs = path.resolve(path.dirname(source), spec)
              let rel = path.relative(path.dirname(dest), abs).split(path.sep).join("/")
              if (!rel.startsWith(".")) rel = "./" + rel
              return rel
            }
            const rewriteOwnRelativeImports = () => {
              const edits: TextEdit[] = []
              const sf = ts.createSourceFile("_move.ts", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
              const quote = (literal: import("typescript").StringLiteral) =>
                literal.getText().startsWith('"') ? JSON.stringify(literal.text) : `'${literal.text.replace(/'/g, "\\'")}'`
              const visit = (node: import("typescript").Node): void => {
                if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
                  const spec = node.moduleSpecifier
                  if (spec && ts.isStringLiteral(spec)) {
                    const next = newRelative(spec.text)
                    if (next !== spec.text) edits.push({ start: spec.getStart(sf), end: spec.getEnd(), newText: quote(spec).replace(spec.text, next) })
                  }
                }
                if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                  const arg = node.arguments[0]
                  if (arg && ts.isStringLiteral(arg)) {
                    const next = newRelative(arg.text)
                    if (next !== arg.text) edits.push({ start: arg.getStart(sf), end: arg.getEnd(), newText: quote(arg).replace(arg.text, next) })
                  }
                }
                ts.forEachChild(node, visit)
              }
              visit(sf)
              return applyTextEdits(sourceText, edits)
            }
            const sourceRewritten = rewriteOwnRelativeImports()
            const destExistsNow = destExists
            changes.push({
              file: dest,
              rel: path.relative(worktree, dest),
              kind: destExistsNow ? "modify" : "create",
              before: destExistsNow ? (yield* Effect.promise(() => fs.readFile(dest, "utf8"))) : "",
              after: sourceRewritten,
              edits: [],
            })
            if (!destExistsNow) {
              changes.push({ file: source, rel: sourceRel, kind: "delete", before: sourceText, after: "", edits: [] })
            }
            planFiles.add(dest)
            if (!destExistsNow) planFiles.add(source)
          }

          // --- R1: a plan with zero real changes is a no-op ---------------------
          const real = changes.filter((c) => c.kind === "create" || c.kind === "delete" || c.before !== c.after)
          if (real.length === 0) {
            return {
              title: `refactor ${mode}`,
              output: `<refactor status="noop" mode="${mode}">No changes to apply (target content already matches).</refactor>`,
              metadata: { mode, status: "noop", changedFiles: 0, edits: 0 },
            }
          }
          if (real.length > maxFiles) throw new Error(`Refactor would touch ${real.length} files (max ${maxFiles}).`)

          // Path safety for every change BEFORE any write (R4/R9).
          for (const change of real) {
            const rel = path.relative(worktree, change.file)
            if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Change escapes the worktree: ${change.file}`)
            if (isGeneratedPath(rel) && !params.allowGenerated) throw new Error(`Refusing to touch generated file: ${rel}`)
            if (change.kind === "modify" && rel.endsWith(".d.ts")) throw new Error(`Refusing to write a .d.ts file: ${rel}`)
          }

          const plan: RefactorPlan = {
            id: params.previewId ?? `ref_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
            mode,
            summary: `${mode} over ${real.length} file${real.length === 1 ? "" : "s"} (${real.reduce((n, c) => n + c.edits.length, 0)} edits)`,
            createdAt: Date.now(),
            changes: real,
            fingerprints: {},
          }
          for (const change of real) {
            const text = change.kind === "delete" ? undefined : (yield* Effect.promise(() => fs.readFile(change.file, "utf8")).pipe(Effect.catch(() => Effect.succeed(undefined))))
            plan.fingerprints[change.file] =
              text !== undefined ? fingerprintText(text) : { exists: false, sha256: "", size: 0, mtimeMs: 0 }
          }

          if (params.dryRun !== false) {
            yield* Effect.promise(() => savePlan(worktree, plan))
            const diff = plan.changes.map((c) => `--- ${c.rel} (${c.kind})\n${changeDiff(c)}`).join("\n\n")
            const output = [
              `<refactor status="preview" previewId="${plan.id}" mode="${mode}">`,
              `  <summary>${plan.summary}</summary>`,
              diff.slice(0, params.maxDiffBytes ?? 60_000),
              `</refactor>`,
              `Next call to apply: refactor({ previewId: "${plan.id}", mode: "${mode}", dryRun: false, confirm: "REFACTOR" })`,
            ].join("\n")
            return {
              title: `refactor ${mode} (preview)`,
              output,
              metadata: { mode, status: "preview", previewId: plan.id, changedFiles: plan.changes.length, edits: plan.changes.reduce((n, c) => n + c.edits.length, 0) },
            }
          }

          // --- apply: requires saved plan + confirm token -----------------------
          if (params.confirm !== "REFACTOR") {
            throw new Error(`Applying a refactor requires confirm:"REFACTOR" (got ${params.confirm ?? "none"}). Preview first, then re-run with dryRun:false.`)
          }
          const loaded = yield* Effect.promise(() => loadPlan(worktree, plan.id))
          if (!loaded) throw new Error(`Plan ${plan.id} expired or missing — re-run the dry-run.`)
          const applied = loaded

          // Stale-check (R6).
          const currentContents = new Map<string, string>()
          for (const change of applied.changes) {
            const text = change.kind === "delete" ? undefined : (yield* Effect.promise(() => fs.readFile(change.file, "utf8")).pipe(Effect.catch(() => Effect.succeed(undefined))))
            if (text !== undefined) currentContents.set(change.file, text)
          }
          assertPlanFresh(applied, Object.fromEntries(currentContents))

          // Baseline diagnostics (diagnostic-delta gate).
          const tsFiles = applied.changes.filter((c) => c.kind !== "delete" && TypecheckScope.isTsFile(c.file))
          let beforeDiags = 0
          if (params.runTypecheck !== false && tsFiles.length > 0) {
            const dir = path.dirname(tsFiles[0]!.file)
            const tsconfigDir = (yield* Effect.promise(() => TypecheckScope.findNearestTsconfig(dir, worktree))) ?? undefined
            if (tsconfigDir) {
              const baseline = yield* TypecheckScope.runScopedTypecheck({
                app,
                worktree,
                tsconfigDir,
                files: tsFiles.map((c) => c.file),
                maxErrors: 200,
                timeoutMs: 30_000,
                signal: ctx.abort,
              })
              beforeDiags = baseline.diagnostics.length
            }
          }

          // Permission asks per touched file, then write with in-memory backups.
          const backups = new Map<string, string>()
          try {
            for (const change of applied.changes) {
              const rel = path.relative(worktree, change.file)
              yield* ctx.ask({
                permission: "edit",
                patterns: [rel],
                always: [rel],
                metadata: { filepath: change.file, diff: changeDiff(change) },
              })
              if (change.kind === "delete") {
                const existing = yield* Effect.promise(() => fs.readFile(change.file, "utf8")).pipe(Effect.catch(() => Effect.succeed(undefined)))
                if (existing !== undefined) backups.set(change.file, existing)
                yield* Effect.promise(() => fs.rm(change.file, { force: true }))
                continue
              }
              const existing = yield* Effect.promise(() => fs.readFile(change.file, "utf8")).pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (existing !== undefined) backups.set(change.file, existing)
              yield* fsutil.writeWithDirs(change.file, change.after)
            }

            // Post-write diagnostic delta; roll back if increased.
            let afterDiags = 0
            if (params.runTypecheck !== false && tsFiles.length > 0) {
              const dir = path.dirname(tsFiles[0]!.file)
              const tsconfigDir = (yield* Effect.promise(() => TypecheckScope.findNearestTsconfig(dir, worktree))) ?? undefined
              if (tsconfigDir) {
                const check = yield* TypecheckScope.runScopedTypecheck({
                  app,
                  worktree,
                  tsconfigDir,
                  files: tsFiles.map((c) => c.file),
                  maxErrors: 200,
                  timeoutMs: 30_000,
                  signal: ctx.abort,
                })
                afterDiags = check.diagnostics.length
              }
            }
            if (afterDiags > beforeDiags && params.rollbackOnFailure !== false) {
              for (const [file, text] of backups) {
                yield* Effect.promise(() => fs.writeFile(file, text, "utf8")).pipe(Effect.catch(() => Effect.void))
              }
              return {
                title: `refactor ${mode} (rolled back)`,
                output: `<refactor status="rolled-back" previewId="${applied.id}" mode="${mode}">Diagnostics increased (${beforeDiags} → ${afterDiags}) after applying; changes rolled back.</refactor>`,
                metadata: { mode, status: "rolled-back", previewId: applied.id, changedFiles: applied.changes.length, edits: applied.changes.reduce((n, c) => n + c.edits.length, 0) },
              }
            }

            yield* Effect.promise(() => fs.rm(path.join(planCacheDir(worktree), `${applied.id}.json`), { force: true }))
            return {
              title: `refactor ${mode} (applied)`,
              output: [
                `<refactor status="applied" previewId="${applied.id}" mode="${mode}">`,
                `  <summary>${applied.summary}</summary>`,
                applied.changes.map((c) => `  <changed rel="${c.rel}" kind="${c.kind}" />`).join("\n"),
                "</refactor>",
              ].join("\n"),
              metadata: { mode, status: "applied", previewId: applied.id, changedFiles: applied.changes.length, edits: applied.changes.reduce((n, c) => n + c.edits.length, 0) },
            }
          } catch (error) {
            for (const [file, text] of backups) {
              yield* Effect.promise(() => fs.writeFile(file, text, "utf8")).pipe(Effect.catch(() => Effect.void))
            }
            throw error
          }
        }).pipe(Effect.orDie),
    }
  }),
)

