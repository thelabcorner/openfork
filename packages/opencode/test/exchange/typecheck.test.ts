import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { ExchangeError } from "@/exchange/error"
import { ExchangeTypecheck } from "@/exchange/typecheck"
import type { ExchangeOwnedCommand } from "@/exchange/owned-command"

const suite = path.join(os.tmpdir(), `opencode-exchange-typecheck-${randomUUID()}`)
const repo = path.join(suite, "repo")
const tsconfig = path.join(repo, "tsconfig.json")
const file = path.join(repo, "ok.ts")

afterAll(async () => fs.rm(suite, { recursive: true, force: true }))

async function prepare() {
  await fs.mkdir(repo, { recursive: true })
  await Promise.all([
    fs.writeFile(
      tsconfig,
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ES2022",
          module: "ESNext",
        },
      }),
    ),
    fs.writeFile(file, "export const answer: number = 42\n"),
  ])
}

function hooks(
  calls: Array<readonly string[]>,
  compiler?: {
    readonly stdout: string
    readonly exitCode: number
  },
) {
  return {
    rootPath: suite,
    directory: repo,
    authorizePath: (absolutePath: string) => {
      const resolved = path.resolve(absolutePath)
      const relative = path.relative(suite, resolved)
      return relative.startsWith("..") || path.isAbsolute(relative)
        ? Effect.fail(new ExchangeError.PathEscape({ detail: "outside test root" }))
        : Effect.succeed(resolved)
    },
    toVirtualPath: (absolutePath: string) =>
      "/" + path.relative(suite, absolutePath).split(path.sep).join("/"),
    run: (request: Omit<ExchangeOwnedCommand.Input, "workdir"> & { readonly cwd: string }) => {
      calls.push(request.argv)
      if (request.argv[0] === "git" && request.argv.includes("rev-parse")) {
        return Effect.succeed({
          stdout: repo + "\n",
          stderr: "",
          truncated: false,
          timedOut: false,
          exitCode: 0,
        })
      }
      if (request.argv[0] === "git" && request.argv.includes("--cached")) {
        return Effect.succeed({
          stdout: "ok.ts\n",
          stderr: "",
          truncated: false,
          timedOut: false,
          exitCode: 0,
        })
      }
      if (request.argv[0] === "git") {
        return Effect.succeed({
          stdout: "",
          stderr: "",
          truncated: false,
          timedOut: false,
          exitCode: 0,
        })
      }
      return Effect.succeed({
        stdout: compiler?.stdout ?? "",
        stderr: "",
        truncated: false,
        timedOut: false,
        exitCode: compiler?.exitCode ?? 0,
      })
    },
    revalidate: () => Effect.void,
  }
}

describe("ExchangeTypecheck", () => {
  test("skips Git discovery for explicit-tsconfig file scope", async () => {
    await prepare()
    const calls: Array<readonly string[]> = []

    const result = await Effect.runPromise(
      ExchangeTypecheck.execute(
        {
          mode: "file",
          filePath: "ok.ts",
          tsconfig: "tsconfig.json",
        },
        hooks(calls),
      ),
    )

    expect(result.metadata).toMatchObject({
      mode: "file",
      status: "passed",
      files: ["/repo/ok.ts"],
    })
    expect(calls.some((argv) => argv[0] === "git")).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toBe("node")
    expect(calls[0]).toContain("--project")
  })

  test("retains Git discovery for changed scope even with explicit tsconfig", async () => {
    await prepare()
    const calls: Array<readonly string[]> = []

    const result = await Effect.runPromise(
      ExchangeTypecheck.execute(
        {
          mode: "changed",
          tsconfig: "tsconfig.json",
        },
        hooks(calls),
      ),
    )

    expect(result.metadata).toMatchObject({
      mode: "changed",
      status: "passed",
      files: ["/repo/ok.ts"],
    })
    expect(calls.some((argv) => argv[0] === "git" && argv.includes("rev-parse"))).toBe(true)
    expect(calls.some((argv) => argv[0] === "git" && argv.includes("--cached"))).toBe(true)
    expect(calls.at(-1)?.[0]).toBe("node")
  })

  test("distinguishes selected-file diagnostics from imported dependency diagnostics", async () => {
    await prepare()
    const dependency = path.join(repo, "dependency.ts")
    await fs.writeFile(dependency, "export const dependency = 1\n")
    const calls: Array<readonly string[]> = []
    const diagnostic = `${dependency}(1,1): error TS2322: Type 'string' is not assignable to type 'number'.\n`

    const result = await Effect.runPromise(
      ExchangeTypecheck.execute(
        {
          mode: "file",
          filePath: "ok.ts",
          tsconfig: "tsconfig.json",
        },
        hooks(calls, { stdout: diagnostic, exitCode: 2 }),
      ),
    )

    expect(result.metadata).toMatchObject({
      mode: "file",
      status: "failed",
      errors: 1,
      targetErrors: 0,
      transitiveErrors: 1,
    })
    expect(result.output).toContain('scope="transitive"')
    expect(result.output).toContain("No diagnostics in the selected files")
    expect(result.output).toContain("Do not edit unrelated files solely to clear this scoped validation.")
  })
})
