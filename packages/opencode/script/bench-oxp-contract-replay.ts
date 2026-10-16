/**
 * Compare legacy per-call schema canonicalization to the cached immutable
 * broker descriptor proof used by OXP. No network calls or DB mutations.
 *
 * Run from repo root: bun packages/opencode/script/bench-oxp-contract-replay.ts
 * This is ONLY the contract/projection CPU cost, not end-to-end capability
 * dispatch, permission checks, MCP transport, or task-completion latency.
 */
import { describe, violation, violationExpected } from "../src/tool/broker-contract"

function makeSchema(count: number) {
  return {
    type: "object",
    properties: Object.fromEntries(Array.from({ length: count }, (_, i) => [
      `argument_${i.toString().padStart(4, "0")}`,
      { type: "string", description: `Authoritative authored argument ${i}; preserve executable semantics.`, maxLength: 4096 },
    ])),
    required: ["argument_0000"],
    additionalProperties: false,
  }
}

function median(values: readonly number[]) {
  const s = values.toSorted((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}
function sample(fn: () => unknown, iterations: number) {
  let accepted = 0
  const samples: number[] = []
  for (let run = 0; run < 5; run++) {
    const start = performance.now()
    for (let i = 0; i < iterations; i++) {
      if (fn() === undefined) accepted++
    }
    samples.push((performance.now() - start) * 1_000 / iterations)
  }
  if (accepted !== iterations * 5) throw new Error("Incorrect contract result")
  return median(samples)
}

for (const count of [64, 256, 1024]) {
  const schema = makeSchema(count)
  const descriptor = describe({
    broker: "capability", target: "project", description: "Inspect approved source",
    targetField: "capability", schema,
  })
  const json = JSON.stringify(descriptor)
  const legacy = () => {
    const parsed = JSON.parse(json) as typeof descriptor
    return violation({
      broker: parsed.broker,
      target: parsed.target,
      description: parsed.description,
      schema: parsed.inputSchema,
      contract: parsed.contract,
      discovery: "describe project",
    })
  }
  const optimized = () => violationExpected({
    broker: "capability", target: "project", expected: descriptor.contract,
    contract: descriptor.contract, discovery: "describe project",
  })
  if (legacy() !== optimized()) throw new Error("Replay semantics differ")
  const oldUs = sample(legacy, 100)
  const newUs = sample(optimized, 20_000)
  console.log(JSON.stringify({
    schemaProperties: count,
    descriptorBytes: Buffer.byteLength(json),
    legacyMedianUs: Number(oldUs.toFixed(3)),
    ownerProofMedianUs: Number(newUs.toFixed(5)),
    speedup: Number((oldUs / Math.max(1e-6, newUs)).toFixed(1)),
    scope: "contract/projection only",
  }))
}
