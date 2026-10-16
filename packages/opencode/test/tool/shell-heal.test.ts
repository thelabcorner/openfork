import { describe, expect, test } from "bun:test"
import { ShellHeal } from "@/tool/shell/heal"

describe("ShellHeal.stripAnsi", () => {
  test("removes SGR color and OSC hyperlink sequences but keeps the text", () => {
    const input =
      "\u001b[31;1mgrep: \u001b[0mThe term is not recognized\r\n\u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\done"
    const output = ShellHeal.stripAnsi(input)
    expect(output).not.toContain("\u001b")
    expect(output).toContain("grep: The term is not recognized")
    expect(output).toContain("linkdone")
  })

  test("leaves ordinary text untouched", () => {
    expect(ShellHeal.stripAnsi("plain text\r\n")).toBe("plain text\r\n")
  })
})

const GREP_ERROR =
  "grep: The term 'grep' is not recognized as a name of a cmdlet, function, script file, or executable program."

describe("ShellHeal.hints", () => {
  test("maps a PowerShell command-not-found to the Find tool", () => {
    const block = ShellHeal.hints({ command: "grep -rn status .", output: GREP_ERROR, dialect: "powershell", exit: 1 })
    expect(block).toBeDefined()
    expect(block).toContain('<shell_heal dialect="powershell" exit="1">')
    expect(block).toContain("`grep` is not installed in this shell.")
    expect(block).toContain("Find tool with the `grep` parameter")
    expect(block).toContain("This runtime is PowerShell, not Bash")
    expect(block).toContain("</shell_heal>")
  })

  test("detects command-not-found inside ANSI-colored output", () => {
    const block = ShellHeal.hints({
      command: "sed -n 1,2p file.ts",
      output: `\u001b[31;1msed\u001b[0m: The term 'sed' is not recognized as a name of a cmdlet, function, script file, or executable program.`,
      dialect: "powershell",
      exit: 1,
    })
    expect(block).toContain("`sed` is not installed in this shell.")
    expect(block).toContain("Surgical text changes: use the Edit tool.")
  })

  test("maps head and tail to the Read tool", () => {
    const block = ShellHeal.hints({
      command: "ls | head -50",
      output: "head: The term 'head' is not recognized as a name of a cmdlet, function, script file, or executable program.",
      dialect: "powershell",
      exit: 1,
    })
    expect(block).toContain("`head` is not installed in this shell.")
    expect(block).toContain("Read tool")
  })

  test("maps a cmd.exe command-not-found to the Find tool", () => {
    const block = ShellHeal.hints({
      command: "grep -rn status .",
      output: "'grep' is not recognized as an internal or external command,\r\noperable program or batch file.",
      dialect: "cmd",
      exit: 1,
    })
    expect(block).toContain('<shell_heal dialect="cmd" exit="1">')
    expect(block).toContain("Find tool with the `grep` parameter")
    expect(block).toContain("This runtime is cmd.exe, not Bash")
  })

  test("flags /dev/null in the command on Windows runtimes", () => {
    const block = ShellHeal.hints({ command: "ls foo 2>/dev/null", output: "", dialect: "powershell", exit: 0 })
    expect(block).toContain("/dev/null")
    expect(block).toContain("$null")
  })

  test("flags the Out-File /dev/null path failure", () => {
    const block = ShellHeal.hints({
      command: "ls missing 2>/dev/null; ls .",
      output: "Out-File: Could not find a part of the path 'C:\\dev\\null'.",
      dialect: "powershell",
      exit: 1,
    })
    expect(block).toContain("/dev/null")
  })

  test("coaches PowerShell parse errors toward PowerShell syntax", () => {
    const block = ShellHeal.hints({
      command: "cat <<EOF > x",
      output: "ParserError: Missing file specification after redirection operator.",
      dialect: "powershell",
      exit: 1,
    })
    expect(block).toContain("parse error")
  })

  test("deduplicates repeated failures and caps the hint list", () => {
    const repeated = [GREP_ERROR, GREP_ERROR, GREP_ERROR].join("\r\n")
    const block = ShellHeal.hints({ command: "grep a .", output: repeated, dialect: "powershell", exit: 1 })
    expect(block?.match(/is not installed in this shell/g)?.length).toBe(1)

    const many = [
      GREP_ERROR,
      "head: The term 'head' is not recognized as a name of a cmdlet, function, script file, or executable program.",
      "tail: The term 'tail' is not recognized as a name of a cmdlet, function, script file, or executable program.",
      "sed: The term 'sed' is not recognized as a name of a cmdlet, function, script file, or executable program.",
      "awk: The term 'awk' is not recognized as a name of a cmdlet, function, script file, or executable program.",
    ].join("\r\n")
    const capped = ShellHeal.hints({ command: "grep a .", output: many, dialect: "powershell", exit: 1 })
    expect(capped?.match(/<issue>/g)?.length).toBe(4)
  })

  test("fails open for unrelated failures and non-Windows dialects", () => {
    expect(
      ShellHeal.hints({ command: "Get-Item missing", output: "Access is denied.", dialect: "powershell", exit: 1 }),
    ).toBeUndefined()
    expect(ShellHeal.hints({ command: "grep a .", output: GREP_ERROR, dialect: "bash", exit: 1 })).toBeUndefined()
    expect(ShellHeal.hints({ command: "company-shell foo", output: GREP_ERROR, dialect: "unknown", exit: 1 })).toBeUndefined()
  })
})
