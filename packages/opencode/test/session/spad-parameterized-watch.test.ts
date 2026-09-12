import { describe, expect, test } from "bun:test"
import { ParameterizedBlockWatch } from "@/session/spad/parameterized-watch"

function structuralBlock(id: string) {
  return [
    `function parse${id}(input${id}) {`,
    `  const node${id} = scan(input${id})`,
    `  if (!node${id}) return null`,
    `  const value${id} = normalize(node${id}.value)`,
    `  if (!value${id}) return null`,
    `  record(value${id}, node${id})`,
    `  return parse${id}(value${id})`,
    `}`,
  ]
}

function pushBlocks(watch: ParameterizedBlockWatch, blocks: string[][]) {
  let hit
  for (const block of blocks) for (const line of block) hit ??= watch.pushLine(line)
  return hit
}

describe("SPAD sustained parameterized block watch", () => {
  test("requires a sustained three-recurrence renamed series", () => {
    const watch = new ParameterizedBlockWatch()
    expect(pushBlocks(watch, [structuralBlock("A"), structuralBlock("B"), structuralBlock("C")])).toBeUndefined()
    const hit = pushBlocks(watch, [structuralBlock("D")])
    expect(hit).toBeDefined()
    expect(hit?.recurrence).toBeGreaterThanOrEqual(3)
    expect(hit?.evidence.renamedParameterClasses).toBeGreaterThanOrEqual(2)
    expect(hit?.evidence.repeatedParameterDensity).toBeGreaterThanOrEqual(0.5)
  })

  test("changing numeric constants break the proposal series", () => {
    const watch = new ParameterizedBlockWatch()
    const blocks = Array.from({ length: 8 }, (_, i) => [
      `function handler${i}(input${i}) {`,
      `  const value${i} = normalize(input${i}.value)`,
      `  if (!value${i}) return ${i}`,
      `  const score${i} = value${i}.length + ${i + 1}`,
      `  record(score${i}, value${i})`,
      `  if (score${i} > ${10 + i}) return value${i}`,
      `  return null`,
      `}`,
    ])
    expect(pushBlocks(watch, blocks)).toBeUndefined()
  })

  test("all-fresh identifier templates stay below strength gate", () => {
    const watch = new ParameterizedBlockWatch()
    const block = (base: number) => Array.from({ length: 8 }, (_, i) => `item${base + i} + value${base + i};`)
    expect(pushBlocks(watch, [block(0), block(10), block(20), block(30), block(40)])).toBeUndefined()
  })

  test("series expires outside local history", () => {
    const watch = new ParameterizedBlockWatch({ maxDistanceLines: 16 })
    pushBlocks(watch, [structuralBlock("A")])
    for (let i = 0; i < 4; i++) pushBlocks(watch, [[...Array.from({ length: 8 }, (_, j) => `const gap${i}_${j} = ${i * 8 + j};`)]])
    expect(pushBlocks(watch, [structuralBlock("B"), structuralBlock("C"), structuralBlock("D")])).toBeUndefined()
  })
})
