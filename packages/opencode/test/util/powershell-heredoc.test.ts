import { describe, expect, test } from "bun:test"
import { rewriteBashHeredocsForPowerShell } from "@/util/powershell-heredoc"

describe("rewriteBashHeredocsForPowerShell", () => {
  test("rewrites a quoted Python heredoc after a command chain", () => {
    const command = "cd packages/opencode && python - <<'PY'\nprint('hello')\nPY"

    expect(rewriteBashHeredocsForPowerShell(command)).toBe("cd packages/opencode && @'\nprint('hello')\n'@ | python -")
  })

  test("supports python3 and tab-stripping heredocs", () => {
    const command = "python3 - <<-PY\n\tprint('hello')\n\tPY\n"

    expect(rewriteBashHeredocsForPowerShell(command)).toBe("@'\nprint('hello')\n'@ | python3 -\n")
  })

  test("does not rewrite unrelated shell syntax", () => {
    const command = "cat <<'EOF'\nhello\nEOF"

    expect(rewriteBashHeredocsForPowerShell(command)).toBe(command)
  })

  test("does not rewrite an unterminated heredoc", () => {
    const command = "python - <<'PY'\nprint('hello')"

    expect(rewriteBashHeredocsForPowerShell(command)).toBe(command)
  })

  test("preserves CRLF bodies and literal dollar signs", () => {
    const command = "python - <<PY\r\nprint('$HOME')\r\nPY\r\n"

    expect(rewriteBashHeredocsForPowerShell(command)).toBe("@'\nprint('$HOME')\r\n'@ | python -\n")
  })

  test("rewrites multiple heredocs in one command", () => {
    const command = "python - <<'PY1'\nprint(1)\nPY1\n; python - <<'PY2'\nprint(2)\nPY2"

    expect(rewriteBashHeredocsForPowerShell(command)).toBe("@'\nprint(1)\n'@ | python -\n; @'\nprint(2)\n'@ | python -")
  })

  test("keeps an explicit PowerShell call operator", () => {
    const command = "& python - <<PY\nprint(1)\nPY"

    expect(rewriteBashHeredocsForPowerShell(command)).toBe("@'\nprint(1)\n'@ | & python -")
  })

  test("uses a collision-safe encoding when both here-string markers occur", () => {
    const command = "python - <<'PY'\n'@\n\"@\nPY"

    expect(rewriteBashHeredocsForPowerShell(command)).toContain(
      "[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('",
    )
    expect(rewriteBashHeredocsForPowerShell(command)).toContain(" | python -")
  })

  test("rewrites stdin-consuming commands like git", () => {
    const command = "git commit -q -F - <<'EOF'\nsubject\n\nbody\nEOF\ngit log --oneline -1"

    expect(rewriteBashHeredocsForPowerShell(command)).toBe(
      "@'\nsubject\n\nbody\n'@ | git commit -q -F -\ngit log --oneline -1",
    )
  })

  test("prepends a UTF-8 preamble for non-ASCII bodies", () => {
    const command = "python - <<'PY'\nprint('héllo ☃')\nPY"

    expect(rewriteBashHeredocsForPowerShell(command)).toBe(
      "$OutputEncoding=[System.Text.UTF8Encoding]::new($false); $env:PYTHONIOENCODING='utf-8'; @'\nprint('héllo ☃')\n'@ | python -",
    )
  })

  test("wraps a quoted interpreter path in a call operator", () => {
    const command = "'C:\\Program Files\\Python312\\python.exe' - <<'PY'\nprint(1)\nPY"

    expect(rewriteBashHeredocsForPowerShell(command)).toBe(
      "@'\nprint(1)\n'@ | & 'C:\\Program Files\\Python312\\python.exe' -",
    )
  })

  test("keeps a call operator after a command chain", () => {
    const command = "cd packages/opencode && & python - <<PY\nprint(1)\nPY"

    expect(rewriteBashHeredocsForPowerShell(command)).toBe(
      "cd packages/opencode && @'\nprint(1)\n'@ | & python -",
    )
  })

  test("leaves an fd-qualified redirection alone", () => {
    const command = "python - 2<<PY\nprint(1)\nPY"

    expect(rewriteBashHeredocsForPowerShell(command)).toBe(command)
  })

  test("leaves a heredoc with extra redirect syntax on the opening line alone", () => {
    const command = "python - <<PY 2>&1\nprint(1)\nPY"

    expect(rewriteBashHeredocsForPowerShell(command)).toBe(command)
  })

  test("leaves a heredoc whose target does not read stdin alone", () => {
    const command = "python <<'PY'\nprint(1)\nPY"

    expect(rewriteBashHeredocsForPowerShell(command)).toBe(command)
  })

  test("leaves a heredoc inside quoted text alone", () => {
    const command = "echo 'a <<PY'\nnot a heredoc"

    expect(rewriteBashHeredocsForPowerShell(command)).toBe(command)
  })

  test("strips leading tabs from the terminator of a tab-stripped heredoc", () => {
    const command = "python - <<-PY\n\tprint(1)\n\t\tPY\r\n"

    expect(rewriteBashHeredocsForPowerShell(command)).toBe("@'\nprint(1)\n'@ | python -\n")
  })

  test("rewrites a heredoc whose body contains no trailing newline", () => {
    const command = "python - <<'PY'\nprint(1)"

    expect(rewriteBashHeredocsForPowerShell(command)).toBe(command)
  })

  test("does not rewrite a target whose argument contains a backtick", () => {
    const command = "python - `ls` <<'PY'\nprint(1)\nPY"

    expect(rewriteBashHeredocsForPowerShell(command)).toBe(command)
  })

  test("rewrites a heredoc that follows a comment line", () => {
    const command = "# run\npython - <<'PY'\nprint(1)\nPY"

    expect(rewriteBashHeredocsForPowerShell(command)).toBe("# run\n@'\nprint(1)\n'@ | python -")
  })
})
