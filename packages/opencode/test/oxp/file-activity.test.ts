import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import type { CodingActivity } from "@opencode-ai/core/coding-activity"
import { OxpConfig } from "@/oxp/config"
import { OxpRoot } from "@/oxp/root"
import {
  fileActivityIdentity,
  fileActivityInput,
  fileActivityProject,
  fileActivityRoute,
  fileActivityTargets,
} from "@/oxp/server"
import type { OxpResult } from "@/oxp/result"
import { testEffect } from "../lib/effect"

/**
 * OXP -> CodingActivity file-activity seam regressions.
 *
 * The exchange kernel (`@/exchange/read`, `write`, `edit`, `file-mutation`)
 * already publishes the canonical record for every committed read/write, so this
 * seam must own exactly one gap: the OpenAI file-transfer broker, which
 * publishes local bytes through its own verified `link()` instead. These are
 * NEGATIVE tests first — the common case is silence, and only the three
 * OpenAI transfer actions may ever produce a target.
 *
 * The second half of the file exercises attribution against a REAL approved root
 * through the same `OxpRoot.resolvePath` the seam itself uses, so project
 * identity is proved from root authority rather than from a path spelling.
 */

const exchangeToolArgs = (path: string) => ({ path, old_string: "a", new_string: "b" })

const transferArgs = (fileID: string) => ({ action: "save_chatgpt_file", file_id: fileID, path: "/proj/out.ts" })

const capabilityArgs = (capability: string, extra: Record<string, unknown> = {}) => ({
  namespace: "openfork",
  capability,
  ...extra,
})

function result(overrides: Partial<OxpResult.CapabilityResult> = {}): OxpResult.CapabilityResult {
  return { output: "ok", ...overrides }
}

function committed(structured: Record<string, unknown>, overrides: Partial<OxpResult.CapabilityResult> = {}) {
  return result({ structured, mutation: { attempted: true, committed: true }, ...overrides })
}

describe("OXP file activity never re-emits the exchange kernel", () => {
  test("the exchange read/write/edit/patch tools are not an activity route at all", () => {
    for (const name of ["read", "write", "edit", "patch", "apply_patch", "find", "git", "process"]) {
      expect({ name, route: fileActivityRoute(name, exchangeToolArgs("/proj/a.ts")) }).toEqual({ name, route: false })
    }
  })

  test("an exchange-shaped success is silent even when it looks committed", () => {
    // A fabricated committed exchange result must still produce nothing: the
    // route gate, not the payload, is what keeps the kernel authoritative.
    const exchange = committed({ action: "write", path: "/proj/a.ts", aiLineChanges: 12 })
    expect(fileActivityTargets("write", exchangeToolArgs("/proj/a.ts"), exchange)).toEqual([])
    expect(fileActivityTargets("edit", exchangeToolArgs("/proj/a.ts"), exchange)).toEqual([])
    expect(fileActivityTargets("patch", exchangeToolArgs("/proj/a.ts"), exchange)).toEqual([])
  })

  test("only the OpenAI file-transfer broker is a file-activity route", () => {
    expect(fileActivityRoute("openai_files", transferArgs("file-1"))).toBe(true)
    expect(fileActivityRoute("capability", capabilityArgs("file.transfer", { action: "save_chatgpt_file" }))).toBe(
      true,
    )
  })

  test("a capability that is not file.transfer never reaches the broker", () => {
    expect(fileActivityRoute("capability", capabilityArgs("file.edit"))).toBe(false)
    expect(fileActivityRoute("capability", capabilityArgs("process.run"))).toBe(false)
    // A non-openfork namespace is a different broker entirely.
    expect(fileActivityRoute("capability", { namespace: "other", capability: "file.transfer" })).toBe(false)
    // Malformed arguments fail closed rather than defaulting into the route.
    expect(fileActivityRoute("capability", undefined)).toBe(false)
    expect(fileActivityRoute("capability", "file.transfer")).toBe(false)
    expect(fileActivityRoute("unknown_tool", capabilityArgs("file.transfer"))).toBe(false)
  })
})

