import { Schema } from "effect"
import DESCRIPTION from "./shell.txt"
import { PositiveInt } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { ShellID } from "./id"
import { ShellLaunch } from "./launch"

const PS = new Set(["powershell", "pwsh"])
const CMD = new Set(["cmd"])

export type Limits = {
  maxLines: number
  maxBytes: number
}

export function parameterSchema() {
  return Schema.Struct({
    command: Schema.String.annotate({
      description:
        "Shell SCRIPT STRING executed by the runtime interpreter described in this tool's shell profile. Operators such as |, &&, ; and > are shell syntax, not argv entries.",
    }),
    timeout: Schema.optional(PositiveInt).annotate({ description: "Optional timeout in milliseconds" }),
    workdir: Schema.optional(Schema.String).annotate({
      description: `The working directory to run the command in. Defaults to the current directory. Use this instead of 'cd' commands.`,
    }),
    background: Schema.optional(Schema.Boolean).annotate({
      description:
        "Run the command in the background. Returns immediately with a job id. Use the `background` tool to manage it. DO NOT sleep, poll, or block on background work.",
    }),
    notify: Schema.optional(Schema.Boolean).annotate({
      description:
        "When background=true, notify the agent automatically when the command finishes (default true). Set false for a long-running managed job (e.g. a dev server) you will control via the `background` tool. Ignored when background is false.",
    }),
    id: Schema.optional(Schema.String).annotate({
      description:
        "Optional short job id, e.g. 'bg1'. Must match ^[A-Za-z0-9_-]+$. Auto-generated if omitted. Rejected if the id is already in use or its log still exists on disk.",
    }),
  })
}

export const Parameters = parameterSchema()
export type Parameters = Schema.Schema.Type<typeof Parameters>

function renderPrompt(template: string, values: Record<string, string>) {
  return template.replace(/\$\{(\w+)\}/g, (_, key: string) => {
    const value = values[key]
    if (value === undefined) throw new Error(`Missing shell prompt value: ${key}`)
    return value
  })
}

function shellDisplayName(name: string) {
  if (name === "pwsh") return "PowerShell (7+)"
  if (name === "powershell") return "Windows PowerShell (5.1)"
  if (name === "cmd") return "cmd.exe"
  return name
}

