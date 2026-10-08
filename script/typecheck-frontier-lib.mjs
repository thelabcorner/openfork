// Shared, side-effect-free machinery for the opt-in compiler frontier.
import { isAbsolute, relative, resolve, sep } from "node:path"

const LOCATION = /^(.*?)\((\d+),(\d+)\):\s+(error|warning|suggestion|message)\s+TS(\d+):\s*(.*)$/
const GLOBAL = /^(error|warning|suggestion|message)\s+TS(\d+):\s*(.*)$/

export function normalizePath(value, root) {
  let file = value.replaceAll("\\", "/")
  if (root && isAbsolute(value)) {
    const rel = relative(resolve(root), resolve(value)).replaceAll(sep, "/")
    if (!rel.startsWith("../") && rel !== ".." && !isAbsolute(rel)) file = rel
  }
  return file.replace(/^\.\//, "").replaceAll(/\/+/g, "/")
}

export function parseDiagnostics(output, root) {
  const diagnostics = []
  for (const line of output.replaceAll("\r\n", "\n").split("\n")) {
    let match = LOCATION.exec(line)
    if (match) {
      diagnostics.push({
        file: normalizePath(match[1], root),
        line: Number(match[2]),
        column: Number(match[3]),
        severity: match[4],
        code: Number(match[5]),
        message: match[6],
        family: match[5].startsWith("377") ? "effect" : "typescript",
      })
      continue
    }
    match = GLOBAL.exec(line)
    if (match) {
      diagnostics.push({
        file: null,
        line: null,
        column: null,
        severity: match[1],
        code: Number(match[2]),
        message: match[3],
        family: match[2].startsWith("377") ? "effect" : "typescript",
      })
    }
  }
  return diagnostics
}

export function diagnosticKey(diagnostic) {
  return [
    diagnostic.file ?? "",
    diagnostic.line ?? 0,
    diagnostic.column ?? 0,
    diagnostic.severity,
    diagnostic.code,
  ].join("|")
}

export function difference(left, right) {
  const counts = new Map()
  for (const item of right) {
    const key = diagnosticKey(item)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return left.filter((item) => {
    const key = diagnosticKey(item)
    const remaining = counts.get(key) ?? 0
    if (!remaining) return true
    counts.set(key, remaining - 1)
    return false
  })
}

export function compareDiagnostics(baseline, candidate) {
  const typescript = (items) => items.filter((item) => item.family === "typescript")
  const before = typescript(baseline)
  const after = typescript(candidate)
  return {
    baselineCount: before.length,
    candidateCount: after.length,
    introduced: difference(after, before),
    missing: difference(before, after),
  }
}

export function summarizeDiagnostics(diagnostics) {
  const summary = { typescriptErrors: 0, effectErrors: 0, effectWarnings: 0, effectSuggestions: 0 }
  for (const item of diagnostics) {
    if (item.family === "typescript" && item.severity === "error") summary.typescriptErrors++
    if (item.family === "effect" && item.severity === "error") summary.effectErrors++
    if (item.family === "effect" && item.severity === "warning") summary.effectWarnings++
    if (item.family === "effect" && item.severity === "suggestion") summary.effectSuggestions++
  }
  return summary
}

export function summarizeEffectRules(diagnostics) {
  const rules = new Map()
  for (const d of diagnostics) {
    if (d.family !== "effect") continue
    const key = `${d.code}:${d.severity}`
    const existing = rules.get(key) ?? { code: d.code, severity: d.severity, count: 0, files: new Set(), samples: [] }
    existing.count++
    if (d.file) existing.files.add(d.file)
    if (existing.samples.length < 3) existing.samples.push({ file: d.file, line: d.line, message: d.message })
    rules.set(key, existing)
  }
  return [...rules.values()]
    .map((rule) => ({
      code: rule.code,
      severity: rule.severity,
      count: rule.count,
      fileCount: rule.files.size,
      samples: rule.samples,
    }))
    .sort((a, b) => b.count - a.count || a.code - b.code)
}

export function median(samples) {
  if (!samples.length) return null
  const sorted = [...samples].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function parseRustTypes(entries) {
  const overrides = new Map()
  for (const entry of entries) {
    const match = /^([\w-]+(?:\/[\w-]+)*)=([\w@/,-]+)$/.exec(entry)
    if (!match) throw new Error(`Invalid --rust-types '${entry}'; expected package=bun or package=node,bun`)
    if (overrides.has(match[1])) throw new Error(`Duplicate --rust-types for ${match[1]}`)
    overrides.set(match[1], match[2].split(","))
  }
  return overrides
}

const FLAGS = new Set(["--help", "--wsl", "--wsl-tsgo"])
const VALUES = new Set([
  "--packages",
  "--checkers",
  "--effect",
  "--gate",
  "--repeats",
  "--warmup",
  "--rust-bin",
  "--tsgo-bin",
  "--bun-bin",
  "--rust-types",
  "--output",
  "--timeout-ms",
])

export function parseArgs(argv) {
  const options = {
    help: false,
    wsl: false,
    wslTsgo: false,
    packages: ["llm", "effect-drizzle-sqlite", "effect-sqlite-node", "http-recorder"],
    checkers: ["tsgo", "rust"],
    effect: "auto",
    gate: "observe",
    repeats: 1,
    warmup: 0,
    rustBin: process.env.TSC_RS_BIN ?? "",
    tsgoBin: process.env.TSGO_BIN ?? "",
    bunBin: process.env.BUN_BIN ?? "",
    rustTypes: [],
    output: "",
    timeoutMs: 180000,
  }
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--") continue
    const idx = arg.indexOf("=")
    const key = idx < 0 ? arg : arg.slice(0, idx)
    if (FLAGS.has(key)) {
      if (idx >= 0) throw new Error(`Flag ${key} takes no value`)
      options[key === "--help" ? "help" : key === "--wsl-tsgo" ? "wslTsgo" : "wsl"] = true
      continue
    }
    if (!VALUES.has(key)) throw new Error(`Unknown option '${arg}'`)
    if (key !== "--rust-types" && seen.has(key)) throw new Error(`Duplicate option ${key}`)
    seen.add(key)
    const value = idx >= 0 ? arg.slice(idx + 1) : argv[++i]
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`)
    switch (key) {
      case "--packages":
        options.packages = value.split(",")
        break
      case "--checkers":
        options.checkers = value.split(",")
        break
      case "--effect":
        options.effect = value
        break
      case "--gate":
        options.gate = value
        break
      case "--repeats":
        options.repeats = Number(value)
        break
      case "--warmup":
        options.warmup = Number(value)
        break
      case "--timeout-ms":
        options.timeoutMs = Number(value)
        break
      case "--rust-bin":
        options.rustBin = value
        break
      case "--tsgo-bin":
        options.tsgoBin = value
        break
      case "--bun-bin":
        options.bunBin = value
        break
      case "--rust-types":
        options.rustTypes.push(value)
        break
      case "--output":
        options.output = value
        break
    }
  }
  if (!["auto", "off"].includes(options.effect)) throw new Error("--effect must be auto or off")
  if (!["observe", "parity", "strict"].includes(options.gate))
    throw new Error("--gate must be observe, parity or strict")
  if (
    !options.checkers.length ||
    options.checkers.some((v) => !["tsgo", "rust", "bun"].includes(v)) ||
    new Set(options.checkers).size !== options.checkers.length
  )
    throw new Error("Invalid --checkers")
  if (!options.packages.length || options.packages.some((v) => !/^[\w-]+(?:\/[\w-]+)*$/.test(v)))
    throw new Error("Invalid --packages")
  if (options.packages.includes("all") && options.packages.length > 1) throw new Error("Use --packages all on its own")
  if (options.gate === "parity" && (!options.checkers.includes("tsgo") || !options.checkers.includes("rust")))
    throw new Error("Parity gate requires tsgo and rust")
  if (options.gate === "strict" && (!options.checkers.includes("tsgo") || !options.checkers.includes("rust")))
    throw new Error("Strict gate requires tsgo and rust")
  for (const [name, value, allowZero] of [
    ["repeats", options.repeats, false],
    ["warmup", options.warmup, true],
    ["timeout-ms", options.timeoutMs, false],
  ]) {
    if (
      !Number.isSafeInteger(value) ||
      value < (allowZero ? 0 : 1) ||
      (name === "timeout-ms" && value > 3600000) ||
      (name !== "timeout-ms" && value > 30)
    )
      throw new Error(`Invalid --${name}`)
  }
  parseRustTypes(options.rustTypes)
  return options
}
