export type ProtectedNegativeClass =
  | "prose"
  | "markdown-table"
  | "markdown-nested-list"
  | "jsonl"
  | "csv"
  | "sql"
  | "source-code"
  | "generated-tests"
  | "diff"
  | "logs"
  | "repeated-sections"
  | "quoted-reference"
  | "code-fence"
  | "structured-output"
  | "explicit-repetition"
  | "expanding-report"

export type TextCase = {
  name: string
  class: ProtectedNegativeClass
  text: string
  user?: string
  structured?: boolean
}

export type CounterfactualPair = {
  name: string
  healthy: TextCase
  degenerate: TextCase
}

function expandingLedger(cycles: number) {
  const findings = Array.from({ length: cycles + 2 }, (_, i) => `Finding ${i + 1}: subsystem-${i % 5} remains under review.`)
  return Array.from({ length: cycles }, (_, c) => ["## Current findings", ...findings.slice(0, c + 1), ""].join("\n")).join("\n")
}

export const negativeCases: readonly TextCase[] = Object.freeze([
  {
    name: "long technical prose with recurring vocabulary",
    class: "prose",
    text: Array.from({ length: 180 }, (_, i) => `Section ${i + 1} evaluates the detector, policy, verifier, recovery budget, and calibration boundary. The argument revisits detector precision while introducing observation ${i}, source family ${i % 13}, and consequence ${i % 17}.`).join("\n\n"),
  },
  {
    name: "large markdown table",
    class: "markdown-table",
    text: ["| id | module | status |", "|---:|---|---|", ...Array.from({ length: 1200 }, (_, i) => `| ${i} | module-${i % 31} | ${i % 7 === 0 ? "retrying" : "ok"} |`)].join("\n"),
  },
  {
    name: "deep nested markdown lists with repeated labels and changing leaves",
    class: "markdown-nested-list",
    text: Array.from({ length: 260 }, (_, i) => `- Approach ${i + 1}\n  - Evidence\n    1. module-${i % 23} changed at revision ${i}\n    2. benchmark-${i % 17} measured ${(i * 31) % 1009}\n  - Next\n    - verify invariant-${i % 29}\n    - record outcome-${i}`).join("\n"),
  },
  {
    name: "jsonl records",
    class: "jsonl",
    text: Array.from({ length: 1200 }, (_, i) => JSON.stringify({ id: i, path: `src/module-${i % 43}.ts`, ok: i % 11 !== 0, attempt: i % 5 })).join("\n"),
  },
  {
    name: "csv export with repeated schema and changing rows",
    class: "csv",
    text: ["id,module,status,attempt,latency_ms", ...Array.from({ length: 1800 }, (_, i) => `${i},module-${i % 43},${i % 11 === 0 ? "retry" : "ok"},${i % 5},${13 + (i * 29) % 700}`)].join("\n"),
  },
  {
    name: "sql bulk insert with changing values",
    class: "sql",
    text: `INSERT INTO results (id, module, status, attempt) VALUES\n${Array.from({ length: 1400 }, (_, i) => `(${i}, 'module-${i % 41}', '${i % 9 === 0 ? "retry" : "ok"}', ${i % 6})`).join(",\n")};`,
  },
  {
    name: "templated source code",
    class: "source-code",
    text: Array.from({ length: 220 }, (_, i) => `export function handler${i}(input: Input) {\n  const value = normalize(input.value)\n  return { id: ${i}, value, ok: value.length > ${i % 9} }\n}\n`).join("\n"),
  },
  {
    name: "generated tests with repetitive setup but changing assertions",
    class: "generated-tests",
    text: Array.from({ length: 180 }, (_, i) => `test("case ${i}", async () => {\n  const fixture = await makeFixture({ id: ${i}, mode: "${i % 4}" })\n  const result = await runFixture(fixture)\n  expect(result.code).toBe(${i % 9})\n  expect(result.id).toBe(${i})\n})\n`).join("\n"),
  },
  {
    name: "unified diff",
    class: "diff",
    text: Array.from({ length: 180 }, (_, i) => `diff --git a/src/a${i}.ts b/src/a${i}.ts\n--- a/src/a${i}.ts\n+++ b/src/a${i}.ts\n@@ -1,3 +1,3 @@\n-const enabled = false\n+const enabled = true\n export const id = ${i}\n`).join("\n"),
  },
  {
    name: "stack and log stream",
    class: "logs",
    text: Array.from({ length: 900 }, (_, i) => `[2026-09-12T12:${String(i % 60).padStart(2, "0")}:00] INFO worker=${i % 16} request=${i} phase=${i % 7} latency=${17 + (i * 13) % 500}ms`).join("\n"),
  },
  {
    name: "repeated markdown sections with changing content",
    class: "repeated-sections",
    text: Array.from({ length: 90 }, (_, i) => `### Approach ${i + 1}\n- Inspect module ${i % 17}\n- Compare invariant ${i % 23}\n- Record result ${i}\n`).join("\n"),
  },
  {
    name: "quoted reference corpus with repeated citation frame",
    class: "quoted-reference",
    text: Array.from({ length: 240 }, (_, i) => `> Reference ${i + 1}: "The verifier remains bounded while evidence item ${i} differs from source ${i % 29}."\n\nCommentary: citation ${i + 1} supports claim-${i % 37}.`).join("\n\n"),
  },
  {
    name: "exact repeated code inside a fence remains non-destructive",
    class: "code-fence",
    text: "```ts\n" + "const placeholder = createPlaceholder();\n".repeat(40) + "```\n",
  },
  {
    name: "structured output is always non-destructive",
    class: "structured-output",
    structured: true,
    text: '{"status":"same","value":42}\n'.repeat(80),
  },
  {
    name: "explicit repetition request is always non-destructive",
    class: "explicit-repetition",
    user: "Repeat the following sentence exactly 100 times.",
    text: "This sentence is intentionally repeated. ".repeat(100),
  },
  {
    name: "expanding report is heuristic only",
    class: "expanding-report",
    text: expandingLedger(22),
  },
])

export const counterfactualPairs: readonly CounterfactualPair[] = Object.freeze([
  {
    name: "enumeration values change vs frozen item",
    healthy: {
      name: "changing enumeration",
      class: "repeated-sections",
      text: Array.from({ length: 180 }, (_, i) => `- Candidate ${i + 1}: inspect module-${i % 31}, score=${(i * 17) % 997}, state=${i % 5}.`).join("\n"),
    },
    degenerate: {
      name: "frozen enumeration",
      class: "repeated-sections",
      text: "- Candidate 1: inspect module-0, score=17, state=0.\n".repeat(180),
    },
  },
  {
    name: "json records progress vs exact replay",
    healthy: {
      name: "progressing json records",
      class: "jsonl",
      text: Array.from({ length: 220 }, (_, i) => JSON.stringify({ id: i, file: `src/${i % 19}.ts`, result: i % 7, attempt: i % 4 })).join("\n"),
    },
    degenerate: {
      name: "replayed json record",
      class: "jsonl",
      text: `${JSON.stringify({ id: 7, file: "src/7.ts", result: 0, attempt: 3 })}\n`.repeat(220),
    },
  },
  {
    name: "repeated code schema vs exact function replay",
    healthy: {
      name: "generated handlers",
      class: "source-code",
      text: Array.from({ length: 120 }, (_, i) => `export function handler${i}(x: number) { return x + ${i}; }\n`).join(""),
    },
    degenerate: {
      name: "replayed function",
      class: "source-code",
      text: "export function handler0(x: number) { return x + 0; }\n".repeat(120),
    },
  },
])
