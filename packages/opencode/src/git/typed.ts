import path from "path"
import { Cause, Effect, Option, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/core/process"
import { GitRuntime } from "@opencode-ai/core/git-runtime"
import { FSUtil } from "@opencode-ai/core/fs-util"

const GIT = [
  "--no-pager",
  "--no-optional-locks",
  "-c",
  "color.ui=false",
  "-c",
  "core.quotepath=false",
  ...GitRuntime.args([]),
] as const

const SAFE_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  PAGER: "cat",
  LC_ALL: "C",
  GIT_LITERAL_PATHSPECS: "1",
}

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

export const Fields = {
  mode: Schema.optional(
    Schema.Literals(["help", "status", "summary", "diff", "log", "show", "stage", "unstage", "restore", "commit", "shell"]),
  ).annotate({ description: "Operation; default status." }),
  paths: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(500))).annotate({
    description: "Repository-relative paths; max 500.",
  }),
  ref: Schema.optional(Schema.String).annotate({ description: "Revision for diff/log/show." }),
  staged: Schema.optional(Schema.Boolean).annotate({ description: "Show staged diff." }),
  maxBytes: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 2000, maximum: 500_000 }))).annotate({
    description: "Output bytes; max 500000.",
  }),
  maxCount: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))).annotate({
    description: "Log commits; max 200.",
  }),
  contextLines: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 200 }))).annotate({
    description: "Diff context lines; max 200.",
  }),
  message: Schema.optional(Schema.String).annotate({ description: "Commit message." }),
  dryRun: Schema.optional(Schema.Boolean).annotate({ description: "Preview commit; default true." }),
  confirm: Schema.optional(
    Schema.Literals(["STAGE_ALL", "UNSTAGE_ALL", "RESTORE_WORKTREE", "RESTORE_BOTH", "RESTORE_ALL", "COMMIT"]),
  ).annotate({
    description: "Confirm token for broad/destructive writes.",
  }),
  allowEmpty: Schema.optional(Schema.Boolean).annotate({ description: "Allow empty commit." }),
  sign: Schema.optional(Schema.Boolean).annotate({ description: "Sign commit." }),
  restoreTarget: Schema.optional(Schema.Literals(["worktree", "staged", "both"])).annotate({
    description: "Restore target; default worktree.",
  }),
  argv: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(80))).annotate({
    description: "Restricted read-only Git argv; max 80.",
  }),
} as const

export const Parameters = Schema.Struct(Fields)
export type Input = Schema.Schema.Type<typeof Parameters>
export type Mode = NonNullable<Input["mode"]>

export const ModeFields = Object.freeze({
  help: [] as const,
  status: ["paths", "maxBytes"] as const,
  summary: ["paths", "maxBytes", "maxCount"] as const,
  diff: ["paths", "ref", "staged", "maxBytes", "contextLines"] as const,
  log: ["ref", "maxBytes", "maxCount"] as const,
  show: ["paths", "ref", "maxBytes"] as const,
  stage: ["paths", "confirm", "maxBytes"] as const,
  unstage: ["paths", "confirm", "maxBytes"] as const,
  restore: ["paths", "confirm", "restoreTarget", "maxBytes"] as const,
  commit: ["message", "dryRun", "confirm", "allowEmpty", "sign", "maxBytes"] as const,
  shell: ["argv", "maxBytes"] as const,
} satisfies Record<Mode, readonly (keyof Input)[]>)

export function validateInput(input: Input) {
  const mode = input.mode ?? "status"
  const allowed = new Set<string>(["mode", ...ModeFields[mode]])
  const extras = Object.entries(input)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key)
    .filter((key) => !allowed.has(key))
  if (extras.length > 0) {
    throw new Error(`git ${mode} does not accept: ${extras.join(", ")}`)
  }
  if (mode === "show" && !input.ref) throw new Error("show mode requires ref")
  if (mode === "commit" && !input.message) throw new Error("commit mode requires message")
  if (mode === "shell" && (!input.argv || input.argv.length === 0)) throw new Error("shell mode requires argv")
}

export type Metadata = {
  mode: string
  ok: boolean
  exitCode: number
  truncated: boolean
  changed?: boolean
  commit?: string
}

export type Result = {
  title: string
  output: string
  metadata: Metadata
}

