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
})