function powershellNotes(name: string) {
  if (name === "pwsh") {
    return `# PowerShell (7+) shell notes
- Bash heredoc/here-string syntax (\`<<EOF\`, quoted delimiters, and \`<<<\`) is not translated. Unquoted Bash heredocs have expansion semantics PowerShell cannot preserve, and byte-level verification shows PowerShell native pipelines also normalize quoted-heredoc LF bytes to CRLF. Use a temporary script/body file or native PowerShell syntax instead.
- This cross-platform shell supports pipeline chain operators (\`&&\` and \`||\`).
- Use double quotes for interpolated strings (\`"Hello $name"\`), single quotes for verbatim strings.
- Prefer full cmdlet names like \`Get-ChildItem\`, \`Set-Content\`, \`Remove-Item\`, and \`New-Item\` over aliases.
- Use \`$(...)\` for subexpressions. Use \`@(...)\` for array expressions.
- To call a native executable whose path contains spaces, use the call operator: \`& "path/to/exe" args\`.
- Do not add backticks generically. Quote for the boundary you are crossing: PowerShell strings/cmdlets and native executable arguments have different parsing rules.
- PowerShell 7.3+ has configurable native argument passing (\`$PSNativeCommandArgumentPassing\`), and the exact mode is version/platform/target dependent. Do not infer it solely from the \`pwsh\` executable name.
- On Windows, the runtime transparently moves unusually large PowerShell source out of native argv before the process command-line ceiling. Do not split or re-quote a command merely to work around that ceiling; ordinary stdin remains available to the authored program. Prefer dedicated file tools when the content is data rather than shell source.
- Do not wrap commands in another \`pwsh -Command\` unless a genuinely separate PowerShell process is required.`
  }
  if (name === "powershell") {
    return `# Windows PowerShell (5.1) shell notes
- Use \`cmd1; if ($?) { cmd2 }\` to chain dependent commands.
- Use double quotes for interpolated strings (\`"Hello $name"\`), single quotes for verbatim strings.
- Prefer full cmdlet names like \`Get-ChildItem\`, \`Set-Content\`, \`Remove-Item\`, and \`New-Item\` over aliases.
- Use \`$(...)\` for subexpressions. Use \`@(...)\` for array expressions.
- To call a native executable whose path contains spaces, use the call operator: \`& "path/to/exe" args\`.
- Do not add backticks generically. Windows PowerShell 5.1 has legacy native-program argument marshalling, so an escape that is correct inside a PowerShell string can be wrong for a native executable argument.
- For a native executable with STATIC, literal arguments that include embedded double quotes, empty arguments, or difficult backslash/quote combinations, prefer PowerShell's stop-parsing token \`--%\` after the executable (for example: \`& "tool.exe" --% "a b" "say \\\"hi\\\"" ""\`). Everything to the right is passed literally using Windows native command-line rules; do not use \`--%\` when you need PowerShell variables or expressions expanded there.
- Windows PowerShell 5.1's native pipeline/output encoding is legacy and context-sensitive. Prefer file/stdin interfaces for arbitrary Unicode or byte-sensitive payloads instead of assuming native argv or pipeline text is lossless.
- Bash heredoc/here-string syntax (\`<<EOF\`, quoted delimiters, and \`<<<\`) is not translated. Unquoted heredocs have Bash expansion semantics, and PowerShell pipelines normalize quoted-heredoc newline bytes. Prefer a temporary script/body file.
- On Windows, the runtime transparently moves unusually large PowerShell source out of native argv before the process command-line ceiling. Do not split or re-quote a command merely to work around that ceiling; ordinary stdin remains available to the authored program. Prefer dedicated file tools when the content is data rather than shell source.
- Do not wrap commands in another \`powershell -Command\` unless a genuinely separate PowerShell process is required.`
  }
  return ""
}

function chainGuidance(name: string) {
  if (name === "powershell") {
    return "If the commands depend on each other and must run sequentially, avoid '&&' in this shell because Windows PowerShell (5.1) does not support it. Use PowerShell conditionals such as `cmd1; if ($?) { cmd2 }` when later commands must depend on earlier success."
  }
  if (PS.has(name)) {
    return "If the commands depend on each other and must run sequentially, use a single shell tool call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" && git push`)."
  }
  if (CMD.has(name)) {
    return "If the commands depend on each other and must run sequentially, use a single shell tool call with `&&` to chain them together (e.g., `mkdir out && dir out`)."
  }
  return "If the commands depend on each other and must run sequentially, use a single shell tool call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" && git push`)."
}

