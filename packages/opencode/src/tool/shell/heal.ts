import type { Dialect } from "./launch"

/**
 * Model-facing shell output must never depend on a renderer interpreting
 * terminal control bytes, and a wrong command-language guess must be recycled
 * into an actionable correction in the same tool result that produced it.
 *
 * This module is a projection layer only: it never rewrites, translates, or
 * retries the authored command. Raw bytes stay in the spilled log/timeline
 * artifacts, and detection fails open (no hint when nothing is recognized).
 */

// CSI sequences (SGR color, cursor), OSC sequences (hyperlinks/titles).
const ANSI_PATTERN = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\))/g

export function stripAnsi(text: string) {
  return text.replace(ANSI_PATTERN, "")
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

function escapeXml(text: string) {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char)
}

// English-locale command-not-found signatures. Match mature harness behavior:
// recognize, do not guess; an unrecognized locale produces no hint.
const NOT_FOUND_PATTERNS: readonly RegExp[] = [
  /The term '([^'\r\n]+)' is not recognized as (?:a|the) name of a cmdlet, function, script file, or (?:executable|operable) program/gi,
  /'([^'\r\n]+)' is not recognized as an internal or external command/gi,
  /([^\s:'"\r\n]+): command not found/gi,
]

function commandName(raw: string) {
  const base = raw.trim().split(/[\\/]/).pop() ?? raw.trim()
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "")
}

type Hint = {
  readonly issue: string
  readonly fixes: readonly string[]
}

const SEARCH_COMMANDS = new Set(["grep", "rg", "egrep", "fgrep", "ag", "ack"])
const EDIT_COMMANDS = new Set(["sed", "awk"])
const READ_COMMANDS = new Set(["head", "tail", "cat", "less", "more"])

function adviceFor(name: string): Hint {
  if (SEARCH_COMMANDS.has(name)) {
    return {
      issue: `\`${name}\` is not installed in this shell.`,
      fixes: [
        "Content search: use the Find tool with the `grep` parameter (regex) instead of shelling out.",
        "If it must run inside a PowerShell pipeline, `Select-String` is the native alternative.",
      ],
    }
  }
  if (name === "find") {
    return {
      issue: "POSIX `find` is not available in this shell.",
      fixes: ["File search: use the Find tool with the `glob` parameter."],
    }
  }
  if (EDIT_COMMANDS.has(name)) {
    return {
      issue: `\`${name}\` is not installed in this shell.`,
      fixes: ["Surgical text changes: use the Edit tool."],
    }
  }
  if (READ_COMMANDS.has(name)) {
    return {
      issue: `\`${name}\` is not installed in this shell.`,
      fixes: ["File reads: use the Read tool (with `offset`/`limit` for partial reads)."],
    }
  }
  if (name === "xargs") {
    return {
      issue: "`xargs` is not installed in this shell.",
      fixes: ["Pipeline fan-out: use PowerShell's `ForEach-Object`, or the dedicated tools."],
    }
  }
  if (name === "wc") {
    return {
      issue: "`wc` is not installed in this shell.",
      fixes: ["Counting: use `Measure-Object -Line`, or read the file with the Read tool."],
    }
  }
  if (name === "touch") {
    return {
      issue: "`touch` is not installed in this shell.",
      fixes: ["Create files with the Write tool or `New-Item`."],
    }
  }
  if (name === "which") {
    return {
      issue: "`which` is not installed in this shell.",
      fixes: ["Resolve commands with `Get-Command`."],
    }
  }
  if (name === "export" || name === "source") {
    return {
      issue: `\`${name}\` is Bash syntax, not PowerShell.`,
      fixes: [
        name === "export"
          ? "Set environment variables for the child process with `$env:NAME = \"value\"`."
          : "Dot-source PowerShell scripts with `. ./script.ps1`.",
      ],
    }
  }
  if (name === "chmod" || name === "chown") {
    return {
      issue: `\`${name}\` does not exist on Windows.`,
      fixes: ["Windows has no POSIX ownership/permission commands; avoid them entirely."],
    }
  }
  return {
    issue: `\`${name}\` is not available in this shell.`,
    fixes: [
      "If this was a Bash/Unix command, it is not installed here; rewrite with PowerShell cmdlets or use the dedicated tools (Read/Find/Edit/Write).",
    ],
  }
}

const DEV_NULL_HINT: Hint = {
  issue: "The command references `/dev/null`, which does not exist on Windows.",
  fixes: [
    "Discard output with the runtime's null device (`$null` / `2>$null` in PowerShell, `NUL` in cmd.exe), or drop the redirect — the tool already captures stdout and stderr.",
  ],
}

const SPECIAL_HINTS: readonly { pattern: RegExp; hint: Hint }[] = [
  {
    pattern: /Could not find a part of the path '[^']*dev[\\/]null'/i,
    hint: DEV_NULL_HINT,
  },
  {
    pattern: /The '<' operator is reserved for future use/i,
    hint: {
      issue: "PowerShell does not support Bash `<` input redirection.",
      fixes: ["Use `Get-Content`, a pipeline, or a temporary file."],
    },
  },
  {
    pattern: /is not a valid statement separator in this version/i,
    hint: {
      issue: "This shell version does not support `&&`.",
      fixes: ["Windows PowerShell 5.1 requires `cmd1; if ($?) { cmd2 }` for dependent chains."],
    },
  },
  {
    pattern: /ParserError/i,
    hint: {
      issue: "PowerShell rejected the command as a parse error.",
      fixes: [
        "If this command was written in Bash/Unix syntax, rewrite it with PowerShell cmdlets or the dedicated tools (Read/Find/Edit/Write).",
      ],
    },
  },
]

const MAX_HINTS = 4

export function hints(input: {
  command: string
  output: string
  dialect: Dialect
  exit: number | null
}): string | undefined {
  if (input.dialect !== "powershell" && input.dialect !== "cmd") return undefined

  const text = stripAnsi(input.output)
  const collected: Hint[] = []
  const seen = new Set<string>()
  const add = (hint: Hint) => {
    if (collected.length >= MAX_HINTS || seen.has(hint.issue)) return
    seen.add(hint.issue)
    collected.push(hint)
  }

  for (const pattern of NOT_FOUND_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const name = commandName(match[1] ?? "")
      if (name) add(adviceFor(name))
    }
  }
  for (const { pattern, hint } of SPECIAL_HINTS) {
    if (pattern.test(text)) add(hint)
  }
  if (/\/dev\/null/.test(input.command)) add(DEV_NULL_HINT)

  if (collected.length === 0) return undefined

  const reminder =
    input.dialect === "powershell"
      ? "This runtime is PowerShell, not Bash. Unix/Bash commands (grep, rg, sed, awk, head, tail, xargs, wc) are not installed; retrying them in this shell will fail again."
      : "This runtime is cmd.exe, not Bash. Unix/Bash commands (grep, rg, sed, awk, head, tail, xargs) are not installed; retrying them in this shell will fail again."

  const lines = [`<shell_heal dialect="${input.dialect}"${input.exit !== null ? ` exit="${input.exit}"` : ""}>`]
  for (const hint of collected) {
    lines.push(`<issue>${escapeXml(hint.issue)}</issue>`)
    for (const fix of hint.fixes) lines.push(`<fix>${escapeXml(fix)}</fix>`)
  }
  lines.push(`<reminder>${escapeXml(reminder)}</reminder>`)
  lines.push("</shell_heal>")
  return lines.join("\n")
}

export * as ShellHeal from "./heal"
