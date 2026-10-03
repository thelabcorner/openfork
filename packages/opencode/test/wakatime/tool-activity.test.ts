import { describe, expect, test } from "bun:test"
import * as path from "path"


import { ToolActivity } from "../../src/wakatime/tool-activity"
import type { EffectBridge } from "../../src/effect/bridge"

/**
 * `tool.execute.after` producer adapter.
 *
 * The adapter is pure projection code, so these tests drive `plan` directly and
 * assert the truthfulness rules: read is not double-reported, write claims no
 * line count, patch tools claim only what they reported and only when they
 * actually applied, orchestration tools stay silent, and paths/session context
 * are canonical.
 *
 * Path expectations are derived from `path.resolve` rather than hardcoded POSIX
 * strings because the adapter canonicalizes through the host platform.
 */

const ROOT = path.resolve("/repo")

/** Canonical absolute path inside the fake instance, as the adapter would emit it. */
const abs = (...segments: string[]) => path.join(ROOT, ...segments)

/**
 * The canonical project folder the adapter proves from the context worktree.
 * Derived lexically, because stamping a folder must not touch the filesystem.
 */
const FOLDER = path.resolve(ROOT)

const CONTEXT: ToolActivity.PluginContext = {
  directory: ROOT,
  worktree: ROOT,
  project: { name: "demo" },
}

function after(tool: string, metadata: unknown, overrides: { sessionID?: string; callID?: string } = {}) {
  return ToolActivity.plan(
    { tool, sessionID: overrides.sessionID ?? "ses_1", callID: overrides.callID ?? "call_1" },
    { metadata },
    CONTEXT,
  )
}

const fileEntry = (filePath: string, additions: number, deletions: number) => ({
  filePath,
  relativePath: filePath,
  type: "update",
  patch: "",
  additions,
  deletions,
})