function bashCommandSection(chain: string, limits: Limits, defaultTimeoutMs: number) {
  return `Before executing the command, please follow these steps:

1. Directory Verification:
   - If the command will create new directories or files, first use \`ls\` to verify the parent directory exists and is the correct location
   - For example, before running "mkdir foo/bar", first use \`ls foo\` to check that "foo" exists and is the intended parent directory

2. Command Execution:
   - Always quote file paths that contain spaces with double quotes (e.g., rm "path with spaces/file.txt")
   - Examples of proper quoting:
     - mkdir "/Users/name/My Documents" (correct)
     - mkdir /Users/name/My Documents (incorrect - will fail)
     - python "/path/with spaces/script.py" (correct)
     - python /path/with spaces/script.py (incorrect - will fail)
   - After ensuring proper quoting, execute the command.
   - Capture the output of the command.

Usage notes:
  - The command argument is required.
  - You can specify an optional timeout in milliseconds. If not specified, commands will time out after ${defaultTimeoutMs}ms.
  - If the output exceeds ${limits.maxLines} lines or ${limits.maxBytes} bytes, it will be truncated and the full output will be written to a file. You can use Read with offset/limit to read specific sections or Find with \`grep\` to search the full content. Do NOT use \`head\`, \`tail\`, or other truncation commands to limit output; the full output will already be captured to a file for more precise searching.

  - Avoid using Bash with the \`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\` commands, unless explicitly instructed or when these commands are truly necessary for the task. Instead, always prefer using the dedicated tools for these commands:
    - File search: Use Find with \`glob\` (NOT find or ls)
    - Content search: Use Find with \`grep\` (NOT grep or rg)
    - Read files: Use Read (NOT cat/head/tail)
    - Edit files: Use Edit (NOT sed/awk)
    - Write files: Use Write (NOT echo >/cat <<EOF). Write/Edit/Patch preserve intentional target-file line-ending semantics; do not normalize CRLF/mixed files through shell text transport.
    - Communication: Output text directly (NOT echo/printf)
  - When issuing multiple commands:
    - If the commands are independent and can run in parallel, make multiple shell tool calls (compatibility tool id: \`bash\`) in a single message. For example, if you need to run "git status" and "git diff", send a single message with two tool calls in parallel.
    - ${chain}
    - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail
  - Prefer explicit chain operators for short command sequences. Newlines are valid shell syntax and are appropriate when the command is intentionally a multiline shell program (for example a supported heredoc); do not use them merely to hide unrelated sequential commands.
  - AVOID using \`cd <directory> && <command>\`. Use the \`workdir\` parameter to change directories instead.
    <good-example>
    Use workdir="/foo/bar" with command: pytest tests
    </good-example>
    <bad-example>
    cd /foo/bar && pytest tests
    </bad-example>`
}

function gitBashNotes(name: string, platform: NodeJS.Platform) {
  if (!["bash", "sh", "zsh", "dash", "ksh"].includes(name) || platform !== "win32") return ""
  return `# Git Bash / MSYS path notes
- For shell path operands, prefer forward-slash Windows paths such as \`C:/Users/name/project\` or canonical MSYS paths such as \`/c/Users/name/project\`.
- A backslash-heavy Windows path can be literal DATA rather than a path. Quote it when it must reach a native program unchanged; the runtime does not rewrite arbitrary command arguments because doing so could corrupt literal data.
- Git for Windows' MSYS argv bridge is empirically unreliable for quote/backslash-heavy source and near ~8 KiB even when \`bash.exe\` is invoked directly with \`-c\`. OpenFork therefore keeps authored Git Bash source out of argv and transports it through a private MSYS-conversion-excluded environment value before the single intentional Bash parse. Ordinary stdin remains available to the authored program. For genuinely large generated programs/data, prefer a temporary script/body file so the shell source stays small; the runtime does not impose the old ~8 KiB argv ceiling on Git Bash source.`
}

