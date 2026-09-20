import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { GitRuntime } from "@opencode-ai/core/git-runtime"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")

describe("GitRuntime", () => {
  test("repository attributes and editor defaults agree with the runtime invariant", () => {
    const attributes = fs.readFileSync(path.join(repoRoot, ".gitattributes"), "utf8")
    const editor = fs.readFileSync(path.join(repoRoot, ".editorconfig"), "utf8")
    expect(attributes).toContain("* text=auto eol=lf")
    expect(attributes).toContain("*.bat text eol=crlf")
    expect(attributes).toContain("*.cmd text eol=crlf")
    expect(editor).toContain("end_of_line = lf")

    const text = spawnSync("git", ["check-attr", "text", "eol", "--", "README.md"], {
      cwd: repoRoot,
      encoding: "utf8",
    })
    expect(text.status, text.stderr).toBe(0)
    expect(text.stdout).toContain("README.md: text: auto")
    expect(text.stdout).toContain("README.md: eol: lf")

    const batch = spawnSync("git", ["check-attr", "text", "eol", "--", "extensions/chrome/host/native-host.bat"], {
      cwd: repoRoot,
      encoding: "utf8",
    })
    expect(batch.status, batch.stderr).toBe(0)
    expect(batch.stdout).toContain("native-host.bat: text: set")
    expect(batch.stdout).toContain("native-host.bat: eol: crlf")
  })

  test("preserves inherited command config and appends the LF policy", () => {
    const env = GitRuntime.environment({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "fetch.prune",
      GIT_CONFIG_VALUE_0: "true",
    })

    expect(env.GIT_CONFIG_COUNT).toBe("3")
    expect(env.GIT_CONFIG_KEY_0).toBe("fetch.prune")
    expect(env.GIT_CONFIG_VALUE_0).toBe("true")
    expect(env.GIT_CONFIG_KEY_1).toBe("core.autocrlf")
    expect(env.GIT_CONFIG_VALUE_1).toBe("false")
    expect(env.GIT_CONFIG_KEY_2).toBe("core.eol")
    expect(env.GIT_CONFIG_VALUE_2).toBe("lf")
  })

  test("repairs malformed inherited command config instead of propagating a Git error", () => {
    const env = GitRuntime.environment({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "fetch.prune",
      GIT_CONFIG_VALUE_0: "true",
    })

    expect(env.GIT_CONFIG_COUNT).toBe("2")
    expect(env.GIT_CONFIG_KEY_0).toBe("core.autocrlf")
    expect(env.GIT_CONFIG_VALUE_0).toBe("false")
    expect(env.GIT_CONFIG_KEY_1).toBe("core.eol")
    expect(env.GIT_CONFIG_VALUE_1).toBe("lf")
  })

  test("reapplication is idempotent and does not grow command-scope config", () => {
    let env: NodeJS.ProcessEnv = {
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "fetch.prune",
      GIT_CONFIG_VALUE_0: "true",
      GIT_CONFIG_KEY_1: "core.autocrlf",
      GIT_CONFIG_VALUE_1: "false",
      GIT_CONFIG_KEY_2: "core.eol",
      GIT_CONFIG_VALUE_2: "lf",
    }
    for (let i = 0; i < 100; i++) env = GitRuntime.environment(env)

    expect(env.GIT_CONFIG_COUNT).toBe("3")
    expect(env.GIT_CONFIG_KEY_0).toBe("fetch.prune")
    expect(env.GIT_CONFIG_VALUE_0).toBe("true")
    expect(env.GIT_CONFIG_KEY_1).toBe("core.autocrlf")
    expect(env.GIT_CONFIG_VALUE_1).toBe("false")
    expect(env.GIT_CONFIG_KEY_2).toBe("core.eol")
    expect(env.GIT_CONFIG_VALUE_2).toBe("lf")
  })

  test("puts defaults before caller argv so an explicit later -c remains intentional override", () => {
    expect(GitRuntime.args(["-c", "core.autocrlf=true", "status"])).toEqual([
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.eol=lf",
      "-c",
      "core.autocrlf=true",
      "status",
    ])
  })

  test("Windows treats differently-cased override keys as the same environment variable", () => {
    if (process.platform !== "win32") return
    const env = GitRuntime.environment(
      {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "fetch.prune",
        GIT_CONFIG_VALUE_0: "false",
      },
      {
        git_config_count: "1",
        git_config_key_0: "fetch.prune",
        git_config_value_0: "true",
      },
    )

    expect(env.GIT_CONFIG_COUNT).toBe("3")
    expect(env.GIT_CONFIG_KEY_0).toBe("fetch.prune")
    expect(env.GIT_CONFIG_VALUE_0).toBe("true")
    expect(Object.keys(env).some((key) => key === "git_config_count")).toBe(false)
  })
})
