import { Effect, Schema } from "effect"
import path from "path"
import * as Tool from "./tool"
import { AppProcess } from "@opencode-ai/core/process"
import { ChildProcess } from "effect/unstable/process"
import { InstanceState } from "@/effect/instance-state"
import DESCRIPTION from "./git.txt"

// argv-array git invocation with a safe env. Never shell strings (rail R7).
const GIT = [
  "--no-pager",
  "--no-optional-locks",
  "-c",
  "color.ui=false",
  "-c",
  "core.quotepath=false",
  "-c",
  "core.autocrlf=false",
] as const

const SAFE_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  PAGER: "cat",
  LC_ALL: "C",
  GIT_LITERAL_PATHSPECS: "1",
}

// shell-mode readonly allowlist (rail R3 — never silently run a write command)
const SHELL_READONLY = new Set([
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "rev-parse",
  "ls-files",
  "grep",
  "describe",
  "remote",
  "config",
  "show-ref",
  "for-each-ref",
  "name-rev",
  "merge-base",
  "cat-file",
  "check-ignore",
  "blame",
  "shortlog",
])

const SHELL_FORBIDDEN = [
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--force",
  "--force-with-lease",
  "--hard",
  "--delete",
  "-d",
  "-D",
  "--remove",
  "-m",
  "--amend",
  "--reset",
  "--checkout",
  "--merge",
  "--rebase",
  "--clean",
]

export const Parameters = Schema.Struct({
  mode: Schema.optional(
    Schema.Literals(["help", "status", "summary", "diff", "log", "show", "stage", "unstage", "restore", "commit", "shell"]),
  ).annotate({ description: "Operation to run (default: status)" }),
  paths: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Relative repo paths to operate on (max 500)",
  }),
  ref: Schema.optional(Schema.String).annotate({ description: "Revision for diff/log/show" }),
  staged: Schema.optional(Schema.Boolean).annotate({ description: "diff mode: show staged changes (--cached)" }),
  maxBytes: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 2000, maximum: 500_000 }))).annotate({
    description: "Output cap in bytes (default 80000, max 500000)",
  }),
  maxCount: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))).annotate({
    description: "log: max commits (default 20, max 200)",
  }),
  contextLines: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 200 }))).annotate({
    description: "diff: context lines (default 3, max 200)",
  }),
  message: Schema.optional(Schema.String).annotate({ description: "commit: commit message (required for commit)" }),
  dryRun: Schema.optional(Schema.Boolean).annotate({ description: "commit: preview only (default true)" }),
  confirm: Schema.optional(
    Schema.Literals(["STAGE_ALL", "UNSTAGE_ALL", "RESTORE_WORKTREE", "RESTORE_BOTH", "RESTORE_ALL", "COMMIT"]),
  ).annotate({
    description: "In-tool confirm token required for destructive/all-path operations",
  }),
  allowEmpty: Schema.optional(Schema.Boolean).annotate({ description: "commit: allow empty commit" }),
  sign: Schema.optional(Schema.Boolean).annotate({ description: "commit: sign the commit (default false)" }),
  restoreTarget: Schema.optional(Schema.Literals(["worktree", "staged", "both"])).annotate({
    description: "restore: what to restore (default worktree)",
  }),
  argv: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "shell mode: restricted read-only git argv (max 80)",
  }),
})

