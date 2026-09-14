import { describe, expect, test } from "bun:test"
import type { FileNode } from "@opencode-ai/sdk/v2"
import { startProjectExplorerSearch } from "./project-explorer-search-runner"

const node = (index: number): FileNode => ({
  name: `file-${index}.ts`,
  path: `src/file-${index}.ts`,
  absolute: `/repo/src/file-${index}.ts`,
  type: "file",
  ignored: false,
})

describe("project explorer cooperative search", () => {
  test("searches 50k loaded nodes in cooperative slices", async () => {
    const nodes = Array.from({ length: 50_000 }, (_, index) => node(index))
    const result = await new Promise<{
      matches: number
      rows: number
      slices: number
      maxSliceMs: number
      totalMs: number
    }>((resolve) => {
      startProjectExplorerSearch({
        query: "file-",
        nodes,
        root: () => nodes,
        children: () => [],
        complete: (search, metrics) =>
          resolve({
            matches: search.matches.size,
            rows: search.rows.length,
            slices: metrics.slices,
            maxSliceMs: metrics.maxSliceMs,
            totalMs: metrics.totalMs,
          }),
      })
    })

    console.info(`[explorer-50k] ${JSON.stringify(result)}`)
    expect(result.matches).toBe(50_000)
    expect(result.rows).toBe(50_000)
    expect(result.slices).toBeGreaterThan(1)
    // This is deliberately looser than the 4ms target to avoid CI scheduler
    // noise while still catching a regression back to one monolithic 20ms+
    // traversal on ordinary developer hardware.
    expect(result.maxSliceMs).toBeLessThan(16)
  })

  test("a superseding generation cancels before publishing stale results", async () => {
    const nodes = Array.from({ length: 50_000 }, (_, index) => node(index))
    let cancelled = false
    let published = false
    const stop = startProjectExplorerSearch({
      query: "file-",
      nodes,
      root: () => nodes,
      children: () => [],
      cancelled: () => cancelled,
      complete: () => {
        published = true
      },
    })
    cancelled = true
    await new Promise((resolve) => setTimeout(resolve, 10))
    stop()
    expect(published).toBe(false)
  })
})
