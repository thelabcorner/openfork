import { describe, expect, test } from "bun:test"
import path from "path"
import { Shell } from "@opencode-ai/core/shell"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { which } from "@opencode-ai/core/util/which"
import { spawnSync } from "node:child_process"

const spawnInvocation = (
  shell: string,
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
) => {
  const invocation = Shell.invocation(shell, command, cwd)
  return spawnSync(invocation.command ?? shell, invocation.args, {
    encoding: "utf8",
    shell: invocation.shell,
    env: Shell.withSourceEnvironment({ ...env }, invocation.sourceEnvironment, process.env),
  })
}

const withShell = async (shell: string | undefined, fn: () => void | Promise<void>) => {
  const prev = process.env.SHELL
  if (shell === undefined) delete process.env.SHELL
  else process.env.SHELL = shell
  Shell.acceptable.reset()
  Shell.preferred.reset()
  try {
    await fn()
  } finally {
    if (prev === undefined) delete process.env.SHELL
    else process.env.SHELL = prev
    Shell.acceptable.reset()
    Shell.preferred.reset()
  }
}

describe("shell", () => {
  test("normalizes shell names", () => {
    expect(Shell.name("/bin/bash")).toBe("bash")
    if (process.platform === "win32") {
      expect(Shell.name("C:/tools/NU.EXE")).toBe("nu")
      expect(Shell.name("C:/tools/PWSH.EXE")).toBe("pwsh")
    }
  })

  test("detects login shells", () => {
    expect(Shell.login("/bin/bash")).toBe(true)
    expect(Shell.login("C:/tools/pwsh.exe")).toBe(false)
  })

  test("detects posix shells", () => {
    expect(Shell.posix("/bin/bash")).toBe(true)
    expect(Shell.posix("/bin/fish")).toBe(false)
    expect(Shell.posix("C:/tools/pwsh.exe")).toBe(false)
  })

  test("falls back when configured shell cannot be resolved", async () => {
    await withShell(undefined, async () => {
      const preferred = Shell.preferred()
      const acceptable = Shell.acceptable()
      expect(Shell.preferred("opencode-missing-shell")).toBe(preferred)
      expect(Shell.acceptable("opencode-missing-shell")).toBe(acceptable)
    })
  })

  test("falls back for terminal-only acceptable shells", () => {
    expect(Shell.name(Shell.acceptable("fish"))).not.toBe("fish")
    expect(Shell.name(Shell.acceptable("nu"))).not.toBe("nu")
  })

  test("builds command invocations per shell family", () => {
    const sh = Shell.invocation("/bin/sh", "echo hi", "/tmp")
    expect(sh.args[0]).toBe("-c")
    if (process.platform === "win32") {
      expect(sh.sourceEnvironment?.entries[0]?.value).toBe("echo hi")
      expect(sh.args).not.toContain("echo hi")
    } else {
      expect(sh.args).toEqual(["-c", "echo hi"])
    }

    expect(Shell.invocation("/usr/bin/fish", "echo hi", "/tmp").args).toEqual(["-c", "echo hi"])
    const zsh = Shell.invocation("/bin/zsh", "echo hi", "/tmp")
    expect(zsh.args[0]).toBe("-l")
    expect(zsh.args[1]).toBe("-c")
    expect(zsh.args.at(-1)).toBe(process.platform === "win32" ? "/tmp" : "echo hi")
  })

  test("argv compatibility accessor fails closed when invocation metadata would be lost", () => {
    const pwsh = Bun.which("pwsh") || Bun.which("powershell")
    if (pwsh) {
      expect(Shell.args(pwsh, "Write-Output ok", process.cwd())).toEqual([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Write-Output ok",
      ])
      if (process.platform === "win32") {
        expect(() =>
          Shell.args(pwsh, `#${"x".repeat(Shell.POWERSHELL_INLINE_SCRIPT_LIMIT + 1)}`, process.cwd()),
        ).toThrow("losing transport metadata")
      }
    }
    if (process.platform === "win32") {
      const bash = Shell.gitbash()
      if (bash) expect(() => Shell.args(bash, "printf ok", process.cwd())).toThrow("losing transport metadata")
      expect(() => Shell.args(process.env.COMSPEC || "cmd.exe", "echo ok", process.cwd())).toThrow(
        "losing transport metadata",
      )
    }
  })

  test("passes Bash and zsh command text opaquely instead of interpolating it into the bootstrap program", () => {
    const command = ["printf", "'%s\\\\n'", "'$HOME'", "'\"quoted\"'", "'\\\\tail\\\\'", "'$(printf nested)'"] .join(" ")
    for (const shell of ["/bin/bash", "/bin/zsh"]) {
      const invocation = Shell.invocation(shell, command, "/tmp/path with spaces")
      expect(invocation.args[2]).not.toContain(command)
      if (process.platform === "win32") {
        expect(invocation.sourceEnvironment?.entries[0]?.value).toBe(command)
        expect(invocation.args[2]).toContain(Shell.MSYS_SCRIPT_SOURCE_ENV)
        expect(invocation.args.at(-1)).toBe("/tmp/path with spaces")
      } else {
        expect(invocation.args[2]).toContain("__opencode_session_shell_source=$2")
        expect(invocation.args[2]).toContain('set -- "$1"')
        expect(invocation.args[2]).toContain('eval "$__opencode_session_shell_source"')
        expect(invocation.args.at(-2)).toBe("/tmp/path with spaces")
        expect(invocation.args.at(-1)).toBe(command)
      }
    }
  })

  test("Bash bootstrap preserves quote-sensitive source semantics", () => {
    const shell = Shell.gitbash() ?? which("bash")
    if (!shell) return
    const command = `printf '%s\\n' '$HOME' '\$(printf nested)' '"double"' 'back\\slash'`
    const result = spawnInvocation(shell, command, process.cwd(), {
      ...process.env,
      HOME: "OPENCODE_OUTER_EXPANSION_SENTINEL",
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.replaceAll("\\r\\n", "\\n")).toBe('$HOME\n$(printf nested)\n"double"\nback\\slash\n')
  })

    test("Git Bash environment transport preserves quoted-heredoc bytes and ordinary stdin", () => {
      const shell = Shell.gitbash()
      if (!shell) return
      const body = "alpha 'single' `backtick` $HOME a\\\\b\nβeta ☃\n"
      const command = `node -e "process.stdin.on('data',d=>process.stdout.write(d.toString('hex')))" <<'EOF'\n${body}EOF`
      const invocation = Shell.invocation(shell, command, process.cwd())
      const result = spawnSync(shell, invocation.args, {
        encoding: "utf8",
        input: "UNRELATED_STDIN_SENTINEL\n",
        env: Shell.withSourceEnvironment(process.env, invocation.sourceEnvironment),
      })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout.trim()).toBe(Buffer.from(body, "utf8").toString("hex"))
    })

    test("Git Bash environment transport exceeds the broken ~8 KiB argv boundary without carrying source in argv", () => {
      const shell = Shell.gitbash()
      if (!shell) return
      const payload = "x".repeat(20_000)
      const command = `printf '%s' '${payload}' | wc -c`
      const invocation = Shell.invocation(shell, command, process.cwd())
      expect(invocation.args.join("\n")).not.toContain(payload)
      const result = spawnSync(shell, invocation.args, {
        encoding: "utf8",
        env: Shell.withSourceEnvironment(process.env, invocation.sourceEnvironment),
      })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout.trim()).toBe("20000")
    })

  test("Bash bootstrap does not expose its transport argument as a new positional parameter", () => {
    const shell = Shell.gitbash() ?? which("bash")
    if (!shell) return
    const command = `printf '%s\\n' "$#" "$1" "\${2-unset}"`
    const result = spawnInvocation(shell, command, "cwd-sentinel")
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.replaceAll("\\r\\n", "\\n")).toBe("1\ncwd-sentinel\nunset\n")
  })

  if (process.platform === "win32") {
    test("Git Bash environment transport survives far beyond the reproduced MSYS ~8 KiB argv boundary", () => {
      const shell = Shell.gitbash()
      if (!shell) return
      const size = 100_000
      const command = "X=" + "x".repeat(size) + "; printf '%s' \"\${#X}\""
      const result = spawnInvocation(shell, command, process.cwd())
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toBe(String(size))
    })

    test("Git Bash transport hides source env and restores caller MSYS env-conversion policy", () => {
      const shell = Shell.gitbash()
      if (!shell) return
      const original = "USER_RULE;" + Shell.MSYS_SCRIPT_SOURCE_ENV
      const command = 'printf \'%s\\n\' "${OPENCODE_INTERNAL_SHELL_SOURCE+visible}" "${MSYS2_ENV_CONV_EXCL-unset}"'
      const result = spawnInvocation(shell, command, process.cwd(), {
        ...process.env,
        MSYS2_ENV_CONV_EXCL: original,
      })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout.replaceAll("\r\n", "\n")).toBe("\n" + original + "\n")
    })

    test("Git Bash transport preserves case-insensitive caller MSYS exclusion keys", () => {
      const shell = Shell.gitbash()
      if (!shell) return
      const command = 'printf \'%s\n\' "${MSYS2_ENV_CONV_EXCL-unset}"'
      const result = spawnInvocation(shell, command, process.cwd(), {
        ...process.env,
        MSYS2_ENV_CONV_EXCL: undefined,
        msys2_env_conv_excl: "LOWER_CASE_RULE",
      })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout.trim()).toBe("LOWER_CASE_RULE")
    })

    test("Git Bash transport preserves wildcard MSYS exclusion policy", () => {
      const shell = Shell.gitbash()
      if (!shell) return
      const command = 'printf \'%s\n\' "${MSYS2_ENV_CONV_EXCL-unset}"'
      const result = spawnInvocation(shell, command, process.cwd(), {
        ...process.env,
        MSYS2_ENV_CONV_EXCL: "*",
      })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout.trim()).toBe("*")
    })

    test("Git Bash transport preserves an explicitly empty MSYS exclusion policy", () => {
      const shell = Shell.gitbash()
      if (!shell) return
      const command = 'printf \'<%s>\\n\' "${MSYS2_ENV_CONV_EXCL-unset}"'
      const result = spawnInvocation(shell, command, process.cwd(), {
        ...process.env,
        MSYS2_ENV_CONV_EXCL: "",
      })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout.trim()).toBe("<>")
    })

    test("source-environment construction canonicalizes case-insensitive transport keys", () => {
      const source = Shell.msysScriptTransport("/usr/bin/printf source-ok").sourceEnvironment
      const env = Shell.withSourceEnvironment(
        {
          opencode_internal_shell_source: "stale",
          msys2_env_conv_excl: "LOWER_CASE_RULE",
        },
        source,
      )
      expect(env.opencode_internal_shell_source).toBeUndefined()
      expect(env.msys2_env_conv_excl).toBeUndefined()
      expect(env[Shell.MSYS_SCRIPT_SOURCE_ENV]).toBe(source.entries[0]?.value)
      expect(env.MSYS2_ENV_CONV_EXCL).toBe(`LOWER_CASE_RULE;${Shell.MSYS_SCRIPT_SOURCE_ENV}`)
    })

    test("Git Bash transport excludes path-looking shell source from MSYS environment conversion", () => {
      const shell = Shell.gitbash()
      if (!shell) return
      const result = spawnInvocation(shell, "/usr/bin/printf '%s' env-ok", process.cwd())
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toBe("env-ok")
    })

    test("Git Bash source environment preserves CRLF and Unicode bytes before Bash parses the script", () => {
      const shell = Shell.gitbash()
      if (!shell) return
      const source = "printf one\r\nprintf βeta 雪☃ emoji-😀\r\n"
      const transport = Shell.msysScriptTransport(source)
      const key = transport.sourceEnvironment.entries[0]!.key
      const probe = `printf '%s' "$${key}" | od -An -v -tx1`
      const result = spawnSync(shell, ["-c", probe], {
        encoding: "utf8",
        env: Shell.withSourceEnvironment(process.env, transport.sourceEnvironment),
      })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout.replace(/\s+/g, "")).toBe(Buffer.from(source, "utf8").toString("hex"))
    })

    test("Git Bash environment source transport leaves stdin available to the authored program", () => {
      const shell = Shell.gitbash()
      if (!shell) return
      const command = "IFS= read -r value; printf '%s' \"$value\""
      const invocation = Shell.invocation(shell, command, process.cwd())
      const result = spawnSync(shell, invocation.args, {
        encoding: "utf8",
        input: "stdin-ok\n",
        env: Shell.withSourceEnvironment(process.env, invocation.sourceEnvironment),
      })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toBe("stdin-ok")
    })

    test("uses the cmd shell adapter and deterministic PowerShell automation prefix", () => {
      const cmd = process.env.COMSPEC || "cmd.exe"
      expect(Shell.invocation(cmd, "echo ok", process.cwd())).toMatchObject({
        command: "echo ok",
        args: [],
        shell: cmd,
      })
      const pwsh = Bun.which("pwsh") || Bun.which("powershell")
      if (!pwsh) return
      expect(Shell.invocation(pwsh, "Write-Output ok", process.cwd()).args.slice(0, -1)).toEqual([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
      ])
    })


    test("routes oversized Windows PowerShell source through chunked environment transport", () => {
      const powershells = [Bun.which("pwsh"), Bun.which("powershell")].filter((item): item is string => Boolean(item))
      for (const pwsh of powershells) {
        const size = 100_000
        const command = `#${"x".repeat(size)}\nWrite-Output '${size}'`
        const invocation = Shell.invocation(pwsh, command, process.cwd())
        expect(invocation.args.join("\n")).not.toContain(command)
        expect(invocation.sourceEnvironment?.entries.length).toBeGreaterThan(1)
        expect(
          invocation.sourceEnvironment?.entries.every((entry) => entry.value.length <= Shell.POWERSHELL_ENV_SCRIPT_CHUNK_LIMIT),
        ).toBe(true)
        expect(invocation.sourceEnvironment?.entries.map((entry) => entry.value).join("")).toBe(command)
        const result = spawnInvocation(pwsh, command, process.cwd())
        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout.trim()).toBe(String(size))
      }
    })

    test("PowerShell environment transport preserves surrogate pairs, hides source entries, and leaves stdin available", () => {
      const powershells = [Bun.which("pwsh"), Bun.which("powershell")].filter((item): item is string => Boolean(item))
      for (const pwsh of powershells) {
        const padding = "x".repeat(Shell.POWERSHELL_ENV_SCRIPT_CHUNK_LIMIT - 1) + "😀" + "y".repeat(10_000)
        const command = [
          `#${padding}`,
          `Write-Output ([bool](Get-ChildItem Env:${Shell.POWERSHELL_SCRIPT_SOURCE_ENV_PREFIX}* -ErrorAction SilentlyContinue))`,
          "Write-Output ([Console]::In.ReadLine())",
        ].join("\n")
        const invocation = Shell.invocation(pwsh, command, process.cwd())
        expect(invocation.sourceEnvironment?.entries.map((entry) => entry.value).join("")).toBe(command)
        const result = spawnSync(pwsh, invocation.args, {
          encoding: "utf8",
          input: "stdin-ok\n",
          env: Shell.withSourceEnvironment(process.env, invocation.sourceEnvironment),
        })
        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout.trim().replaceAll("\r\n", "\n")).toBe("False\nstdin-ok")
      }
    })

    test("PowerShell environment transport fails closed when an expected source chunk is missing", () => {
      const powershells = [Bun.which("pwsh"), Bun.which("powershell")].filter((item): item is string => Boolean(item))
      for (const pwsh of powershells) {
        const n = Shell.POWERSHELL_ENV_SCRIPT_CHUNK_LIMIT
        const command =
          "#" +
          "a".repeat(n - 1) +
          "\n#" +
          "b".repeat(n - 2) +
          "\nWrite-Output 'must-not-run-after-missing-chunk'"
        const transport = Shell.powershellScriptTransport(command)
        expect(transport.sourceEnvironment.entries.length).toBeGreaterThanOrEqual(3)
        const env = Shell.withSourceEnvironment({ ...process.env }, transport.sourceEnvironment, process.env)
        const missing = transport.sourceEnvironment.entries[1]
        expect(missing).toBeDefined()
        if (!missing) continue
        delete env[missing.key]

        const result = spawnSync(pwsh, [...Shell.POWERSHELL_AUTOMATION_ARGS, transport.script], {
          encoding: "utf8",
          env,
        })
        expect(result.status).not.toBe(0)
        expect(result.stdout).not.toContain("must-not-run-after-missing-chunk")
expect(result.stderr).toContain("OpenFork PowerShell source transport is incomplete: missing chunk")
      }
    })

    test("PowerShell environment transport fails closed when reconstructed source length changes", () => {
      const powershells = [Bun.which("pwsh"), Bun.which("powershell")].filter((item): item is string => Boolean(item))
      for (const pwsh of powershells) {
        const command = "#" + "x".repeat(Shell.POWERSHELL_ENV_SCRIPT_CHUNK_LIMIT + 100) + "\nWrite-Output 'must-not-run-after-truncation'"
        const transport = Shell.powershellScriptTransport(command)
        const env = Shell.withSourceEnvironment({ ...process.env }, transport.sourceEnvironment, process.env)
        const entry = transport.sourceEnvironment.entries[0]
        expect(entry).toBeDefined()
        if (!entry) continue
        env[entry.key] = entry.value.slice(0, -1)

        const result = spawnSync(pwsh, [...Shell.POWERSHELL_AUTOMATION_ARGS, transport.script], {
          encoding: "utf8",
          env,
        })
        expect(result.status).not.toBe(0)
        expect(result.stdout).not.toContain("must-not-run-after-truncation")
expect(result.stderr).toContain("OpenFork PowerShell source transport length mismatch")
      }
    })

    test("rejects multiline cmd.exe input before the silent-prefix execution path", () => {
      expect(() => Shell.invocation(process.env.COMSPEC || "cmd.exe", "echo one\necho two", process.cwd())).toThrow(
        "multiline cmd.exe program",
      )
    })

    test("cmd environment validation rejects only referenced inherited values above the cmd limit", () => {
      const cmd = process.env.COMSPEC || "cmd.exe"
      const key = "OPENFORK_CMD_ENV_LIMIT_TEST"
      const oversized = "x".repeat(Shell.CMD_INHERITED_ENV_LIMIT + 1)
      expect(() => Shell.validateInvocationEnvironment(cmd, `echo %${key}%`, { [key]: oversized })).toThrow(
        "Cannot execute this cmd.exe script faithfully",
      )
      expect(() => Shell.validateInvocationEnvironment(cmd, `echo %${key}:~0,10%`, { [key]: oversized })).toThrow(
        "Cannot execute this cmd.exe script faithfully",
      )
      expect(() => Shell.validateInvocationEnvironment(cmd, "node child.js", { [key]: oversized })).not.toThrow()
      expect(() =>
        Shell.validateInvocationEnvironment(cmd, `echo %${key}%`, {
          [key]: "x".repeat(Shell.CMD_INHERITED_ENV_LIMIT),
        }),
      ).not.toThrow()
      expect(() =>
        Shell.validateInvocationEnvironment(cmd, `echo %${key}%`, {
          [key]: oversized,
          [key.toLowerCase()]: "small-later-duplicate",
        }),
      ).toThrow("Cannot execute this cmd.exe script faithfully")
      expect(() =>
        Shell.validateInvocationEnvironment(cmd, `echo %${key}%`, {
          [key.toLowerCase()]: "small-first-duplicate",
          [key]: oversized,
        }),
      ).not.toThrow()
    })

    test("rejects blacklisted shells case-insensitively", async () => {
      await withShell("NU.EXE", async () => {
        expect(Shell.name(Shell.acceptable())).not.toBe("nu")
      })
    })

    test("normalizes Git Bash shell paths from env", async () => {
      const shell = "/cygdrive/c/Program Files/Git/bin/bash.exe"
      await withShell(shell, async () => {
        expect(Shell.preferred()).toBe(FSUtil.windowsPath(shell))
      })
    })

    test("resolves /usr/bin/bash from env to Git Bash", async () => {
      const bash = Shell.gitbash()
      if (!bash) return
      await withShell("/usr/bin/bash", async () => {
        expect(Shell.acceptable()).toBe(bash)
        expect(Shell.preferred()).toBe(bash)
      })
    })

    test("resolves bare bash to Git Bash before PATH", async () => {
      const bash = Shell.gitbash()
      if (!bash) return
      expect(Shell.acceptable("bash")).toBe(bash)
      expect(Shell.preferred("bash")).toBe(bash)
      await withShell("bash", async () => {
        expect(Shell.acceptable()).toBe(bash)
        expect(Shell.preferred()).toBe(bash)
      })
    })

    test("resolves bare PowerShell shells", async () => {
      const shell = which("pwsh") || which("powershell")
      if (!shell) return
      await withShell(path.win32.basename(shell), async () => {
        expect(Shell.preferred()).toBe(shell)
      })
    })
  }
})
