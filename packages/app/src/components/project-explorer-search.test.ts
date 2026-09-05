import { describe, expect, test } from "bun:test"
import { createProjectExplorerSearchExpansion } from "./project-explorer-search"

function makeTree(initial: string[] = []) {
  const expanded = new Set(initial)
  const tree = createProjectExplorerSearchExpansion({
    isExpanded: (path) => expanded.has(path),
    expand: (path) => expanded.add(path),
    collapse: (path) => expanded.delete(path),
  })
  return { expanded, tree }
}

describe("project explorer search expansion", () => {
  test("requeues shared ancestors after a query supersedes their pending listing", () => {
    const expanded = new Set<string>()
    const requests: number[] = []
    let generation = 0
    const search = createProjectExplorerSearchExpansion({
      isExpanded: (path) => expanded.has(path),
      expand: (path, options) => { expanded.add(path); requests.push(options?.generation ?? -1) },
      collapse: (path) => { expanded.delete(path) },
      beginGeneration: () => ++generation,
    })
    search.sync(new Set(["shared"]), "a")
    search.sync(new Set(["shared"]), "ab")
    expect(requests).toEqual([1, 2])
    search.sync(new Set(["shared"]), "ab")
    expect(requests).toEqual([1, 2])
  })
  test("clearing search collapses only directories expanded for search", () => {
    const { expanded, tree } = makeTree(["already-open"])

    tree.sync(new Set(["already-open", "search/branch"]))
    expect([...expanded].sort()).toEqual(["already-open", "search/branch"])

    tree.sync(undefined)
    expect([...expanded]).toEqual(["already-open"])
  })

  test("query changes release stale search branches", () => {
    const { expanded, tree } = makeTree()

    tree.sync(new Set(["old/branch"]))
    tree.sync(new Set(["new/branch"]))

    expect([...expanded].sort()).toEqual(["new/branch"])
  })

  test("manual toggles are not collapsed when search is cleared", () => {
    const { expanded, tree } = makeTree()

    tree.sync(new Set(["branch"]))
    tree.userToggled("branch")
    tree.sync(undefined)

    expect([...expanded]).toEqual(["branch"])
  })

  test("manual expand-all ownership survives tree updates during search", () => {
    const { expanded, tree } = makeTree()

    tree.sync(new Set(["branch"]), "query")
    tree.releaseAll("query")
    expanded.add("branch")
    tree.sync(new Set(["branch"]), "query")
    tree.sync(undefined, "")

    expect([...expanded]).toEqual(["branch"])
  })

  test("does not supersede queued work when the same query is refreshed", () => {
    const generations: number[] = []
    let nextGeneration = 0
    const { expanded, tree } = (() => {
      const current = new Set<string>()
      const value = createProjectExplorerSearchExpansion({
        isExpanded: (path) => current.has(path),
        expand: (path) => current.add(path),
        collapse: (path) => current.delete(path),
        beginGeneration: () => {
          const generation = ++nextGeneration
          generations.push(generation)
          return generation
        },
      })
      return { expanded: current, tree: value }
    })()

    tree.sync(new Set(["src"]), "needle")
    tree.sync(new Set(["src"]), "needle")
    tree.sync(new Set(["src", "src/lib"]), "needle")

    expect(generations).toEqual([1])
    expect([...expanded].sort()).toEqual(["src", "src/lib"])
  })
})
