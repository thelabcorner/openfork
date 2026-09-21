import { ChildProcess } from "effect/unstable/process"
import type { CommandInput, StdinConfig } from "effect/unstable/process/ChildProcess"
import type { Duration } from "effect"
import { analyzeBashStdinSyntaxForPowerShell } from "@/util/powershell-heredoc"
import path from "node:path"
import {
  CMD_INLINE_SCRIPT_LIMIT,
  POWERSHELL_INLINE_SCRIPT_LIMIT,
  POWERSHELL_AUTOMATION_ARGS,
  msysScriptTransport,
  powershellScriptTransport,
  validateInvocationEnvironment,
  withSourceEnvironment,
  type SourceEnvironment,
} from "@opencode-ai/core/shell"

export type Dialect = "powershell" | "cmd" | "bash" | "zsh" | "posix" | "unknown"

export type ExecutionProfile = {
  platform: NodeJS.Platform
  shellPath: string
  shellName: string
  dialect: Dialect
  invocationProtocol: "powershell-command" | "cmd-shell-adapter" | "posix-c" | "generic-shell-adapter"
  pathEnvironment: "native-windows" | "msys-git-bash" | "native-posix"
  nativeArgMode: "powershell-legacy" | "powershell-version-dependent" | "shell-native" | "unknown"
  persistent: false
  transport: "script-string"
}

export type LaunchPlan = {
  profile: ExecutionProfile
  sourceScript: string
  interpreterScript: string
  command: string
  args: string[]
  shell?: string
  sourceTransport: "argv" | "environment" | "shell-option"
  sourceEnvironment?: SourceEnvironment
  detached: boolean
}

// Microsoft documents 8191 characters for cmd.exe command lines and expanded
// environment-variable values. Leave headroom rather than treating the exact
// published ceiling as a usable transport budget.
export { CMD_INLINE_SCRIPT_LIMIT, POWERSHELL_INLINE_SCRIPT_LIMIT }

export function profile(shell: string, platform: NodeJS.Platform = process.platform): ExecutionProfile {
  // Keep profile classification a pure function of the resolved executable and
  // the advertised host. `Shell.name()` intentionally follows the *current*
  // process platform, which makes cross-platform contract tests impossible and
  // can mis-describe a serialized Windows path inspected on another host.
  const shellName = (platform === "win32" ? path.win32.parse(shell).name : path.basename(shell)).toLowerCase()
  const dialect: Dialect =
    shellName === "pwsh" || shellName === "powershell"
      ? "powershell"
      : shellName === "cmd"
        ? "cmd"
        : shellName === "bash"
          ? "bash"
            : shellName === "zsh"
              ? "zsh"
              : ["sh", "dash", "ksh"].includes(shellName)
                ? "posix"
                : "unknown"
  return {
    platform,
    shellPath: shell,
    shellName,
    dialect,
    invocationProtocol:
      dialect === "powershell"
        ? "powershell-command"
        : dialect === "cmd" && platform === "win32"
          ? "cmd-shell-adapter"
          : dialect === "bash" || dialect === "zsh" || dialect === "posix"
            ? "posix-c"
            : "generic-shell-adapter",
    pathEnvironment:
      platform === "win32"
        ? ["bash", "sh", "zsh", "dash", "ksh"].includes(shellName)
          ? "msys-git-bash"
          : "native-windows"
        : "native-posix",
    // `pwsh` alone does not identify the native argument mode. PowerShell
    // 7.3 introduced `$PSNativeCommandArgumentPassing`, whose default/effective
    // behavior varies by version, platform, and target executable. Do not
    // advertise a capability we have not actually probed.
    nativeArgMode:
      dialect === "unknown"
        ? "unknown"
        : shellName === "powershell"
        ? "powershell-legacy"
        : shellName === "pwsh"
          ? "powershell-version-dependent"
          : "shell-native",
    persistent: false,
    transport: "script-string",
  }
}

/**
 * Produce the exact process contract without spawning it. This is the audit
 * boundary between the user/model-approved script and the interpreter script/argv handed
 * to the platform process layer, and is intentionally pure so regression tests
 * can compare approved source and interpreter transport text directly. Native argv/stdio bytes are
 * verified separately with child-process sentinels.
 */