describe("tool.execute.after producer truthfulness", () => {
  test("read stays silent because the read tool already reports it directly", () => {
    expect(ToolActivity.supports("read")).toBe(false)
    expect(
      after("read", {
        filePaths: [abs("a.ts")],
        count: 3,
        applied: true,
        files: [fileEntry(abs("a.ts"), 3, 0)],
      }),
    ).toEqual([])
  })

  test("write reports the path the tool wrote and claims no line count", () => {
    const planned = after("write", {
      filepath: abs("src", "new.ts"),
      exists: false,
      diagnostics: { [abs("src", "new.ts")]: [{ severity: "error" }] },
    })
    expect(planned).toHaveLength(1)
    expect(planned[0]).toEqual({
      entity: abs("src", "new.ts"),
      kind: "write",
      aiSession: "ses_1",
      sourceRef: "call_1",
      replayToken: "call_1",
      source: "session",
      project: "demo",
      projectFolder: FOLDER,
    })
    // A whole-file write is not a line diff; the count must be absent, not zero.
    expect("aiLineChanges" in planned[0]).toBe(false)
  })

  test("edit reports the signed net delta its result metadata states", () => {
    const planned = after("edit", {
      diagnostics: {},
      diff: "",
      filediff: { file: abs("src", "edit.ts"), patch: "", additions: 7, deletions: 3 },
    })
    expect(planned).toEqual([
      {
        entity: abs("src", "edit.ts"),
        kind: "write",
        aiSession: "ses_1",
        sourceRef: "call_1",
        replayToken: "call_1",
        source: "session",
        project: "demo",
        projectFolder: FOLDER,
        aiLineChanges: 4,
      },
    ])
  })

  test("a deletion-heavy edit is negative rather than a count of touched lines", () => {
    // Additions+deletions would report 9 touched lines for an edit that removed
    // eight and added one. The exact net delta is -7.
    const planned = after("edit", {
      filediff: { file: abs("src", "shrunk.ts"), additions: 1, deletions: 8 },
    })
    expect(planned.map((item) => item.aiLineChanges)).toEqual([-7])
  })

  test("edit bulk pathway reports each file once", () => {
    const planned = after("edit", {
      files: [fileEntry(abs("a.ts"), 1, 0), fileEntry(abs("b.ts"), 2, 5)],
      fileCount: 2,
    })
    expect(planned.map((item) => item.entity)).toEqual([abs("a.ts"), abs("b.ts")])
    expect(planned.map((item) => item.aiLineChanges)).toEqual([1, -3])
  })

  test("patch and apply_patch report only an applied plan", () => {
    const applied = { applied: true, files: [fileEntry(abs("p.ts"), 4, 1)] }
    expect(after("patch", applied).map((item) => [item.entity, item.aiLineChanges])).toEqual([[abs("p.ts"), 3]])
    expect(after("apply_patch", applied).map((item) => [item.entity, item.aiLineChanges])).toEqual([[abs("p.ts"), 3]])

    // A validated-but-not-applied plan is not a write.
    for (const metadata of [
      { applied: false, files: [fileEntry(abs("p.ts"), 4, 1)] },
      { files: [fileEntry(abs("p.ts"), 4, 1)] },
      { applied: "true", files: [fileEntry(abs("p.ts"), 4, 1)] },
    ]) {
      expect(after("patch", metadata)).toEqual([])
      expect(after("apply_patch", metadata)).toEqual([])
    }
  })

  test("a patch with conflicts still reports the files that actually changed", () => {
    const planned = after("patch", {
      applied: true,
      conflicts: 1,
      files: [fileEntry(abs("ok.ts"), 2, 1), fileEntry(abs("bad.ts"), 0, 0)],
    })
    expect(planned.map((item) => item.entity)).toEqual([abs("ok.ts"), abs("bad.ts")])
  })

  test("orchestration and non-mutating tools are silent", () => {
    for (const tool of [
      "bash",
      "task",
      "webfetch",
      "websearch",
      "grep",
      "glob",
      "list",
      "todowrite",
      "question",
      "custom_unknown_tool",
      "constructor",
      "",
    ]) {
      expect(after(tool, { files: [fileEntry(abs("a.ts"), 1, 1)], applied: true })).toEqual([])
    }
    expect(ToolActivity.REPORTED_TOOLS.sort()).toEqual(["apply_patch", "edit", "patch", "write"])
  })

  test("missing, malformed, and empty result metadata are silent", () => {
    for (const metadata of [
      undefined,
      null,
      "string",
      42,
      [],
      {},
      { filepath: "" },
      { filepath: "   " },
      { filepath: 12 },
      { filediff: {} },
      { files: "nope" },
      { files: [null, 5, {}, { additions: 1 }] },
      { applied: true, files: [{}] },
    ]) {
      expect(after("edit", metadata)).toEqual([])
      expect(after("write", metadata)).toEqual([])
      expect(after("patch", metadata)).toEqual([])
    }
  })
})

describe("tool.execute.after canonical context and dedupe", () => {
  test("relative metadata paths resolve against the canonical instance directory", () => {
    const planned = ToolActivity.plan(
      { tool: "write", sessionID: "ses_2", callID: "call_2" },
      { metadata: { filepath: path.join("src", "rel.ts") } },
      CONTEXT,
    )
    expect(planned.map((item) => item.entity)).toEqual([abs("src", "rel.ts")])
    expect(planned[0]).toMatchObject({ aiSession: "ses_2", sourceRef: "call_2", replayToken: "call_2" })
  })

  test("paths that canonicalize to the same file are recorded once", () => {
    const planned = after("edit", {
      filediff: { file: path.join(ROOT, "src", ".", "dup.ts"), additions: 2, deletions: 1 },
      files: [fileEntry(abs("src", "dup.ts"), 3, 1), fileEntry(path.join("src", "dup.ts"), 1, 0)],
    })
    expect(planned).toHaveLength(1)
    expect(planned[0].entity).toBe(abs("src", "dup.ts"))
    // Dedupe sums net deltas rather than dropping real edits: 1 + 2 + 1.
    expect(planned[0].aiLineChanges).toBe(4)
  })

  test("distinct files are never collapsed together", () => {
    const planned = after("edit", {
      files: [fileEntry(abs("src", "a.ts"), 1, 0), fileEntry(abs("src", "b.ts"), 0, 1)],
    })
    expect(planned.map((item) => item.entity)).toEqual([abs("src", "a.ts"), abs("src", "b.ts")])
  })

  test("project falls back to the worktree basename when unnamed", () => {
    const planned = ToolActivity.plan(
      { tool: "write", sessionID: "s", callID: "c" },
      { metadata: { filepath: abs("a.ts") } },
      { directory: ROOT, worktree: ROOT, project: {} },
    )
    expect(planned[0]).toMatchObject({ project: path.basename(ROOT) })
  })

  test("an instance at the filesystem root reports no project at all", () => {
    const root = path.parse(ROOT).root
    const planned = ToolActivity.plan(
      { tool: "write", sessionID: "s", callID: "c" },
      { metadata: { filepath: path.join(root, "a.ts") } },
      { directory: root, worktree: root, project: undefined },
    )
    expect(planned).toHaveLength(1)
    expect("project" in planned[0]).toBe(false)
    // The root IS this instance's authoritative folder, so it is still reported
    // as one: it is not a display-name guess that happens to be empty.
    expect(planned[0]).toMatchObject({ projectFolder: path.resolve(root) })
  })
})

