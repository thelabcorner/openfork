import { describe, expect, test } from "bun:test"
import { ShellPrompt } from "@/tool/shell/prompt"

const limits = { maxLines: 2_000, maxBytes: 64_000 }

describe("ShellPrompt", () => {
  test("advertises the resolved interpreter and script-string contract", () => {
    const result = ShellPrompt.render("/bin/bash", "linux", limits, 120_000)
    expect(result.description).toContain("Actual interpreter: bash (/bin/bash)")
    expect(result.description).toContain("Dialect: bash")
    expect(result.description).toContain("Invocation protocol: posix-c")
    expect(result.description).toContain("shell SCRIPT STRING, not an argv array")
    expect(result.description).toContain("Every tool call starts a fresh shell process")
    expect(result.description).not.toContain("persistent shell session")
    expect(result.description).not.toContain("DO NOT use newlines to separate commands")
    expect(result.description).toContain("intentionally a multiline shell program")
  })

  test("does not teach an unterminated heredoc PR example", () => {
    const result = ShellPrompt.render("/bin/bash", "linux", limits, 120_000)
    expect(result.description).toContain("--body-file")
    expect(result.description).toContain("dedicated Write tool")
    expect(result.description).not.toContain("$(cat <<'EOF'")
    expect(result.description).not.toContain("printf '%s")
  })

  test("PowerShell guidance refuses Bash heredoc translation", () => {
    const result = ShellPrompt.render("C:\\Program Files\\PowerShell\\7\\pwsh.exe", "win32", limits, 120_000)
    expect(result.description).toContain("Bash heredoc/here-string syntax")
    expect(result.description).toContain("is not translated")
    expect(result.description).toContain("`<<<`")
    expect(result.description).toContain("normalize quoted-heredoc LF bytes to CRLF")
    expect(result.description).not.toContain("Escape special characters with the PowerShell backtick")
    expect(result.description).toContain("dedicated Write tool")
    expect(result.description).not.toContain("gh pr create --title \"the pr title\" --body @'")
    expect(result.description).toContain("transparently moves unusually large PowerShell source out of native argv")
    expect(result.description).toContain("ordinary stdin remains available")
    expect(result.description).toContain("temporary script/body file")
  })

  test("Windows PowerShell 5.1 advertises legacy native argv handling and the literal stop-parsing escape hatch", () => {
    const result = ShellPrompt.render(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "win32",
      limits,
      120_000,
    )
    expect(result.description).toContain("Native argument mode: powershell-legacy")
    expect(result.description).toContain("stop-parsing token `--%`")
    expect(result.description).toContain("do not use `--%` when you need PowerShell variables or expressions expanded")
    expect(result.description).toContain("native pipeline/output encoding is legacy and context-sensitive")
    expect(result.description).toContain("transparently moves unusually large PowerShell source out of native argv")
    expect(result.description).toContain("ordinary stdin remains available")
  })

  test("keeps Git materialization policy separate from target-file EOL preservation", () => {
    const value = ShellPrompt.render("/bin/bash", "linux", limits, 120_000).description
    expect(value).toContain("core.autocrlf=false")
    expect(value).toContain("core.eol=lf")
    expect(value).toContain("intentional target-file CRLF/mixed terminators are preserved by Write/Edit/Patch")
    expect(value).toContain("Do not use shell newline conversion or Git config changes")
  })

  test("Git Bash on Windows distinguishes shell paths from literal Windows-path data", () => {
    const result = ShellPrompt.render("C:\\Program Files\\Git\\bin\\bash.exe", "win32", limits, 120_000)
    expect(result.description).toContain("Git Bash / MSYS path notes")
    expect(result.description).toContain("C:/Users/name/project")
    expect(result.description).toContain("/c/Users/name/project")
    expect(result.description).toContain("runtime does not rewrite arbitrary command arguments")
    expect(result.description).toContain("keeps authored Git Bash source out of argv")
    expect(result.description).toContain("Ordinary stdin remains available")
    expect(result.description).toContain("does not impose the old ~8 KiB argv ceiling")
    expect(result.description).toContain("temporary script/body file")
  })

  test("Windows MSYS POSIX-family shells receive the same transport/path contract, not Bash-only advice", () => {
    for (const shell of [
      "C:\\Program Files\\Git\\usr\\bin\\sh.exe",
      "C:\\Program Files\\Git\\usr\\bin\\dash.exe",
      "C:\\Program Files\\Git\\usr\\bin\\ksh.exe",
      "C:\\Program Files\\Git\\usr\\bin\\zsh.exe",
    ]) {
      const result = ShellPrompt.render(shell, "win32", limits, 120_000)
      expect(result.description).toContain("Path environment: msys-git-bash")
      expect(result.description).toContain("Git Bash / MSYS path notes")
      expect(result.description).toContain("keeps authored Git Bash source out of argv")
    }
  })

  test("cmd guidance does not imply double quotes make percent-delimited data literal", () => {
    const result = ShellPrompt.render("C:\\Windows\\System32\\cmd.exe", "win32", limits, 120_000)
    expect(result.description).toContain("`%NAME%` is environment-variable syntax even inside double quotes")
    expect(result.description).toContain("file/stdin or another transport")
    expect(result.description).toContain("arbitrary Unicode or byte-sensitive data")
    expect(result.description).toContain("rejects newlines in inline cmd.exe commands")
    expect(result.description).toContain("does not auto-stage rejected source into a `.cmd` file")
    expect(result.description).toContain("silently treat the value as empty")
    expect(result.description).toContain("runtime rejects a command that references such a value")
  })

  test("unknown wrapper shells do not receive invented POSIX syntax guidance", () => {
    const result = ShellPrompt.render("C:\\tools\\company-shell.exe", "win32", limits, 120_000)
    expect(result.description).toContain("Dialect: unknown")
    expect(result.description).toContain("Invocation protocol: generic-shell-adapter")
    expect(result.description).toContain("Do not assume Bash, POSIX, PowerShell, or cmd.exe syntax")
    expect(result.description).toContain("cmd-compatible `/d /s /c` parsing on Windows")
    expect(result.description).not.toContain("mkdir /Users/name/My Documents")
  })
})
