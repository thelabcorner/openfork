import path from "node:path"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/core/process"
import { which } from "@opencode-ai/core/util/which"
import { ProjectInspection } from "./inspection"

/**
 * Shared native/OXP toolchain inspection owner.
 *
 * Probes a closed, deterministic set of executables with exact argv, no shell,
 * no stdin, 4KB output per attempt, and a 5-second deadline. This module
 * contains no Session/Tool.Context and performs no work during discovery.
 * External adapters must separately authorize process execution.
 */
export const RUNTIME_PROBES: ReadonlyArray<{
  readonly name: string
  readonly binaries: readonly string[]
  readonly flag: string
}> = [
  { name: "bun", binaries: ["bun"], flag: "--version" },
  { name: "node", binaries: ["node"], flag: "--version" },
  { name: "npm", binaries: ["npm"], flag: "--version" },
  { name: "pnpm", binaries: ["pnpm"], flag: "--version" },
  { name: "yarn", binaries: ["yarn"], flag: "--version" },
  { name: "python", binaries: ["python", "python3"], flag: "--version" },
  { name: "go", binaries: ["go"], flag: "version" },
  { name: "rustc", binaries: ["rustc"], flag: "--version" },
]

const ENV_FIELDS: ReadonlyArray<[name: string, hint: string]> = [
  ["PATH", "first entry of $PATH"],
  ["NODE_ENV", "node environment"],
  ["CI", "CI detection"],
  ["VIRTUAL_ENV", "python virtualenv"],
  ["GOPATH", "go workspace"],
  ["CARGO_HOME", "cargo home"],
  ["BUN_INSTALL", "bun install dir"],
]

export type Result = {
  readonly runtimes: ReadonlyArray<{ readonly name: string; readonly version?: string; readonly path?: string }>
  readonly env: ReadonlyArray<{ readonly name: string; readonly value?: string; readonly hint: string }>
}

export function probe(app: AppProcess.Interface, signal: AbortSignal): Effect.Effect<Result> {
  return Effect.gen(function* () {
    const run = Effect.fnUntraced(function* (binary: string, flag: string) {
      const result = yield* app
        .run(ChildProcess.make(binary, [flag], { env: {}, stdin: "ignore", stdout: "pipe", stderr: "pipe" }), {
          maxOutputBytes: 4_000,
          timeout: "5 seconds",
          signal,
        })
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!result) return undefined
      return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString("utf8"),
        stderr: result.stderr.toString("utf8"),
      }
    })

    // Probes do not depend on one another. Four bounded concurrent processes
    // remove the serial startup waterfall without allowing an unbounded
    // process fanout. Effect.forEach retains stable inventory output order.
    const probed = yield* Effect.forEach(
      RUNTIME_PROBES,
      (entry) =>
        Effect.gen(function* () {
          if (signal.aborted) return undefined
          let version: string | undefined
          let resolved: string | undefined
          for (const binary of entry.binaries) {
            if (signal.aborted) break
            const found = which(binary)
            const result = yield* run(binary, entry.flag)
            if (result && result.exitCode === 0) {
              version = (result.stdout || result.stderr).split("\n")[0]?.trim() || undefined
              if (found) resolved = found
              break
            }
          }
          return version || resolved ? { name: entry.name, version, path: resolved } : undefined
        }),
      { concurrency: 4 },
    )
    const runtimes = probed.filter((value): value is NonNullable<typeof value> => value !== undefined)
    const env: Array<{ name: string; value?: string; hint: string }> = []
    for (const [name, hint] of ENV_FIELDS) {
      const value = process.env[name]
      if (value !== undefined) {
        env.push({ name, value: name === "PATH" ? value.split(path.delimiter)[0] : value, hint })
      }
    }
    return { runtimes, env }
  })
}

export function render(
  input: Result,
  options: { readonly root: string; readonly git: boolean | "unknown"; readonly externalPrincipal?: boolean },
): string {
  // Every payload is emitted as an XML *attribute*. Escape quotes too and
  // bound environment-controlled values to protect transport/output budgets.
  const escape = (value: string, max = 2_048) => {
    // XML 1.0 attributes cannot contain NUL/control scalars or lone UTF-16
    // surrogates. Text from PATH, an executable, and aliases is untrusted.
    const safe = Array.from(value.slice(0, max))
      .filter((scalar) => {
        const code = scalar.codePointAt(0)!
        return (
          code === 0x9 ||
          code === 0xa ||
          code === 0xd ||
          (code >= 0x20 && code <= 0xd7ff) ||
          (code >= 0xe000 && code <= 0xfffd) ||
          (code >= 0x10000 && code <= 0x10ffff)
        )
      })
      .join("")
    return ProjectInspection.escapeXml(safe)
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")
      .replace(/\t/g, "&#x9;")
      .replace(/\n/g, "&#xA;")
      .replace(/\r/g, "&#xD;")
  }
  // The OXP caller has an approved *workspace* root, not ambient authority
  // to enumerate this workstation's tool installation and HOME paths.
  // Native use preserves the full local diagnostic projection.
  const external = options.externalPrincipal === true
  // An executable's --version response and environment variables are not
  // inherently trustworthy. A compromised binary or unusual environment
  // value must not turn a version-only probe into a path/secret disclosure.
  const externalVersion = (name: string, value: string | undefined) => {
    if (!value) return undefined
    const numeric = /^(?:v)?\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9._-]{1,40})?$/
    const python = /^Python \d+(?:\.\d+){1,3}(?:(?:a|b|rc)\d+)?$/
    const go = /^go version go\d+(?:\.\d+){1,3}(?:rc\d+)? [a-z0-9_]+\/[a-z0-9_]+$/
    const rust = /^rustc \d+(?:\.\d+){1,3}(?:-[A-Za-z0-9._-]+)? \([a-f0-9]+ \d{4}-\d{2}-\d{2}\)$/
    return numeric.test(value) ||
      (name === "python" && python.test(value)) ||
      (name === "go" && go.test(value)) ||
      (name === "rustc" && rust.test(value))
      ? value
      : undefined
  }
  const safeExternalEnv = (row: Result["env"][number]) =>
    (row.name === "NODE_ENV" && ["production", "development", "test"].includes(row.value ?? "")) ||
    (row.name === "CI" && ["true", "false", "0", "1"].includes((row.value ?? "").toLowerCase()))
  return [
    `<toolchain git="${options.git}" root="${escape(options.root)}">`,
    ...input.runtimes.map((runtime) => {
      const version = external ? externalVersion(runtime.name, runtime.version) : runtime.version
      return `  <runtime name="${escape(runtime.name, 64)}"${version ? ` version="${escape(version, 256)}"` : ""}${!external && runtime.path ? ` path="${escape(runtime.path)}"` : ""} />`
    }),
    ...input.env
      .filter((row) => !external || safeExternalEnv(row))
      .map(
        (row) => `  <env name="${escape(row.name)}" value="${escape(row.value ?? "")}" hint="${escape(row.hint)}" />`,
      ),
    "</toolchain>",
  ].join("\n")
}

export * as ProjectToolchain from "./toolchain"