describe("tool.execute.after project folder authority", () => {
  test("a root file and a deeply nested file report one identical canonical folder", () => {
    // The worktree is the instance's own root, so entity depth cannot change it.
    // A parent-directory heuristic would report `src`/`deep` for the nested file.
    const planned = after("edit", {
      filediff: { file: abs("top.ts"), additions: 1, deletions: 0 },
      files: [fileEntry(abs("src", "deep", "a.ts"), 2, 0)],
    })
    expect(planned.map((item) => item.entity)).toEqual([abs("top.ts"), abs("src", "deep", "a.ts")])
    expect([...new Set(planned.map((item) => item.projectFolder))]).toEqual([FOLDER])
    for (const folder of planned.map((item) => item.projectFolder)) {
      expect(path.isAbsolute(folder!)).toBe(true)
    }
  })

  test("the folder is the worktree even when the display name disagrees with it", () => {
    // An operator-chosen project name is a label, never a directory. It must not
    // be turned into one, and it must not displace the proven root.
    const planned = ToolActivity.plan(
      { tool: "write", sessionID: "s", callID: "c" },
      { metadata: { filepath: abs("a.ts") } },
      { directory: ROOT, worktree: ROOT, project: { name: "renamed-in-ui" } },
    )
    expect(planned[0]).toMatchObject({ project: "renamed-in-ui", projectFolder: FOLDER })
  })

  test("the worktree wins over the directory when the two differ", () => {
    // A linked worktree proves a different root than the project directory.
    const worktree = abs(".openfork", "wt", "feature")
    const planned = ToolActivity.plan(
      { tool: "write", sessionID: "s", callID: "c" },
      { metadata: { filepath: path.join(worktree, "a.ts") } },
      { directory: ROOT, worktree, project: { name: "repo" } },
    )
    expect(planned[0]).toMatchObject({ projectFolder: path.resolve(worktree) })
  })

  test("the directory is the fallback for a context with no worktree", () => {
    const planned = ToolActivity.plan(
      { tool: "write", sessionID: "s", callID: "c" },
      { metadata: { filepath: abs("a.ts") } },
      { directory: ROOT, worktree: "", project: undefined },
    )
    expect(planned[0]).toMatchObject({ projectFolder: FOLDER })
  })

  test("a non-VCS '/' worktree sentinel reports the absolute directory, never '/'", () => {
    // A global/non-VCS instance carries `worktree: "/"` (Project.fromDirectory).
    // That sentinel matches any absolute path, so reporting it would attribute
    // every edit to the filesystem root. The instance directory is the only real
    // root in that case, and it must be the value that lands on the record.
    const planned = ToolActivity.plan(
      { tool: "write", sessionID: "s", callID: "c" },
      { metadata: { filepath: abs("a.ts") } },
      { directory: ROOT, worktree: "/", project: undefined },
    )
    expect(planned).toHaveLength(1)
    expect(planned[0]).toMatchObject({ projectFolder: FOLDER })
    expect(planned[0].projectFolder).not.toBe("/")
    expect(planned[0].projectFolder).not.toBe(path.resolve("/"))
    expect(path.isAbsolute(planned[0].projectFolder!)).toBe(true)
    // The display name stays a name: the sentinel contributes no project either.
    expect(planned[0].project).toBe(path.basename(ROOT))
  })

  test("a relative result path with no authoritative base is dropped, never cwd-resolved", () => {
    // The result metadata named a relative path but the context proved no real
    // root, so there is nothing truthful to record. Resolving against the host
    // cwd would attribute the edit to whatever directory launched the process.
    for (const context of [
      { directory: "", worktree: "", project: undefined },
      { directory: ".", worktree: "/", project: undefined },
      { directory: "repo", worktree: "/", project: undefined },
      { directory: "repo", worktree: "repo", project: undefined },
      { directory: ".", worktree: ".", project: undefined },
    ] satisfies ToolActivity.PluginContext[]) {
      const planned = ToolActivity.plan(
        { tool: "write", sessionID: "s", callID: "c" },
        { metadata: { filepath: path.join("repo", "a.ts") } },
        context,
      )
      expect({ context, planned }).toEqual({ context, planned: [] })
    }
  })

  test("an absolute entity keeps its own absolute semantics and is not rebased", () => {
    // An absolute path in the metadata is already authoritative. It must not be
    // resolved against the instance root, and it must not fold into it.
    const outside = path.join(path.parse(ROOT).root, "elsewhere", "a.ts")
    const planned = ToolActivity.plan(
      { tool: "write", sessionID: "s", callID: "c" },
      { metadata: { filepath: outside } },
      CONTEXT,
    )
    expect(planned).toHaveLength(1)
    expect(planned[0].entity).toBe(path.resolve(outside))
    // The folder still names the executing instance's root, not the entity's parent.
    expect(planned[0].projectFolder).toBe(FOLDER)
    expect(planned[0].projectFolder).not.toBe(path.resolve(path.dirname(outside)))
  })

  test("read stays silent, so the lower read producer keeps sole ownership of the folder", () => {
    // Exactly-once: the adapter must not add a read record just because it could
    // now name a folder the read tool also names.
    const planned = after("read", { filePaths: [abs("a.ts")], files: [fileEntry(abs("a.ts"), 1, 0)] })
    expect(planned).toEqual([])
  })
})

