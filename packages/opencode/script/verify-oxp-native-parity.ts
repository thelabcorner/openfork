/**
 * Reproducible release verification for the native-tool / OXP parity contract.
 *
 * Run:
 *   bun packages/opencode/script/verify-oxp-native-parity.ts
 *   bun packages/opencode/script/verify-oxp-native-parity.ts --quick
 *   bun packages/opencode/script/verify-oxp-native-parity.ts --with-typecheck
 *
 * Each package/test family runs in a separate Bun process. This isolates the
 * heavyweight native ToolRegistry/Instance fixtures from OXP and frontend test
 * runtimes on Windows and preserves the explicit Effect test deadline.
 *
 * This script never weakens failing assertions or converts a compiler error
 * into a passing release result.
 */
import path from "node:path"

const pkg = path.resolve(import.meta.dir, "..")
const app = path.resolve(pkg, "../app")
const core = path.resolve(pkg, "../core")
const schema = path.resolve(pkg, "../schema")
const quick = process.argv.includes("--quick")
const typecheck = process.argv.includes("--with-typecheck")
const accepted = new Set(["--quick", "--with-typecheck"])
for (const arg of process.argv.slice(2)) {
  if (!accepted.has(arg)) {
    console.error(`Unknown option ${arg}. Expected --quick or --with-typecheck.`)
    process.exit(2)
  }
}

const runtime = process.execPath
type Check = { readonly label: string; readonly cwd: string; readonly argv: string[]; readonly kind?: "typecheck" }
const cases: Check[] = [
  {
    // Fail before integration fixtures when a generated static listener
    // manifest disagrees with the authoritative native OXP decoders.
    // Never ship a fast-but-stale tools/list schema/fingerprint.
    label: "OXP generated transport manifest drift",
    cwd: pkg,
    argv: ["script/generate-oxp-transport-manifest.ts", "--check"],
  },
  {
    label: "OXP transport-only eager dependency boundary",
    cwd: pkg,
    argv: ["script/audit-oxp-import-graph.ts", "--assert-transport-purity"],
  },
  {
    label: "Core-owned browser-safe context footprint projection",
    cwd: core,
    argv: ["test", "test/session/context-occupancy.test.ts"],
  },
  {
    label: "OXP broker, parity, usage, and shared domain",
    cwd: pkg,
    argv: [
      "test",
      "--timeout",
      "45000",
      "test/oxp/capability.test.ts",
      "test/oxp/transport-manifest.test.ts",
      "test/oxp/transport-protocol.test.ts",
      "test/oxp/transport-pagination.test.ts",
      "test/oxp/transport-listener.test.ts",
      "test/oxp/host-lazy.test.ts",
      "test/oxp/project.test.ts",
      "test/oxp/read.test.ts",
      "test/oxp/usage.test.ts",
      "test/oxp/tool-parity-doc.test.ts",
      "test/oxp/tool-parity-matrix.test.ts",
      "test/project/xml-projection.test.ts",
      "test/project/toolchain.test.ts",
      "test/tool/quota-usage.test.ts",
    ],
  },
  ...(!quick
    ? [
        {
          label: "Native OpenFork project tool",
          cwd: pkg,
          argv: ["test", "--timeout", "45000", "test/tool/project.test.ts"],
        },
        {
          label: "OpenFork application context occupancy",
          cwd: app,
          argv: ["test", "src/components/session/session-context-occupancy.test.ts"],
        },
      ]
    : []),
  ...(typecheck
    ? [
        { label: "Schema strict TypeScript", cwd: schema, argv: ["run", "typecheck"], kind: "typecheck" as const },
        { label: "Core strict TypeScript", cwd: core, argv: ["run", "typecheck"], kind: "typecheck" as const },
        { label: "App strict TypeScript", cwd: app, argv: ["run", "typecheck"], kind: "typecheck" as const },
        { label: "OpenFork host strict TypeScript", cwd: pkg, argv: ["run", "typecheck"], kind: "typecheck" as const },
      ]
    : []),
]

const verdicts: Array<{ label: string; exitCode: number; elapsedMs: number }> = []
for (const row of cases) {
  console.log(`\n=== ${row.label} ===`)
  const start = performance.now()
  const child = Bun.spawn({
    cmd: [runtime, ...row.argv],
    cwd: row.cwd,
    env: { ...process.env, OPENCODE_EFFECT_TEST_TIMEOUT_MS: "30000" },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await child.exited
  const elapsedMs = Math.round(performance.now() - start)
  verdicts.push({ label: row.label, exitCode, elapsedMs })
  console.log(`${exitCode === 0 ? "PASS" : "FAIL"} ${row.label} · ${elapsedMs} ms · exit ${exitCode}`)
  // Stop on any test/runtime failure (including native process crashes).
  // Independent typecheck failures are all collected to give parallel owners
  // their actionable diagnostics while preserving a failing overall verdict.
  if (exitCode !== 0 && row.kind !== "typecheck") break
}

console.log("\n=== OXP parity verification summary ===")
for (const result of verdicts) {
  console.log(`${result.exitCode === 0 ? "PASS" : "FAIL"} ${result.label} (${result.elapsedMs} ms)`)
}
if (verdicts.length !== cases.length || verdicts.some((row) => row.exitCode !== 0)) {
  process.exitCode = 1
} else {
  console.log("PASS all selected release gates")
}