function powershellCommandSection(
  name: string,
  chain: string,
  pathSep: string,
  limits: Limits,
  defaultTimeoutMs: number,
) {
  return `${powershellNotes(name)}

Before executing the command, please follow these steps:

1. Directory Verification:
   - If the command will create new directories or files, first use \`Test-Path -LiteralPath <parent>\` to verify the parent directory exists and is the correct location
   - For example, before creating \`foo${pathSep}bar\`, first use \`Test-Path -LiteralPath "foo"\` to check that \`foo\` exists and is the intended parent directory

2. Command Execution:
   - Always quote file paths that contain spaces with double quotes (e.g., Remove-Item -LiteralPath "path with spaces${pathSep}file.txt")
   - Examples of proper quoting:
     - New-Item -ItemType Directory -Path "My Documents" (correct)
     - New-Item -ItemType Directory -Path My Documents (incorrect - path is split)
     - & "path with spaces${pathSep}script.ps1" (correct)
     - path with spaces${pathSep}script.ps1 (incorrect - path is split and not invoked)
   - After ensuring proper quoting, execute the command.
   - Capture the output of the command.

Usage notes:
  - The command argument is required.
  - You can specify an optional timeout in milliseconds. If not specified, commands will time out after ${defaultTimeoutMs}ms.
  - If the output exceeds ${limits.maxLines} lines or ${limits.maxBytes} bytes, it will be truncated and the full output will be written to a file. You can use Read with offset/limit to read specific sections or Find with \`grep\` to search the full content. Do NOT use \`Select-Object -First\`, \`Select-Object -Last\`, or other truncation commands to limit output; the full output will already be captured to a file for more precise searching.

  - Avoid using Shell with PowerShell file/content cmdlets unless explicitly instructed or when these cmdlets are truly necessary for the task. Instead, always prefer using the dedicated tools for these commands:
    - File search: Use Find with \`glob\` (NOT Get-ChildItem)
    - Content search: Use Find with \`grep\` (NOT Select-String)
    - Read files: Use Read (NOT Get-Content)
    - Edit files: Use Edit (NOT Set-Content)
    - Write files: Use Write (NOT Set-Content/Out-File or here-strings). Write/Edit/Patch preserve intentional target-file line-ending semantics; PowerShell text pipelines must not become an accidental EOL converter.
    - Communication: Output text directly (NOT Write-Output/Write-Host)
  - When issuing multiple commands:
    - If the commands are independent and can run in parallel, make multiple shell tool calls (compatibility tool id: \`bash\`) in a single message. For example, if you need to run "git status" and "git diff", send a single message with two tool calls in parallel.
    - ${chain}
    - Use \`;\` only when you need to run commands sequentially but don't care if earlier commands fail
  - Prefer explicit chain operators for short command sequences. Newlines are valid PowerShell statement separators and are appropriate when the command is intentionally a multiline shell program; do not use them merely to hide unrelated sequential commands.
  - AVOID changing directories inside the command. Use the \`workdir\` parameter to change directories instead.
    <good-example>
    Use workdir="project${pathSep}subdir" with command: pytest tests
    </good-example>
    <bad-example>
    ${name === "powershell" ? `Set-Location -LiteralPath "project${pathSep}subdir"; if ($?) { pytest tests }` : `Set-Location -LiteralPath "project${pathSep}subdir" && pytest tests`}
    </bad-example>`
}

function cmdCommandSection(chain: string, limits: Limits, defaultTimeoutMs: number) {
  return `# cmd.exe shell notes
- Use double quotes for paths with spaces.
- Single quotes are ordinary characters in cmd.exe, not a general quoting mechanism.
- Use %VAR% for environment variables.
- \`%NAME%\` is environment-variable syntax even inside double quotes. Do not present \`%...%\` as ordinary literal-data quoting; use a file/stdin or another transport when literal percent-delimited text matters.
- Use \`if exist\` for existence checks.
- Use \`call\` when invoking batch files from another batch-style command.
- cmd.exe has a much smaller command-line ceiling than modern POSIX/PowerShell shells (Windows documents an 8191-character limit). Put large or quote-dense command programs/data in a temporary file instead of constructing one giant inline command.
- The runtime intentionally does not auto-stage rejected source into a \`.cmd\` file. Batch-file execution changes observable semantics such as \`%0\`, \`%~dp0\`, and command echoing; create a batch file explicitly only when those batch semantics are intended.
- cmd.exe cannot faithfully expand an inherited \`%NAME%\` value beyond its 8191-character environment limit: real Windows testing shows it can silently treat the value as empty and exit 0 on the wrong branch. The runtime rejects a command that references such a value; pass large data through a file/stdin interface instead.
- cmd.exe also inherits Windows console/code-page behavior. For arbitrary Unicode or byte-sensitive data, prefer a file/stdin interface rather than assuming inline command text is lossless.

Before executing the command, please follow these steps:

1. Directory Verification:
   - If the command will create new directories or files, first use \`if exist\` to verify the parent directory exists and is the correct location
   - For example, before creating \`foo\\bar\`, first use \`if exist "foo\\" dir "foo"\` to check that \`foo\` exists and is the intended parent directory

2. Command Execution:
   - Always quote file paths that contain spaces with double quotes (e.g., del "path with spaces\\file.txt")
   - Examples of proper quoting:
     - mkdir "My Documents" (correct)
     - mkdir My Documents (incorrect - path is split)
     - call "path with spaces\\script.bat" (correct)
     - path with spaces\\script.bat (incorrect - path is split and not invoked correctly)
   - After ensuring proper quoting, execute the command.
   - Capture the output of the command.

Usage notes:
  - The command argument is required.
  - You can specify an optional timeout in milliseconds. If not specified, commands will time out after ${defaultTimeoutMs}ms.
  - If the output exceeds ${limits.maxLines} lines or ${limits.maxBytes} bytes, it will be truncated and the full output will be written to a file. You can use Read with offset/limit to read specific sections or Find with \`grep\` to search the full content. Do NOT use \`more\` or other pagination commands to limit output; the full output will already be captured to a file for more precise searching.

  - Avoid using Shell with cmd.exe file/content commands unless explicitly instructed or when these commands are truly necessary for the task. Instead, always prefer using the dedicated tools for these commands:
    - File search: Use Find with \`glob\` (NOT dir /s)
    - Content search: Use Find with \`grep\` (NOT findstr)
    - Read files: Use Read (NOT type)
    - Edit files: Use Edit (NOT copy)
    - Write files: Use Write (NOT echo > file). Write/Edit/Patch preserve intentional target-file line-ending semantics; cmd.exe text/code-page behavior must not become an accidental byte/EOL converter.
    - Communication: Output text directly (NOT echo)
  - When issuing multiple commands:
    - If the commands are independent and can run in parallel, make multiple shell tool calls (compatibility tool id: \`bash\`) in a single message. For example, if you need to run "dir" and "where cmd", send a single message with two tool calls in parallel.
    - ${chain}
    - Use \`&\` only when you need to run commands sequentially but don't care if earlier commands fail
  - Prefer explicit chain operators for short command sequences. This tool rejects newlines in inline cmd.exe commands because integration testing showed cmd.exe can exit successfully after executing only the first line. Use a temporary .cmd file when a real multiline cmd program is required.
  - AVOID changing directories inside the command. Use the \`workdir\` parameter to change directories instead.
    <good-example>
    Use workdir="project\\subdir" with command: dir
    </good-example>
    <bad-example>
    cd /d "project\\subdir" && dir
    </bad-example>`
}

