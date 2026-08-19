import { Effect, Schema } from "effect"
import path from "path"
import fs from "node:fs/promises"
import * as Tool from "./tool"
import { AppProcess } from "@opencode-ai/core/process"
import { ChildProcess } from "effect/unstable/process"
import { InstanceState } from "@/effect/instance-state"
import { TypecheckScope } from "./typecheck-scope"
import DESCRIPTION from "./typecheck.txt"

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  ".git",
  "__pycache__",
  ".opencode",
])

const GIT_ARGS = [
  "--no-optional-locks",
  "-c",
  "core.quotepath=false",
] as const

export const Parameters = Schema.Struct({
  mode: Schema.optional(Schema.Literals(["file", "files", "folder", "changed", "bottomUp", "full", "explain"])).annotate({
    description:
      "What to typecheck (default: file when filePath given, files when files[] given, folder when folder given, else changed)",
  }),
  filePath: Schema.optional(Schema.String).annotate({ description: "One file to typecheck" }),
  files: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "Files to typecheck" }),
  folder: Schema.optional(Schema.String).annotate({ description: "Folder to recursively scan for TS files" }),
  tsconfig: Schema.optional(Schema.String).annotate({ description: "Explicit tsconfig path (default: nearest up the tree)" }),
  maxErrors: Schema.optional(Schema.Int).annotate({
    description: "Cap on reported diagnostics (default 80, max 500)",
  }),
  maxFiles: Schema.optional(Schema.Int).annotate({
    description: "Cap on scanned files for folder/bottomUp modes (default 60, max 500)",
  }),
  depth: Schema.optional(Schema.Int).annotate({
    description: "bottomUp: import dependency closure depth (default 2, max 5)",
  }),
  includeTests: Schema.optional(Schema.Boolean).annotate({ description: "folder mode: include test files" }),
  includeUntracked: Schema.optional(Schema.Boolean).annotate({ description: "changed mode: include untracked TS files" }),
  includeImporters: Schema.optional(Schema.Boolean).annotate({
    description: "bottomUp: also include files that import the seed files",
  }),
  reason: Schema.optional(Schema.String).annotate({
    description: "REQUIRED for full mode: why the slow full-project check is needed",
  }),
  timeoutMs: Schema.optional(Schema.Int).annotate({ description: "Compiler timeout (default 30000)" }),
})

type Metadata = {
  mode: string
  status: string
  files: string[]
  errors: number
  truncated: boolean
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// Local-import selection for bottomUp: regex is fine here — it only selects
// which files to compile, never parses for correctness.
function localImports(text: string): string[] {
  const out: string[] = []
  const re = /(?:from\s+|import\s*\()\s*["']([^"']+)["']/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) out.push(match[1]!)
  return out
}

async function walkTsFiles(dir: string, max: number, includeTests: boolean): Promise<string[]> {
  const out: string[] = []
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[])
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= max) break
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      out.push(...(await walkTsFiles(path.join(dir, entry.name), max - out.length, includeTests)))
      continue
    }
    if (!TypecheckScope.isTsFile(entry.name)) continue
    if (!includeTests && (entry.name.endsWith(".test.ts") || entry.name.endsWith(".spec.ts") || entry.name.includes(".test."))) continue
    out.push(path.join(dir, entry.name))
  }
  return out
}