export type RunResult = {
  exitCode: number
  stdout: string
  stderr: string
  truncated: boolean
}

export type BeforeMutation = () => Effect.Effect<void, unknown>

export function isMutating(input: Input): boolean {
  const mode = input.mode ?? "status"
  if (mode === "stage" || mode === "unstage" || mode === "restore") return true
  if (mode === "commit") return input.dryRun === false
  return false
}

export function isReadOnly(input: Input): boolean {
  return !isMutating(input)
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export function resolvePathInside(worktree: string, value: string): string {
  if (value.includes("\0")) throw new Error("Rejecting Git path containing a NUL byte")
  if (path.isAbsolute(value)) throw new Error("Git paths must be relative to the repository root")
  if (value.includes(":(") || value.startsWith(":/") || value.includes(":(top")) {
    throw new Error("Git pathspec magic is not accepted by typed Git operations")
  }
  if (value.startsWith("-")) throw new Error("Git paths may not begin with '-'")
  const absolute = path.resolve(worktree, value)
  const relative = path.relative(worktree, absolute)
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Git path escapes the repository root")
  return relative.split(path.sep).join("/")
}

export const run = Effect.fn("GitTyped.run")(function* (
  app: AppProcess.Interface,
  args: readonly string[],
  cwd: string,
  options: { maxBytes?: number; timeoutMs?: number; signal?: AbortSignal } = {},
) {
  const result = yield* app.run(
    ChildProcess.make("git", [...GIT, ...args], {
      cwd,
      env: SAFE_ENV,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }),
    {
      maxOutputBytes: options.maxBytes ?? 80_000,
      timeout: options.timeoutMs ?? 30_000,
      signal: options.signal,
    },
  )
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
    truncated: result.stdoutTruncated || result.stderrTruncated,
  } satisfies RunResult
})

export const resolveWorktreeRoot = Effect.fn("GitTyped.resolveWorktreeRoot")(function* (
  app: AppProcess.Interface,
  cwd: string,
) {
  const location = FSUtil.normalizePath(cwd)
  const inside = yield* run(app, ["rev-parse", "--is-inside-work-tree"], location, { maxBytes: 4096, timeoutMs: 5000 })
  if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
    return yield* Effect.fail(new Error("Location is not inside a Git worktree"))
  }
  const top = yield* run(app, ["rev-parse", "--show-toplevel"], location, { maxBytes: 4096, timeoutMs: 5000 })
  const root = top.stdout.trim()
  if (top.exitCode !== 0 || !root) {
    return yield* Effect.fail(new Error("Could not resolve Git worktree root"))
  }
  return FSUtil.normalizePath(root)
})

function requireConfirm(expected: string, actual: string | undefined, what: string) {
  if (actual !== expected) {
    throw new Error(`${what} requires confirm:"${expected}"`)
  }
}

function validateShell(argv: readonly string[]) {
  if (argv.length === 0) throw new Error("shell mode requires argv")
  if (argv.length > 80) throw new Error("shell mode argv is capped at 80 items")
  const subcommand = argv[0]!
  if (!SHELL_READONLY.has(subcommand)) {
    throw new Error(`shell mode refuses write subcommand "${subcommand}"`)
  }
  for (const item of argv) {
    if (SHELL_FORBIDDEN.some((forbidden) => item === forbidden || item.startsWith(forbidden + "="))) {
      throw new Error(`shell mode refuses forbidden argument: ${item}`)
    }
  }
}

