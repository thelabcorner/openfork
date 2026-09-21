export * as ExchangeTest from "./test"

import path from "node:path"
import { Effect } from "effect"
import type { Schema } from "effect"
import type { FSUtil } from "@opencode-ai/core/fs-util"
import type { Ripgrep } from "@opencode-ai/core/ripgrep"
import { TestScope } from "@/tool/test-scope"
import { ExchangeError } from "./error"
import { ExchangeOwnedCommand } from "./owned-command"

const LIST_FILE_CAP = 500
const TAIL_BYTES = 64 * 1024
const FULL_TAIL_BYTES = 256 * 1024
const TAIL_LINES = 400
const MAX_FAILURES = 50

export const Parameters = TestScope.Parameters
export type Input = Schema.Schema.Type<typeof Parameters>

export interface Workspace {
  readonly rootPath: string
  readonly directory: string
  readonly rootWorkdir: string
  readonly virtualDirectory: string
  readonly alias: string
}

export interface Dependencies {
  readonly fs: FSUtil.Interface
  readonly rg: Ripgrep.Interface
}

export interface Hooks<E> {
  /** Canonicalize/prove one existing absolute path remains inside authority. */
  readonly authorizePath: (absolutePath: string) => Effect.Effect<string, ExchangeError.Error | E>
  readonly run: (
    input: Omit<ExchangeOwnedCommand.Input, "workdir"> & { readonly cwd: string },
  ) => Effect.Effect<ExchangeOwnedCommand.Result, E>
  readonly revalidate: () => Effect.Effect<void, ExchangeError.Error | E>
}

export interface Result {
  readonly title: string
  readonly output: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly mutation: { readonly attempted: boolean; readonly committed: boolean }
}

const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