export const TypecheckTool = Tool.define<typeof Parameters, Metadata, AppProcess.Service>(
  "typecheck",
  Effect.gen(function* () {
    const app = yield* AppProcess.Service

    const runGit = Effect.fn("TypecheckTool.runGit")(function* (args: string[], cwd: string) {
      const result = yield* app
        .run(ChildProcess.make("git", [...GIT_ARGS, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" }), {
          maxOutputBytes: 2_000_000,
          timeout: 15_000,
        })
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!result || result.exitCode !== 0) return [] as string[]
      return result.stdout
        .toString("utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    })

    const resolveMode = Effect.fn("TypecheckTool.resolveMode")(function* (
      mode: string | undefined,
      params: Schema.Schema.Type<typeof Parameters>,
    ) {
      if (mode) return mode
      if (params.filePath) return "file"
      if (params.files?.length) return "files"
      if (params.folder) return "folder"
      return "changed"
    })

    const computeScope = Effect.fn("TypecheckTool.scope")(function* (
      mode: string,
      params: Schema.Schema.Type<typeof Parameters>,
      worktree: string,
      directory: string,
    ) {
      const maxFiles = params.maxFiles ?? 60

      if (mode === "file") {
        if (!params.filePath) throw new Error("file mode requires filePath")
        const file = path.isAbsolute(params.filePath) ? params.filePath : path.join(directory, params.filePath)
        return [file]
      }
      if (mode === "files") {
        if (!params.files?.length) throw new Error("files mode requires files[]")
        return params.files.map((f) => (path.isAbsolute(f) ? f : path.join(directory, f)))
      }
      if (mode === "folder") {
        if (!params.folder) throw new Error("folder mode requires folder")
        const dir = path.isAbsolute(params.folder) ? params.folder : path.join(directory, params.folder)
        const files = yield* Effect.promise(() => walkTsFiles(dir, maxFiles, params.includeTests ?? false))
        if (files.length === 0) throw new Error(`No TypeScript files found under ${dir}`)
        return files
      }
      if (mode === "changed") {
        const staged = yield* runGit(["diff", "--cached", "--name-only", "--diff-filter=ACMR"], worktree)
        const unstaged = yield* runGit(["diff", "--name-only", "--diff-filter=ACMR"], worktree)
        let list = [...staged, ...unstaged]
        if (params.includeUntracked) {
          list = [...list, ...(yield* runGit(["ls-files", "--others", "--exclude-standard"], worktree))]
        }
        const files = list
          .filter((f) => TypecheckScope.isTsFile(f))
          .map((f) => path.join(worktree, f))
        if (files.length === 0) throw new Error("No changed TypeScript files detected (use includeUntracked for new files)")
        return files
      }
      if (mode === "bottomUp") {
        const seeds = params.files?.length
          ? params.files.map((f) => (path.isAbsolute(f) ? f : path.join(directory, f)))
          : params.filePath
            ? [path.isAbsolute(params.filePath) ? params.filePath : path.join(directory, params.filePath)]
            : []
        if (seeds.length === 0) throw new Error("bottomUp requires filePath or files[] as seeds")
        const depth = params.depth ?? 2
        const seen = new Set<string>()
        const ordered: string[] = []
        const visit = async (file: string, d: number): Promise<void> => {
          if (seen.has(file) || d > depth) return
          seen.add(file)
          const text = await fs.readFile(file, "utf8").catch(() => "")
          const imports = localImports(text)
          for (const spec of imports) {
            if (!spec.startsWith(".")) continue
            const resolved = path.resolve(path.dirname(file), spec)
            for (const candidate of [resolved, `${resolved}.ts`, `${resolved}.tsx`, `${resolved}.d.ts`, path.join(resolved, "index.ts")]) {
              if (seen.has(candidate)) continue
              if (await fs.stat(candidate).then((s) => s.isFile()).catch(() => false)) {
                await visit(candidate, d + 1)
              }
            }
          }
          ordered.push(file)
        }
        yield* Effect.promise(async () => {
          for (const seed of seeds.slice(0, maxFiles)) await visit(seed, 0)
        })
        return ordered.filter((f) => TypecheckScope.isTsFile(f)).slice(0, maxFiles)
      }
      throw new Error(`Unsupported mode: ${mode}`)
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const mode = yield* resolveMode(params.mode, params)
          const maxErrors = Math.min(params.maxErrors ?? 80, 500)

          if (mode === "explain") {
            const codeText = params.filePath?.replace(/\D/g, "")
            const code = codeText ? Number.parseInt(codeText, 10) : NaN
            if (!Number.isFinite(code) || code <= 0) {
              throw new Error("explain mode requires a TS error code (pass it as filePath, e.g. filePath: 'TS2307' or '2307')")
            }
            const info = TypecheckScope.explainCode(code)
            const output = [
              `<typecheck-explain code="TS${code}" category="${info.category}" severity="${info.severity}">`,
              `  <suggestion>${info.suggestion}</suggestion>`,
              "</typecheck-explain>",
            ].join("\n")
            return {
              title: `explain TS${code}`,
              output,
              metadata: { mode, status: "passed", files: [], errors: 0, truncated: false },
            }
          }

          if (mode === "full") {
            if (!params.reason) {
              throw new Error("full mode requires a `reason` — it runs the repo's own typecheck script and is slow. Prefer a scoped mode (file/files/folder/changed/bottomUp).")
            }
          }
          const fullReason = params.reason

          yield* ctx.ask({
            permission: "typecheck",
            patterns: ["*"],
            always: ["*"],
            metadata: { mode, full: mode === "full" },
          })

          const scope = yield* computeScope(mode, params, instance.worktree, instance.directory)
          if (scope.length === 0) throw new Error("No files selected to typecheck")

          // Worktree-bound guard: every file must live inside the worktree.
          for (const file of scope) {
            const rel = path.relative(instance.worktree, file)
            if (rel.startsWith("..") || path.isAbsolute(rel)) {
              throw new Error(`Refusing to typecheck file outside the worktree: ${file}`)
            }
          }

          const timeoutMs = params.timeoutMs ?? 30_000
          let outcome: TypecheckScope.TypecheckOutcome
          let tsconfigDir: string | undefined

          if (mode === "full") {
            outcome = yield* TypecheckScope.runFullTypecheck({
              app,
              worktree: instance.worktree,
              cwd: instance.directory,
              reason: fullReason ?? "full mode requested",
              timeoutMs: Math.max(timeoutMs, 120_000),
              signal: ctx.abort,
            })
          } else {
            const firstDir = path.dirname(scope[0]!)
            tsconfigDir = params.tsconfig
              ? (path.isAbsolute(params.tsconfig) ? path.dirname(params.tsconfig) : path.dirname(path.join(instance.directory, params.tsconfig)))
              : (yield* Effect.promise(() => TypecheckScope.findNearestTsconfig(firstDir, instance.worktree))) ?? (yield* Effect.promise(() => TypecheckScope.findNearestTsconfig(instance.directory, instance.worktree)))
            if (!tsconfigDir) throw new Error(`No tsconfig found for ${scope[0]} — cannot run a scoped typecheck.`)
            outcome = yield* TypecheckScope.runScopedTypecheck({
              app,
              worktree: instance.worktree,
              tsconfigDir,
              files: scope,
              maxErrors,
              timeoutMs,
              signal: ctx.abort,
            })
          }

          const diagnostics = outcome.diagnostics
          const status: "passed" | "failed" = outcome.exitCode === 0 ? "passed" : "failed"
          const clusters = TypecheckScope.clusterDiagnostics(diagnostics)
          const counts: Record<string, number> = {}
          for (const d of diagnostics) counts[d.severity] = (counts[d.severity] ?? 0) + 1

          const rel = (f: string) => TypecheckScope.relativePosix(instance.worktree, f)
          const scopeXml = `<scope mode="${mode}" files="${scope.length}">${scope.map((f) => `\n  <file>${escapeXml(rel(f))}</file>`).join("")}\n</scope>`
          const tsconfigXml = tsconfigDir ? `<tsconfig>${escapeXml(path.relative(instance.worktree, tsconfigDir))}</tsconfig>` : "<tsconfig>package typecheck script</tsconfig>"
          const summaryXml = `<summary status="${status}" errors="${diagnostics.length}" bin="${outcome.bin}" exit="${outcome.exitCode}">`
          const triageXml = [
            `<triage>`,
            `  <p0>${counts["P0"] ?? 0}</p0>`,
            `  <p1>${counts["P1"] ?? 0}</p1>`,
            `  <p2>${counts["P2"] ?? 0}</p2>`,
            `  <p3>${counts["P3"] ?? 0}</p3>`,
            `</triage>`,
          ].join("\n")

          const diagXml = diagnostics.slice(0, maxErrors).map((d) => {
            return `  <diagnostic file="${escapeXml(rel(d.file))}" line="${d.line}" column="${d.column}" code="TS${d.code}" severity="${d.severity}" category="${d.category}">\n    <message>${escapeXml(d.message)}</message>\n    <suggestion>${escapeXml(d.suggestion)}</suggestion>\n  </diagnostic>`
          })

          const clusterXml = [
            `<clusters>`,
            ...clusters.map((c) => `  <cluster code="TS${c.code}" severity="${c.severity}" category="${c.category}" occurrences="${c.count}" files="${c.files}"/>`),
            `</clusters>`,
          ].join("\n")

          const next = [
            "<next>",
            diagnostics.length > 0
              ? `  Fix in P0→P1 order first (${counts["P0"] ?? 0} P0, ${counts["P1"] ?? 0} P1).`
              : "  No errors detected in the selected scope.",
            mode === "full"
              ? "  full mode ran the package typecheck script."
              : `  Scoped check via temp tsconfig in ${tsconfigDir ? path.relative(instance.worktree, tsconfigDir) : "package dir"}.`,
            "</next>",
          ].join("\n")

          const output = [
            `<typecheck mode="${mode}" status="${status}" errors="${diagnostics.length}" truncated="${outcome.truncated}">`,
            scopeXml,
            tsconfigXml,
            summaryXml,
            triageXml,
            clusterXml,
            ...(diagXml.length ? ["<diagnostics>", ...diagXml, "</diagnostics>"] : []),
            next,
            "</typecheck>",
          ].join("\n")

          return {
            title: `typecheck ${mode}`,
            output,
            metadata: { mode, status, files: scope.map(rel), errors: diagnostics.length, truncated: outcome.truncated },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

