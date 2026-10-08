#!/usr/bin/env node
// Independent, opt-in TypeScript/Effect checker experiment. Never mutates build outputs.
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { platform, arch, cpus, tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { performance } from "node:perf_hooks"
import {
  compareDiagnostics,
  diagnosticKey,
  median,
  parseArgs,
  parseDiagnostics,
  parseRustTypes,
  summarizeDiagnostics,
  summarizeEffectRules,
} from "./typecheck-frontier-lib.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const VERSION_CACHE = new Map()
const HELP = `OpenFork typecheck frontier (experimental; does not replace root typecheck)

Usage: node script/typecheck-frontier.mjs [options]
  --packages llm,core         Package directories beneath packages/ (default: four Effect plugin packages)
  --packages all              Inspect every workspace with a tsconfig (includes composite caveats)
  --checkers tsgo,rust,bun    Checker set (default: tsgo,rust)
  --effect auto|off           For rust, prefer tsconfig.effect-frontier.json if present (default: auto)
  --rust-bin PATH             Explicit native tsc-rs executable (or Linux path with --wsl)
  --wsl                       Run rust via Windows WSL2 (not directly comparable to Windows-native checks)
  --wsl-tsgo                  Also run tsgo via WSL2 with --tsgo-bin /absolute/linux/path
  --rust-types llm=bun        Explicit ambient-types workaround for rust only (repeatable)
  --gate observe|parity|strict
                              observe: report only; parity: fail TS diagnostic drift;
                              strict: parity + fail rust TS/Effect errors
  --repeats 5 --warmup 1      Repeat measurements, report median (default: 1, 0)
  --timeout-ms 180000         Per-invocation timeout
  --output PATH               Write JSON report outside the checkout (never overwrite source)
  --help                      This message

No compiler or package installation is performed. Set TSC_RS_BIN or --rust-bin.
On Windows: --wsl --rust-bin /absolute/linux/path/to/tsc.
Bun/tsgo binary overrides: --bun-bin PATH / --tsgo-bin PATH (or BUN_BIN / TSGO_BIN).
Docs: docs/perf/typecheck-frontier-2026-10-08.md
`

function ensure(condition, message) {
  if (!condition) throw new Error(message)
}

function wslPath(path) {
  const match = /^([A-Za-z]):[\\/](.+)$/.exec(path)
  ensure(match, `WSL mode cannot map Windows build-info path: ${path}`)
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`
}

function workspacePackages() {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
  const entries = manifest.workspaces?.packages
  ensure(Array.isArray(entries), "Root package.json is missing its workspace package list")
  return entries.map((item) => {
    ensure(item.startsWith("packages/") && !item.includes("*"), `Unsupported workspace definition: ${item}`)
    const key = item.slice("packages/".length)
    const cwd = join(ROOT, item)
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"))
    return {
      key,
      cwd,
      name: pkg.name,
      baseConfig: join(cwd, "tsconfig.json"),
      overlay: join(cwd, "tsconfig.effect-frontier.json"),
    }
  })
}

function selectedPackages(selection) {
  const packages = workspacePackages()
  const wanted = selection.includes("all")
    ? packages
    : selection.map((key) => {
        const found = packages.find((item) => item.key === key)
        ensure(found, `Unknown package '${key}'. Known: ${packages.map((item) => item.key).join(", ")}`)
        return found
      })
  const missing = wanted.filter((item) => !existsSync(item.baseConfig))
  ensure(!missing.length, `Missing tsconfig: ${missing.map((item) => item.key).join(", ")}`)
  return [...new Map(wanted.map((pkg) => [pkg.key, pkg])).values()]
}

function makeCommand(pkg, checker, options, ambient) {
  const config =
    checker === "rust" && options.effect === "auto" && existsSync(pkg.overlay) ? pkg.overlay : pkg.baseConfig
  const relativeConfig = relative(ROOT, config).replaceAll("\\", "/")
  const isComposite =
    /"composite"\s*:\s*true/.test(readFileSync(pkg.baseConfig, "utf8")) ||
    /"composite"\s*:\s*true/.test(readFileSync(config, "utf8"))
  // -p --noEmit avoids project builds. Composite projects use disposable build-info paths.
  const common = ["-p", relativeConfig, "--noEmit"]
  if (!isComposite) common.push("--incremental", "false")
  if (checker === "rust") {
    if (ambient.has(pkg.key)) common.push("--types", ambient.get(pkg.key).join(","))
    if (platform() === "win32") {
      ensure(options.wsl, "tsc-rs has no supported Windows binary: use --wsl and --rust-bin /linux/path/to/tsc")
      ensure(options.rustBin.startsWith("/"), "--rust-bin with --wsl must be an absolute Linux path")
      return {
        command: "wsl.exe",
        argv: ["--exec", options.rustBin, ...common],
        config: relativeConfig,
        environment: "wsl2",
        isComposite,
      }
    }
    return {
      command: options.rustBin || "tsc-rs",
      argv: common,
      config: relativeConfig,
      environment: "native",
      isComposite,
    }
  }
  if (checker === "tsgo") {
    if (options.wslTsgo) {
      ensure(options.tsgoBin.startsWith("/"), "--tsgo-bin with --wsl-tsgo must be an absolute Linux path")
      return {
        command: "wsl.exe",
        argv: ["--exec", options.tsgoBin, ...common],
        config: relativeConfig,
        environment: "wsl2",
        isComposite,
      }
    }
    const name = platform() === "win32" ? "tsgo.exe" : "tsgo"
    return {
      command: options.tsgoBin || join(ROOT, "node_modules", ".bin", name),
      argv: common,
      config: relativeConfig,
      environment: "native",
      isComposite,
    }
  }
  // Bun check accepts --project but not --noEmit/--incremental. It never emits.
  const bunArgs = ["check", "-p", relativeConfig, "--no-pretty"]
  if (platform() === "win32" && !options.bunBin) {
    return {
      command: "cmd.exe",
      argv: ["/d", "/s", "/c", `bun ${bunArgs.map((arg) => `"${arg}"`).join(" ")}`],
      config: relativeConfig,
      environment: "native",
      isComposite,
    }
  }
  return { command: options.bunBin || "bun", argv: bunArgs, config: relativeConfig, environment: "native", isComposite }
}

function execute(command, argv, timeoutMs) {
  const start = performance.now()
  const child = spawnSync(command, argv, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  })
  const elapsedMs = Math.round((performance.now() - start) * 100) / 100
  return {
    elapsedMs,
    status: child.status,
    signal: child.signal,
    error: child.error?.message ?? null,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
  }
}

function compilerVersion(spec) {
  if (spec.command === "cmd.exe") return "Bun (Windows shim)"
  const isWsl = spec.command === "wsl.exe"
  const binary = isWsl ? spec.argv.slice(0, 2) : [spec.command]
  const key = binary.join("|")
  if (!VERSION_CACHE.has(key)) {
    const probe = execute(isWsl ? "wsl.exe" : spec.command, isWsl ? [...binary, "--version"] : ["--version"], 30000)
    const value =
      probe.status === 0
        ? (probe.stdout || probe.stderr).trim().split("\n")[0]
        : `unavailable (exit ${probe.status ?? "unknown"})`
    VERSION_CACHE.set(key, value)
  }
  return VERSION_CACHE.get(key)
}

function runChecker(pkg, checker, options, ambient) {
  const spec = makeCommand(pkg, checker, options, ambient)
  const samples = []
  let last = null
  let unstable = false
  let prior = null
  for (let i = -options.warmup; i < options.repeats; i++) {
    const scratch = spec.isComposite && checker !== "bun" ? mkdtempSync(join(tmpdir(), "openfork-typecheck-")) : null
    let result
    try {
      const argv = [...spec.argv]
      if (scratch) {
        const info = join(scratch, "typecheck.tsbuildinfo")
        argv.push("--tsBuildInfoFile", spec.environment === "wsl2" ? wslPath(info) : info)
      }
      result = execute(spec.command, argv, options.timeoutMs)
    } finally {
      if (scratch) rmSync(scratch, { recursive: true, force: true })
    }
    const diagnostics = parseDiagnostics(result.stdout + "\n" + result.stderr, ROOT)
    const keys = diagnostics.map(diagnosticKey).sort().join("\n")
    if (result.error || result.status === null || (result.status !== 0 && diagnostics.length === 0)) {
      const reason = result.error || `exit ${result.status} with no recognized diagnostics`
      throw new Error(`${checker}/${pkg.key}: ${reason}\n${(result.stderr || result.stdout).slice(0, 800)}`)
    }
    if (i < 0) continue
    if (prior !== null && prior !== keys) unstable = true
    prior = keys
    samples.push(result.elapsedMs)
    last = {
      exitCode: result.status,
      diagnostics,
      summary: summarizeDiagnostics(diagnostics),
      effectRules: summarizeEffectRules(diagnostics),
      stdout: result.stdout,
      stderr: result.stderr,
    }
  }
  return {
    checker,
    version: compilerVersion(spec),
    config: spec.config,
    environment: spec.environment,
    isComposite: spec.isComposite,
    ambientTypes: checker === "rust" ? (ambient.get(pkg.key) ?? []) : [],
    samplesMs: samples,
    medianMs: median(samples),
    unstableDiagnostics: unstable,
    ...last,
  }
}

// Alternate order per measured repetition to reduce second-checker cache bias.
function runPackageChecks(pkg, options, ambient) {
  const checks = new Map()
  const original = [...options.checkers]
  for (let i = -options.warmup; i < options.repeats; i++) {
    const order = Math.abs(i) % 2 === 1 ? [...original].reverse() : original
    for (const checker of order) {
      const next = runChecker(pkg, checker, { ...options, warmup: 0, repeats: 1 }, ambient)
      if (i < 0) continue
      const existing = checks.get(checker)
      if (!existing) {
        checks.set(checker, next)
        continue
      }
      const before = existing.diagnostics.map(diagnosticKey).sort().join("\n")
      const after = next.diagnostics.map(diagnosticKey).sort().join("\n")
      existing.unstableDiagnostics ||= before !== after
      existing.samplesMs.push(next.medianMs)
      existing.medianMs = median(existing.samplesMs)
      existing.diagnostics = next.diagnostics
      existing.summary = next.summary
      existing.effectRules = next.effectRules
      existing.exitCode = next.exitCode
      existing.stdout = next.stdout
      existing.stderr = next.stderr
    }
  }
  return original.map((checker) => checks.get(checker))
}

function assess(pkgResult, options) {
  const by = Object.fromEntries(pkgResult.checks.map((item) => [item.checker, item]))
  const reference = by.tsgo
  const rust = by.rust
  if (reference && rust) {
    pkgResult.comparison = compareDiagnostics(reference.diagnostics, rust.diagnostics)
    pkgResult.comparison.identical =
      pkgResult.comparison.introduced.length === 0 && pkgResult.comparison.missing.length === 0
  }
  if (options.gate === "observe") return []
  const reasons = []
  if (!reference || !rust) {
    if (options.gate === "parity") reasons.push("parity requires both tsgo and rust")
  } else if (!pkgResult.comparison.identical)
    reasons.push(`TS parity drift (+${pkgResult.comparison.introduced.length}/-${pkgResult.comparison.missing.length})`)
  if (options.gate === "strict" && rust) {
    if (rust.summary.typescriptErrors) reasons.push(`${rust.summary.typescriptErrors} rust TS errors`)
    if (rust.summary.effectErrors) reasons.push(`${rust.summary.effectErrors} Effect errors`)
  }
  for (const check of pkgResult.checks)
    if (check.unstableDiagnostics) reasons.push(`${check.checker} diagnostics changed across repeats`)
  return reasons
}

function printRun(result) {
  console.log(`\n[${result.package}]`)
  for (const check of result.checks) {
    const summary = check.summary
    const timing =
      check.samplesMs.length > 1 ? `median ${check.medianMs}ms (n=${check.samplesMs.length})` : `${check.medianMs}ms`
    console.log(
      `  ${check.checker.padEnd(5)} ${timing}, exit ${check.exitCode}, TS errors ${summary.typescriptErrors}, Effect ${summary.effectErrors} errors / ${summary.effectWarnings} warnings / ${summary.effectSuggestions} suggestions`,
    )
    console.log(`    Version: ${check.version} | Environment: ${check.environment}`)
    if (check.effectRules.length)
      console.log(
        `    Top Effect rules: ${check.effectRules
          .slice(0, 5)
          .map((r) => `TS${r.code} ${r.severity}×${r.count}`)
          .join(", ")}`,
      )
    if (check.unstableDiagnostics) console.log("    WARNING: diagnostic output changed during repetitions")
  }
  if (result.comparison) {
    const cmp = result.comparison
    console.log(
      `  TS diagnostic parity: ${cmp.identical ? "MATCH" : `DRIFT (+${cmp.introduced.length} / -${cmp.missing.length})`}`,
    )
    for (const [label, list] of [
      ["introduced", cmp.introduced],
      ["missing", cmp.missing],
    ]) {
      for (const item of list.slice(0, 5))
        console.log(`    ${label}: ${item.file ?? "(global)"}:${item.line ?? 0}:${item.column ?? 0} TS${item.code}`)
      if (list.length > 5) console.log(`    ... ${list.length - 5} more ${label}`)
    }
  }
  if (result.failures.length) console.log(`  FAILED: ${result.failures.join("; ")}`)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(HELP)
    return
  }
  const packages = selectedPackages(options.packages)
  const reportPath = options.output ? resolve(process.cwd(), options.output) : null
  if (reportPath) {
    const rel = relative(ROOT, reportPath)
    ensure(
      rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel),
      "--output must be outside the OpenFork checkout to protect concurrent work",
    )
    ensure(!existsSync(reportPath), `Refusing to overwrite an existing report: ${reportPath}`)
  }
  const ambient = parseRustTypes(options.rustTypes)
  for (const key of ambient.keys())
    ensure(
      packages.some((pkg) => pkg.key === key),
      `--rust-types names a package that was not selected: ${key}`,
    )
  if (options.wsl) ensure(platform() === "win32", "--wsl is only valid on a Windows host")
  if (options.wslTsgo)
    ensure(
      platform() === "win32" && options.checkers.includes("tsgo"),
      "--wsl-tsgo requires Windows and the tsgo checker",
    )
  if (options.wslTsgo)
    ensure(options.tsgoBin.startsWith("/"), "--wsl-tsgo requires --tsgo-bin with an absolute Linux path")
  const environments = options.checkers.map((checker) =>
    (checker === "rust" && options.wsl) || (checker === "tsgo" && options.wslTsgo) ? "wsl2" : "native",
  )
  const mixedRuntime = new Set(environments).size > 1
  if (mixedRuntime) console.log("NOTE: Windows-native and WSL2 compiler timings are NOT directly comparable.")
  console.log(
    `OpenFork typecheck frontier | ${packages.length} packages | ${options.checkers.join(", ")} | gate=${options.gate} (existing scripts unchanged)`,
  )
  const report = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    environment: { platform: platform(), arch: arch(), logicalCpuCount: cpus().length, mixedRuntime },
    configuration: { ...options, rustTypes: Object.fromEntries(ambient) },
    packages: [],
    passed: true,
  }
  let executionFailure = false
  for (const pkg of packages) {
    const result = { package: pkg.key, name: pkg.name, checks: [], comparison: null, failures: [] }
    try {
      result.checks = runPackageChecks(pkg, options, ambient)
      result.failures = assess(result, options)
    } catch (error) {
      executionFailure = true
      result.failures = [`execution: ${error instanceof Error ? error.message : String(error)}`]
    }
    if (result.failures.length) report.passed = false
    report.packages.push(result)
    printRun(result)
  }
  if (reportPath) {
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" })
    console.log(`\nJSON report: ${reportPath}`)
  }
  console.log(
    `\n${executionFailure ? "EXECUTION FAILED" : options.gate === "observe" ? "OBSERVATION ONLY (no diagnostic gate)" : report.passed ? "GATE PASS" : "GATE FAIL"}`,
  )
  if (!report.passed) process.exitCode = executionFailure ? 2 : 1
}

try {
  main()
} catch (error) {
  console.error(`typecheck-frontier: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
}