export function plan(shell: string, script: string, platform: NodeJS.Platform = process.platform): LaunchPlan {
  const runtime = profile(shell, platform)
  if (script.includes("\0")) {
    throw new Error("Shell source cannot contain NUL bytes.")
  }
  if (runtime.dialect === "powershell") {
    const bashStdin = analyzeBashStdinSyntaxForPowerShell(script)
    // No compatibility rewrite is permitted here. A previous quoted-heredoc
    // translation looked textually correct but failed the byte oracle on real
    // Windows PowerShell/pwsh. Fail closed until a transport can prove both
    // Bash semantics and stdin bytes.
    if (bashStdin.unquotedHeredoc) {
      throw new Error(
        "Cannot execute an unquoted Bash heredoc through PowerShell without changing semantics: Bash expands $variables, $(commands), and $((arithmetic)) in an unquoted heredoc body. Bash heredocs are not translated on this PowerShell runtime; use native PowerShell syntax or a temporary script/body file instead.",
      )
    }
    if (bashStdin.quotedHeredoc) {
      throw new Error(
        platform === "win32"
          ? "Cannot safely translate a quoted Bash heredoc through PowerShell: byte-level verification shows PowerShell native pipelines normalize the heredoc's trailing LF to CRLF. Use a temporary script/body file (preferred) or native PowerShell syntax when that shell's text/newline semantics are intentional."
          : "Cannot execute a quoted Bash heredoc through PowerShell without cross-translating shell languages. Use a temporary script/body file or native PowerShell syntax instead.",
      )
    }
    if (bashStdin.hereString) {
      throw new Error(
        "Cannot execute Bash here-string syntax (`<<<`) through PowerShell. Use a temporary input file, a native PowerShell here-string, or the target program's file/stdin interface instead.",
      )
    }
    const transport =
      platform === "win32" && script.length > POWERSHELL_INLINE_SCRIPT_LIMIT
        ? powershellScriptTransport(script)
        : undefined
    return {
      profile: runtime,
      sourceScript: script,
      interpreterScript: transport?.script ?? script,
      command: shell,
      args: [...POWERSHELL_AUTOMATION_ARGS, transport?.script ?? script],
      sourceTransport: transport ? "environment" : "argv",
      sourceEnvironment: transport?.sourceEnvironment,
      detached: platform !== "win32",
    }
  }

  if (platform === "win32" && runtime.dialect === "cmd" && script.length > CMD_INLINE_SCRIPT_LIMIT) {
    throw new Error(
      "Cannot execute this inline cmd.exe script safely because it is near Windows cmd.exe's 8191-character command-line limit. Put the program/data in a temporary file or use the target program's file/stdin interface, then run a short command that references it.",
    )
  }
  if (platform === "win32" && runtime.dialect === "cmd" && /[\r\n]/.test(script)) {
    throw new Error(
      "Cannot execute a multiline cmd.exe program through the inline command transport: integration testing shows cmd.exe can exit successfully after executing only the first line. Put the program in a temporary .cmd file and run that file, or express a short sequence with explicit cmd.exe chain operators.",
    )
  }
  if (platform === "win32" && runtime.dialect === "cmd") {
    return {
      profile: runtime,
      sourceScript: script,
      interpreterScript: script,
      // Node/cross-spawn's cmd shell adapter handles the peculiar /d /s /c
      // wrapping with windowsVerbatimArguments. Directly passing the script as
      // argv re-quotes its internal double quotes and corrupts native argv.
      command: script,
      args: [],
      shell,
      sourceTransport: "shell-option",
      detached: false,
    }
  }
  if (
    platform === "win32" &&
    runtime.pathEnvironment === "msys-git-bash" &&
    (runtime.dialect === "bash" || runtime.dialect === "zsh" || runtime.dialect === "posix")
  ) {
    const transport = msysScriptTransport(script)
    return {
      profile: runtime,
      sourceScript: script,
      interpreterScript: transport.script,
      command: shell,
      args: ["-c", transport.script],
      sourceTransport: "environment",
      sourceEnvironment: transport.sourceEnvironment,
      detached: false,
    }
  }
  // Match mature agent harnesses (Codex/Gemini): once the interpreter is
  // known, invoke it directly and pass the script as the argument to -c.
  // Do not route a script string through Node's shell option, which adds an
  // implicit shell-construction layer whose quoting rules are harder to audit,
  // especially for Git Bash on Windows.
  if (runtime.dialect === "bash" || runtime.dialect === "zsh" || runtime.dialect === "posix") {
    return {
      profile: runtime,
      sourceScript: script,
      interpreterScript: script,
      command: shell,
      args: ["-c", script],
      sourceTransport: "argv",
      detached: platform !== "win32",
    }
  }

  return {
    profile: runtime,
    sourceScript: script,
    interpreterScript: script,
    command: script,
    args: [],
    shell,
    sourceTransport: "shell-option",
    detached: platform !== "win32",
  }
}

/**
 * Single V1 owner for turning a model-authored shell script string into a
 * process invocation. Foreground shell calls, detached shell calls, and
 * background monitors must all use this boundary so validation and process
 * invocation cannot drift between execution modes.
 */
export function command(
  shell: string,
  script: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdin: CommandInput | StdinConfig = "ignore",
  options: { forceKillAfter?: Duration.Input } = {},
) {
  validateInvocationEnvironment(shell, script, env)
  const launch = plan(shell, script)
  const childEnv = withSourceEnvironment(env, launch.sourceEnvironment, process.env)
  if (launch.shell === undefined) {
    return ChildProcess.make(launch.command, launch.args, {
      cwd,
      env: childEnv,
      stdin,
      detached: launch.detached,
      ...options,
    })
  }

  return ChildProcess.make(launch.command, launch.args, {
    shell: launch.shell,
    cwd,
    env: childEnv,
    stdin,
    detached: launch.detached,
    ...options,
  })
}

export * as ShellLaunch from "./launch"
