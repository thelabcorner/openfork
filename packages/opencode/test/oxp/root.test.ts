import { afterAll, beforeEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { OxpConfig } from "@/oxp/config"
import { OxpRoot } from "@/oxp/root"
import { testEffect } from "../lib/effect"

const suite = path.join(os.tmpdir(), `opencode-oxp-root-${randomUUID()}`)
const configDir = path.join(suite, ".config")
const stateDir = path.join(suite, ".state")
const globalLayer = Global.layerWith({ config: configDir, state: stateDir })
const layer = AppNodeBuilder.build(
  LayerNode.group([OxpRoot.node, OxpConfig.node]),
  [[Global.node, globalLayer]],
)
const it = testEffect(layer)

function attempt<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(
    Effect.match({
      onFailure: (left) => ({ _tag: "Left" as const, left }),
      onSuccess: (right) => ({ _tag: "Right" as const, right }),
    }),
  )
}

beforeEach(async () => {
  await fs.rm(suite, { recursive: true, force: true })
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })
})

afterAll(async () => {
  await fs.rm(suite, { recursive: true, force: true })
})

describe("OxpRoot", () => {
  it.live(
    "resolves virtual, native, and unambiguous relative paths through one canonical authority path",
    Effect.gen(function* () {
      const roots = yield* OxpRoot.Service
      const rootDir = path.join(suite, "workspace")
      const file = path.join(rootDir, "src", "a.ts")
      const outside = path.join(suite, "outside.txt")
      yield* Effect.promise(() => fs.mkdir(path.dirname(file), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(file, "export const a = 1\n"))
      yield* Effect.promise(() => fs.writeFile(outside, "outside\n"))

      const root = yield* roots.approve(rootDir)
      const virtual = yield* roots.resolvePath(`/${root.alias}/src/a.ts`)
      const native = yield* roots.resolvePath(file)
      const relative = yield* roots.resolvePath("src/a.ts")
      const escaped = yield* attempt(roots.resolvePath(`/${root.alias}/../outside.txt`))
      const outsideResult = yield* attempt(roots.resolvePath(outside))

      expect(virtual.path).toBe(native.path)
      expect(relative.path).toBe(native.path)
      expect(native.virtualPath).toBe(`/${root.alias}/src/a.ts`)
      expect(escaped._tag).toBe("Left")
      if (escaped._tag === "Left") expect(escaped.left._tag).toBe("OXP_PATH_ESCAPE")
      expect(outsideResult._tag).toBe("Left")
      if (outsideResult._tag === "Left") expect(outsideResult.left._tag).toBe("OXP_PATH_ESCAPE")
    }),
  )

  it.live(
    "treats dot as the explicit approved root instead of a path escape",
    Effect.gen(function* () {
      const roots = yield* OxpRoot.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const root = yield* roots.approve(rootDir)

      const dot = yield* roots.resolvePath(".", { rootID: root.id })
      const dotted = yield* roots.resolvePath("././", { rootID: root.id })

      expect(dot.path).toBe(rootDir)
      expect(dot.virtualPath).toBe(`/${root.alias}`)
      expect(dotted.path).toBe(rootDir)
      expect(dotted.virtualPath).toBe(`/${root.alias}`)
    }),
  )

  it.live(
    "requires explicit root identity for a relative path when root choice is ambiguous",
    Effect.gen(function* () {
      const roots = yield* OxpRoot.Service
      const firstDir = path.join(suite, "first")
      const secondDir = path.join(suite, "second")
      yield* Effect.promise(() => Promise.all([fs.mkdir(firstDir), fs.mkdir(secondDir)]))
      yield* Effect.promise(() => fs.writeFile(path.join(firstDir, "a.txt"), "a"))
      const first = yield* roots.approve(firstDir)
      yield* roots.approve(secondDir)

      const ambiguous = yield* attempt(roots.resolvePath("a.txt"))
      const explicit = yield* roots.resolvePath("a.txt", { rootID: first.id })

      expect(ambiguous._tag).toBe("Left")
      if (ambiguous._tag === "Left") expect(ambiguous.left._tag).toBe("OXP_ROOT_REQUIRED")
      expect(explicit.root.id).toBe(first.id)
    }),
  )

  it.live(
    "never lets an explicit root identity be retargeted by a path spelling",
    Effect.gen(function* () {
      const roots = yield* OxpRoot.Service
      const firstDir = path.join(suite, "first")
      const secondDir = path.join(suite, "second")
      const secondFile = path.join(secondDir, "secret.txt")
      yield* Effect.promise(() => Promise.all([fs.mkdir(firstDir), fs.mkdir(secondDir)]))
      yield* Effect.promise(() => fs.writeFile(secondFile, "secret"))
      const first = yield* roots.approve(firstDir)
      const second = yield* roots.approve(secondDir)

      const virtual = yield* attempt(roots.resolvePath(`/${second.alias}/secret.txt`, { rootID: first.id }))
      const native = yield* attempt(roots.resolvePath(secondFile, { rootID: first.id }))

      expect(virtual._tag).toBe("Left")
      if (virtual._tag === "Left") expect(virtual.left._tag).toBe("OXP_PATH_ESCAPE")
      expect(native._tag).toBe("Left")
      if (native._tag === "Left") expect(native.left._tag).toBe("OXP_PATH_ESCAPE")
    }),
  )

  it.live(
    "rejects nested links that escape an approved root",
    Effect.gen(function* () {
      const roots = yield* OxpRoot.Service
      const rootDir = path.join(suite, "workspace")
      const external = path.join(suite, "external")
      const link = path.join(rootDir, "escape")
      yield* Effect.promise(() => Promise.all([fs.mkdir(rootDir), fs.mkdir(external)]))
      yield* Effect.promise(() => fs.writeFile(path.join(external, "secret.txt"), "secret"))
      yield* Effect.promise(() => fs.symlink(external, link, process.platform === "win32" ? "junction" : "dir"))

      const root = yield* roots.approve(rootDir)
      const result = yield* attempt(roots.resolvePath(`/${root.alias}/escape/secret.txt`))

      expect(result._tag).toBe("Left")
      if (result._tag === "Left") expect(result.left._tag).toBe("OXP_PATH_ESCAPE")
    }),
  )

  it.live(
    "detects approved-root deletion, rename, and root-level link replacement",
    Effect.gen(function* () {
      const roots = yield* OxpRoot.Service
      const rootDir = path.join(suite, "workspace")
      const moved = path.join(suite, "workspace-moved")
      const external = path.join(suite, "external")
      yield* Effect.promise(() => Promise.all([fs.mkdir(rootDir), fs.mkdir(external)]))
      const root = yield* roots.approve(rootDir)

      yield* Effect.promise(() => fs.rename(rootDir, moved))
      const renamed = yield* attempt(roots.resolveRoot(root.id))
      expect(renamed._tag).toBe("Left")
      if (renamed._tag === "Left") expect(renamed.left._tag).toBe("OXP_ROOT_CHANGED")

      yield* Effect.promise(() => fs.symlink(external, rootDir, process.platform === "win32" ? "junction" : "dir"))
      const replaced = yield* attempt(roots.resolveRoot(root.id))
      expect(replaced._tag).toBe("Left")
      if (replaced._tag === "Left") expect(replaced.left._tag).toBe("OXP_ROOT_CHANGED")
    }),
  )

  it.live(
    "detects replacement by a different directory object at the same pathname",
    Effect.gen(function* () {
      const roots = yield* OxpRoot.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const root = yield* roots.approve(rootDir)

      // The pathname is deliberately restored exactly. Authority must remain tied
      // to the approved directory object rather than silently transferring to the
      // replacement directory.
      yield* Effect.promise(() => fs.rm(rootDir, { recursive: true, force: true }))
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const result = yield* attempt(roots.resolveRoot(root.id))

      expect(result._tag).toBe("Left")
      if (result._tag === "Left") expect(result.left._tag).toBe("OXP_ROOT_CHANGED")
    }),
  )

  it.live(
    "permits a missing suffix only for explicitly create-oriented resolution",
    Effect.gen(function* () {
      const roots = yield* OxpRoot.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const root = yield* roots.approve(rootDir)
      const target = `/${root.alias}/new/deep/file.txt`

      const read = yield* attempt(roots.resolvePath(target))
      const create = yield* roots.resolvePath(target, { allowMissing: true })

      expect(read._tag).toBe("Left")
      if (read._tag === "Left") expect(read.left._tag).toBe("OXP_NOT_FOUND")
      expect(create.virtualPath).toBe(target)
      expect(create.path).toBe(path.join(rootDir, "new", "deep", "file.txt"))
    }),
  )

  it.live(
    "rejects overlapping roots and keeps alias identity deterministic across rename",
    Effect.gen(function* () {
      const roots = yield* OxpRoot.Service
      const firstDir = path.join(suite, "a", "project")
      const secondDir = path.join(suite, "b", "project")
      const nested = path.join(firstDir, "nested")
      yield* Effect.promise(() => Promise.all([fs.mkdir(nested, { recursive: true }), fs.mkdir(secondDir, { recursive: true })]))

      const first = yield* roots.approve(firstDir)
      const second = yield* roots.approve(secondDir)
      const overlap = yield* attempt(roots.approve(nested))
      const collision = yield* attempt(roots.rename(second.id, first.alias))
      const renamed = yield* roots.rename(second.id, "Second Project")

      expect(first.alias).toBe("project")
      expect(second.alias).toBe("project-2")
      expect(overlap._tag).toBe("Left")
      if (overlap._tag === "Left") expect(overlap.left._tag).toBe("OXP_CONFLICT")
      expect(collision._tag).toBe("Left")
      if (collision._tag === "Left") expect(collision.left._tag).toBe("OXP_CONFLICT")
      expect(renamed.id).toBe(second.id)
      expect(renamed.path).toBe(second.path)
      expect(renamed.alias).toBe("second-project")
    }),
  )

  it.live(
    "keeps project-selector roots synchronized while preserving independent manual authority",
    Effect.gen(function* () {
      const roots = yield* OxpRoot.Service
      const project = path.join(suite, "catalog-project")
      const nested = path.join(project, "nested-project")
      const manual = path.join(suite, "manual-extra")
      const nestedFile = path.join(nested, "src", "index.ts")
      yield* Effect.promise(() =>
        Promise.all([
          fs.mkdir(path.dirname(nestedFile), { recursive: true }),
          fs.mkdir(manual, { recursive: true }),
        ]),
      )
      yield* Effect.promise(() => fs.writeFile(nestedFile, "export {}\n"))

      const initial = yield* roots.syncProjectRoots([project, nested, project])
      const projectRoot = initial.find((root) => root.path === project)!
      const nestedRoot = initial.find((root) => root.path === nested)!
      expect(OxpRoot.isProjectManaged(projectRoot)).toBe(true)
      expect(OxpRoot.isProjectManaged(nestedRoot)).toBe(true)
      expect(initial).toHaveLength(2)

      const resolved = yield* roots.resolvePath(nestedFile)
      expect(resolved.root.id).toBe(nestedRoot.id)

      const manualRoot = yield* roots.approve(manual)
      const stable = yield* roots.syncProjectRoots([nested])
      expect(stable.find((root) => root.path === nested)?.id).toBe(nestedRoot.id)
      expect(stable.some((root) => root.id === projectRoot.id)).toBe(false)
      expect(stable.some((root) => root.id === manualRoot.id)).toBe(true)

      const removeManaged = yield* attempt(roots.remove(nestedRoot.id))
      expect(removeManaged._tag).toBe("Left")
      if (removeManaged._tag === "Left") expect(removeManaged.left._tag).toBe("OXP_CONFLICT")

      const afterClose = yield* roots.syncProjectRoots([])
      expect(afterClose.some((root) => root.id === nestedRoot.id)).toBe(false)
      expect(afterClose.some((root) => root.id === manualRoot.id)).toBe(true)
    }),
  )

  it.live(
    "refuses a redundant manual approval for an OpenFork project root",
    Effect.gen(function* () {
      const roots = yield* OxpRoot.Service
      const project = path.join(suite, "project-owned-root")
      yield* Effect.promise(() => fs.mkdir(project, { recursive: true }))

      const [auto] = yield* roots.syncProjectRoots([project])
      const imported = yield* roots.importMany([{ path: project }])
      expect(imported.find((root) => root.id === auto?.id)?.sources).toEqual(["project"])
      const manual = yield* attempt(roots.approve(project))
      expect(manual._tag).toBe("Left")
      if (manual._tag === "Left") expect(manual.left._tag).toBe("OXP_CONFLICT")
      expect((yield* roots.list())[0]?.sources).toEqual(["project"])

      const afterClose = yield* roots.syncProjectRoots([])
      expect(auto).toBeDefined()
      expect(afterClose).toHaveLength(0)
    }),
  )

  it.live(
    "rejects project roots written in a foreign host path namespace",
    Effect.gen(function* () {
      const roots = yield* OxpRoot.Service
      const foreign = process.platform === "win32" ? "/mnt/e/AlphaGym" : "E:\\AlphaGym"
      const result = yield* attempt(roots.syncProjectRoots([foreign]))

      expect(result._tag).toBe("Left")
      if (result._tag === "Left") expect(result.left._tag).toBe("OXP_INVALID_ARGUMENT")
      expect(yield* roots.list()).toHaveLength(0)
    }),
  )

  it.live(
    "never reinterprets a persisted root from a foreign host path namespace",
    Effect.gen(function* () {
      const roots = yield* OxpRoot.Service
      const config = yield* OxpConfig.Service
      const native = path.join(suite, "legacy-native-root")
      const foreign = process.platform === "win32" ? "/mnt/e/AlphaGym" : "E:\\AlphaGym"
      yield* Effect.promise(() => fs.mkdir(native, { recursive: true }))

      const root = yield* roots.approve(native)
      yield* config.update((current) => ({
        ...current,
        roots: current.roots.map((entry) =>
          entry.id === root.id
            ? { ...entry, path: foreign, identityFingerprint: undefined }
            : entry,
        ),
      }))

      const result = yield* attempt(roots.resolveRoot(root.id))
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") expect(result.left._tag).toBe("OXP_ROOT_CHANGED")
    }),
  )

  it.live(
    "keeps delegation agent preferences root-scoped and removes stale preferences with the root",
    Effect.gen(function* () {
      const roots = yield* OxpRoot.Service
      const config = yield* OxpConfig.Service
      const firstDir = path.join(suite, "legacy-agent-first")
      const secondDir = path.join(suite, "legacy-agent-second")
      yield* Effect.promise(() =>
        Promise.all([
          fs.mkdir(firstDir, { recursive: true }),
          fs.mkdir(secondDir, { recursive: true }),
        ]),
      )
      const first = yield* roots.approve(firstDir)
      yield* config.setWorkerDefaultAgent(first.id, "review")
      const second = yield* roots.approve(secondDir)
      expect(second.id).not.toBe(first.id)
      let policy = (yield* config.get()).workerPolicy
      expect(
        policy?.agentRoots?.find((entry) => entry.rootID === first.id)
          ?.defaultAgent,
      ).toBe("review")
      expect(
        policy?.agentRoots?.find((entry) => entry.rootID === second.id)
          ?.defaultAgent,
      ).toBeUndefined()

      yield* roots.remove(first.id)
      policy = (yield* config.get()).workerPolicy
      expect(
        policy?.agentRoots?.some((entry) => entry.rootID === first.id),
      ).toBe(false)
    }),
  )

  it.live(
    "rejects whole-filesystem approval and revokes removed roots",
    Effect.gen(function* () {
      const roots = yield* OxpRoot.Service
      const whole = path.parse(suite).root
      const wholeResult = yield* attempt(roots.approve(whole))
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const root = yield* roots.approve(rootDir)
      yield* roots.remove(root.id)
      const removed = yield* attempt(roots.resolveRoot(root.id))

      expect(wholeResult._tag).toBe("Left")
      if (wholeResult._tag === "Left") expect(wholeResult.left._tag).toBe("OXP_INVALID_ARGUMENT")
      expect(removed._tag).toBe("Left")
      if (removed._tag === "Left") expect(removed.left._tag).toBe("OXP_ROOT_NOT_FOUND")
    }),
  )

  it.live(
    "imports legacy roots as one idempotent batch and refuses partial overlap commits",
    Effect.gen(function* () {
      const roots = yield* OxpRoot.Service
      const firstDir = path.join(suite, "legacy-a")
      const secondDir = path.join(suite, "legacy-b")
      const thirdDir = path.join(suite, "legacy-c")
      const nested = path.join(firstDir, "nested")
      yield* Effect.promise(() =>
        Promise.all([
          fs.mkdir(nested, { recursive: true }),
          fs.mkdir(secondDir, { recursive: true }),
          fs.mkdir(thirdDir, { recursive: true }),
        ]),
      )

      const first = yield* roots.importMany([
        { path: firstDir, alias: "legacy" },
        { path: secondDir, alias: "legacy" },
        { path: firstDir, alias: "duplicate" },
      ])
      expect(first).toHaveLength(2)
      expect(first.map((root) => root.alias)).toEqual(["legacy", "legacy-2"])

      const again = yield* roots.importMany([
        { path: firstDir, alias: "different" },
        { path: secondDir, alias: "different" },
      ])
      expect(again.map((root) => root.id)).toEqual(first.map((root) => root.id))

      const conflict = yield* attempt(
        roots.importMany([
          { path: thirdDir, alias: "third" },
          { path: nested, alias: "nested" },
        ]),
      )
      expect(conflict._tag).toBe("Left")
      if (conflict._tag === "Left") expect(conflict.left._tag).toBe("OXP_CONFLICT")
      expect((yield* roots.list())).toHaveLength(2)
    }),
  )

  it.live(
    "requires a root for relative addressing when no roots are approved",
    Effect.gen(function* () {
      const roots = yield* OxpRoot.Service
      const result = yield* attempt(roots.resolvePath("src/index.ts"))
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") expect(result.left._tag).toBe("OXP_ROOT_REQUIRED")
    }),
  )

  it.live(
    "canonicalizes neutral dot segments while keeping parent traversal forbidden",
    Effect.gen(function* () {
      const roots = yield* OxpRoot.Service
      const rootDir = path.join(suite, "dot-root")
      const nested = path.join(rootDir, "nested")
      yield* Effect.promise(() => fs.mkdir(nested, { recursive: true }))
      const root = yield* roots.approve(rootDir)

      const same = yield* roots.resolvePath(".", { rootID: root.id })
      expect(same.path).toBe(rootDir)
      expect(same.virtualPath).toBe("/" + root.alias)

      const normalized = yield* roots.resolvePath("./nested/./", { rootID: root.id })
      expect(normalized.path).toBe(nested)

      const escape = yield* attempt(roots.resolvePath("./nested/../", { rootID: root.id }))
      expect(escape._tag).toBe("Left")
      if (escape._tag === "Left") expect(escape.left._tag).toBe("OXP_PATH_ESCAPE")
    }),
  )

  it.live(
    "rejects UNC roots on Windows without touching the network",
    Effect.gen(function* () {
      if (process.platform !== "win32") return
      const roots = yield* OxpRoot.Service
      const result = yield* attempt(roots.approve("\\\\unreachable.invalid\\share"))
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") expect(result.left._tag).toBe("OXP_INVALID_ARGUMENT")
    }),
  )
})