describe("OXP file activity records only committed OpenAI transfers", () => {
  test("a saved or downloaded blob is a write named by its destination", () => {
    const saved = committed({ action: "save_chatgpt_file", path: "/proj/out.ts", bytes: 12 })
    expect(fileActivityTargets("openai_files", transferArgs("file-1"), saved)).toEqual([
      { kind: "write", virtualPath: "/proj/out.ts" },
    ])
    const downloaded = committed({ action: "download_openai_file", path: "/proj/out.ts", bytes: 12 })
    expect(fileActivityTargets("openai_files", { action: "download_openai_file" }, downloaded)).toEqual([
      { kind: "write", virtualPath: "/proj/out.ts" },
    ])
  })

  test("an uploaded blob is a read named by its local source", () => {
    const uploaded = committed({ action: "upload_openai_file", source: "/proj/in.ts", source_bytes: 12 })
    expect(fileActivityTargets("openai_files", { action: "upload_openai_file" }, uploaded)).toEqual([
      { kind: "read", virtualPath: "/proj/in.ts" },
    ])
  })

  test("a direct transfer and the brokered capability produce the same target", () => {
    // `openai_files` and `capability` -> `file.transfer` are two doors onto one
    // broker, so they must not disagree about what the record is.
    const transferred = committed({ action: "save_chatgpt_file", path: "/proj/out.ts", bytes: 12 })
    const direct = fileActivityTargets("openai_files", transferArgs("file-1"), transferred)
    const brokered = fileActivityTargets(
      "capability",
      capabilityArgs("file.transfer", { action: "save_chatgpt_file", path: "/proj/out.ts" }),
      transferred,
    )
    expect(brokered).toEqual(direct)
    expect(brokered).toEqual([{ kind: "write", virtualPath: "/proj/out.ts" }])
  })

  test("remote metadata discovery records nothing", () => {
    // `list`/`get` never carry a mutation, and are not transfer actions.
    for (const action of ["list_openai_files", "get_openai_file"]) {
      const listed = result({ structured: { action, files: [] } })
      expect({ action, targets: fileActivityTargets("openai_files", { action }, listed) }).toEqual({
        action,
        targets: [],
      })
    }
  })

  test("an uncommitted or missing mutation is never real file activity", () => {
    const structured = { action: "save_chatgpt_file", path: "/proj/out.ts" }
    expect(fileActivityTargets("openai_files", transferArgs("file-1"), result({ structured }))).toEqual([])
    // `attempted` alone is an intent, not an effect: it must stay silent.
    for (const mutation of [
      { attempted: true, committed: false },
      { attempted: false, committed: false },
    ]) {
      expect(
        fileActivityTargets("openai_files", transferArgs("file-1"), result({ structured, mutation })),
      ).toEqual([])
    }
    // The gate is exactly `committed === true`; it is the broker's own verified
    // publication claim, so it is never inferred from `attempted`.
    expect(
      fileActivityTargets(
        "openai_files",
        transferArgs("file-1"),
        result({ structured, mutation: { attempted: false, committed: true } }),
      ),
    ).toEqual([{ kind: "write", virtualPath: "/proj/out.ts" }])
  })

  test("an unknown action, missing path, or absent payload is silent", () => {
    expect(
      fileActivityTargets("openai_files", {}, committed({ action: "delete_openai_file", path: "/proj/out.ts" })),
    ).toEqual([])
    expect(fileActivityTargets("openai_files", {}, committed({ action: "save_chatgpt_file" }))).toEqual([])
    // A write reads `path`; a read reads `source`. Neither borrows the other.
    expect(fileActivityTargets("openai_files", {}, committed({ action: "save_chatgpt_file", source: "/proj/in.ts" }))).toEqual(
      [],
    )
    expect(fileActivityTargets("openai_files", {}, committed({ action: "upload_openai_file", path: "/proj/in.ts" }))).toEqual(
      [],
    )
    expect(fileActivityTargets("openai_files", {}, result({ mutation: { attempted: true, committed: true } }))).toEqual([])
  })

  test("an empty or non-object action is silent rather than coerced", () => {
    expect(fileActivityTargets("openai_files", {}, committed({ action: "" }))).toEqual([])
    expect(fileActivityTargets("openai_files", {}, committed({ action: 7 }))).toEqual([])
    expect(fileActivityTargets("openai_files", {}, committed({ action: ["save_chatgpt_file"] }))).toEqual([])
  })
})

