import { resolveReplacement } from "../src/tool/edit/match"

const cases = [
  { lines: 500, iterations: 160 },
  { lines: 5_000, iterations: 60 },
  { lines: 20_000, iterations: 16 },
]

function stat(name: string, run: () => void, iterations: number) {
  for (let i = 0; i < 5; i++) run()
  const times: number[] = []
  for (let i = 0; i < iterations; i++) {
    const started = performance.now()
    run()
    times.push(performance.now() - started)
  }
  times.sort((a, b) => a - b)
  const p50 = times[Math.floor((times.length - 1) * 0.5)]!
  const p95 = times[Math.floor((times.length - 1) * 0.95)]!
  console.log(JSON.stringify({ name, iterations, p50Ms: +p50.toFixed(3), p95Ms: +p95.toFixed(3) }))
}

for (const { lines, iterations } of cases) {
  const source = Array.from({ length: lines }, (_, i) => `const row_${i} = ${i};`).join("\n") + "\n"
  const needle = `const row_${Math.floor(lines / 2)} = ${Math.floor(lines / 2)};`
  const replacement = "const changed = true;"
  stat(`unique-exact/${lines}`, () => {
    const result = resolveReplacement(source, needle, replacement)
    if (result.applied !== 1) throw new Error("incorrect result")
  }, iterations)
  stat(`selected-exact/${lines}`, () => {
    const result = resolveReplacement(source, needle, replacement, false, {
      mode: "one",
      atLine: Math.floor(lines / 2) + 1,
    })
    if (result.applied !== 1) throw new Error("incorrect result")
  }, iterations)
}
