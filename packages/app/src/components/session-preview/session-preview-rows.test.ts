import { expect, test } from "bun:test"
import type { SessionPreviewRelationships, SessionPreviewTreeRow } from "./session-preview-model"
import {
  forEachPreviewSession,
  previewRelationshipCount,
  previewSessionWeights,
  previewUnopenedCount,
  previewVisibleRows,
} from "./session-preview-rows"

function row(id: string, depth = 0): SessionPreviewTreeRow {
  return { row: { id, title: id, locked: false, origin: "user" }, depth, last: true }
}
function fixture(sectionSizes: number[], special = 0): SessionPreviewRelationships {
  return {
    sections: sectionSizes.map((size, index) => ({
      kind: index % 2 ? "plugin" as const : "subagent" as const,
      name: `Section ${index}`,
      rows: Array.from({ length: size }, (_, i) => row(`s${index}:${i}`, i % 4)),
    })),
    specialAgents: Array.from({ length: special }, (_, i) => ({
      row: row(`agent:${i}`).row,
      parentTitle: `Parent ${i}`,
    })),
  }
}

test("bounded projection matches the former complete flattening for section and special-agent boundaries", () => {
  for (const sizes of [[0], [1], [30, 40, 60], [0, 0, 200], [79, 3], [82, 0, 1]]) {
    const rel = fixture(sizes, 5)
    const full = [
      ...rel.sections.flatMap((section, sectionIndex) => section.rows.map((member, index) => ({
        first: index === 0,
        sectionKey: `section-${sectionIndex}`,
        sectionName: section.name,
        sectionKind: section.kind,
        sectionCount: section.rows.length,
        row: member,
      }))),
      ...rel.specialAgents.map((entry, index) => ({
        first: index === 0,
        sectionKey: "special-agents",
        sectionName: "Special Agents",
        sectionKind: "special" as const,
        sectionCount: rel.specialAgents.length,
        row: { row: entry.row, depth: 0, last: true },
        parentTitle: entry.parentTitle,
      })),
    ]
    expect(previewRelationshipCount(rel)).toBe(full.length)
    for (const limit of [0, 1, 30, 79, 80, 81, 160, 500]) {
      expect(previewVisibleRows(rel, limit, "Special Agents")).toEqual(full.slice(0, limit))
    }
    const all: string[] = []
    forEachPreviewSession(rel, (id) => all.push(id))
    expect(all).toEqual(full.map((item) => item.row.row.id))
  }
  expect(previewRelationshipCount(undefined)).toBe(0)
  expect(previewVisibleRows(undefined, 80, "Special Agents")).toEqual([])
})

test("large group materializes only the first requested page without dropping bulk-action rows", () => {
  const rel = fixture([16_384], 17)
  const visible = previewVisibleRows(rel, 80, "Special Agents")
  expect(visible).toHaveLength(80)
  expect(visible[0]?.row.row.id).toBe("s0:0")
  expect(visible.at(-1)?.row.row.id).toBe("s0:79")
  expect(previewRelationshipCount(rel)).toBe(16_401)
  let count = 0
  forEachPreviewSession(rel, () => count++)
  expect(count).toBe(16_401)
})

test("openable and status multiplicities preserve repeated cross-group sessions", () => {
  const rel = fixture([4, 4], 3)
  // The same worker can occur in two groups plus the special-agent list.
  rel.sections[1]!.rows[0]!.row.id = "s0:0"
  rel.specialAgents[0]!.row.id = "s0:0"
  const weights = previewSessionWeights(rel)
  expect(weights.get("s0:0")).toBe(3)
  expect(weights.get("s0:1")).toBe(1)
  expect([...weights.values()].reduce((sum, count) => sum + count, 0)).toBe(previewRelationshipCount(rel))
  expect(previewUnopenedCount(weights, new Set(["s0:0"]), previewRelationshipCount(rel))).toBe(8)
  expect(previewUnopenedCount(weights, new Set(["s0:0", "s0:1", "unknown"]), previewRelationshipCount(rel))).toBe(7)
})

test("openable count matches the former O(all rows) calculation across many tab revisions", () => {
  const rel = fixture([16_384, 3], 12)
  const weights = previewSessionWeights(rel)
  const total = previewRelationshipCount(rel)
  const idSet = [...weights.keys()]
  let seed = 211
  for (let pass = 0; pass < 100; pass++) {
    const opens = new Set<string>()
    for (let i = 0; i < 300; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      opens.add(idSet[seed % idSet.length]!)
    }
    let original = 0
    forEachPreviewSession(rel, (id) => {
      if (!opens.has(id)) original++
    })
    expect(previewUnopenedCount(weights, opens, total)).toBe(original)
  }
})