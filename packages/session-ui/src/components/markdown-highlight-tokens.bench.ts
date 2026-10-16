import type { ThemedToken } from "shiki"
import { getTokenStyleObject, stringifyTokenStyle } from "shiki"
import { convertHighlightTokens, flattenHighlightLines } from "./markdown-highlight-tokens"
import { createTokenStyleSerializer } from "./markdown-token-style"
import { highlightTokenBytes, nextHighlightStateBytes } from "./markdown-highlight-accounting"

const lines: ThemedToken[][] = Array.from({ length: 250 }, (_, row) =>
  Array.from({ length: 32 }, (_, column) => ({ content: `token_${row}_${column}`, offset: column } as ThemedToken)),
)
const segments = lines.flat()
const toToken = (value: ThemedToken): [string, string] => [value.content, "color:#abc"]
const oldComplete = () =>
  lines.flatMap((line, index) => (index === lines.length - 1 ? line : [...line, { content: "\n", offset: 0 } as ThemedToken])).map(toToken)
const newComplete = () => flattenHighlightLines(lines, toToken)
const oldStream = () => segments.filter((token) => token.content.length > 0).map(toToken)
const newStream = () => convertHighlightTokens(segments, toToken)
const palette = ["#79b8ff", "#e1e4e8", "#f97583", "#85e89d", "#b392f0", "#ffab70"]
const colored: ThemedToken[] = segments.map((token, index) => ({
  ...token,
  color: palette[index % palette.length]!,
  fontStyle: index % 24 === 0 ? 1 : 0,
}))
const cachedStyle = createTokenStyleSerializer()
const oldStyles = () => colored.map((value) => stringifyTokenStyle(value.htmlStyle ?? getTokenStyleObject(value)))
const newStyles = () => colored.map(cachedStyle)
const stable: [string, string][] = segments.map((token) => [token.content, "color:#abc"])
const prevUnstable: [string, string][] = [["incomplete", "color:#abc"]]
const nextUnstable: [string, string][] = [["incomplete + suffix", "color:#abc"]]
const accountedBytes = highlightTokenBytes(stable) + highlightTokenBytes(prevUnstable)
const oldAccounting = () => highlightTokenBytes(stable) + highlightTokenBytes(nextUnstable)
const newAccounting = () => nextHighlightStateBytes(
  { unstable: prevUnstable },
  accountedBytes,
  { reset: false, stable: [], unstable: nextUnstable },
)

function bench(name: string, operation: () => unknown, rounds = 200) {
  for (let i = 0; i < 30; i++) operation()
  const samples: number[] = []
  for (let trial = 0; trial < 7; trial++) {
    const begin = performance.now()
    let output: unknown
    for (let i = 0; i < rounds; i++) output = operation()
    if (output === undefined || (Array.isArray(output) && !output.length)) throw new Error("invalid benchmark output")
    samples.push((performance.now() - begin) / rounds)
  }
  samples.sort((a, b) => a - b)
  return { name, medianMs: samples[3]!, minMs: samples[0]!, p95Ms: samples[6]! }
}
const results = [
  bench("complete original", oldComplete),
  bench("complete optimized", newComplete),
  bench("stream original", oldStream),
  bench("stream optimized", newStream),
  bench("Shiki styles original", oldStyles),
  bench("Shiki styles cached", newStyles),
  bench("state accounting full scan", oldAccounting),
  bench("state accounting delta", newAccounting),
]
console.table(results)
console.log("tokenCount=", segments.length, "completeSpeedup=", (results[0]!.medianMs/results[1]!.medianMs).toFixed(2), "streamSpeedup=", (results[2]!.medianMs/results[3]!.medianMs).toFixed(2), "styleSpeedup=", (results[4]!.medianMs/results[5]!.medianMs).toFixed(2), "accountingSpeedup=", (results[6]!.medianMs/results[7]!.medianMs).toFixed(2))