const executeRaw = Effect.fn("GitTyped.execute")(function* (
  app: AppProcess.Interface,
  input: Input,
  root: string,
  signal?: AbortSignal,
  beforeMutation?: BeforeMutation,
) {
  yield* Effect.try({
    try: () => validateInput(input),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })
  const mode = input.mode ?? "status"
  const maxBytes = input.maxBytes ?? 80_000
  const paths = input.paths?.map((item) => resolvePathInside(root, item)) ?? []
  const mutate = beforeMutation ?? (() => Effect.void)

  const statusPorcelain = Effect.fnUntraced(function* (selected: string[] = []) {
    const args = ["status", "--porcelain=v1", "--untracked-files=all", "--no-renames"]
    if (selected.length) args.push("--", ...selected)
    return (yield* run(app, args, root, { maxBytes, signal })).stdout
  })
  const renderStatus = Effect.fnUntraced(function* (selected: string[] = []) {
    const text = yield* statusPorcelain(selected)
    if (!text.trim()) return '<status clean="true" />\n(working tree clean)'
    const lines = text.trim().split("\n")
    return `<status clean="false" entries="${lines.length}">\n${lines.map((line) => `  <entry>${escapeXml(line)}</entry>`).join("\n")}\n</status>`
  })
  const render = (output: string, extra: Partial<Metadata> = {}): Result => ({
    title: `git ${mode}`,
    output,
    metadata: { mode, ok: true, exitCode: 0, truncated: false, ...extra },
  })

  if (mode === "help") {
    return render(
      "Typed Git modes: status, summary, diff, log, show, stage, unstage, restore, commit, shell. shell is restricted to a read-only allowlist.",
    )
  }
  if (mode === "status") return render(yield* renderStatus(paths))
  if (mode === "summary") {
    const [status, branch, recent] = yield* Effect.all([
      statusPorcelain(paths),
      run(app, ["branch", "--show-current"], root, { maxBytes: 4096, signal }),
      run(app, ["log", "--oneline", "-n", `${Math.min(input.maxCount ?? 5, 20)}`], root, { maxBytes, signal }),
    ])
    const current = branch.stdout.trim() || "(detached HEAD)"
    const lines = [
      `<summary branch="${escapeXml(current)}">`,
      status.trim()
        ? status.trim().split("\n").map((line) => `  <entry>${escapeXml(line)}</entry>`).join("\n")
        : "  <clean />",
      "</summary>",
      "<recent>",
      recent.stdout.trim()
        ? recent.stdout.trim().split("\n").map((line) => `  <commit>${escapeXml(line)}</commit>`).join("\n")
        : "  <none />",
      "</recent>",
    ]
    return render(lines.join("\n"), { changed: status.trim().length > 0 })
  }
  if (mode === "diff") {
    const args = ["diff", "--no-ext-diff", "--no-renames", `--unified=${input.contextLines ?? 3}`]
    if (input.staged) args.push("--cached")
    if (input.ref) args.push(input.ref)
    if (paths.length) args.push("--", ...paths)
    const result = yield* run(app, args, root, { maxBytes, signal })
    return {
      ...render(`<diff staged="${Boolean(input.staged)}">\n${escapeXml(result.stdout.trim() || "(no diff)")}\n</diff>`),
      metadata: { ...render("").metadata, ok: result.exitCode === 0, exitCode: result.exitCode, truncated: result.truncated },
    }
  }
  if (mode === "log") {
    const args = ["log", "--oneline", "--decorate", "-n", `${Math.min(input.maxCount ?? 20, 200)}`]
    if (input.ref) args.push(input.ref)
    const result = yield* run(app, args, root, { maxBytes, signal })
    return {
      ...render(`<log>\n${escapeXml(result.stdout.trim() || "(no commits)")}\n</log>`),
      metadata: { ...render("").metadata, ok: result.exitCode === 0, exitCode: result.exitCode, truncated: result.truncated },
    }
  }
  if (mode === "show") {
    if (!input.ref) throw new Error("show mode requires ref")
    const args = ["show", "--stat", input.ref]
    if (paths.length) args.push("--", ...paths)
    const result = yield* run(app, args, root, { maxBytes, signal })
    return {
      ...render(`<show ref="${escapeXml(input.ref)}">\n${escapeXml(result.stdout.trim() || "(nothing to show)")}\n</show>`),
      metadata: { ...render("").metadata, ok: result.exitCode === 0, exitCode: result.exitCode, truncated: result.truncated },
    }
  }
  if (mode === "stage") {
    if (paths.length === 0) requireConfirm("STAGE_ALL", input.confirm, "Staging all changes")
    yield* mutate()
    const args = ["add"]
    if (paths.length === 0) args.push("-A", ".")
    else args.push("--", ...paths)
    const result = yield* run(app, args, root, { signal })
    if (result.exitCode !== 0) throw new Error("git add failed")
    return render(`<staged paths="${paths.length || "all"}">\n${yield* renderStatus()}\n</staged>`, { changed: true })
  }
  if (mode === "unstage") {
    if (paths.length === 0) requireConfirm("UNSTAGE_ALL", input.confirm, "Unstaging all changes")
    yield* mutate()
    const args = ["restore", "--staged"]
    if (paths.length === 0) args.push("--", ".")
    else args.push("--", ...paths)
    const result = yield* run(app, args, root, { signal })
    if (result.exitCode !== 0) throw new Error("git restore --staged failed")
    return render(`<unstaged paths="${paths.length || "all"}">\n${yield* renderStatus()}\n</unstaged>`, { changed: true })
  }
  if (mode === "restore") {
    const target = input.restoreTarget ?? "worktree"
    if (paths.length === 0) requireConfirm("RESTORE_ALL", input.confirm, "Restoring all changes")
    else requireConfirm(target === "both" ? "RESTORE_BOTH" : "RESTORE_WORKTREE", input.confirm, `Restoring ${target} changes`)
    const conflicts = yield* run(app, ["diff", "--name-only", "--diff-filter=U"], root, { maxBytes: 4096, signal })
    if (conflicts.stdout.trim()) throw new Error("Refusing to restore while unmerged conflicts exist")
    yield* mutate()
    const args = ["restore"]
    if (target === "staged") args.push("--staged")
    if (target === "both") args.push("--staged", "--worktree")
    if (paths.length === 0) args.push("--", ".")
    else args.push("--", ...paths)
    const result = yield* run(app, args, root, { signal })
    if (result.exitCode !== 0) throw new Error("git restore failed")
    return render(`<restored target="${target}" paths="${paths.length || "all"}">\n${yield* renderStatus()}\n</restored>`, { changed: true })
  }
  if (mode === "commit") {
    if (!input.message) throw new Error("commit mode requires message")
    const conflicts = yield* run(app, ["diff", "--name-only", "--diff-filter=U", "--cached"], root, { maxBytes: 4096, signal })
    if (conflicts.stdout.trim()) throw new Error("Refusing to commit while unmerged files are staged")
    const dry = yield* run(app, ["commit", "--dry-run"], root, { maxBytes, signal })
    const hasStaged = dry.stdout.includes("Changes to be committed") || !dry.stdout.includes("nothing to commit")
    if (!hasStaged && !input.allowEmpty) throw new Error("Nothing staged to commit")
    if (input.dryRun !== false) {
      return render(`<commit dry-run="true">\n${escapeXml(dry.stdout.trim() || "(would commit staged changes)")}\n</commit>\nRe-run with dryRun:false and confirm:"COMMIT" to apply.`)
    }
    requireConfirm("COMMIT", input.confirm, "Committing")
    yield* mutate()
    const args = ["commit", "-m", input.message]
    if (input.allowEmpty) args.push("--allow-empty")
    if (!input.sign) args.push("--no-gpg-sign")
    const result = yield* run(app, args, root, { signal })
    if (result.exitCode !== 0) throw new Error("git commit failed")
    const echo = yield* run(app, ["log", "-1", "--oneline"], root, { maxBytes: 4096, signal })
    const hash = echo.stdout.trim()
    return render(`<commit applied="true">\n  <commit>${escapeXml(hash)}</commit>\n${yield* renderStatus()}\n</commit>`, {
      changed: true,
      commit: hash,
    })
  }
  if (mode === "shell") {
    const argv = input.argv ?? []
    validateShell(argv)
    const result = yield* run(app, argv, root, { maxBytes, signal })
    const output = result.stdout.trim() || result.stderr.trim() || "(no output)"
    return {
      ...render(`<git-shell argv="${escapeXml(argv.join(" "))}" exit="${result.exitCode}">\n${escapeXml(output)}\n</git-shell>`),
      metadata: { mode, ok: result.exitCode === 0, exitCode: result.exitCode, truncated: result.truncated },
    }
  }
  throw new Error(`Unsupported Git mode: ${mode}`)
})

export const execute = (
  app: AppProcess.Interface,
  input: Input,
  root: string,
  signal?: AbortSignal,
  beforeMutation?: BeforeMutation,
) =>
  executeRaw(app, input, root, signal, beforeMutation).pipe(
    Effect.catchCause((cause) => {
      const failure = Cause.findErrorOption(cause)
      if (Option.isSome(failure)) return Effect.fail(failure.value)
      return Effect.fail(new Error(Cause.pretty(cause)))
    }),
  )

export * as GitTyped from "./typed"