describe("OXP file activity never fabricates a line count", () => {
  test("a transferred blob reports no aiLineChanges, only its kind and path", () => {
    // A transfer publishes verified byte counts, not a before/after line delta.
    const transferred = committed({
      action: "save_chatgpt_file",
      path: "/proj/out.ts",
      bytes: 4_096,
      sha256: "a".repeat(64),
    })
    const [target] = fileActivityTargets("openai_files", transferArgs("file-1"), transferred)
    expect(target).toEqual({ kind: "write", virtualPath: "/proj/out.ts" })
    expect(Object.hasOwn(target!, "aiLineChanges")).toBe(false)
  })

  test("a producer-supplied line count on a transfer is dropped, not trusted", () => {
    // The file-exchange contract has no line-delta field. If one ever appears it
    // is not a proven delta, so the seam must still decline to forward it.
    for (const claimed of [12, 0, -5, 1.5, 10_000]) {
      const transferred = committed({
        action: "download_openai_file",
        path: "/proj/out.ts",
        bytes: 4_096,
        aiLineChanges: claimed,
      })
      const [target] = fileActivityTargets("openai_files", { action: "download_openai_file" }, transferred)
      expect({ claimed, target }).toEqual({ claimed, target: { kind: "write", virtualPath: "/proj/out.ts" } })
      expect(JSON.stringify(target)).not.toContain("aiLineChanges")
    }
  })
})

describe("OXP file activity identity and project attribution", () => {
  test("identity is a resolved absolute path, so one file dedupes within a call", () => {
    const root = fileActivityIdentity("/proj/src/a.ts")
    expect(fileActivityIdentity("/proj/src/./a.ts")).toBe(root)
    expect(fileActivityIdentity("/proj/src/b/../a.ts")).toBe(root)
    expect(fileActivityIdentity("/proj/src/a.ts")).toBe(root)
    expect(fileActivityIdentity("/proj/src/b.ts")).not.toBe(root)
    expect(root).toContain("a.ts")
  })

  test("project identity is the canonical root's own directory name, whatever the alias", () => {
    // The root is the project. The alias is a renameable public spelling and
    // never names one, and a root's basename is always present because an
    // approved root is never a whole drive or filesystem.
    expect(fileActivityProject("/home/dev/proj", "totally-different")).toBe("proj")
    expect(fileActivityProject(path.join("/home/dev", "proj"), undefined)).toBe("proj")
    expect(fileActivityProject("C:\\workspaces\\canonical-repo", "public-alias")).toBe("canonical-repo")
    // The alias survives only as an unreachable-by-construction last resort,
    // rather than silently standing in for an absent project.
    expect(fileActivityProject("/", "public-alias")).toBe("public-alias")
  })
})

const suite = path.join(os.tmpdir(), `opencode-oxp-file-activity-${randomUUID()}`)
const configDir = path.join(suite, ".config")
const stateDir = path.join(suite, ".state")
const layer = AppNodeBuilder.build(
  LayerNode.group([OxpRoot.node, OxpConfig.node]),
  [[Global.node, Global.layerWith({ config: configDir, state: stateDir })]],
)
const it = testEffect(layer)

beforeEach(async () => {
  await fs.rm(suite, { recursive: true, force: true })
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })
})
afterAll(async () => fs.rm(suite, { recursive: true, force: true }))

/**
 * The seam's own reduction, run against a real root: targets -> `resolvePath` ->
 * call-local dedupe -> attributed input. Unresolvable virtual paths drop out
 * exactly as they do in the producer.
 */
const attribute = Effect.fnUntraced(function* (
  roots: OxpRoot.Interface,
  name: string,
  args: unknown,
  value: OxpResult.CapabilityResult,
) {
  const inputs = new Map<string, CodingActivity.Input>()
  for (const target of fileActivityTargets(name, args, value)) {
    const resolved = yield* roots.resolvePath(target.virtualPath).pipe(
      Effect.match({
        onFailure: () => undefined,
        onSuccess: (found) => found,
      }),
    )
    if (resolved === undefined) continue
    inputs.set(fileActivityIdentity(resolved.path), fileActivityInput(target.kind, resolved))
  }
  return [...inputs.values()]
})

