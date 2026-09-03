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
})
