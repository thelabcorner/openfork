/** Standalone synthetic projection microbenchmark. No DB, no live server. */
import { topUsageBy, topUsageSeries, usageBucketFloor } from "../src/usage/series"

const MODELS = 900
const PERIODS = 180
const BUDGET = 80
const ITERATIONS = 25
const slots = Array.from({ length: PERIODS }, (_, i) => ({ start: 1_000 + i * 86_400_000 }))
const data = new Map<string, Map<number, { cost: number; tokens: number; messages: number }>>()
let seed = 1095
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296)
for (let i = 0; i < MODELS; i++) {
  const timeline = new Map<number, { cost: number; tokens: number; messages: number }>()
  for (let j = 0; j < PERIODS; j++) {
    if (random() > 0.36) continue
    timeline.set(slots[j]!.start, { cost: random(), tokens: random() * 500, messages: Math.floor(random() * 4) })
  }
  data.set(`model-${i}`, timeline)
}
function oldRank() {
  return [...data.entries()].sort((a, b) => {
    let am = 0, bm = 0
    for (const [, bucket] of a[1]) am += bucket.messages
    for (const [, bucket] of b[1]) bm += bucket.messages
    return bm - am
  }).slice(0, BUDGET)
}
const newRank = () => topUsageSeries(data, BUDGET)
function oldAlign(entries: ReturnType<typeof oldRank>) {
  const out = []
  for (const [key, perStart] of entries) {
    const cost = new Array<number>(slots.length).fill(0)
    for (const [start, bucket] of perStart) {
      let fi = slots.length - 1
      while (fi > 0 && slots[fi]!.start > start) fi--
      if (slots[fi]!.start <= start) cost[fi]! += bucket.cost
    }
    out.push([key, cost])
  }
  return out
}
function newAlign(entries: ReturnType<typeof oldRank>) {
  const out = []
  for (const [key, perStart] of entries) {
    const cost = new Array<number>(slots.length).fill(0)
    for (const [start, bucket] of perStart) {
      const fi = usageBucketFloor(slots, start)
      if (fi >= 0) cost[fi]! += bucket.cost
    }
    out.push([key, cost])
  }
  return out
}
if (JSON.stringify(oldRank()) !== JSON.stringify(newRank())) throw new Error("ranking parity mismatch")
if (JSON.stringify(oldAlign(oldRank())) !== JSON.stringify(newAlign(newRank()))) throw new Error("alignment parity mismatch")
function bench(label: string, fn: () => unknown) {
  for (let i = 0; i < 3; i++) fn()
  const begin = performance.now()
  for (let i = 0; i < ITERATIONS; i++) fn()
  const avg = (performance.now() - begin) / ITERATIONS
  console.log(`${label}: ${avg.toFixed(3)} ms/op`)
  return avg
}
console.log(`Dataset: ${MODELS} models, ${PERIODS} periods, top ${BUDGET}, ${ITERATIONS} runs`)
const a = bench("previous rank", oldRank)
const b = bench("bounded rank", newRank)
const c = bench("previous alignment", () => oldAlign(newRank()))
const d = bench("indexed alignment", () => newAlign(newRank()))
console.log(`ranking speedup: ${(a/b).toFixed(2)}x; alignment speedup: ${(c/d).toFixed(2)}x`)

const sessions = Array.from({ length: 100_000 }, (_, i) => ({ id: i, tokens: (i * 271) % 120_107 }))
const oldSessions = () => [...sessions].sort((a, b) => b.tokens - a.tokens).slice(0, 50)
const newSessions = () => topUsageBy(sessions, 50, (session) => session.tokens)
if (JSON.stringify(oldSessions()) !== JSON.stringify(newSessions())) throw new Error("session ranking parity mismatch")
const oldMs = bench("full session ranking (100k)", oldSessions)
const newMs = bench("bounded session ranking (100k)", newSessions)
console.log(`session ranking speedup: ${(oldMs/newMs).toFixed(2)}x`)
