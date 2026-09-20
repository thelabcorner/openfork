import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import * as ProcessEnvironment from "../src/process-environment"

describe("ProcessEnvironment.merge", () => {
  test("Windows explicit overrides replace inherited keys case-insensitively", () => {
    expect(ProcessEnvironment.merge({ PATH: "base" }, { Path: "override" }, "win32")).toEqual({
      Path: "override",
    })
  })

  test("Windows ambiguous base maps preserve the first logical entry", () => {
    expect(ProcessEnvironment.merge({ OPENFORK_CASE: "first", openfork_case: "second" }, undefined, "win32")).toEqual({
      OPENFORK_CASE: "first",
    })
  })

  test("Windows later explicit overrides win even when their casing changes", () => {
    expect(
      ProcessEnvironment.merge(
        { OPENFORK_CASE: "base" },
        { OpenFork_Case: "one", openfork_case: "two" },
        "win32",
      ),
    ).toEqual({ openfork_case: "two" })
  })

  test("POSIX environment names remain case-sensitive", () => {
    expect(ProcessEnvironment.merge({ PATH: "upper" }, { Path: "mixed" }, "linux")).toEqual({
      PATH: "upper",
      Path: "mixed",
    })
  })

  test("canonicalized Windows override is what cmd actually observes", () => {
    if (process.platform !== "win32") return
    const cmd = process.env.COMSPEC || "cmd.exe"
    const key = "OPENFORK_ENV_MERGE_ORACLE"
    const env = ProcessEnvironment.merge(process.env, { [key.toLowerCase()]: "override-visible" }, "win32")
    const result = spawnSync(`echo [%${key}%]`, [], { shell: cmd, encoding: "utf8", env })
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe("[override-visible]")
  })
})
