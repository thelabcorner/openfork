import { parameterizedMatchCode, parameterizedMatchTokens, tokenizeParameterizedCode } from "../src/session/spad/parameterized"
import { ParameterizedFingerprintBuilder, equalParameterizedFingerprint } from "../src/session/spad/parameterized-fast"
import { ParameterizedBlockWatch } from "../src/session/spad/parameterized-watch"

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

function renamedFunction(i: number) {
  return `function parse${i}(input${i}) { const node${i} = scan(input${i}); if (!node${i}) return null; const value${i} = normalize(node${i}.value); return parse${i}(value${i}) }`
}

function generatedHandler(i: number) {
  return `export function handler${i}(input${i}) { const value${i} = normalize(input${i}.value); return { id: ${i}, value: value${i}, ok: value${i}.length > ${i % 9} } }`
}

const pairs = 20_000
const positive: Array<[string, string]> = []
const negative: Array<[string, string]> = []
for (let i = 0; i < pairs; i++) {
  positive.push([renamedFunction(i), renamedFunction(i + 1)])
  negative.push([generatedHandler(i), generatedHandler(i + 1)])
}

const positiveTokens = positive.map(([a, b]) => [tokenizeParameterizedCode(a), tokenizeParameterizedCode(b)] as const)
const negativeTokens = negative.map(([a, b]) => [tokenizeParameterizedCode(a), tokenizeParameterizedCode(b)] as const)

function bench(name: string, data: Array<[string, string]>) {
  const times: number[] = []
  let matches = 0
  for (let rep = 0; rep < 7; rep++) {
    let local = 0
    const start = Bun.nanoseconds()
    for (const [a, b] of data) if (parameterizedMatchCode(a, b).matched) local++
    times.push(Bun.nanoseconds() - start)
    if (rep === 6) matches = local
  }
  const ns = median(times)
  const chars = data.reduce((sum, [a, b]) => sum + a.length + b.length, 0)
  return { benchmark: name, pairs: data.length, matches, medianNs: ns, nsPerPair: ns / data.length, nsPerInputChar: ns / chars }
}

function benchPretokenized(name: string, data: ReadonlyArray<readonly [ReturnType<typeof tokenizeParameterizedCode>, ReturnType<typeof tokenizeParameterizedCode>]>) {
  const times: number[] = []
  let matches = 0
  for (let rep = 0; rep < 11; rep++) {
    let local = 0
    const start = Bun.nanoseconds()
    for (const [a, b] of data) if (parameterizedMatchTokens(a, b).matched) local++
    times.push(Bun.nanoseconds() - start)
    if (rep === 10) matches = local
  }
  const ns = median(times)
  const tokens = data.reduce((sum, [a, b]) => sum + a.length + b.length, 0)
  return { benchmark: name, pairs: data.length, matches, medianNs: ns, nsPerPair: ns / data.length, nsPerInputToken: ns / tokens }
}

function benchTokenize(name: string, data: Array<[string, string]>) {
  const times: number[] = []
  let tokens = 0
  for (let rep = 0; rep < 7; rep++) {
    let local = 0
    const start = Bun.nanoseconds()
    for (const [a, b] of data) local += tokenizeParameterizedCode(a).length + tokenizeParameterizedCode(b).length
    times.push(Bun.nanoseconds() - start)
    if (rep === 6) tokens = local
  }
  const ns = median(times)
  const chars = data.reduce((sum, [a, b]) => sum + a.length + b.length, 0)
  return { benchmark: name, pairs: data.length, tokens, medianNs: ns, nsPerInputChar: ns / chars, nsPerToken: ns / tokens }
}

function benchFingerprint(name: string, data: Array<[string, string]>) {
  const times: number[] = []
  let proposals = 0
  const maxChars = Math.max(...data.flatMap(([a, b]) => [a.length, b.length]))
  const left = new ParameterizedFingerprintBuilder(maxChars + 8)
  const right = new ParameterizedFingerprintBuilder(maxChars + 8)
  for (let rep = 0; rep < 11; rep++) {
    let local = 0
    const start = Bun.nanoseconds()
    for (const [a, b] of data) if (equalParameterizedFingerprint(left.build(a), right.build(b))) local++
    times.push(Bun.nanoseconds() - start)
    if (rep === 10) proposals = local
  }
  const ns = median(times)
  const chars = data.reduce((sum, [a, b]) => sum + a.length + b.length, 0)
  return { benchmark: name, pairs: data.length, proposals, medianNs: ns, nsPerPair: ns / data.length, nsPerInputChar: ns / chars }
}

function structuralBlock(i: number) {
  return [
    `function parse${i}(input${i}) {`,
    `  const node${i} = scan(input${i})`,
    `  if (!node${i}) return null`,
    `  const value${i} = normalize(node${i}.value)`,
    `  if (!value${i}) return null`,
    `  record(value${i}, node${i})`,
    `  return parse${i}(value${i})`,
    `}`,
  ]
}

function numericBlock(i: number) {
  return [
    `function handler${i}(input${i}) {`,
    `  const value${i} = normalize(input${i}.value)`,
    `  if (!value${i}) return ${i}`,
    `  const score${i} = value${i}.length + ${i + 1}`,
    `  record(score${i}, value${i})`,
    `  if (score${i} > ${10 + i}) return value${i}`,
    `  return null`,
    `}`,
  ]
}

function benchWatch(name: string, blocks: string[][]) {
  const lines = blocks.flat()
  const chars = lines.reduce((sum, line) => sum + line.length + 1, 0)
  const times: number[] = []
  let detections = 0
  for (let rep = 0; rep < 9; rep++) {
    const watch = new ParameterizedBlockWatch()
    let local = 0
    const start = Bun.nanoseconds()
    for (const line of lines) if (watch.pushLine(line)) local++
    times.push(Bun.nanoseconds() - start)
    if (rep === 8) detections = local
  }
  const ns = median(times)
  return { benchmark: name, blocks: blocks.length, detections, medianNs: ns, nsPerInputChar: ns / chars }
}

console.log(JSON.stringify({
  runtime: `Bun ${Bun.version}`,
  rows: [
    bench("end-to-end-consistent-renaming", positive),
    bench("end-to-end-changing-numeric-semantics", negative),
    benchTokenize("tokenize-consistent-renaming", positive),
    benchFingerprint("fingerprint-consistent-renaming", positive),
    benchFingerprint("fingerprint-changing-numeric-semantics", negative),
    benchPretokenized("verify-consistent-renaming", positiveTokens),
    benchPretokenized("verify-changing-numeric-semantics", negativeTokens),
    benchWatch("watch-sustained-renaming", Array.from({ length: 4000 }, (_, i) => structuralBlock(i))),
    benchWatch("watch-changing-numeric-semantics", Array.from({ length: 4000 }, (_, i) => numericBlock(i))),
  ],
}, null, 2))
