import { describe, expect, test } from "bun:test"
import type { FileNode } from "@opencode-ai/sdk/v2"
import { flattenFileTreeV2 } from "./file-tree-v2-model"
import { appendedProjectExplorerSearchPaths, createProjectExplorerSearchAccumulator } from "./project-explorer-search-runner"
import { buildProjectExplorerSearchTree, startProjectExplorerSearchTree } from "./project-explorer-search-tree"
import { startProjectExplorerSearchTreeDelta } from "./project-explorer-search-incremental"

const lookup = (_path: string): FileNode | undefined => undefined
const paths = (model: ReturnType<typeof buildProjectExplorerSearchTree>) =>
  flattenFileTreeV2(model, () => true).map((row) => [row.node.path, row.node.type, row.node.name, row.level, row.node.absolute])

async function extend(
  previous: ReturnType<typeof buildProjectExplorerSearchTree>,
  addedMatches: readonly string[],
  addedAncestors: readonly string[],
  root = "C:\\repo",
) {
  return new Promise<ReturnType<typeof buildProjectExplorerSearchTree>>((resolve, reject) => {
    const stopped = startProjectExplorerSearchTreeDelta({
      previous, addedMatches, addedAncestors, lookup, root, sliceMs: 0.2,
      complete: (model) => resolve(model),
    })
    if (!stopped) reject(new Error("Unexpected bounded-index fallback"))
  })
}

describe("incremental Project Explorer search hierarchy", () => {
  test("appends 12 distinct pages while preserving complete reference order and previous models", async () => {
    const accumulator = createProjectExplorerSearchAccumulator("file")
    accumulator.page(["src/file-a.ts", "README-file.md"])
    let snapshot = accumulator.snapshot()
    let model = buildProjectExplorerSearchTree(snapshot.matches, snapshot.ancestors, lookup, "C:\\repo")
    const initial = paths(model)
    for (let batch = 0; batch < 12; batch++) {
      const incoming = Array.from({ length: 50 }, (_, i) =>
        `src/group-${(batch + i) % 7}/file-${String(batch * 50 + i).padStart(5, "0")}.ts`)
      if (batch === 4) incoming.push("README-file.md")
      accumulator.page(incoming, batch === 3 ? ["src/existing-file"] : [])
      const next = accumulator.snapshot()
      const addedMatches = appendedProjectExplorerSearchPaths(snapshot.matches, next.matches)
      const addedAncestors = appendedProjectExplorerSearchPaths(snapshot.ancestors, next.ancestors)
      expect(addedMatches).toBeDefined()
      expect(addedAncestors).toBeDefined()
      model = await extend(model, addedMatches!, addedAncestors!)
      const expected = buildProjectExplorerSearchTree(next.matches, next.ancestors, lookup, "C:\\repo")
      expect(paths(model)).toEqual(paths(expected))
      snapshot = next
    }
    expect(initial).toEqual([
      ["src", "directory", "src", 0, "C:\\repo\\src"],
      ["src/file-a.ts", "file", "file-a.ts", 1, "C:\\repo\\src\\file-a.ts"],
      ["README-file.md", "file", "README-file.md", 0, "C:\\repo\\README-file.md"],
    ])
  })

  test("converts a previous file into a directory as later pages discover descendants", async () => {
    let model = buildProjectExplorerSearchTree(new Set(["src/tool"]), new Set(["src"]), lookup)
    const before = paths(model)
    model = await extend(model, ["src/tool/inside.ts"], ["src/tool"], "")
    expect(paths(model)).toEqual(paths(buildProjectExplorerSearchTree(
      new Set(["src/tool", "src/tool/inside.ts"]), new Set(["src", "src/tool"]), lookup,
    )))
    expect(before[1]?.[1]).toBe("file")
    expect(paths(model)[1]?.[1]).toBe("directory")
  })

  test("wide unchanged buckets preserve nodes/array identities and cancellation never publishes", async () => {
    const original = new Set(Array.from({ length: 20_000 }, (_, i) => `src/file-${String(i).padStart(5, "0")}.ts`))
    const first = await new Promise<ReturnType<typeof buildProjectExplorerSearchTree>>((resolve) => {
      startProjectExplorerSearchTree({
        matches: original, ancestors: new Set(["src"]), lookup,
        complete: resolve,
      })
    })
    const priorBucket = first.children.get("src")
    const changed = await extend(first, ["docs/new-file.ts"], ["docs"], "")
    expect(changed.children.get("src")).toBe(priorBucket)
    expect(first.children.get("docs")).toBeUndefined()
    expect(changed.children.get("docs")?.map((node) => node.path)).toEqual(["docs/new-file.ts"])
    expect(changed.children.get("")).not.toBe(first.children.get(""))
    expect(paths(changed)).toEqual(paths(buildProjectExplorerSearchTree(
      new Set([...original, "docs/new-file.ts"]), new Set(["src", "docs"]), lookup,
    )))
    const newSiblings = Array.from({ length: 1_000 }, (_, i) =>
      `src/file-new-${String(1_000 - i).padStart(5, "0")}.ts`)
    const wideUpdate = await extend(changed, newSiblings, [], "")
    expect(paths(wideUpdate)).toEqual(paths(buildProjectExplorerSearchTree(
      new Set([...original, "docs/new-file.ts", ...newSiblings]), new Set(["src", "docs"]), lookup,
    )))
    expect(changed.children.get("src")).toBe(priorBucket)

    const queued: Array<() => void> = []
    let called = false
    let virtualTime = 0
    const cancel = startProjectExplorerSearchTreeDelta({
      previous: changed,
      addedMatches: ["src/file-new.ts"],
      addedAncestors: [],
      lookup, root: "",
      schedule: (run) => { queued.push(run); return 0 as unknown as ReturnType<typeof setTimeout> },
      now: () => (virtualTime += 0.02),
      sliceMs: 0.1,
      complete: () => { called = true },
    })
    expect(cancel).toBeDefined()
    queued.shift()!()
    cancel!()
    while (queued.length) queued.shift()!()
    expect(called).toBe(false)
    expect(changed.children.get("src")).toBe(priorBucket)
  })

  test("large deltas and unknown base indexes require an authoritative full projector", () => {
    const known = buildProjectExplorerSearchTree(new Set(), new Set(), lookup)
    expect(startProjectExplorerSearchTreeDelta({
      previous: known, addedMatches: Array(2_049).fill("a/file.ts"), addedAncestors: [],
      lookup, root: "", complete: () => { throw new Error("Should fall back") },
    })).toBeUndefined()
    expect(startProjectExplorerSearchTreeDelta({
      previous: { children: new Map(), total: 0 }, addedMatches: ["a/file.ts"], addedAncestors: [],
      lookup, root: "", complete: () => { throw new Error("Should fall back") },
    })).toBeUndefined()
  })
})
