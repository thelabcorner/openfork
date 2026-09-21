import { Effect, Schema } from "effect"
import path from "path"
import * as Tool from "./tool"
import { AppProcess } from "@opencode-ai/core/process"
import { GitRuntime } from "@opencode-ai/core/git-runtime"
import { ChildProcess } from "effect/unstable/process"
import { InstanceState } from "@/effect/instance-state"
import { TypecheckScope } from "./typecheck-scope"
import DESCRIPTION from "./typecheck.txt"


const GIT_ARGS = [
  "--no-optional-locks",
  "-c",
  "core.quotepath=false",
  ...GitRuntime.args([]),
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

          const scope =
            mode === "full"
              ? []
              : yield* TypecheckScope.computeScope({
                  mode: mode as TypecheckScope.ScopeMode,
                  worktree: instance.worktree,
                  directory: instance.directory,
                  filePath: params.filePath,
                  files: params.files,
                  folder: params.folder,
                  maxFiles: params.maxFiles,
                  depth: params.depth,
                  includeTests: params.includeTests,
                  includeUntracked: params.includeUntracked,
                  includeImporters: params.includeImporters,
                  runGit,
                })
          if (mode !== "full" && scope.length === 0) throw new Error("No files selected to typecheck")

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
            const tsconfigPath = params.tsconfig
              ? (path.isAbsolute(params.tsconfig) ? params.tsconfig : path.join(instance.directory, params.tsconfig))
              : (yield* Effect.promise(() => TypecheckScope.findNearestTsconfigFile(firstDir, instance.worktree))) ??
                (yield* Effect.promise(() => TypecheckScope.findNearestTsconfigFile(instance.directory, instance.worktree)))
            if (!tsconfigPath) throw new Error(`No tsconfig found for ${scope[0]} — cannot run a scoped typecheck.`)
            tsconfigDir = path.dirname(tsconfigPath)
            outcome = yield* TypecheckScope.runScopedTypecheck({
              app,
              worktree: instance.worktree,
              tsconfigDir,
              tsconfigPath,
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

