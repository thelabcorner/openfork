/**
 * Golden oracle for workbuddy correctness gate.
 * Exact equality, no epsilon — captures exposedModels / parseConfigPayload / parseWorkBuddyContextWindows.
 * Run: bun run benchmarks/workbuddy-oracle.ts
 */
import { parseWorkBuddyContextWindows, decodeWorkBuddyContextModel } from "../packages/opencode/src/plugin/workbuddy"

// Re-export parseConfigPayload is not exported — we test via catalogFor fixture indirectly.
// For oracle, we exercise the exported parseWorkBuddyContextWindows + decodeWorkBuddyContextModel
// and also snapshot exposedModels-equivalent via harness.

function deepEqual(a: any, b: any): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

type Case = { name: string; input: any; fallback: number; expected: number[] }
const cases: Case[] = [
  {
    name: "explicit selectable lengths preserves default",
    input: { defaultLength: 131072, supportedLengths: [32768, { tokens: 65536 }, 131072] },
    fallback: 131072,
    expected: [32768, 65536, 131072],
  },
  {
    name: "ignores range bounds and malformed values",
    input: { minLength: 1, maxLength: 1048576, lengths: ["bad", 0, 262144] },
    fallback: 131072,
    expected: [131072, 262144],
  },
  {
    name: "array raw with object tokens",
    input: [{ tokens: 32768 }, 65536, { tokenCount: 131072 }],
    fallback: 131072,
    expected: [32768, 65536, 131072],
  },
  {
    name: "empty object fallback only",
    input: {},
    fallback: 131072,
    expected: [131072],
  },
  {
    name: "dedup and sort",
    input: { supportedLengths: [131072, 131072, 32768] },
    fallback: 131072,
    expected: [32768, 131072],
  },
]

let passed = 0
let failed = 0
for (const c of cases) {
  const out = parseWorkBuddyContextWindows(c.input as any, c.fallback)
  const ok = deepEqual(out, c.expected)
  console.log(`${ok ? "PASS" : "FAIL"} oracle:${c.name} -> ${JSON.stringify(out)} expected ${JSON.stringify(c.expected)}`)
  if (ok) passed++; else failed++
}

// decodeWorkBuddyContextModel
const d1 = decodeWorkBuddyContextModel("hy4-preview#ctx-262144")
const d1ok = d1.model === "hy4-preview" && d1.contextWindowTokens === 262144
console.log(`${d1ok ? "PASS" : "FAIL"} oracle:decodeWorkBuddyContextModel hy4-preview#ctx-262144 -> ${JSON.stringify(d1)}`)
if (d1ok) passed++; else failed++

const d2 = decodeWorkBuddyContextModel("hy4-preview@wb-account-a")
const d2ok = d2.model === "hy4-preview@wb-account-a" && d2.contextWindowTokens === undefined
console.log(`${d2ok ? "PASS" : "FAIL"} oracle:decodeWorkBuddyContextModel affinity preserved -> ${JSON.stringify(d2)}`)
if (d2ok) passed++; else failed++

const d3 = decodeWorkBuddyContextModel("glm-5.2#ctx-0")
const d3ok = d3.model === "glm-5.2#ctx-0" // 0 invalid, should return original
console.log(`${d3ok ? "PASS" : "FAIL"} oracle:decodeWorkBuddyContextModel invalid 0 -> ${JSON.stringify(d3)}`)
if (d3ok) passed++; else failed++

console.log(`\nOracle: ${passed} passed, ${failed} failed`)
if (failed) process.exit(1)

// Export golden for harness consumption
export const goldenCases = cases
