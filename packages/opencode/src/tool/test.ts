import { Effect, Fiber, Schema, Stream } from "effect"
import path from "path"
import fs from "node:fs/promises"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as Tool from "./tool"
import { InstanceState } from "@/effect/instance-state"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Entry } from "@opencode-ai/core/filesystem"
import * as Truncate from "./truncate"
import { TRUNCATION_DIR } from "./truncation-dir"
import { ToolID } from "./schema"
import { TestScope } from "./test-scope"
import DESCRIPTION from "./test.txt"

export const Parameters = Schema.Struct({
  action: Schema.optional(Schema.Literals(["run", "list"])).annotate({
    description:
      "What to do (default run). run = execute tests; list = enumerate test files (and names when the harness supports it cheaply).",
  }),
  path: Schema.optional(Schema.String).annotate({
    description: "Filter: file or directory to run/list (relative). Default: harness default scope.",
  }),
  testNamePattern: Schema.optional(Schema.String).annotate({
    description:
      "Filter: test-name pattern (regex or substring per harness; mapped per harness: -t for bun/jest/vitest, --test-name-pattern for node:test, --grep for mocha, -g for playwright, --match for ava).",
  }),
  runtime: Schema.optional(Schema.Literals(["auto", "bun", "node"])).annotate({
    description: "Runtime (default auto: prefer the repo's runtime). Explicit value forces the runner.",
  }),
  timeoutMs: Schema.optional(Schema.Int).annotate({
    description: "Hard timeout for the run (default 120000; max 600000). On expiry the child is killed.",
  }),
  full: Schema.optional(Schema.Boolean).annotate({
    description: "Always spill the full output to a file and report the path (default: spill only on truncation/failure).",
  }),
})

type Metadata = {
  action: string
  harness: string
  runtime: string
  status: string
  exit: number | null
  durationMs: number
  passed: number
  failed: number
  skipped: number
  parsed: boolean
  partial: boolean
  truncated: boolean
  outputPath?: string
  files?: number
}

const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

// Bounded tail ring (last TAIL_LINES / TAIL_BYTES) for the output tail render.
const TAIL_LINES = 400
const TAIL_BYTES = 64 * 1024
const MAX_FAILURES = 50
const LIST_FILE_CAP = 500
// In-memory capture cap: beyond this the full output lives only in the spill
// file and parsing reads the file back.
const FULL_CAP = 4 * 1024 * 1024

function humanize(ms: number | undefined): string {
  if (ms === undefined) return "?s"
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// Render a path relative to the worktree (or the project directory when the
// worktree is a root like "/", e.g. non-git dirs), posix-ified.
function displayRel(abs: string, worktree: string, directory: string): string {
  if (worktree !== "/" && worktree !== path.parse(abs).root) {
    const r = path.relative(worktree, abs)
    if (!r.startsWith("..") && !path.isAbsolute(r)) return r.split(path.sep).join("/")
  }
  const r = path.relative(directory, abs)
  if (!r.startsWith("..") && !path.isAbsolute(r)) return r.split(path.sep).join("/")
  return abs
}

function tailRing(raw: string, maxLines: number, maxBytes: number): string {
  const lines = raw.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(raw, "utf-8") <= maxBytes) return raw
  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i]!, "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) break
    out.unshift(lines[i]!)
    bytes += size
  }
  return out.join("\n")
}

// Per-harness default globs for `list` (design §6.7). Config include/testMatch
// overrides are probed first (see testGlobsFor).
const DEFAULT_GLOBS: Record<string, string[]> = {
  bun: ["**/*.{test,spec}.{ts,tsx,js,mjs,cjs}", "**/test/**/*.{ts,tsx,js,mjs,cjs}"],
  vitest: ["**/*.{test,spec}.?(c|m)[jt]s?(x)"],
  jest: ["**/__tests__/**/*.[jt]s?(x)", "**/?(*.)+(spec|test).[jt]s?(x)"],
  node: ["**/*.test.{js,mjs,cjs}", "**/test-*.{js,mjs,cjs}", "**/test.{js,mjs,cjs}", "**/test/**/*.{js,mjs,cjs}"],
  mocha: ["**/*.test.{js,cjs,mjs}", "**/test/**/*.{js,cjs,mjs}"],
  ava: ["**/*.test.{js,mjs,cjs}", "**/test/**/*.{js,mjs,cjs}"],
  playwright: ["**/*.@(spec|test).?(c|m)[jt]s?(x)"],
}

