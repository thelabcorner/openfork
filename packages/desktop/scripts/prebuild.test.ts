import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"

describe("desktop prebuild hook", () => {
  test("preflights and stages the worktree-store sidecar exactly once with the resolved channel", async () => {
    const source = await readFile(path.join(import.meta.dir, "prebuild.ts"), "utf8")
    expect(source.match(/from "\.\/fetch-worktree-store"/g) ?? []).toHaveLength(1)
    expect(source.match(/await preflightWorktreeStore\(/g) ?? []).toHaveLength(1)
    expect(source.match(/await stageWorktreeStore\(/g) ?? []).toHaveLength(1)
    expect(source).toContain("const worktreeStore = await preflightWorktreeStore({ channel })")
    expect(source).toContain("await stageWorktreeStore({ channel })")
    const preflight = source.indexOf("await preflightWorktreeStore(")
    expect(preflight).toBeLessThan(source.indexOf("await stageWorktreeStore("))
    expect(preflight).toBeLessThan(source.indexOf("copy-icons"))
  })
})