function profile(name: string, platform: NodeJS.Platform, limits: Limits, defaultTimeoutMs: number) {
  const isPowerShell = PS.has(name)
  const chain = chainGuidance(name)
  const dialect = ShellLaunch.profile(name, platform).dialect
  if (dialect === "unknown") {
    return {
      intro: `Executes a command through the configured shell wrapper \`${name}\`. Its command-language dialect is unknown.`,
      workdirSection:
        "All commands run in the current working directory by default. Use the `workdir` parameter when another directory is required.",
      commandSection: `# Unknown shell dialect
- Do not assume Bash, POSIX, PowerShell, or cmd.exe syntax from this wrapper's filename.
- Keep commands to the wrapper's documented syntax. If its dialect is not known from the task/repository, avoid shell-specific operators, substitutions, heredocs, quoting recipes, and path rewrites rather than guessing.
- This wrapper is entered through the host shell adapter, not a guessed direct-argv contract. Compatible wrappers must implement the host shell protocol (a \`-c\` command-string entrypoint on POSIX; cmd-compatible \`/d /s /c\` parsing on Windows). If the configured executable does not implement that protocol, execution fails rather than inventing another adapter.
- The runtime still treats \`command\` as a shell SCRIPT STRING and starts a fresh process for every call.`,
      gitCommands: "commands",
      gitCommandRestriction: "git commands",
      createPrInstruction:
        "Create PR bodies with the dedicated Write tool and pass the file to the target program rather than guessing this wrapper's quoting syntax.",
      createPrExample: `gh pr create --title "the pr title" --body-file pr-body.md`,
    }
  }
  if (CMD.has(name)) {
    return {
      intro: `Executes a given ${shellDisplayName(name)} command with optional timeout, ensuring proper handling and security measures.`,
      workdirSection:
        "All commands run in the current working directory by default. Use the `workdir` parameter if you need to run a command in a different directory. AVOID changing directories inside the command - use `workdir` instead.",
      commandSection: cmdCommandSection(chain, limits, defaultTimeoutMs),
      gitCommands: "git commands",
      gitCommandRestriction: "git commands",
      createPrInstruction:
        "Create PR bodies with the dedicated Write tool, then pass that file to `gh pr create --body-file`; do not synthesize multiline Markdown with cmd.exe echo/redirection.",
      createPrExample: `gh pr create --title "the pr title" --body-file pr-body.md`,
    }
  }
  if (isPowerShell) {
    return {
      intro: `Executes a given ${shellDisplayName(name)} command with optional timeout, ensuring proper handling and security measures.`,
      workdirSection:
        "All commands run in the current working directory by default. Use the `workdir` parameter if you need to run a command in a different directory. AVOID changing directories inside the command - use `workdir` instead.",
      commandSection: powershellCommandSection(
        name,
        chain,
        platform === "win32" ? "\\" : "/",
        limits,
        defaultTimeoutMs,
      ),
      gitCommands: "git commands",
      gitCommandRestriction: "git commands",
      createPrInstruction:
        "Create PR bodies with the dedicated Write tool, then pass that file to `gh pr create --body-file`; Markdown should not cross extra PowerShell/native-argument quoting layers.",
      createPrExample: `gh pr create --title "the pr title" --body-file pr-body.md`,
    }
  }
  return {
    intro: `Executes a given ${shellDisplayName(name)} shell script in a fresh process with optional timeout. Shell state does not persist across tool calls.`,
    workdirSection:
      "All commands run in the current working directory by default. Use the `workdir` parameter if you need to run a command in a different directory. AVOID using `cd <directory> && <command>` patterns - use `workdir` instead.",
    commandSection: [gitBashNotes(name, platform), bashCommandSection(chain, limits, defaultTimeoutMs)]
      .filter(Boolean)
      .join("\n\n"),
    gitCommands: "shell commands",
    gitCommandRestriction: "git commands",
    createPrInstruction:
      "Create PR bodies with the dedicated Write tool, then pass that file to `gh pr create --body-file`; Markdown should not cross extra shell quoting layers.",
    createPrExample: `gh pr create --title "the pr title" --body-file pr-body.md`,
  }
}