type Metadata = {
  mode: string
  ok: boolean
  exitCode: number
  truncated: boolean
  changed?: boolean
  commit?: string
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// Resolve a plain relative path inside the worktree. Rejects absolute paths,
// `..` escapes, pathspec magic, NUL bytes, and `-`-leading paths (rail R4).
function resolvePathInside(worktree: string, p: string): string {
  if (p.includes("\0")) throw new Error(`Rejecting path with NUL byte: ${JSON.stringify(p)}`)
  if (p.includes(":(") || p.startsWith(":/") || p.includes(":(top")) {
    throw new Error(`Rejecting pathspec magic in path: ${p}`)
  }
  if (p.startsWith("-")) throw new Error(`Rejecting option-looking path: ${p} — use ./ prefix or a typed mode`)
  const abs = path.isAbsolute(p) ? p : path.resolve(worktree, p)
  const rel = path.relative(worktree, abs)
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes the worktree: ${p}`)
  }
  return rel.split(path.sep).join("/")
}

export const GitTool = Tool.define<typeof Parameters, Metadata, AppProcess.Service>(
  "git",
  Effect.gen(function* () {
    const app = yield* AppProcess.Service

    const run = Effect.fn("GitTool.run")(function* (
      args: readonly string[],
      cwd: string,
      opts: { maxBytes?: number; timeoutMs?: number; signal?: AbortSignal } = {},
    ) {
      const result = yield* app
        .run(ChildProcess.make("git", [...GIT, ...args], { cwd, env: SAFE_ENV, stdin: "ignore", stdout: "pipe", stderr: "pipe" }), {
          maxOutputBytes: opts.maxBytes ?? 80_000,
          timeout: opts.timeoutMs ?? 30_000,
          signal: opts.signal,
        })
        .pipe(Effect.catch((error) =>
          Effect.succeed({
            command: error.command,
            exitCode: error.exitCode ?? 1,
            stdout: Buffer.alloc(0),
            stderr: Buffer.from(error.message),
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
        ))
      return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString("utf8"),
        stderr: result.stderr.toString("utf8"),
        truncated: result.stdoutTruncated || result.stderrTruncated,
      }
    })

    // Worktree assertion (rail R6): the cwd must be inside a git worktree.
    const assertWorktree = Effect.fn("GitTool.assertWorktree")(function* (cwd: string) {
      const inside = yield* run(["rev-parse", "--is-inside-work-tree"], cwd, { maxBytes: 4096, timeoutMs: 5000 })
      if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
        throw new Error(`${cwd} is not inside a git worktree. The git tool operates on the current project's repository.`)
      }
      const top = yield* run(["rev-parse", "--show-toplevel"], cwd, { maxBytes: 4096, timeoutMs: 5000 })
      const root = top.stdout.trim()
      if (!root) throw new Error("Could not resolve git worktree root")
      return path.resolve(root)
    })

    const statusPorcelain = Effect.fn("GitTool.status")(function* (root: string, paths: string[] = []) {
      const args = ["status", "--porcelain=v1", "--untracked-files=all", "--no-renames"]
      if (paths.length) args.push("--", ...paths)
      const result = yield* run(args, root)
      return result.stdout
    })

    const renderStatus = Effect.fn("GitTool.renderStatus")(function* (root: string, paths: string[] = []) {
      const text = yield* statusPorcelain(root, paths)
      if (!text.trim()) return "<status clean=\"true\" />\n(working tree clean)"
      const lines = text.trim().split("\n")
      return `<status clean="false" entries="${lines.length}">\n${lines.map((l) => `  <entry>${escapeXml(l)}</entry>`).join("\n")}\n</status>`
    })

    const requireConfirm = Effect.fn("GitTool.requireConfirm")(function* (expected: string, actual: string | undefined, what: string) {
      if (actual !== expected) {
        throw new Error(`${what} requires the in-tool confirm token confirm:"${expected}" (you provided ${actual ? `"${actual}"` : "none"}).`)
      }
    })

    const relPaths = Effect.fn("GitTool.relPaths")(function* (worktree: string, paths: readonly string[] | undefined) {
      if (!paths?.length) return [] as string[]
      return paths.map((p) => resolvePathInside(worktree, p))
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const mode = params.mode ?? "status"
          // Resolve the actual git root from the project directory (worktree
          // may be unset/" / " in non-git or bare contexts).
          const root = yield* assertWorktree(instance.directory)
          const maxBytes = params.maxBytes ?? 80_000
          const signal = ctx.abort

          const paths = yield* relPaths(root, params.paths)
          const permPatterns =
            paths.length > 0
              ? paths.map((p) => `git:${mode}:${p}`)
              : mode === "commit"
                ? [`git:commit:${(params.message ?? "").slice(0, 60)}`]
                : [`git:${mode}:*`]

          yield* ctx.ask({
            permission: "git",
            patterns: permPatterns,
            always: mode === "commit" ? [`git:commit:${(params.message ?? "").slice(0, 60)}`] : permPatterns,
            metadata: { mode, ...(paths.length ? { paths } : {}) },
          })

          const render = (output: string, extra: Record<string, unknown> = {}) => ({
            title: `git ${mode}`,
            output,
            metadata: { mode, ok: true, exitCode: 0, truncated: false, ...extra } satisfies Metadata,
          })

          if (mode === "help") {
            return render(DESCRIPTION)
          }

          if (mode === "status") {
            const output = yield* renderStatus(root, paths)
            return render(output)
          }

          if (mode === "summary") {
            const [status, branch, recent] = yield* Effect.all([
              statusPorcelain(root, paths),
              run(["branch", "--show-current"], root, { maxBytes: 4096 }),
              run(["log", "--oneline", "-n", `${Math.min(params.maxCount ?? 5, 20)}`], root, { maxBytes }),
            ])
            const current = branch.stdout.trim() || "(detached HEAD)"
            const lines = [
              `<summary branch="${escapeXml(current)}">`,
              status.trim()
                ? status.trim().split("\n").map((l) => `  <entry>${escapeXml(l)}</entry>`).join("\n")
                : "  <clean />",
              "</summary>",
              `<recent>`,
              recent.stdout.trim() ? recent.stdout.trim().split("\n").map((l) => `  <commit>${escapeXml(l)}</commit>`).join("\n") : "  <none />",
              `</recent>`,
            ]
            return render(lines.join("\n"), { changed: status.trim().length > 0 })
          }

          if (mode === "diff") {
            const args = ["diff", "--no-ext-diff", "--no-renames", `--unified=${params.contextLines ?? 3}`]
            if (params.staged) args.push("--cached")
            if (params.ref) args.push(params.ref)
            if (paths.length) args.push("--", ...paths)
            const result = yield* run(args, root, { maxBytes, signal })
            const out = result.stdout.trim() || "(no diff)"
            return { ...render(`<diff staged="${Boolean(params.staged)}">\n${escapeXml(out)}\n</diff>`), metadata: { ...render("").metadata, truncated: result.truncated } }
          }

          if (mode === "log") {
            const args = ["log", "--oneline", "--decorate", "-n", `${Math.min(params.maxCount ?? 20, 200)}`]
            if (params.ref) args.push(params.ref)
            const result = yield* run(args, root, { maxBytes, signal })
            const out = result.stdout.trim() || "(no commits)"
            return { ...render(`<log>\n${escapeXml(out)}\n</log>`), metadata: { ...render("").metadata, truncated: result.truncated } }
          }

          if (mode === "show") {
            if (!params.ref) throw new Error("show mode requires ref")
            const args = ["show", "--stat", params.ref]
            if (paths.length) args.push("--", ...paths)
            const result = yield* run(args, root, { maxBytes, signal })
            return { ...render(`<show ref="${escapeXml(params.ref)}">\n${escapeXml(result.stdout.trim() || "(nothing to show)")}\n</show>`), metadata: { ...render("").metadata, truncated: result.truncated } }
          }

          if (mode === "stage") {
            if (paths.length === 0) {
              yield* requireConfirm("STAGE_ALL", params.confirm, "Staging all changes")
            }
            const args = ["add"]
            if (paths.length === 0) {
              args.push("-A", ".")
            } else {
              args.push("--", ...paths)
            }
            const result = yield* run(args, root, { signal })
            if (result.exitCode !== 0) throw new Error(`git add failed:\n${result.stderr.trim()}`)
            const status = yield* renderStatus(root)
            return render(`<staged paths="${paths.length || "all"}">\n${status}\n</staged>`, { changed: true })
          }

          if (mode === "unstage") {
            if (paths.length === 0) {
              yield* requireConfirm("UNSTAGE_ALL", params.confirm, "Unstaging all changes")
            }
            const args = ["restore", "--staged"]
            if (paths.length === 0) args.push("--", ".")
            else args.push("--", ...paths)
            const result = yield* run(args, root, { signal })
            if (result.exitCode !== 0) throw new Error(`git restore --staged failed:\n${result.stderr.trim()}`)
            const status = yield* renderStatus(root)
            return render(`<unstaged paths="${paths.length || "all"}">\n${status}\n</unstaged>`, { changed: true })
          }

          if (mode === "restore") {
            const target = params.restoreTarget ?? "worktree"
            if (paths.length === 0) {
              yield* requireConfirm("RESTORE_ALL", params.confirm, "Restoring all changes")
            } else {
              const token = target === "both" ? "RESTORE_BOTH" : "RESTORE_WORKTREE"
              yield* requireConfirm(token, params.confirm, `Restoring ${target} changes`)
            }
            // Refuse when there are staged conflicts.
            const conflicts = yield* run(["diff", "--name-only", "--diff-filter=U"], root, { maxBytes: 4096 })
            if (conflicts.stdout.trim()) {
              throw new Error(`Refusing to restore while unmerged conflicts exist:\n${conflicts.stdout.trim()}`)
            }
            const args = ["restore"]
            if (target === "staged") args.push("--staged")
            if (target === "both") args.push("--staged", "--worktree")
            if (paths.length === 0) args.push("--", ".")
            else args.push("--", ...paths)
            const result = yield* run(args, root, { signal })
            if (result.exitCode !== 0) throw new Error(`git restore failed:\n${result.stderr.trim()}`)
            const status = yield* renderStatus(root)
            return render(`<restored target="${target}" paths="${paths.length || "all"}">\n${status}\n</restored>`, { changed: true })
          }

          if (mode === "commit") {
            if (!params.message) throw new Error("commit mode requires message")
            // Refuse on unmerged files; require staged changes unless allowEmpty.
            const conflicts = yield* run(["diff", "--name-only", "--diff-filter=U", "--cached"], root, { maxBytes: 4096 })
            if (conflicts.stdout.trim()) {
              throw new Error(`Refusing to commit while unmerged files are staged:\n${conflicts.stdout.trim()}`)
            }
            const dry = yield* run(["commit", "--dry-run"], root, { maxBytes })
            const hasStaged = dry.stdout.includes("Changes to be committed") || !dry.stdout.includes("nothing to commit")
            if (!hasStaged && !params.allowEmpty) {
              throw new Error("Nothing staged to commit (use stage first, or allowEmpty:true for an empty commit).")
            }
            if (params.dryRun !== false) {
              return render(`<commit dry-run="true">\n${escapeXml(dry.stdout.trim() || "(would commit staged changes)")}\n</commit>\nRe-run with dryRun:false and confirm:"COMMIT" to apply.`)
            }
            // Confirm token gates the actual write, not the dry-run preview.
            yield* requireConfirm("COMMIT", params.confirm, "Committing")
            const args = ["commit", "-m", params.message]
            if (params.allowEmpty) args.push("--allow-empty")
            if (!params.sign) args.push("--no-gpg-sign")
            const result = yield* run(args, root, { signal })
            if (result.exitCode !== 0) throw new Error(`git commit failed:\n${result.stderr.trim()}`)
            const echo = yield* run(["log", "-1", "--oneline"], root, { maxBytes: 4096 })
            const status = yield* renderStatus(root)
            const hash = echo.stdout.trim()
            return render(`<commit applied="true">\n  <commit>${escapeXml(hash)}</commit>\n${status}\n</commit>`, {
              changed: true,
              commit: hash,
            })
          }

          if (mode === "shell") {
            const argv = params.argv ?? []
            if (argv.length === 0) throw new Error("shell mode requires argv (a git command array)")
            if (argv.length > 80) throw new Error("shell mode argv is capped at 80 items")
            const sub = argv[0]!
            if (!SHELL_READONLY.has(sub)) {
              throw new Error(`shell mode refuses the write subcommand "${sub}". Use typed modes: stage, unstage, restore, commit.`)
            }
            for (const item of argv) {
              if (SHELL_FORBIDDEN.some((f) => item === f || item.startsWith(f + "="))) {
                throw new Error(`shell mode refuses forbidden argument: ${item}`)
              }
            }
            const result = yield* run(argv, root, { maxBytes, signal })
            const out = result.stdout.trim() || result.stderr.trim() || "(no output)"
            return {
              ...render(`<git-shell argv="${escapeXml(argv.join(" "))}" exit="${result.exitCode}">\n${escapeXml(out)}\n</git-shell>`),
              metadata: { mode, ok: result.exitCode === 0, exitCode: result.exitCode, truncated: result.truncated },
            }
          }

          throw new Error(`Unsupported mode: ${mode}`)
        }).pipe(Effect.orDie),
    }
  }),
)