describe("OXP file activity attributes the canonical approved root", () => {
  it.live(
    "a file at the root and a deeply nested file name the same project, not a parent directory",
    Effect.gen(function* () {
      const roots = yield* OxpRoot.Service
      // `holder` is a real ancestor directory name, so any parent-directory
      // heuristic would report it instead of the project.
      const native = path.join(suite, "holder", "repo")
      const topNative = path.join(native, "top.txt")
      const deepNative = path.join(native, "src", "deep", "a.ts")
      yield* Effect.promise(() => fs.mkdir(path.dirname(deepNative), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(topNative, "alpha\n"))
      yield* Effect.promise(() => fs.writeFile(deepNative, "export const a = 1\n"))
      const root = yield* roots.approve(native, "totally-different")
      // Expectations are built from the root's own resolved canonical path, not
      // from a second realpath call, so they observe exactly what the seam does.
      const canonical = (yield* roots.resolvePath(`/${root.alias}`)).canonicalPath
      const virtual = (file: string) => `/${root.alias}/${path.relative(canonical, file).split(path.sep).join("/")}`

      for (const [label, file] of [
        ["at root", path.join(canonical, "top.txt")],
        ["nested", path.join(canonical, "src", "deep", "a.ts")],
      ] as const) {
        const inputs = yield* attribute(
          roots,
          "openai_files",
          { action: "save_chatgpt_file" },
          committed({ action: "save_chatgpt_file", path: virtual(file), bytes: 12 }),
        )
        expect({ label, inputs }).toEqual({
          label,
          inputs: [{ entity: file, kind: "write", project: "repo", projectFolder: canonical, source: "oxp" }],
        })
      }
    }),
  )

  it.live(
    "a direct transfer and the brokered capability are attributed identically",
    Effect.gen(function* () {
      const roots = yield* OxpRoot.Service
      const native = path.join(suite, "holder", "workspace")
      const sourceNative = path.join(native, "pkg", "artifact.bin")
      yield* Effect.promise(() => fs.mkdir(path.dirname(sourceNative), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(sourceNative, "payload\n"))
      const root = yield* roots.approve(native, "public-alias")
      const canonical = (yield* roots.resolvePath(`/${root.alias}`)).canonicalPath
      const uploaded = committed({
        action: "upload_openai_file",
        source: `/${root.alias}/pkg/artifact.bin`,
        source_bytes: 8,
      })

      const direct = yield* attribute(
        roots,
        "openai_files",
        { action: "upload_openai_file", path: "pkg/artifact.bin" },
        uploaded,
      )
      const brokered = yield* attribute(
        roots,
        "capability",
        capabilityArgs("file.transfer", { action: "upload_openai_file", path: "pkg/artifact.bin" }),
        uploaded,
      )
      expect(direct).toEqual([
        {
          entity: path.join(canonical, "pkg", "artifact.bin"),
          kind: "read",
          project: "workspace",
          projectFolder: canonical,
          source: "oxp",
        },
      ])
      expect(brokered).toEqual(direct)
      // The public alias, the file's own parent, and the root's parent are all
      // public spellings; none of them may stand in for the proven root folder.
      const projects = direct.map((input) => input.project)
      expect(projects).not.toContain("public-alias")
      expect(projects).not.toContain("pkg")
      expect(projects).not.toContain("holder")
      const folders = direct.map((input) => input.projectFolder)
      expect(folders).toEqual([canonical])
      for (const leaked of ["public-alias", "pkg", "holder", "/public-alias"]) {
        expect(folders).not.toContain(leaked)
      }
      expect(path.isAbsolute(folders[0]!)).toBe(true)
    }),
  )

  it.live(
    "an ordinary exchange operation stays silent, and one file is recorded once per call",
    Effect.gen(function* () {
      const roots = yield* OxpRoot.Service
      const native = path.join(suite, "workspace")
      const targetNative = path.join(native, "a.ts")
      yield* Effect.promise(() => fs.mkdir(native, { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(targetNative, "export const a = 1\n"))
      const root = yield* roots.approve(native, "public-alias")
      const virtual = `/${root.alias}/a.ts`
      // A perfect committed transfer payload, routed at the exchange tools. The
      // route gate, not the payload, is what keeps the kernel authoritative.
      const transfer = committed({ action: "save_chatgpt_file", path: virtual, bytes: 4 })
      for (const name of ["read", "write", "edit", "patch", "find", "git", "process"]) {
        const inputs = yield* attribute(roots, name, exchangeToolArgs("a.ts"), transfer)
        expect({ name, inputs }).toEqual({ name, inputs: [] })
      }

      // Two spellings of one file inside one call collapse onto one record.
      const one = yield* roots.resolvePath(virtual)
      const other = yield* roots.resolvePath(`/${root.alias}/./a.ts`)
      expect(one.path).toBe(path.join(one.canonicalPath, "a.ts"))
      expect({
        sameFile: one.path === other.path,
        sameIdentity: fileActivityIdentity(one.path) === fileActivityIdentity(other.path),
        sameProject: fileActivityInput("write", one).project === fileActivityInput("write", other).project,
        sameFolder: fileActivityInput("write", one).projectFolder === fileActivityInput("write", other).projectFolder,
      }).toEqual({ sameFile: true, sameIdentity: true, sameProject: true, sameFolder: true })
      // The folder is the approved root this resolve re-verified, never the alias
      // or the `/alias/...` virtual spelling the call was addressed with.
      expect(fileActivityInput("write", one).projectFolder).toBe(one.canonicalPath)
      expect(fileActivityInput("write", one).projectFolder).not.toBe(`/${one.root.alias}`)
    }),
  )
})
