import { describe, expect, test } from "bun:test"
import { CMD_INLINE_SCRIPT_LIMIT, POWERSHELL_INLINE_SCRIPT_LIMIT, ShellLaunch } from "@/tool/shell/launch"


describe("ShellLaunch.profile", () => {
  test("describes Windows PowerShell independently from the host label", () => {
    const value = ShellLaunch.profile("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "win32")
    expect(value).toMatchObject({
      platform: "win32",
      shellName: "powershell",
      dialect: "powershell",
      invocationProtocol: "powershell-command",
      pathEnvironment: "native-windows",
      nativeArgMode: "powershell-legacy",
      persistent: false,
      transport: "script-string",
    })
  })

  test("classifies Git Bash on Windows as a POSIX/MSYS path environment", () => {
    const value = ShellLaunch.profile("C:\\Program Files\\Git\\bin\\bash.exe", "win32")
    expect(value).toMatchObject({
      platform: "win32",
      shellName: "bash",
      dialect: "bash",
      invocationProtocol: "posix-c",
      pathEnvironment: "msys-git-bash",
      nativeArgMode: "shell-native",
    })
  })

  test("does not guess pwsh native argv mode from the executable name", () => {
    expect(ShellLaunch.profile("C:\\Program Files\\PowerShell\\7\\pwsh.exe", "win32")).toMatchObject({
      nativeArgMode: "powershell-version-dependent",
    })
  })

  test("classifies zsh on a POSIX host", () => {
    expect(ShellLaunch.profile("/bin/zsh", "darwin")).toMatchObject({
      shellName: "zsh",
      dialect: "zsh",
      pathEnvironment: "native-posix",
      nativeArgMode: "shell-native",
    })
  })

  test("does not pretend an unknown wrapper executable is POSIX", () => {
    expect(ShellLaunch.profile("C:\\tools\\company-shell.exe", "win32")).toMatchObject({
      shellName: "company-shell",
      dialect: "unknown",
      invocationProtocol: "generic-shell-adapter",
      pathEnvironment: "native-windows",
      nativeArgMode: "unknown",
    })
  })
})

describe("ShellLaunch.plan", () => {
  const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe"

  test("keeps short PowerShell source as the interpreter script when no transport bootstrap is needed", () => {
    const script = "Write-Output 'hello'"
    const value = ShellLaunch.plan(pwsh, script, "win32")
    expect(value.sourceScript).toBe(script)
    expect(value.interpreterScript).toBe(script)
    expect(value.command).toBe(pwsh)
    expect(value.args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"])
    expect(value.args.at(-1)).toBe(script)
    expect(value.shell).toBeUndefined()
  })

  test("rejects a quoted Bash heredoc because PowerShell changes its newline bytes", () => {
    const script = "python - <<'PY'\nprint('$HOME')\nPY"
    expect(() => ShellLaunch.plan(pwsh, script, "win32")).toThrow(
      "Cannot safely translate a quoted Bash heredoc through PowerShell",
    )
  })

  test("keeps short PowerShell source as the process script when no transport bootstrap is needed", () => {
    const script = "Write-Output '$HOME'; & tool.exe 'a b'"
    const value = ShellLaunch.plan(pwsh, script, "win32")
    expect(value.sourceScript).toBe(value.interpreterScript)
  })

  test("routes oversized Windows PowerShell source around the native command-line boundary", () => {
    const script = "x".repeat(POWERSHELL_INLINE_SCRIPT_LIMIT + 1)
    const value = ShellLaunch.plan(pwsh, script, "win32")
    expect(value.sourceTransport).toBe("environment")
    expect(value.sourceEnvironment?.entries.map((entry) => entry.value).join("")).toBe(script)
    expect(value.args.join("\n")).not.toContain(script)
    expect(value.interpreterScript).not.toBe(script)
  })

  test("invokes known PowerShell explicitly on POSIX instead of adding a generic shell adapter", () => {
    const script = "Write-Output 'hello-posix-pwsh'"
    const value = ShellLaunch.plan("/usr/bin/pwsh", script, "linux")
    expect(value).toMatchObject({
      sourceScript: script,
      interpreterScript: script,
      command: "/usr/bin/pwsh",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      sourceTransport: "argv",
      detached: true,
    })
    expect(value.shell).toBeUndefined()
    expect(value.profile.invocationProtocol).toBe("powershell-command")
  })

  test("does not cross-translate Bash heredocs for PowerShell on POSIX", () => {
    expect(() => ShellLaunch.plan("/usr/bin/pwsh", "cat <<'EOF'\nhello\nEOF", "linux")).toThrow(
      "Cannot execute a quoted Bash heredoc through PowerShell without cross-translating shell languages",
    )
  })

  test("rejects an expanding Bash heredoc instead of silently literalizing it", () => {
    expect(() => ShellLaunch.plan(pwsh, "python - <<PY\nprint('$HOME')\nPY", "win32")).toThrow(
      "Cannot execute an unquoted Bash heredoc through PowerShell without changing semantics",
    )
  })

  test("rejects the whole plan when quoted and expanding heredocs are mixed", () => {
    const script = "python - <<'A'\nprint('literal')\nA\n; python - <<B\nprint('$HOME')\nB"
    expect(() => ShellLaunch.plan(pwsh, script, "win32")).toThrow(
      "Cannot execute an unquoted Bash heredoc through PowerShell without changing semantics",
    )
  })

  test("rejects Bash here-string syntax", () => {
    expect(() => ShellLaunch.plan(pwsh, "Write-Output hi <<< world", "win32")).toThrow(
      "Cannot execute Bash here-string syntax (`<<<`) through PowerShell",
    )
  })

  test("does not reject Bash-looking stdin syntax inside PowerShell strings or comments", () => {
    for (const script of ["Write-Output \"python - <<'PY'\"", "# python - <<'PY'\nWrite-Output ok"]) {
      expect(() => ShellLaunch.plan(pwsh, script, "win32")).not.toThrow()
    }
  })

  test("POSIX shell-string plans directly invoke the resolved interpreter with an opaque -c argument", () => {
    const script = "printf '%s\\n' '$HOME'"
    const value = ShellLaunch.plan("/bin/bash", script, "linux")
    expect(value).toMatchObject({
      sourceScript: script,
      interpreterScript: script,
      command: "/bin/bash",
      args: ["-c", script],
      detached: true,
    })
    expect(value.shell).toBeUndefined()
  })

  test("rejects oversized inline cmd scripts before the platform truncation boundary", () => {
    const cmd = "C:\\Windows\\System32\\cmd.exe"
    expect(() => ShellLaunch.plan(cmd, "x".repeat(CMD_INLINE_SCRIPT_LIMIT), "win32")).not.toThrow()
    expect(() => ShellLaunch.plan(cmd, "x".repeat(CMD_INLINE_SCRIPT_LIMIT + 1), "win32")).toThrow(
      "8191-character command-line limit",
    )
  })

  test("routes Windows Git Bash source through the byte-safe environment transport", () => {
    const bash = "C:\\Program Files\\Git\\bin\\bash.exe"
    const script = "x".repeat(10_000)
    const value = ShellLaunch.plan(bash, script, "win32")
    expect(value.sourceTransport).toBe("environment")
    expect(value.args.join("\n")).not.toContain(script)
    expect(value.sourceScript).toBe(script)
  })

  test("the Git Bash transport keeps user source out of argv and reserves only its private environment key", () => {
    const bash = "C:\\Program Files\\Git\\bin\\bash.exe"
    const script = String.raw`printf '%s\\n' '$HOME' '$(printf nested)' 'a\\\\b'`
    const value = ShellLaunch.plan(bash, script, "win32")
    expect(value.args.join("\n")).not.toContain(script)
    expect(value.sourceEnvironment?.entries).toEqual([{ key: "OPENCODE_INTERNAL_SHELL_SOURCE", value: script }])
    expect(value.sourceEnvironment?.msysExclusions).toEqual(["OPENCODE_INTERNAL_SHELL_SOURCE"])
    expect(value.interpreterScript).toContain('unset OPENCODE_INTERNAL_SHELL_SOURCE')
    expect(value.interpreterScript).toContain('eval "$__opencode_internal_shell_source_4f73b6a1"')
  })

  test("keeps large Git Bash source out of argv without reintroducing the old ~8 KiB boundary", () => {
    const bash = "C:\\Program Files\\Git\\bin\\bash.exe"
    const script = "x".repeat(100_000)
    const value = ShellLaunch.plan(bash, script, "win32")
    expect(value.sourceTransport).toBe("environment")
    expect(value.sourceEnvironment?.entries[0]?.value).toBe(script)
    expect(value.args.join("\n")).not.toContain(script)
  })

  test("rejects actual NUL source but not a literal backslash-zero sequence", () => {
    const bash = "C:\\Program Files\\Git\\bin\\bash.exe"
    expect(() => ShellLaunch.plan(bash, "printf \'\\\\0\'", "win32")).not.toThrow()
    expect(() => ShellLaunch.plan(bash, "printf before\0after", "win32")).toThrow("NUL bytes")
  })

  test("uses the Node/cross-spawn cmd shell adapter after fail-closed validation", () => {
    const cmd = "C:\\Windows\\System32\\cmd.exe"
    const value = ShellLaunch.plan(cmd, "echo ok", "win32")
    expect(value.command).toBe("echo ok")
    expect(value.args).toEqual([])
    expect(value.shell).toBe(cmd)
    expect(value.sourceTransport).toBe("shell-option")
    expect(value.detached).toBe(false)
  })

  test("keeps a short cmd script below the conservative inline budget", () => {
    const script = "echo ok"
    expect(ShellLaunch.plan("C:\\Windows\\System32\\cmd.exe", script, "win32")).toMatchObject({
      sourceScript: script,
      interpreterScript: script,
    })
  })

  test("rejects multiline inline cmd scripts instead of silently executing only the first line", () => {
    expect(() => ShellLaunch.plan("C:\\Windows\\System32\\cmd.exe", "echo one\necho two", "win32")).toThrow(
      "executing only the first line",
    )
  })
})