const BACKGROUND_SECTION = [
  "# Background commands",
  "- Set `background: true` to run a long-lived command (a dev server, a build, a watch) without blocking. The tool returns immediately with a job id like `job_abc`.",
  "- With the default `notify: true` you are notified automatically when the command finishes (or times out).",
  "- Set `notify: false` for managed jobs you control yourself (e.g. a dev server that should keep running). You will NOT be notified — you must check it explicitly.",
  "- Use the `background` tool to manage any background job: `background list`, `background status {id}`, `background read {id}` (live output), `background wait {id}`, `background send {id}`, `background kill {id}`.",
  "- Full output streams to a per-job log file reported at launch; read it with `background read {id}`.",
  "- Background jobs ignore the default timeout; pass an explicit `timeout` to kill the job after that many milliseconds.",
].join("\n")

export function render(shell: string, platform: NodeJS.Platform, limits: Limits, defaultTimeoutMs: number) {
  const runtime = ShellLaunch.profile(shell, platform)
  const name = runtime.shellName
  const selected = profile(name, platform, limits, defaultTimeoutMs)
  return {
    description: renderPrompt(DESCRIPTION, {
      intro: selected.intro,
      os: platform,
      shell: `${shellDisplayName(name)} (${runtime.shellPath})`,
      dialect: runtime.dialect,
      invocationProtocol: runtime.invocationProtocol,
      pathEnvironment: runtime.pathEnvironment,
      nativeArgMode: runtime.nativeArgMode,
      tmp: Global.Path.tmp,
      workdirSection: selected.workdirSection,
      commandSection: selected.commandSection,
      backgroundSection: BACKGROUND_SECTION,
      gitCommands: selected.gitCommands,
      toolName: ShellID.ToolID,
      gitCommandRestriction: selected.gitCommandRestriction,
      createPrInstruction: selected.createPrInstruction,
      createPrExample: selected.createPrExample,
    }),
    parameters: parameterSchema(),
  }
}

export * as ShellPrompt from "./prompt"
