// Bench: @mention popover hot paths vs the <16ms frame-budget gate.
// Measures the REAL exported implementations:
//   resolveAtToken          — per keystroke (trigger detection, incl. spaced external paths)
//   toMentionOptions        — per results batch (server MentionResult[] -> AtOption[])
//   buildAtRows             — per results batch (groups -> virtualizer row model)
//   splitHighlightSegments  — per row mount (match-position highlight spans)
// Scroll-frame JS cost is bounded by these: fixed 28px rows mean no
// measureElement writes, and segmentation only runs when a row mounts.
//
// Run: bun "C:/Users/slooshied/WebstormProjects/opencode/packages/app/bench/at-mention.bench.mts"

import fuzzysort from "fuzzysort"
import { buildAtRows, splitHighlightSegments } from "../src/components/prompt-input/at-rows"
import { normalizeMentionPage, toMentionOptions } from "../src/components/prompt-input/at-mention-search"
import { resolveAtToken } from "../src/components/prompt-input/at-token"
import type { MentionResult } from "../src/context/file"
import type { AtGroup } from "../src/components/prompt-input/at-rows"

function time(op: string, iterations: number, run: () => void) {
  for (let i = 0; i < Math.min(iterations, 50); i++) run()
  const t0 = Bun.nanoseconds()
  for (let i = 0; i < iterations; i++) run()
  const ms = (Bun.nanoseconds() - t0) / 1e6
  const nsOp = (ms * 1e6) / iterations
  console.log(`${op.padEnd(52)} ${String(iterations).padStart(8)} it   ${nsOp.toFixed(0).padStart(8)} ns/op   ${ms.toFixed(2).padStart(9)} ms total`)
}

function makeResults(count: number): MentionResult[] {
  const out: MentionResult[] = []
  for (let i = 0; i < count; i++) {
    if (i % 5 === 0) {
      out.push({
        kind: "symbol",
        name: `createHandler${i}`,
        path: `packages/app/src/handlers/mod-${i % 97}/thing.ts`,
        line: (i % 400) + 1,
        symbolKind: (["fn", "method", "class", "interface", "type", "enum", "const"] as const)[i % 7],
        positions: [0, 6, 7],
      })
      continue
    }
    if (i % 11 === 0) {
      out.push({ kind: "file", path: `packages/ui/src/components/folder-${i % 31}/`, type: "directory" })
      continue
    }
    out.push({
      kind: "file",
      path: `packages/app/src/pages/session/view-${i % 211}/component-${i}.tsx`,
      positions: i % 3 === 0 ? [4, 5, 12] : undefined,
    })
  }
  return out
}

function makeGroups(totalItems: number): AtGroup[] {
  const per = Math.floor(totalItems / 3)
  return [
    { category: "agent", items: [{ type: "agent", name: "build", display: "build" }] },
    {
      category: "recent",
      items: Array.from({ length: 8 }, (_, i) => ({ type: "file" as const, path: `src/f${i}.ts`, display: `src/f${i}.ts`, recent: true })),
    },
    {
      category: "file",
      items: Array.from({ length: per }, (_, i) => ({
        type: "file" as const,
        path: `packages/app/src/deep/nested/dir-${i % 40}/file-${i}.tsx`,
        display: `packages/app/src/deep/nested/dir-${i % 40}/file-${i}.tsx`,
        isDir: false,
        positions: i % 4 === 0 ? [3, 4] : undefined,
      })),
    },
    {
      category: "symbol",
      items: Array.from({ length: totalItems - per - 8 }, (_, i) => ({
        type: "symbol" as const,
        name: `symbolName${i}`,
        path: `src/m${i % 60}/x.ts`,
        line: i + 1,
        symbolKind: "fn" as const,
        display: `symbolName${i}`,
        positions: [0, 1, 2],
      })),
    },
  ]
}

console.log("— trigger resolution (per keystroke) —")
const keystream = ["", "s", "sr", "src", "src/", "src/comp", "C:", "C:\\Program Files\\tool v2", "~/.config/my app data"]
time("resolveAtToken keystream x1", 100_000, () => {
  for (const token of keystream) resolveAtToken(`hello @${token}`)
})

console.log("\n— per results batch (server page of 200; fetch-more up to 5000) —")
for (const n of [200, 1000, 5000]) {
  const results = makeResults(n)
  const recents = Array.from({ length: 20 }, (_, i) => `packages/app/src/pages/session/view-${i}/component-${i}.tsx`)
  time(`toMentionOptions n=${n}`, n >= 5000 ? 200 : 1000, () => toMentionOptions(results, recents))
}

console.log("\n— real /find/search wire path (compat normalize: sentinels + baseOffset projection) —")
function makeWirePage(count: number) {
  return {
    results: makeResults(count).map((entry) => {
      if (entry.kind === "symbol") {
        return {
          kind: "symbol" as const,
          name: entry.name,
          path: entry.path,
          line: `${entry.line}` as number | string,
          symbolKind: entry.symbolKind,
          positions: entry.positions?.map((p) => `${p}` as number | string),
        }
      }
      const baseOffset = entry.path.length - (entry.path.split("/").pop() ?? "").length
      return {
        kind: "file" as const,
        path: entry.path,
        type: entry.type,
        positions: entry.positions?.map((p) => p + baseOffset) as number[] | undefined,
        baseOffset: `${baseOffset}` as number | string,
      }
    }),
    hasMore: false,
  }
}
for (const n of [200, 1000, 5000]) {
  const page = makeWirePage(n)
  time(`normalizeMentionPage n=${n}`, n >= 5000 ? 200 : 1000, () => normalizeMentionPage(page))
}
for (const n of [1000, 5000]) {
  const groups = makeGroups(n)
  time(`buildAtRows rows=${n}`, n >= 5000 ? 500 : 2000, () => buildAtRows(groups))
}

console.log("\n— highlight segmentation (per row mount; ~28 rows visible+overscan) —")
time("splitHighlightSegments 30ch/8hits", 20_000, () => splitHighlightSegments("createSessionTabsController", [0, 6, 7, 14, 15, 16, 22, 27]))

console.log("\n— context: local-set fuzzysort per keystroke (hook filters only non-skipped items) —")
const localSet = [
  ...Array.from({ length: 25 }, (_, i) => ({ display: `reference-${i}` })),
  ...Array.from({ length: 10 }, (_, i) => ({ display: `agent-${i}` })),
  ...Array.from({ length: 15 }, (_, i) => ({ display: `mcp-resource-${i}` })),
]
time("fuzzysort.go 50-item local set", 20_000, () => fuzzysort.go("ref", localSet, { keys: ["display"] }))
