/**
 * Reproducible, side-effect-free titlebar status request-tree microbenchmark.
 *
 * Run from the repository root:
 *   bun run benchmarks/tab-strip-request-tree.bench.ts
 *
 * Comparisons apply to the request-tree algorithm only, not to DOM rendering,
 * Solid reactivity, Electron p95 latency, or overall concurrent throughput.
 */
import { performance } from "node:perf_hooks"
import { sessionQuestionRequest } from "../packages/app/src/pages/session/composer/session-request-tree"
import type { QuestionRequest } from "@opencode-ai/sdk/v2/client"

const CHILDREN = 128
const LOOKUPS = 2_500
const REPEATS = 7
const rootID = "root"
const children = new Map([[rootID, Array.from({ length: CHILDREN }, (_, i) => `worker-${i}`)]])
const root = { root: [{ id: "root" } as QuestionRequest] }
const distant = { [`worker-${CHILDREN - 1}`]: [{ id: "last" } as QuestionRequest] }
const empty = {} as Record<string, QuestionRequest[]>
type Requests = Record<string, QuestionRequest[]>

function legacy(request: Requests) {
  const seen = new Set([rootID])
  const ids = [rootID]
  for (const id of ids) {
    const list = children.get(id)
    if (!list) continue
    for (const child of list) {
      if (seen.has(child)) continue
      seen.add(child)
      ids.push(child)
    }
  }
  const id = ids.find((id) => request[id]?.some(() => true))
  return id ? request[id]?.find(() => true) : undefined
}

const optimized = (request: Requests) => sessionQuestionRequest(children, request, rootID)
let checksum = 0

function sample(fn: (request: Requests) => QuestionRequest | undefined, request: Requests) {
  const start = performance.now()
  for (let i = 0; i < LOOKUPS; i++) checksum += fn(request)?.id.length ?? 0
  return performance.now() - start
}

function compare(name: string, request: Requests) {
  if (legacy(request)?.id !== optimized(request)?.id) throw new Error(`request precedence mismatch: ${name}`)
  for (let i = 0; i < 3; i++) {
    sample(legacy, request)
    sample(optimized, request)
  }
  const previous: number[] = []
  const updated: number[] = []
  for (let i = 0; i < REPEATS; i++) {
    if (i % 2) {
      updated.push(sample(optimized, request))
      previous.push(sample(legacy, request))
    } else {
      previous.push(sample(legacy, request))
      updated.push(sample(optimized, request))
    }
  }
  const median = (numbers: number[]) => numbers.sort((a, b) => a - b)[Math.floor(numbers.length / 2)]
  const before = median(previous)
  const after = median(updated)
  console.log(`${name.padEnd(18)} previous=${before.toFixed(3)}ms optimized=${after.toFixed(3)}ms ratio=${(before / after).toFixed(2)}x`)
}

console.log(`Request tree: ${CHILDREN} descendants, ${LOOKUPS} lookups/trial, ${REPEATS} alternating trials`)
compare("root request", root)
compare("last descendant", distant)
compare("no request", empty)
console.log(`checksum=${checksum}`)