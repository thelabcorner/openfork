/* oxlint-disable typescript-eslint/no-floating-promises -- node:test owns and awaits registered test lifecycles */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  compareDiagnostics,
  difference,
  median,
  normalizePath,
  parseArgs,
  parseDiagnostics,
  parseRustTypes,
  summarizeDiagnostics,
  summarizeEffectRules,
} from "./typecheck-frontier-lib.mjs"

const location = (file, line, column, severity, code, message = "fixture") =>
  `${file}(${line},${column}): ${severity} TS${code}: ${message}`

describe("compiler diagnostics", () => {
  it("recognizes TS errors, Effect severity, global errors, multiline context and CRLF", () => {
    const input = [
      location("packages\\core\\src\\a.ts", 4, 7, "error", 2322, "Type mismatch"),
      "  Type Foo is not assignable",
      location("packages/llm/test/a.ts", 3, 1, "suggestion", 377098, "Use Schema.Finite"),
      location("packages/llm/src/a.ts", 11, 2, "warning", 377033, "multiple provide"),
      location("packages/llm/src/a.ts", 14, 9, "error", 377001, "floating effect"),
      "error TS18003: No inputs found",
      "Found 2 errors.",
    ].join("\r\n")
    const parsed = parseDiagnostics(input)
    assert.equal(parsed.length, 5)
    assert.deepEqual(
      parsed.map((item) => item.family),
      ["typescript", "effect", "effect", "effect", "typescript"],
    )
    assert.equal(parsed[0].file, "packages/core/src/a.ts")
    assert.equal(parsed[4].file, null)
    assert.equal(parsed[3].code, 377001)
    assert.deepEqual(summarizeDiagnostics(parsed), {
      typescriptErrors: 2,
      effectErrors: 1,
      effectWarnings: 1,
      effectSuggestions: 1,
    })
  })

  it("compares TS diagnostics as a multiset without hiding missing errors", () => {
    const diagnostic = location("packages/core/src/a.ts", 1, 1, "error", 2322)
    const baseline = parseDiagnostics([diagnostic, diagnostic, location("x.ts", 3, 1, "error", 2307)].join("\n"))
    const candidate = parseDiagnostics(
      [diagnostic, location("y.ts", 6, 2, "error", 2345), location("y.ts", 1, 1, "suggestion", 377017)].join("\n"),
    )
    const diff = compareDiagnostics(baseline, candidate)
    assert.equal(diff.baselineCount, 3)
    assert.equal(diff.candidateCount, 2)
    assert.equal(diff.introduced.length, 1)
    assert.equal(diff.missing.length, 2)
    assert.equal(diff.missing[0].code, 2322)
    assert.equal(diff.missing[1].code, 2307)
    assert.equal(diff.identical, undefined)
    assert.deepEqual(difference([], baseline), [])
  })

  it("keeps source locations in the parity identity, ignoring message phrasing", () => {
    const before = parseDiagnostics(location("x.ts", 1, 3, "error", 2304, "Name is missing"))
    const after = parseDiagnostics(location("x.ts", 1, 3, "error", 2304, "Cannot find name"))
    assert.equal(compareDiagnostics(before, after).introduced.length, 0)
    assert.equal(compareDiagnostics(before, after).missing.length, 0)
    assert.equal(
      compareDiagnostics(before, parseDiagnostics(location("x.ts", 1, 4, "error", 2304))).introduced.length,
      1,
    )
  })

  it("normalizes stable repository-relative paths", () => {
    assert.equal(normalizePath(".\\packages\\core\\a.ts"), "packages/core/a.ts")
  })

  it("computes the median without mutating input", () => {
    const samples = [50, 2, 17, 4]
    assert.equal(median(samples), 10.5)
    assert.deepEqual(samples, [50, 2, 17, 4])
    assert.equal(median([]), null)
    assert.equal(median([8]), 8)
  })
})

describe("frontier argument safety", () => {
  it("defaults to read-only observation on effect-enabled workspaces", () => {
    const args = parseArgs([])
    assert.deepEqual(args.checkers, ["tsgo", "rust"])
    assert.deepEqual(args.packages, ["llm", "effect-drizzle-sqlite", "effect-sqlite-node", "http-recorder"])
    assert.equal(args.gate, "observe")
    assert.equal(args.effect, "auto")
  })

  it("accepts repeated per-package ambient overrides, single gate and benchmark arguments", () => {
    const args = parseArgs([
      "--packages=llm,effect-sqlite-node",
      "--rust-types",
      "llm=bun",
      "--rust-types",
      "effect-sqlite-node=node",
      "--gate",
      "parity",
      "--warmup",
      "1",
      "--repeats",
      "5",
    ])
    assert.equal(args.repeats, 5)
    assert.equal(args.warmup, 1)
    assert.deepEqual(
      [...parseRustTypes(args.rustTypes)],
      [
        ["llm", ["bun"]],
        ["effect-sqlite-node", ["node"]],
      ],
    )
  })

  it("rejects invalid checker/gate combinations, unknown flags, duplicates and unsafe selection", () => {
    for (const argv of [
      ["--checkers", "rust", "--gate", "parity"],
      ["--checkers", "bun,rust", "--gate", "parity"],
      ["--checkers", "rust,rust"],
      ["--checkers", "whatever"],
      ["--packages", "../secrets"],
      ["--packages", "all,core"],
      ["--repeats", "0"],
      ["--warmup", "-1"],
      ["--timeout-ms", "0"],
      ["--gate", "other"],
      ["--effect", "strange"],
      ["--random"],
      ["--packages", "core", "--packages", "llm"],
      ["--rust-types", "core=../other"],
      ["--rust-types", "core=bun", "--rust-types", "core=node"],
    ])
      assert.throws(() => parseArgs(argv), `accepted invalid args: ${JSON.stringify(argv)}`)
  })

  it("does not permit an observational checker to silently become a strict gate", () => {
    assert.equal(parseArgs(["--gate", "observe"]).gate, "observe")
    assert.throws(() => parseArgs(["--gate", "strict", "--checkers", "bun"]))
  })

  it("aggregates Effect rules without mixing severity and captures bounded samples", () => {
    const data = parseDiagnostics(
      [
        location("a.ts", 1, 1, "warning", 377023),
        location("a.ts", 2, 1, "warning", 377023),
        location("b.ts", 3, 1, "warning", 377023),
        location("c.ts", 4, 1, "error", 377023),
        location("c.ts", 5, 1, "suggestion", 377098),
        location("a.ts", 6, 1, "error", 2322),
      ].join("\n"),
    )
    const rules = summarizeEffectRules(data)
    assert.deepEqual(
      rules.map((r) => [r.code, r.severity, r.count, r.fileCount]),
      [
        [377023, "warning", 3, 2],
        [377023, "error", 1, 1],
        [377098, "suggestion", 1, 1],
      ],
    )
    assert.equal(rules[0].samples.length, 3)
  })
})

it("supports nested workspace keys and independent WSL checker selection", () => {
  const args = parseArgs(["--packages", "sdk/js", "--wsl", "--wsl-tsgo", "--tsgo-bin", "/tmp/tsgo"])
  assert.deepEqual(args.packages, ["sdk/js"])
  assert.equal(args.wslTsgo, true)
  assert.equal(args.wsl, true)
  assert.throws(() => parseArgs(["--packages", "sdk/../core"]))
})
