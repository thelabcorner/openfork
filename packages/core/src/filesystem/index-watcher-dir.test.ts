import { describe, expect, test } from "bun:test"
import { deriveDir } from "./index-watcher-dir"

describe("index watcher deriveDir", () => {
  const root = "/repo"

  test("file event invalidates its parent dir", () => {
    expect(deriveDir(root, "/repo/src/a/b.ts")).toBe("src/a")
  })

  test("root file event invalidates the root dir", () => {
    expect(deriveDir(root, "/repo/foo.ts")).toBe("")
  })

  test("directory create/delete invalidates its parent", () => {
    expect(deriveDir(root, "/repo/src/newdir")).toBe("src")
  })

  test("skips paths outside the root", () => {
    expect(deriveDir(root, "/other/file.ts")).toBeUndefined()
  })

  test("skips dot segments (e.g. .git)", () => {
    expect(deriveDir(root, "/repo/.git/index.lock")).toBeUndefined()
    expect(deriveDir(root, "/repo/src/.hidden/file.ts")).toBeUndefined()
  })

  test("normalizes windows separators", () => {
    expect(deriveDir("C:\\repo", "C:\\repo\\src\\a.ts")).toBe("src")
  })
})