const duration = (ms: number | undefined) => {
  if (ms === undefined) return "?s"
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function tailRing(raw: string, maxBytes: number) {
  const lines = raw.split("\n")
  if (lines.length <= TAIL_LINES && Buffer.byteLength(raw, "utf8") <= maxBytes) return raw
  const out: string[] = []
  let bytes = 0
  for (let index = lines.length - 1; index >= 0 && out.length < TAIL_LINES; index--) {
    const line = lines[index]!
    const size = Buffer.byteLength(line, "utf8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) break
    out.unshift(line)
    bytes += size
  }
  return out.join("\n")
}

function relativeInside(base: string, target: string) {
  const rel = path.relative(base, target)
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined
  return rel === "" ? "." : rel.split(path.sep).join("/")
}

function virtualize(text: string, rootPath: string, alias: string) {
  const virtual = `/${alias}`
  const variants = new Set([rootPath, rootPath.replaceAll("\\", "/"), rootPath.replaceAll("/", "\\")])
  let next = text
  for (const candidate of variants) if (candidate) next = next.split(candidate).join(virtual)
  return next
}

const detect = Effect.fn("ExchangeTest.detect")(function* (directory: string, rootPath: string) {
  const detected = yield* Effect.tryPromise({
    try: () => TestScope.detectHarness(directory, rootPath),
    catch: () => new ExchangeError.DependencyUnavailable({ detail: "Unable to inspect the test harness" }),
  })
  if (!detected) {
    return yield* new ExchangeError.InvalidArgument({
      detail: "No test harness detected in the selected workdir (checked package.json test script, dependencies, and config files)",
    })
  }
  return detected
})

const validateFilter = Effect.fn("ExchangeTest.validateFilter")(function* <E>(
  workspace: Workspace,
  hooks: Hooks<E>,
  filter?: string,
) {
  if (!filter) return undefined
  if (path.isAbsolute(filter)) {
    return yield* new ExchangeError.InvalidArgument({ detail: "test path filter must be relative to workdir" })
  }
  if (filter.replaceAll("\\", "/").split("/").includes("..")) {
    return yield* new ExchangeError.PathEscape({ detail: "test path filter may not contain parent traversal" })
  }
  const target = path.resolve(workspace.directory, filter)
  const canonical = yield* hooks.authorizePath(target)
  const inRoot = relativeInside(workspace.rootPath, canonical)
  if (inRoot === undefined) return yield* new ExchangeError.PathEscape({ detail: "test path filter escapes the approved root" })
  const inWorkdir = path.relative(workspace.directory, canonical)
  if (inWorkdir.startsWith("..") || path.isAbsolute(inWorkdir)) {
    return yield* new ExchangeError.PathEscape({ detail: "test path filter escapes the selected workdir" })
  }
  return inWorkdir === "" ? "." : inWorkdir.split(path.sep).join("/")
})

export function execute<E>(
  deps: Dependencies,
  workspace: Workspace,
  input: Input,
  hooks: Hooks<E>,
  signal?: AbortSignal,
): Effect.Effect<Result, ExchangeError.Error | E> {
  return Effect.gen(function* () {
    if (signal?.aborted) return yield* new ExchangeError.Cancelled({ detail: "Test request was cancelled" })
    const action = input.action ?? "run"
    const relPath = yield* validateFilter(workspace, hooks, input.path)
    const detected = yield* detect(workspace.directory, workspace.rootPath)

    if (action === "list") {
      const globs = yield* Effect.tryPromise({
        try: () => TestScope.testGlobsFor(detected.harness, workspace.directory),
        catch: () => new ExchangeError.DependencyUnavailable({ detail: "Unable to resolve test-file globs" }),
      })
      const found = new Set<string>()
      let truncated = false
      for (const glob of globs) {
        if (signal?.aborted) return yield* new ExchangeError.Cancelled({ detail: "Test listing was cancelled" })
        const pattern = relPath && relPath !== "." ? `${relPath}/${glob}` : glob
        const entries = yield* deps.rg.find({ cwd: workspace.directory, pattern, signal, limit: LIST_FILE_CAP + 1 }).pipe(
          Effect.catch(() => Effect.succeed([])),
        )
        for (const entry of entries) {
          if (found.size >= LIST_FILE_CAP) {
            truncated = true
            break
          }
          found.add(entry.path)
        }
        if (truncated) break
      }
      const files = [...found].toSorted()
      yield* hooks.revalidate()
      return {
        title: `test list (${detected.harness})`,
        output: [
          `<test-list harness="${detected.harness}" files="${files.length}" names="?" workdir="${escapeXml(workspace.virtualDirectory)}">`,
          ...files.map((file) => `  <file path="${escapeXml(file.split(path.sep).join("/"))}" />`),
          ...(truncated ? [`  <next>More than ${LIST_FILE_CAP} files matched; narrow path.</next>`] : []),
          "  <next>Exact test names require action=run; file discovery respects the harness config and .gitignore.</next>",
          "</test-list>",
        ].join("\n"),
        metadata: {
          action: "list",
          harness: detected.harness,
          runtime: input.runtime ?? "auto",
          status: "passed",
          files: files.length,
          truncated,
          workdir: workspace.rootWorkdir,
        },
        mutation: { attempted: false, committed: false },
      }
    }

    const command = yield* Effect.tryPromise({
      try: () =>
        TestScope.buildCommand({
          harness: detected.harness,
          dir: workspace.directory,
          path: relPath,
          filter: input.testNamePattern,
          runtime: input.runtime,
        }),
      catch: (error) =>
        new ExchangeError.InvalidArgument({
          detail: error instanceof Error ? error.message : "Unable to build the test command",
        }),
    })
    const commandWorkdir = relativeInside(workspace.rootPath, command.cwd)
    if (commandWorkdir === undefined) {
      return yield* new ExchangeError.PathEscape({ detail: "Resolved test command workdir escapes the approved root" })
    }

    const startedAt = Date.now()
    const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 120_000, 100), 600_000)
    const reporterFile =
      command.outputFile && relativeInside(workspace.rootPath, command.outputFile) !== undefined
        ? command.outputFile
        : undefined
    const cleanupReporter = () => reporterFile ? deps.fs.remove(reporterFile).pipe(Effect.ignore) : Effect.void
    const ran = yield* hooks.run({
      cwd: command.cwd,
      argv: [command.bin, ...command.args],
      env: { ...process.env, ...command.env },
      title: `test run (${detected.harness})`,
      operation: "test.run",
      timeoutMs,
      outputCapBytes: ExchangeOwnedCommand.DEFAULT_OUTPUT_CAP_BYTES,
      signal,
    }).pipe(Effect.tapError(() => cleanupReporter()))
    const durationMs = Date.now() - startedAt
    const captured = ran.stdout + (ran.stderr ? `\n${ran.stderr}` : "")

    let parseSource = captured
    if (reporterFile) {
      const outputRel = relativeInside(workspace.rootPath, reporterFile)
      if (outputRel !== undefined) {
        const fileText = yield* deps.fs.readFileStringSafe(reporterFile).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (fileText !== undefined) parseSource = fileText
        yield* cleanupReporter()
      }
    }

    const exitCode = ran.timedOut ? null : (ran.exitCode ?? 1)
    const summary = TestScope.parseReporter(parseSource, detected.harness, exitCode ?? 1)
    const failedSignal = summary.failed > 0 || (!summary.parsed && (exitCode ?? 1) !== 0)
    const status = ran.timedOut ? "timed-out" : failedSignal ? "failed" : "passed"
    const virtualizedRaw = virtualize(captured, workspace.rootPath, workspace.alias)
    const tail = tailRing(virtualizedRaw, input.full ? FULL_TAIL_BYTES : TAIL_BYTES)
    const showTail = input.full === true || status !== "passed" || !summary.parsed
    const failureRows = summary.failures.slice(0, MAX_FAILURES).map((failure) => {
      let file = failure.file
      if (file && path.isAbsolute(file)) {
        const rel = relativeInside(workspace.rootPath, file)
        file = rel === undefined ? path.basename(file) : rel
      }
      return `    <failure${file ? ` file="${escapeXml(file.split(path.sep).join("/"))}"` : ""}${failure.line ? ` line="${failure.line}"` : ""} name="${escapeXml(failure.fullName)}"${failure.assertion ? ` detail="${escapeXml(virtualize(failure.assertion.slice(0, 160), workspace.rootPath, workspace.alias))}"` : ""} />`
    })

    yield* hooks.revalidate()
    const output = [
      `<test-run harness="${detected.harness}" runtime="${input.runtime ?? "auto"}" status="${status}" exit="${exitCode ?? 1}" duration="${duration(durationMs)}" passed="${summary.passed}" failed="${summary.failed}" skipped="${summary.skipped}" partial="${ran.timedOut}" parsed="${summary.parsed}" truncated="${ran.truncated}">`,
      `  <summary>${summary.passed} passed / ${summary.failed} failed / ${summary.skipped} skipped (${duration(durationMs)})</summary>`,
      ...(failureRows.length
        ? [
            `  <failures count="${summary.failures.length}">`,
            ...failureRows,
            ...(summary.failures.length > MAX_FAILURES
              ? [`    <next>${summary.failures.length - MAX_FAILURES} more failures omitted.</next>`]
              : []),
            "  </failures>",
          ]
        : []),
      ...(showTail && tail.trim() ? [`  <tail lines="${tail.split("\n").length}">${escapeXml(tail)}</tail>`] : []),
      `  <next>${status === "passed" ? "All selected tests passed." : ran.timedOut ? `Run timed out after ${timeoutMs} ms and the owned process tree was retired.` : "Fix the reported failures, then re-run the narrowest relevant scope."}</next>`,
      "</test-run>",
    ].join("\n")

    return {
      title: `test run (${detected.harness})`,
      output,
      metadata: {
        action: "run",
        harness: detected.harness,
        runtime: input.runtime ?? "auto",
        status,
        exit: exitCode,
        durationMs,
        passed: summary.passed,
        failed: summary.failed,
        skipped: summary.skipped,
        parsed: summary.parsed,
        partial: ran.timedOut,
        truncated: ran.truncated,
        workdir: workspace.rootWorkdir,
      },
      mutation: { attempted: true, committed: true },
    }
  })
}

