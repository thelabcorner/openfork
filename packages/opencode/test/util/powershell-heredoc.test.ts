import { describe, expect, test } from "bun:test"
import { analyzeBashStdinSyntaxForPowerShell } from "@/util/powershell-heredoc"

describe("analyzeBashStdinSyntaxForPowerShell", () => {
  test("detects a quoted Bash heredoc without rewriting it", () => {
    const command = "python - <<'PY'\nprint('$HOME')\nPY"
    expect(analyzeBashStdinSyntaxForPowerShell(command)).toEqual({
      unquotedHeredoc: false,
      quotedHeredoc: true,
      hereString: false,
    })
  })

  test("detects an unquoted Bash heredoc with expansion semantics", () => {
    const command = "python - <<PY\nprint('$HOME')\nprint('$(whoami)')\nprint('$((1 + 2))')\nPY"
    expect(analyzeBashStdinSyntaxForPowerShell(command)).toEqual({
      unquotedHeredoc: true,
      quotedHeredoc: false,
      hereString: false,
    })
  })

  test("detects tab-stripping and CRLF quoted heredocs", () => {
    const command = "python3 - <<-'PY'\r\n\tprint('hello')\r\n\tPY\r\n"
    expect(analyzeBashStdinSyntaxForPowerShell(command)).toMatchObject({
      quotedHeredoc: true,
      unquotedHeredoc: false,
    })
  })

  test("detects fd-qualified and no-space heredocs", () => {
    const fd = "python - 2<<'PY'\nprint(1)\nPY"
    const attached = "python<<'PY'\nprint(1)\nPY"
    expect(analyzeBashStdinSyntaxForPowerShell(fd).quotedHeredoc).toBe(true)
    expect(analyzeBashStdinSyntaxForPowerShell(attached).quotedHeredoc).toBe(true)
  })

  test("detects Bash here-string syntax", () => {
    const command = "python -c 'import sys; print(sys.stdin.read())' <<< 'hello'"
    expect(analyzeBashStdinSyntaxForPowerShell(command)).toMatchObject({
      hereString: true,
    })
  })

  test("ignores heredoc-looking text inside quoted strings", () => {
    const command = "Write-Output \"python - <<'PY'\""
    expect(analyzeBashStdinSyntaxForPowerShell(command)).toEqual({
      unquotedHeredoc: false,
      quotedHeredoc: false,
      hereString: false,
    })
  })

  test("ignores heredoc-looking text in comments", () => {
    const command = "# python - <<'PY'\nWrite-Output ok"
    expect(analyzeBashStdinSyntaxForPowerShell(command)).toEqual({
      unquotedHeredoc: false,
      quotedHeredoc: false,
      hereString: false,
    })
  })

  test("does not mistake a PowerShell literal here-string body for Bash syntax", () => {
    const command = "@'\npython - <<'PY'\n'@ | Write-Output"
    expect(analyzeBashStdinSyntaxForPowerShell(command)).toEqual({
      unquotedHeredoc: false,
      quotedHeredoc: false,
      hereString: false,
    })
  })

  test("leaves ordinary PowerShell commands untouched", () => {
    const command = "Write-Output 'hello'; Get-ChildItem"
    expect(analyzeBashStdinSyntaxForPowerShell(command)).toEqual({
      unquotedHeredoc: false,
      quotedHeredoc: false,
      hereString: false,
    })
  })
})