// Best-effort: extract string-literal array items like `include: ["a", "b"]`
// or `testMatch: ["x", "y"]` from a config file's text.
function arrayLiterals(text: string, key: string): string[] | undefined {
  const re = new RegExp(`${key}\\s*:\\s*\\[([^\\]]*)\\]`)
  const match = re.exec(text)
  if (!match) return undefined
  const items = [...match[1]!.matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!)
  return items.length > 0 ? items : undefined
}

// Resolve test-file globs for a harness, honoring config include/testMatch
// when parseable (design §6.7). Falls back to defaults.
async function testGlobsFor(harness: string, dir: string): Promise<string[]> {
  const fs = await import("node:fs/promises")
  if (harness === "vitest") {
    for (const name of ["vitest.config.mjs", "vitest.config.js", "vitest.config.mts", "vitest.config.ts"]) {
      const text = await fs.readFile(path.join(dir, name), "utf8").catch(() => undefined)
      if (text !== undefined) {
        const include = arrayLiterals(text, "include")
        if (include) return include
      }
    }
  }
  if (harness === "jest") {
    const json = await fs.readFile(path.join(dir, "jest.config.json"), "utf8").catch(() => undefined)
    if (json !== undefined) {
      try {
        const testMatch = (JSON.parse(json) as { testMatch?: string[] }).testMatch
        if (testMatch?.length) return testMatch
      } catch {
        // fall through to regex probe
      }
    }
    for (const name of ["jest.config.mjs", "jest.config.js", "jest.config.ts"]) {
      const text = await fs.readFile(path.join(dir, name), "utf8").catch(() => undefined)
      if (text !== undefined) {
        const testMatch = arrayLiterals(text, "testMatch")
        if (testMatch) return testMatch
      }
    }
  }
  return DEFAULT_GLOBS[harness] ?? DEFAULT_GLOBS.node!
}

export const TestTool = Tool.define<
  typeof Parameters,
  Metadata,
  ChildProcessSpawner | Ripgrep.Service | Truncate.Service
