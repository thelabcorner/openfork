import { describe, expect, test } from "bun:test"
import path from "node:path"
import {
  javascriptRuntime,
  nestedStandaloneScriptRequest,
  type JavaScriptRuntimeInfo,
  userChildEnvironment,
} from "../../src/util/javascript-runtime"

const nodeVersions = {}

describe("javascript runtime", () => {
  test("uses process.execPath directly under Node", () => {
    const runtime = javascriptRuntime({ execPath: "/runtime/node", versions: nodeVersions, bun: null })

    expect(runtime).toEqual({
      kind: "node",
      execPath: "/runtime/node",
      standalone: false,
      script: {
        command: "/runtime/node",
        args: [],
        env: {},
      },
    })
  })

  test("marks Electron descendants for run-as-node", () => {
    const runtime = javascriptRuntime({
      execPath: "C:/app/electron.exe",
      versions: { electron: "42.3.3" },
      bun: null,
    })

    expect(runtime.kind).toBe("electron")
    expect(runtime.script).toEqual({
      command: "C:/app/electron.exe",
      args: [],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    })
  })

  test("uses Bun CLI mode for standalone executables", () => {
    const runtime = javascriptRuntime({
      execPath: "C:/bin/opencode.exe",
      versions: nodeVersions,
      bun: { isStandaloneExecutable: true },
    })

    expect(runtime.kind).toBe("bun")
    expect(runtime.standalone).toBe(true)
    expect(runtime.script.env).toEqual({ BUN_BE_BUN: "1" })
  })

  test("detects Bun 1.3 standalone executables from the virtual main path", () => {
    const runtime = javascriptRuntime({
      execPath: "C:/bin/opencode.exe",
      versions: nodeVersions,
      argv: ["bun", "B:/~BUN/root/opencode.exe"],
      bunMain: "B:/~BUN/root/opencode.exe",
      bun: {},
    })

    expect(runtime.kind).toBe("bun")
    expect(runtime.standalone).toBe(true)
    expect(runtime.script.env).toEqual({ BUN_BE_BUN: "1" })
  })

  test("does not mistake ordinary Bun execution for a standalone executable", () => {
    const runtime = javascriptRuntime({
      execPath: "C:/Users/me/.bun/bin/bun.exe",
      versions: nodeVersions,
      argv: ["C:/Users/me/.bun/bin/bun.exe", "C:/project/src/index.ts"],
      bunMain: "C:/project/src/index.ts",
      bun: {},
    })

    expect(runtime.kind).toBe("bun")
    expect(runtime.standalone).toBe(false)
    expect(runtime.script.env).toEqual({})
  })
})

describe("nested standalone script reroute", () => {
  const runtime: JavaScriptRuntimeInfo = {
    kind: "bun",
    execPath: "C:/bin/opencode.exe",
    standalone: true,
    script: {
      command: "C:/bin/opencode.exe",
      args: [],
      env: { BUN_BE_BUN: "1" },
    },
  }

  test("recognizes a script launch inherited from a parent OpenCode process", () => {
    const cwd = process.cwd()
    const request = nestedStandaloneScriptRequest({
      argv: ["scripts/indexer.js", "--changed", "foo.ts"],
      env: { OPENCODE: "1", OPENCODE_PID: "1234" },
      cwd,
      pid: 5678,
      runtime,
      isFile: () => true,
    })

    expect(request).toEqual({
      file: path.resolve(cwd, "scripts/indexer.js"),
      args: ["--changed", "foo.ts"],
    })
  })

  test("does not reroute normal OpenCode CLI children", () => {
    const request = nestedStandaloneScriptRequest({
      argv: ["run", "hello"],
      env: { OPENCODE: "1", OPENCODE_PID: "1234" },
      pid: 5678,
      runtime,
      isFile: () => true,
    })

    expect(request).toBeUndefined()
  })

  test("requires a distinct inherited OpenCode pid", () => {
    const request = nestedStandaloneScriptRequest({
      argv: ["indexer.js"],
      env: { OPENCODE: "1", OPENCODE_PID: "5678" },
      pid: 5678,
      runtime,
      isFile: () => true,
    })

    expect(request).toBeUndefined()
  })

  test("never reroutes after Bun CLI mode is already active", () => {
    const request = nestedStandaloneScriptRequest({
      argv: ["indexer.js"],
      env: { OPENCODE: "1", OPENCODE_PID: "1234", BUN_BE_BUN: "1" },
      pid: 5678,
      runtime,
      isFile: () => true,
    })

    expect(request).toBeUndefined()
  })

  test("requires a real script file", () => {
    const request = nestedStandaloneScriptRequest({
      argv: ["indexer.js"],
      env: { OPENCODE: "1", OPENCODE_PID: "1234" },
      pid: 5678,
      runtime,
      isFile: () => false,
    })

    expect(request).toBeUndefined()
  })
})

describe("user child environment", () => {
  test("strips the Electron host-only run-as-node flag from shell children", () => {
    expect(userChildEnvironment({ KEEP: "yes", ELECTRON_RUN_AS_NODE: "1" })).toEqual({ KEEP: "yes" })
  })

  test("allows an explicit shell environment hook to opt back into run-as-node", () => {
    expect(userChildEnvironment({ KEEP: "yes", ELECTRON_RUN_AS_NODE: "1" }, { ELECTRON_RUN_AS_NODE: "1" })).toEqual({
      KEEP: "yes",
      ELECTRON_RUN_AS_NODE: "1",
    })
  })
})
