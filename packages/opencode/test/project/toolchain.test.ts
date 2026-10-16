import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { AppProcess } from "@opencode-ai/core/process"
import { ProjectToolchain } from "@/project/toolchain"

describe("ProjectToolchain shared native/OXP domain owner", () => {
  test("runs independent runtime probes with bounded parallelism and deterministic output ordering", async () => {
    let active = 0
    let peak = 0
    const started: string[] = []
    const app = {
      run: (command: { readonly command: string }) =>
        Effect.gen(function* () {
          started.push(command.command)
          active++
          peak = Math.max(peak, active)
          yield* Effect.sleep("30 millis")
          active--
          return { exitCode: 0, stdout: Buffer.from("v1.2.3\n"), stderr: Buffer.alloc(0) }
        }),
    } as unknown as AppProcess.Interface
    const result = await Effect.runPromise(ProjectToolchain.probe(app, new AbortController().signal))
    expect(started).toEqual(ProjectToolchain.RUNTIME_PROBES.map((item) => item.binaries[0]))
    expect(peak).toBe(4)
    expect(active).toBe(0)
    expect(result.runtimes.map((item) => item.name)).toEqual(ProjectToolchain.RUNTIME_PROBES.map((item) => item.name))
  })

  test("does not spawn any probe when a caller has already cancelled", async () => {
    let attempts = 0
    const app = {
      run: () => {
        attempts++
        return Effect.die("Cancelled inspection must never spawn a runtime")
      },
    } as unknown as AppProcess.Interface
    const abort = new AbortController()
    abort.abort()
    const result = await Effect.runPromise(ProjectToolchain.probe(app, abort.signal))
    expect(attempts).toBe(0)
    expect(result.runtimes).toEqual([])
  })

  test("preserves declared result order while falling back to alternative executables", async () => {
    const attempted: string[] = []
    const app = {
      run: (command: { readonly command: string }) =>
        Effect.sync(() => {
          attempted.push(command.command)
          return {
            exitCode: command.command === "python" ? 1 : 0,
            stdout: Buffer.from(command.command === "python3" ? "Python 3.12.4\n" : "v1.2.3\n"),
            stderr: Buffer.alloc(0),
          }
        }),
    } as unknown as AppProcess.Interface
    const result = await Effect.runPromise(ProjectToolchain.probe(app, new AbortController().signal))
    expect(attempted).toContain("python")
    expect(attempted).toContain("python3")
    expect(result.runtimes.find((item) => item.name === "python")?.version).toBe("Python 3.12.4")
    expect(result.runtimes.map((item) => item.name)).toEqual(ProjectToolchain.RUNTIME_PROBES.map((item) => item.name))
  })

  test("does not emit XML-forbidden control characters from environment or runtime output", () => {
    const controls = Array.from({ length: 32 }, (_, value) => String.fromCharCode(value))
      .filter((character) => character !== "\t" && character !== "\n" && character !== "\r")
      .join("")
    const output = ProjectToolchain.render(
      {
        runtimes: [{ name: "node", version: `v1.0.0${controls}` }],
        env: [{ name: "NODE_ENV", value: `production${controls}`, hint: "environment" }],
      },
      { root: `/approved${controls}`, git: "unknown" },
    )
    expect(output).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/)
  })

  test("uses a closed exact-argv probe inventory without a shell or unbounded output", async () => {
    const calls: Array<{ cmd: string; args: readonly string[]; timeout: unknown; maxOutputBytes: number | undefined }> =
      []
    const app = {
      run: (
        command: { readonly _tag: string; readonly command: string; readonly args: readonly string[] },
        options: {
          readonly timeout?: unknown
          readonly maxOutputBytes?: number
        },
      ) =>
        Effect.sync(() => {
          expect(command._tag).toBe("StandardCommand")
          calls.push({
            cmd: command.command,
            args: command.args,
            timeout: options.timeout,
            maxOutputBytes: options.maxOutputBytes,
          })
          return {
            exitCode: 0,
            stdout: Buffer.from("v1.2.3\n"),
            stderr: Buffer.alloc(0),
          }
        }),
    } as unknown as AppProcess.Interface

    const result = await Effect.runPromise(ProjectToolchain.probe(app, new AbortController().signal))
    expect(calls.map((call) => call.cmd)).toEqual(ProjectToolchain.RUNTIME_PROBES.map((row) => row.binaries[0]))
    expect(calls).toHaveLength(8)
    expect(
      calls.every((call) => call.args.length === 1 && call.maxOutputBytes === 4_000 && call.timeout === "5 seconds"),
    ).toBe(true)
    expect(result.runtimes).toHaveLength(8)
    expect(result.runtimes.every((entry) => entry.version === "v1.2.3")).toBe(true)
  })

  test("escapes hostile XML attribute text and bounds environment-controlled output", () => {
    const rendered = ProjectToolchain.render(
      {
        runtimes: [{ name: "node", version: 'v1" < &&', path: "C:/Program Files/node" }],
        env: [{ name: "NODE_ENV", value: "<script>\"'&" + "x".repeat(10_000), hint: 'safe "value"' }],
      },
      { root: '/workspace/"unsafe', git: "unknown" },
    )
    expect(rendered).toContain('git="unknown"')
    expect(rendered).toContain('root="/workspace/&quot;unsafe"')
    expect(rendered).toContain('version="v1&quot; &lt; &amp;&amp;"')
    expect(rendered).toContain("&lt;script&gt;&quot;&apos;&amp;")
    expect(rendered).not.toContain("<script>")
    expect(rendered.length).toBeLessThan(5_000)
  })

  test("external projections redact machine-global installation paths and environment directories", () => {
    const input: ProjectToolchain.Result = {
      runtimes: [
        { name: "node", version: "v22.1.0", path: "C:/private/toolchains/node.exe" },
        { name: "python", version: "Python 3.12.4\nSECRET_TOKEN=private" },
        { name: "go", version: "go version go1.25.0 windows/amd64" },
      ],
      env: [
        { name: "PATH", value: "C:/secret/bin", hint: "first entry of PATH" },
        { name: "VIRTUAL_ENV", value: "C:/users/private/venv", hint: "venv" },
        { name: "NODE_ENV", value: "development", hint: "node environment" },
        { name: "CI", value: "SECRET_TOKEN=private", hint: "CI" },
      ],
    }
    const native = ProjectToolchain.render(input, { root: "C:/private/project", git: true })
    const external = ProjectToolchain.render(input, {
      root: "/approved/project",
      git: "unknown",
      externalPrincipal: true,
    })
    expect(native).toContain("C:/private/toolchains/node.exe")
    expect(native).toContain("C:/secret/bin")
    expect(external).toContain('root="/approved/project"')
    expect(external).toContain('name="NODE_ENV"')
    expect(external).toContain('name="go" version="go version go1.25.0 windows/amd64"')
    expect(external).toContain('name="node" version="v22.1.0"')
    expect(external).not.toContain("C:/")
    expect(external).not.toContain("SECRET_TOKEN")
    expect(external).not.toContain('path="')
    expect(external).not.toContain('name="PATH"')
    expect(external).not.toContain('name="VIRTUAL_ENV"')
    expect(external).not.toContain('name="CI"')
  })
})