>(
  "test",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    const rg = yield* Ripgrep.Service
    const trunc = yield* Truncate.Service

    // Incremental spill: every streamed chunk is appended to a per-run file in
    // the truncation dir so a timeout/kill still leaves the full output. The
    // caller decides whether to keep (report) or delete it.
    const openSpill = Effect.fn("TestTool.openSpill")(function* () {
      const file = path.join(TRUNCATION_DIR, ToolID.ascending())
      yield* Effect.promise(() => fs.mkdir(TRUNCATION_DIR, { recursive: true }))
      return file
    })

    const removeSpill = Effect.fn("TestTool.removeSpill")(function* (file: string) {
      yield* Effect.promise(() => fs.rm(file, { force: true })).pipe(Effect.catch(() => Effect.void))
    })

    const renderFailures = (failures: TestScope.TestCase[], worktree: string, directory: string) => {
      const capped = failures.slice(0, MAX_FAILURES)
      const rows = capped.map((f) => {
        const relFile =
          f.file && path.isAbsolute(f.file) ? displayRel(f.file, worktree, directory) : f.file
        const attrs = [
          relFile ? `file="${escapeXml(relFile)}"` : "",
          f.line ? `line="${f.line}"` : "",
          `name="${escapeXml(f.fullName)}"`,
          f.assertion ? `detail="${escapeXml(f.assertion.slice(0, 160))}"` : "",
        ]
          .filter(Boolean)
          .join(" ")
        return `    <failure ${attrs} />`
      })
      if (failures.length > MAX_FAILURES) {
        rows.push(`    <next>… ${failures.length - MAX_FAILURES} more failures — see fullOutput</next>`)
      }
      return rows.join("\n")
    }

    const runAction = Effect.fn("TestTool.runAction")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
      instance: { directory: string; worktree: string },
    ) {
      const directory = instance.directory
      const worktree = instance.worktree
      const timeoutMs = Math.min(params.timeoutMs ?? 120_000, 600_000)
      const limits = yield* trunc.limits()

      // Path filter: resolve + worktree-bound guard, but pass the path to the
      // runner as-is (relative to the run cwd).
      let relPath: string | undefined
      if (params.path) {
        const abs = path.resolve(directory, params.path)
        const rel = path.relative(worktree, abs)
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          throw new Error(`Refusing to run tests outside the worktree: ${params.path}`)
        }
        relPath = params.path.split(path.sep).join("/")
      }

      const detected = yield* Effect.promise(() => TestScope.detectHarness(directory, worktree))
      if (!detected) {
        throw new Error(
          `No test harness detected in ${path.relative(worktree, directory) || "."} (checked package.json test script + dependencies + config files). Run the repo's tests via the shell tool (e.g. \`npm test\`).`,
        )
      }
      const harness = detected.harness

      const command = yield* Effect.promise(() =>
        TestScope.buildCommand({
          harness,
          dir: directory,
          path: relPath,
          filter: params.testNamePattern,
          runtime: params.runtime,
        }),
      )
      const commandText = `${command.bin} ${command.args.join(" ")}`

      yield* ctx.ask({
        permission: "test",
        patterns: [commandText],
        always: [commandText],
        metadata: {
          harness,
          runtime: params.runtime ?? "auto",
          path: params.path,
          testNamePattern: params.testNamePattern,
          command: commandText,
        },
      })

      const spill = yield* openSpill()
      const started = Date.now()
      let full = ""
      let expired = false
      let aborted = false
      let exitCode: number | null = null
      let fileBytes = 0

      const code = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make(command.bin, command.args, {
              cwd: command.cwd,
              env: { ...process.env, ...command.env },
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
            }),
          )

          const streamFiber = yield* Effect.forkScoped(
            Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
              Effect.promise(async () => {
                if (full.length < FULL_CAP) full += chunk
                await fs.appendFile(spill, chunk, "utf8").catch(() => undefined)
                fileBytes += Buffer.byteLength(chunk, "utf-8")
              }),
            ),
          )

          const abort = Effect.callback<void>((resume) => {
            if (ctx.abort.aborted) return resume(Effect.void)
            const handler = () => resume(Effect.void)
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          })

          const exit = yield* Effect.raceAll([
            handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
            abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
            Effect.sleep(`${timeoutMs + 100} millis`).pipe(
              Effect.map(() => ({ kind: "timeout" as const, code: null })),
            ),
          ])

          if (exit.kind === "abort") {
            aborted = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }
          if (exit.kind === "timeout") {
            expired = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }

          // The stream fiber may still be draining buffered output when
          // exitCode resolves — join it (bounded) so nothing is lost.
          yield* Fiber.join(streamFiber).pipe(Effect.timeout("2 seconds")).pipe(Effect.ignore)
          return exit.kind === "exit" ? exit.code : null
        }),
      ).pipe(Effect.orDie)
      exitCode = code

      const durationMs = Date.now() - started

      // Parse from the in-memory capture when it fits, else read the spill
      // file back (it always holds the complete output).
      const raw =
        full.length < FULL_CAP
          ? full
          : (yield* Effect.promise(() => fs.readFile(spill, "utf8").catch(() => "")))

      // vitest/playwright probe: reporter JSON may have gone to --outputFile.
      let parseSource = raw
      if (command.outputFile) {
        const fileText = yield* Effect.promise(() =>
          fs.readFile(command.outputFile!, "utf8").catch(() => undefined),
        )
        if (fileText !== undefined) {
          parseSource = fileText
          yield* Effect.promise(() => fs.rm(command.outputFile!, { force: true })).pipe(Effect.catch(() => Effect.void))
        }
      }

      const summary = TestScope.parseReporter(parseSource, harness, exitCode ?? 1)
      const failedSignal = summary.failed > 0 || (summary.parsed === false && (exitCode ?? 1) !== 0)
      const status = expired ? "timed-out" : aborted ? "aborted" : failedSignal ? "failed" : "passed"

      const keepSpill =
        params.full ||
        status !== "passed" ||
        summary.parsed === false ||
        fileBytes > limits.maxBytes

      const spillPath = keepSpill ? spill : yield* removeSpill(spill).pipe(Effect.as(undefined))

      const tail = tailRing(raw, Math.min(limits.maxLines, TAIL_LINES), Math.min(limits.maxBytes, TAIL_BYTES))
      const showTail = status !== "passed" || summary.parsed === false

      const failuresXml = summary.failures.length > 0 ? renderFailures(summary.failures, worktree, directory) : ""

      const relPathNote = relPath ? ` Re-run with path=${relPath}${params.testNamePattern ? ` -t ${params.testNamePattern}` : ""} to narrow.` : ""
      const next =
        status === "passed"
          ? "All tests passed."
          : summary.failed > 0
            ? `Fix failures first (${summary.failed}).${relPathNote}`
            : expired
              ? `Run timed out after ${timeoutMs} ms — the child was killed; output may be partial. Increase timeoutMs or narrow with path=/testNamePattern.`
              : aborted
                ? "Run aborted by the user."
                : "See fullOutput for details."

      const attrs = [
        `harness="${harness}"`,
        `runtime="${params.runtime ?? "auto"}"`,
        `status="${status}"`,
        `exit="${exitCode ?? 1}"`,
        `duration="${humanize(durationMs)}"`,
        `passed="${summary.passed}"`,
        `failed="${summary.failed}"`,
        `skipped="${summary.skipped}"`,
        `partial="${expired || aborted}"`,
        `parsed="${summary.parsed}"`,
      ].join(" ")

      const lines = [
        `<test-run ${attrs}>`,
        `  <summary>${summary.passed} passed / ${summary.failed} failed / ${summary.skipped} skipped (${humanize(durationMs)})</summary>`,
        ...(summary.failures.length > 0
          ? [`  <failures count="${summary.failures.length}">`, failuresXml, "  </failures>"]
          : []),
        ...(showTail && tail.trim()
          ? [`  <tail lines="${tail.split("\n").length}">${escapeXml(tail.slice(0, 8_000))}</tail>`]
          : []),
        ...(spillPath ? [`  <fullOutput path="${escapeXml(spillPath)}" />`] : []),
        `  <next>${escapeXml(next)}</next>`,
        "</test-run>",
      ]

      return {
        title: `test run (${harness})`,
        output: lines.join("\n"),
        metadata: {
          action: "run",
          harness,
          runtime: params.runtime ?? "auto",
          status,
          exit: exitCode,
          durationMs,
          passed: summary.passed,
          failed: summary.failed,
          skipped: summary.skipped,
          parsed: summary.parsed,
          partial: expired || aborted,
          truncated: keepSpill,
          ...(spillPath ? { outputPath: spillPath } : {}),
        } satisfies Metadata,
      }
    })

    const listAction = Effect.fn("TestTool.listAction")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
      instance: { directory: string; worktree: string },
    ) {
      const directory = instance.directory
      const worktree = instance.worktree

      let relPath: string | undefined
      if (params.path) {
        const abs = path.resolve(directory, params.path)
        const rel = path.relative(worktree, abs)
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          throw new Error(`Refusing to list tests outside the worktree: ${params.path}`)
        }
        relPath = params.path.split(path.sep).join("/")
      }

      const detected = yield* Effect.promise(() => TestScope.detectHarness(directory, worktree))
      if (!detected) {
        throw new Error(
          `No test harness detected in ${path.relative(worktree, directory) || "."} (checked package.json test script + dependencies + config files).`,
        )
      }
      const harness = detected.harness
      const commandText = `test list (${harness}) — no execution`
      yield* ctx.ask({
        permission: "test",
        patterns: [commandText],
        always: [commandText],
        metadata: { harness, runtime: params.runtime ?? "auto", path: params.path, command: commandText },
      })

      const globs = yield* Effect.promise(() => testGlobsFor(harness, directory))
      const found = new Set<string>()
      let truncated = false
      for (const glob of globs) {
        const pattern = relPath ? `${relPath}/${glob}` : glob
        const entries = yield* rg
          .find({ cwd: directory, pattern, limit: LIST_FILE_CAP + 1 })
          .pipe(Effect.catch(() => Effect.succeed([] as Entry[])))
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
      const rel = (p: string) => displayRel(path.join(directory, p), worktree, directory)
      const rows = files.map((p) => `  <file path="${escapeXml(rel(p))}" />`)
      const more = truncated ? `\n  … (more than ${LIST_FILE_CAP} files)` : ""

      const lines = [
        `<test-list harness="${harness}" files="${files.length}" names="?">`,
        ...rows,
        ...(more ? [more] : []),
        `  <next>names from config/manifests; exact names require a run (action=run). Files respect harness include/testMatch + .gitignore.</next>`,
        "</test-list>",
      ]

      return {
        title: `test list (${harness})`,
        output: lines.join("\n"),
        metadata: {
          action: "list",
          harness,
          runtime: params.runtime ?? "auto",
          status: "passed",
          exit: 0,
          durationMs: 0,
          passed: 0,
          failed: 0,
          skipped: 0,
          parsed: true,
          partial: false,
          truncated,
          files: files.length,
        } satisfies Metadata,
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const action = params.action ?? "run"
          if (action === "list") {
            return yield* listAction(params, ctx, {
              directory: instance.directory,
              worktree: instance.worktree,
            })
          }
          return yield* runAction(params, ctx, {
            directory: instance.directory,
            worktree: instance.worktree,
          })
        }).pipe(Effect.orDie),
    }
  }),
)
