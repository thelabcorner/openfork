import { Effect, Stream } from "effect"
import { Duration } from "effect"
import os from "os"
import { createWriteStream } from "node:fs"
import * as Tool from "./tool"
import path from "path"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { FSUtil } from "@opencode-ai/core/fs-util"
import { fileURLToPath } from "url"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell } from "@opencode-ai/core/shell"
import { ShellID } from "./shell/id"

import * as Truncate from "./truncate"
import { TRUNCATION_DIR } from "./truncation-dir"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import type { CommandInput, StdinConfig } from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ShellPrompt, type Parameters } from "./shell/prompt"
import { BashArity } from "@/permission/arity"
import { BackgroundJob } from "@/background/job"
import { ShellJobs, jobLogPath, jobMetaPath } from "@/background/shell-jobs"
import { Identifier } from "@/id/id"
import type { TaskPromptOps } from "./task"
import { Scope } from "effect"

export { Parameters } from "./shell/prompt"

const MAX_METADATA_LENGTH = 30_000
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const CMD_FILES = new Set([
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

type Chunk = {
  text: string
  size: number
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean, cmd = false) {
  if (!ps) {
    return list
      .slice(1)
      .filter(
        (item) =>
          !item.text.startsWith("-") &&
          !(cmd && item.text.startsWith("/")) &&
          !(list[0]?.text === "chmod" && item.text.startsWith("+")),
      )
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
    }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    text: out.join("\n"),
    cut: true,
  }
}

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

const escapeXML = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

type BackgroundMeta = {
  jobId: string
  command: string
  logPath: string
  notify: boolean
  timeoutMs?: number
}

function renderRunning(meta: BackgroundMeta) {
  return [
    `<background_shell job="${meta.jobId}" state="running">`,
    `<summary>Background command started: ${escapeXML(meta.command)}</summary>`,
    `<command>${escapeXML(meta.command)}</command>`,
    meta.notify
      ? "You will be notified when it finishes."
      : "Notify is off; check on it with the `background` tool.",
    `Use the \`background\` tool with id \`${meta.jobId}\` to: status, read, wait, send, kill.`,
    `Full output streams to: ${meta.logPath}`,
    "</background_shell>",
  ].join("\n")
}

function renderCompleted(meta: BackgroundMeta, preview: string, exit: number | null) {
  return [
    `<background_shell job="${meta.jobId}" state="completed" exit="${exit ?? 0}">`,
    `<summary>Background command completed: ${escapeXML(meta.command)}</summary>`,
    `<command>${escapeXML(meta.command)}</command>`,
    "<preview>",
    preview || "(no output)",
    "</preview>",
    `Full output: ${meta.logPath}`,
    "</background_shell>",
  ].join("\n")
}

function renderError(meta: BackgroundMeta, error: string, preview: string, exit: number | null) {
  return [
    `<background_shell job="${meta.jobId}" state="error" exit="${exit ?? 1}">`,
    `<summary>Background command failed: ${escapeXML(meta.command)}</summary>`,
    `<command>${escapeXML(meta.command)}</command>`,
    `<error>${error}</error>`,
    "<preview>",
    preview || "(no output)",
    "</preview>",
    `Full output: ${meta.logPath}`,
    "</background_shell>",
  ].join("\n")
}

function renderTimeout(meta: BackgroundMeta, preview: string) {
  return [
    `<background_shell job="${meta.jobId}" state="cancelled" reason="timeout">`,
    `<summary>Background command timed out after ${meta.timeoutMs} ms: ${escapeXML(meta.command)}</summary>`,
    `<command>${escapeXML(meta.command)}</command>`,
    `<error>Killed after exceeding the explicit timeout of ${meta.timeoutMs} ms.</error>`,
    "<preview>",
    preview || "(no output)",
    "</preview>",
    `Full output: ${meta.logPath}`,
    "</background_shell>",
  ].join("\n")
}

const ask = Effect.fn("ShellTool.ask")(function* (ctx: Tool.Context, scan: Scan, input: { command: string }) {
  if (scan.dirs.size > 0) {
    const directories = Array.from(scan.dirs)
    const globs = directories.map((dir) => {
      if (process.platform === "win32") return FSUtil.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {
        command: input.command,
        directories,
        patterns: globs,
      },
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: ShellID.ToolID,
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {
      command: input.command,
    },
  })
})

function cmd(
  shell: string,
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdin: CommandInput | StdinConfig = "ignore",
  options: { forceKillAfter?: Duration.Input } = {},
) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin,
      detached: false,
      ...options,
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin,
    detached: process.platform !== "win32",
    ...options,
  })
}
const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* FSUtil.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const flags = yield* RuntimeFlags.Service
    const background = yield* BackgroundJob.Service
    const jobs = yield* ShellJobs.Service
    const scope = yield* Scope.Scope
    const defaultTimeoutMs = flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000

    const cygpath = Effect.fn("ShellTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return FSUtil.normalizePath(file)
    })

    const resolvePath = Effect.fn("ShellTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && FSUtil.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return FSUtil.normalizePath(path.resolve(root, FSUtil.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const argPath = Effect.fn("ShellTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePath(next, cwd, shell)
    })

    const collect = Effect.fn("ShellTool.collect")(function* (
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
      instance: InstanceContext,
    ) {
      const scan: Scan = {
        dirs: new Set<string>(),
        patterns: new Set<string>(),
        always: new Set<string>(),
      }
      const shellKind = ShellID.toKind(Shell.name(shell))

      for (const node of commands(root)) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        const cmd = ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]

        if (cmd && (FILES.has(cmd) || (shellKind === "cmd" && CMD_FILES.has(cmd)))) {
          for (const arg of pathArgs(command, ps, shellKind === "cmd")) {
            const resolved = yield* argPath(arg, cwd, ps, shell)
            yield* Effect.logInfo("resolved path", { arg, resolved })
            if (!resolved || containsPath(resolved, instance)) continue
            const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
            scan.dirs.add(dir)
          }
        }

        if (tokens.length && (!cmd || !CWD.has(cmd))) {
          scan.patterns.add(source(node))
          scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }
      }

      return scan
    })

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      return {
        ...process.env,
        ...extra.env,
      }
    })

    const run = Effect.fn("ShellTool.run")(function* (
      input: {
        shell: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        timeout: number
      },
      ctx: Tool.Context,
    ) {
      const limits = yield* trunc.limits()
      const keep = limits.maxBytes * 2
      let full = ""
      let last = ""
      const list: Chunk[] = []
      let used = 0
      let file = ""
      let sink: ReturnType<typeof createWriteStream> | undefined
      let cut = false
      let expired = false
      let aborted = false
      const startedAt = Date.now()

      const closeSink = Effect.fnUntraced(function* () {
        const stream = sink
        if (!stream) return
        sink = undefined
        if (stream.destroyed || stream.closed) return
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              let settled = false
              const done = () => {
                if (settled) return
                settled = true
                stream.off("close", done)
                stream.off("error", done)
                stream.off("finish", done)
                resolve()
              }
              stream.once("close", done)
              stream.once("error", done)
              stream.once("finish", done)
              stream.end(done)
            }),
        ).pipe(Effect.catch(() => Effect.void))
      })

      yield* ctx.metadata({
        metadata: {
          output: "",
          timeout: input.timeout,
          startedAt,
        },
      })

      const code: number | null = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(closeSink)
          const handle = yield* spawner.spawn(cmd(input.shell, input.command, input.cwd, input.env))

          yield* Effect.forkScoped(
            Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
              const size = Buffer.byteLength(chunk, "utf-8")
              list.push({ text: chunk, size })
              used += size
              while (used > keep && list.length > 1) {
                const item = list.shift()
                if (!item) break
                used -= item.size
                cut = true
              }

              last = preview(last + chunk)

              if (file) {
                sink?.write(chunk)
              } else {
                full += chunk
                if (Buffer.byteLength(full, "utf-8") > limits.maxBytes) {
                  return trunc.write(full).pipe(
                    Effect.andThen((next) =>
                      Effect.sync(() => {
                        file = next
                        cut = true
                        sink = createWriteStream(next, { flags: "a" })
                        full = ""
                      }),
                    ),
                    Effect.andThen(
                      ctx.metadata({
                        metadata: {
                          output: last,
                          timeout: input.timeout,
                          startedAt,
                        },
                      }),
                    ),
                  )
                }
              }

              return ctx.metadata({
                metadata: {
                  output: last,
                  timeout: input.timeout,
                  startedAt,
                },
              })
            }),
          )

          const abort = Effect.callback<void>((resume) => {
            if (ctx.abort.aborted) return resume(Effect.void)
            const handler = () => resume(Effect.void)
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          })

          const timeout = Effect.sleep(`${input.timeout + 100} millis`)

          const exit = yield* Effect.raceAll([
            handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
            abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
            timeout.pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
          ])

          if (exit.kind === "abort") {
            aborted = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }
          if (exit.kind === "timeout") {
            expired = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }

          return exit.kind === "exit" ? exit.code : null
        }),
      ).pipe(Effect.orDie)

      const meta: string[] = []
      if (expired) {
        meta.push(
          `shell tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
        )
      }
      if (aborted) meta.push("User aborted the command")
      const raw = list.map((item) => item.text).join("")
      const end = tail(raw, limits.maxLines, limits.maxBytes)
      if (end.cut) cut = true
      if (!file && end.cut) {
        file = yield* trunc.write(raw)
      }

      let output = end.text
      if (!output) output = "(no output)"

      if (cut && file) {
        output = `...output truncated...\n\nFull output saved to: ${file}\n\n` + output
      }

      if (meta.length > 0) {
        output += "\n\n<shell_metadata>\n" + meta.join("\n") + "\n</shell_metadata>"
      }
      return {
        title: input.command,
        metadata: {
          output: last || preview(output),
          exit: code,
          truncated: cut,
          timeout: input.timeout,
          startedAt,
          endedAt: Date.now(),
          ...(cut && file ? { outputPath: file } : {}),
        },
        output,
      }
    })

    const inject = Effect.fn("ShellTool.injectBackgroundResult")(function* (ctx: Tool.Context, text: string) {
      const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
      if (!ops) return
      yield* ops
        .prompt({
          sessionID: ctx.sessionID,
          agent: ctx.agent,
          parts: [{ type: "text", synthetic: true, text }],
        })
        .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
    })

    const readLogTail = Effect.fn("ShellTool.readLogTail")(function* (logPath: string) {
      const limits = yield* trunc.limits()
      const text = yield* fs.readFileStringSafe(logPath)
      if (!text) return "(no output)"
      return tail(text, limits.maxLines, limits.maxBytes).text || "(no output)"
    })

    const runBackground = Effect.fn("ShellTool.runBackground")(function* (
      input: {
        shell: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        jobId: string
        logPath: string
        metaPath: string
        notify: boolean
        timeoutMs?: number
      },
      ctx: Tool.Context,
    ) {
      const limits = yield* trunc.limits()
      const keep = limits.maxBytes * 2
      const list: Chunk[] = []
      let used = 0
      let last = ""
      let sink: ReturnType<typeof createWriteStream> | undefined
      let timedOut = false

      const closeSink = Effect.fnUntraced(function* () {
        const stream = sink
        if (!stream) return
        sink = undefined
        if (stream.destroyed || stream.closed) return
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              let settled = false
              const done = () => {
                if (settled) return
                settled = true
                stream.off("close", done)
                stream.off("error", done)
                stream.off("finish", done)
                resolve()
              }
              stream.once("close", done)
              stream.once("error", done)
              stream.once("finish", done)
              stream.end(done)
            }),
        ).pipe(Effect.catch(() => Effect.void))
      })

      const meta: BackgroundMeta = {
        jobId: input.jobId,
        command: input.command,
        logPath: input.logPath,
        notify: input.notify,
        timeoutMs: input.timeoutMs,
      }

      const previewText = Effect.fnUntraced(function* () {
        const raw = list.map((item) => item.text).join("")
        const end = tail(raw, limits.maxLines, limits.maxBytes)
        return end.text || "(no output)"
      })

      const code: number | null = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(closeSink)
          sink = createWriteStream(input.logPath, { flags: "a" })
          const handle = yield* spawner.spawn(
            cmd(input.shell, input.command, input.cwd, input.env, { stream: "pipe", endOnDone: false }, {
              forceKillAfter: "3 seconds",
            }),
          )
          yield* jobs.register({
            id: input.jobId,
            handle,
            command: input.command,
            shell: input.shell,
            cwd: input.cwd,
            env: input.env,
            logPath: input.logPath,
            metaPath: input.metaPath,
            notify: input.notify,
            timeoutMs: input.timeoutMs,
          })
          yield* Effect.addFinalizer(() => jobs.remove(input.jobId).pipe(Effect.ignore))

          yield* Effect.forkScoped(
            Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
              const size = Buffer.byteLength(chunk, "utf-8")
              list.push({ text: chunk, size })
              used += size
              while (used > keep && list.length > 1) {
                const item = list.shift()
                if (!item) break
                used -= item.size
              }
              last = preview(last + chunk)
              sink?.write(chunk)
              return Effect.void
            }),
          )

          const exit = yield* input.timeoutMs !== undefined
            ? Effect.raceAll([
                handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
                Effect.sleep(`${input.timeoutMs + 100} millis`).pipe(
                  Effect.map(() => ({ kind: "timeout" as const, code: null })),
                ),
              ])
            : handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code })))

          if (exit.kind === "timeout") {
            timedOut = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
            if (input.notify) {
              yield* inject(ctx, renderTimeout(meta, yield* previewText()))
            }
            yield* background.cancel(input.jobId).pipe(Effect.ignore)
          }
          return exit.code
        }),
      ).pipe(Effect.orDie)

      if (!timedOut && code !== 0) {
        return yield* Effect.fail(new Error(`Command exited with code ${code}`))
      }
      return yield* previewText()
    })

    const pollUntilRegistered = Effect.fn("ShellTool.pollUntilRegistered")(function* (jobId: string) {
      let waited = 0
      while (waited < 2000) {
        const entry = yield* jobs.get(jobId)
        if (entry) return
        const info = yield* background.get(jobId)
        if (info && info.status !== "running") return
        yield* Effect.sleep("10 millis")
        waited += 10
      }
    })

    const notify = Effect.fn("ShellTool.notifyBackgroundResult")(function* (
      input: {
        jobId: string
        command: string
        logPath: string
        notify: boolean
      },
      ctx: Tool.Context,
    ) {
      if (!ctx.extra?.promptOps) return
      const meta: BackgroundMeta = {
        jobId: input.jobId,
        command: input.command,
        logPath: input.logPath,
        notify: input.notify,
      }
      yield* background.wait({ id: input.jobId }).pipe(
        Effect.flatMap((result) => {
          if (result.info?.status === "completed") {
            return inject(ctx, renderCompleted(meta, result.info.output ?? "", 0))
          }
          if (result.info?.status === "error") {
            return readLogTail(input.logPath).pipe(
              Effect.flatMap((preview) =>
                inject(ctx, renderError(meta, result.info?.error ?? "Command failed", preview, null)),
              ),
            )
          }
          return Effect.void
        }),
        Effect.forkIn(scope, { startImmediately: true }),
      )
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const limits = yield* trunc.limits()
        const prompt = ShellPrompt.render(name, process.platform, limits, defaultTimeoutMs)
        yield* Effect.logInfo("shell tool using shell", { shell })

          return {
            description: prompt.description,
            parameters: prompt.parameters,
            execute: (params: Parameters, ctx: Tool.Context) =>
              Effect.gen(function* () {
                const instanceCtx = yield* InstanceState.context
                const cwd = params.workdir
                  ? yield* resolvePath(params.workdir, instanceCtx.directory, shell)
                  : instanceCtx.directory
                if (params.timeout !== undefined && params.timeout < 0) {
                  throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
                }
                const timeout = params.timeout ?? defaultTimeoutMs
                const ps = Shell.ps(shell)
                yield* Effect.scoped(
                  Effect.gen(function* () {
                    const tree = yield* Effect.acquireRelease(parse(params.command, ps), (tree) =>
                      Effect.sync(() => tree.delete()),
                    )
                    const scan = yield* collect(tree.rootNode, cwd, ps, shell, instanceCtx)
                    if (!containsPath(cwd, instanceCtx)) scan.dirs.add(cwd)
                    yield* ask(ctx, scan, params)
                  }),
                )

                const env = yield* shellEnv(ctx, cwd)

                if (params.background === true) {
                  const jobId = params.id ?? Identifier.ascending("job")
                  if (params.id) {
                    if (!/^[A-Za-z0-9_-]+$/.test(params.id)) {
                      throw new Error(
                        `Invalid job id: ${params.id}. Must match ^[A-Za-z0-9_-]+$ (letters, digits, _ and -).`,
                      )
                    }
                    const registered = yield* background.get(params.id)
                    if (registered) {
                      throw new Error(`job id "${params.id}" is already in use`)
                    }
                    const logExists = yield* fs.existsSafe(jobLogPath(params.id))
                    const metaExists = yield* fs.existsSafe(jobMetaPath(params.id))
                    if (logExists || metaExists) {
                      throw new Error(
                        `job id "${params.id}" is already in use (a stale log exists on disk; pick a new id)`,
                      )
                    }
                  }

                  const logPath = jobLogPath(jobId)
                  const metaPath = jobMetaPath(jobId)
                  const wantsNotify = params.notify ?? true
                  const timeoutMs = params.timeout
                  const startedAt = Date.now()
                  const metadata: Record<string, unknown> = {
                    background: true,
                    jobId,
                    logPath,
                    notify: wantsNotify,
                    startedAt,
                    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
                  }

                  yield* fs.ensureDir(TRUNCATION_DIR)
                  yield* fs.writeFileString(logPath, "")
                  yield* fs.writeJson(metaPath, {
                    id: jobId,
                    command: params.command,
                    shell,
                    cwd,
                    startedAt,
                    notify: wantsNotify,
                    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
                  })

                  yield* background.start({
                    id: jobId,
                    type: "shell",
                    title: params.command,
                    metadata,
                    run: runBackground(
                      { shell, command: params.command, cwd, env, jobId, logPath, metaPath, notify: wantsNotify, timeoutMs },
                      ctx,
                    ),
                  })
                  // The run effect (forked by start) registers the handle in
                  // ShellJobs; wait briefly so the manager tool's kill/send can
                  // resolve the handle without racing the launch. If the process
                  // dies before registration (spawn failure), settle quickly.
                  yield* pollUntilRegistered(jobId)
                  if (wantsNotify) yield* notify({ jobId, command: params.command, logPath, notify: wantsNotify }, ctx)

                  return {
                    title: params.command,
                    metadata,
                    output: renderRunning({ jobId, command: params.command, logPath, notify: wantsNotify, timeoutMs }),
                  }
                }

                return yield* run(
                  {
                    shell,
                    command: params.command,
                    cwd,
                    env,
                    timeout,
                  },
                  ctx,
                )
              }).pipe(Effect.orDie),
          }
        })
  }),
)
