import { createHash } from "node:crypto"
import { PreparedProgramCache } from "@/code/prepared"

const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`
const timed = <T>(run: () => T) => {
  const start = performance.now()
  const value = run()
  return { value, ms: performance.now() - start }
}

const javascriptSource = `
const items = Array.isArray(input.items) ? input.items : []
const active = items.filter((item) => item.value > 0)
return active.reduce((sum, item) => sum + item.value, 0)
`
const typescriptSource = `
type Item = { value: number }
const items: Item[] = Array.isArray(input.items) ? input.items : []
const active = items.filter((item) => item.value > 0)
return active.reduce((sum, item) => sum + item.value, 0)
`

PreparedProgramCache.resetForTest()
const javascriptCold = timed(() => PreparedProgramCache.get(javascriptSource, hash(javascriptSource)))
const typescriptCold = timed(() => PreparedProgramCache.get(typescriptSource, hash(typescriptSource)))

const iterations = 20_000
const hitHash = hash(javascriptSource)
const hitStart = performance.now()
for (let i = 0; i < iterations; i++) PreparedProgramCache.get(javascriptSource, hitHash)
const hitMicros = ((performance.now() - hitStart) * 1_000) / iterations

console.log("Code Tool prepare benchmark")
console.log("===========================")
console.log(`cold_prepare_js ${javascriptCold.ms.toFixed(3)} ms`)
console.log(`cold_prepare_ts ${typescriptCold.ms.toFixed(3)} ms`)
console.log(`cache_hit_mean ${hitMicros.toFixed(3)} us/op`)
console.log(`cache_entries ${PreparedProgramCache.stats().entries}`)