describe("tool.execute.after hook behavior", () => {
  /** The hook receives the tool's full result envelope, not metadata alone. */
  const hookInput = (tool: string) => ({ tool, sessionID: "s", callID: "c", args: {} })
  const hookOutput = (metadata: unknown) => ({ title: "t", output: "", metadata })

  function fakeBridge(fail = false) {
    const calls: unknown[] = []
    const bridge = {
      promise: (effect: unknown) => {
        calls.push(effect)
        return fail ? Promise.reject(new Error("bridge down")) : Promise.resolve(undefined)
      },
    } as unknown as EffectBridge.Shape
    return { calls, bridge }
  }

  test("the hook records through the bridge and never mutates hook output", async () => {
    const { calls, bridge } = fakeBridge()
    const hook = ToolActivity.hooks(CONTEXT, bridge)
    const output = hookOutput({ filepath: abs("a.ts") })
    await hook["tool.execute.after"]!(hookInput("write"), output)
    expect(calls).toHaveLength(1)
    expect(output).toEqual(hookOutput({ filepath: abs("a.ts") }))
  })

  test("the hook stays off the bridge entirely for silent tools", async () => {
    const { calls, bridge } = fakeBridge()
    const hook = ToolActivity.hooks(CONTEXT, bridge)
    await hook["tool.execute.after"]!(hookInput("bash"), hookOutput({}))
    await hook["tool.execute.after"]!(hookInput("read"), hookOutput({ filePaths: [abs("a.ts")] }))
    expect(calls).toEqual([])
  })

  test("a bridge failure never rejects the completed tool call", async () => {
    const { bridge } = fakeBridge(true)
    const hook = ToolActivity.hooks(CONTEXT, bridge)
    await expect(
      hook["tool.execute.after"]!(hookInput("write"), hookOutput({ filepath: abs("a.ts") })),
    ).resolves.toBeUndefined()
  })
})
