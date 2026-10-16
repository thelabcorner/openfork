import { afterAll, describe, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { SavedCodeAdmission } from "@opencode-ai/core/code/admission"
import { SavedCodeCatalog } from "@/code/saved"
import * as Revision from "@/code/revision"
import { testEffect } from "../lib/effect"

const suite = path.join(os.tmpdir(), `openfork-saved-code-${randomUUID()}`)
const config = path.join(suite, "config")
const state = path.join(suite, "state")
const project = path.join(suite, "project")
await Promise.all([
  fs.mkdir(config, { recursive: true }),
  fs.mkdir(state, { recursive: true }),
  fs.mkdir(project, { recursive: true }),
])
const projectRoot = await fs.realpath(project)

afterAll(async () => {
  await fs.rm(suite, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([SavedCodeAdmission.node, SavedCodeCatalog.node]),
    [[Global.node, Global.layerWith({ config, state })]],
  ),
)

const context = {
  project: {
    root: projectRoot,
    key: projectRoot,
  },
}

function artifact(input: {
  id: string
  source: string
  description?: string
  scope?: "project" | "global"
  run?: string
}) {
  const spec = {
    name: input.id,
    ...(input.description ? { description: input.description } : {}),
    scope: input.scope ?? "project",
  } as const
  const derived = Revision.derive({ source: input.source, spec, dependencies: [] })
  const manifest = Revision.manifest({
    derived,
    spec,
    origin: {
      run: input.run ?? `run:prt_${input.id}`,
      session: "ses_saved_test",
      message: "msg_saved_test",
    },
  })
  return { derived, manifest, spec }
}

describe("SavedCodeCatalog filesystem authority", () => {
  it.effect("commits immutable source/revision before current alias and admission", () =>
    Effect.gen(function* () {
      const catalog = yield* SavedCodeCatalog.Service
      const item = artifact({ id: "alpha", source: "return input.value" })
      const saved = yield* catalog.save({
        context,
        scope: "project",
        manifest: item.manifest,
        source: item.derived.source,
      })

      expect(saved.admitted).toBe(true)
      expect(saved.handle).toBe(`saved:project/alpha@${item.derived.revision}`)
      const root = path.join(projectRoot, ".openfork", "code", "alpha")
      const sourceFile = path.join(
        root,
        "revisions",
        "source",
        `${item.derived.sourceHash.slice("sha256:".length)}.ts`,
      )
      const revisionFile = path.join(
        root,
        "revisions",
        `${item.derived.revision.slice("sha256:".length)}.json`,
      )
      expect(yield* Effect.promise(() => fs.readFile(sourceFile, "utf8"))).toBe(item.derived.source)
      expect(JSON.parse(yield* Effect.promise(() => fs.readFile(revisionFile, "utf8")))).toMatchObject({
        sourceHash: item.derived.sourceHash,
      })
      expect(JSON.parse(yield* Effect.promise(() => fs.readFile(path.join(root, "tool.json"), "utf8"))).revision).toBe(
        item.derived.revision,
      )
      expect(yield* Effect.promise(() => fs.readFile(path.join(root, "code.ts"), "utf8"))).toBe(item.derived.source)
    }),
  )

  it.effect("advances the alias without invalidating exact old revisions", () =>
    Effect.gen(function* () {
      const catalog = yield* SavedCodeCatalog.Service
      const first = artifact({ id: "history", source: "return 1", run: "run:prt_history_a" })
      const second = artifact({ id: "history", source: "return 2", run: "run:prt_history_b" })
      yield* catalog.save({ context, scope: "project", manifest: first.manifest, source: first.derived.source })
      yield* catalog.save({ context, scope: "project", manifest: second.manifest, source: second.derived.source })

      const current = yield* catalog.resolve(context, "project/history")
      const old = yield* catalog.resolve(context, `saved:project/history@${first.derived.revision}`)

      expect(current.revision).toBe(second.derived.revision)
      expect(current.source).toBe("return 2")
      expect(old.revision).toBe(first.derived.revision)
      expect(old.source).toBe("return 1")
      expect(old.admitted).toBe(true)
    }),
  )

  it.effect("treats same unqualified project/global ID as ambiguous instead of shadowing", () =>
    Effect.gen(function* () {
      const catalog = yield* SavedCodeCatalog.Service
      const projectTool = artifact({ id: "shared", source: "return 'project'" })
      const globalTool = artifact({ id: "shared", source: "return 'global'", scope: "global" })
      yield* catalog.save({
        context,
        scope: "project",
        manifest: projectTool.manifest,
        source: projectTool.derived.source,
      })
      yield* catalog.save({
        context,
        scope: "global",
        manifest: globalTool.manifest,
        source: globalTool.derived.source,
      })

      const ambiguous = yield* catalog.resolve(context, "shared").pipe(
        Effect.map(() => undefined),
        Effect.catch((error) => Effect.succeed(error)),
      )
      expect(ambiguous).toBeInstanceOf(SavedCodeCatalog.SavedStorageError)
      expect((ambiguous as SavedCodeCatalog.SavedStorageError).kind).toBe("SavedToolAmbiguous")
      expect((yield* catalog.resolve(context, "project/shared")).source).toBe("return 'project'")
      expect((yield* catalog.resolve(context, "global/shared")).source).toBe("return 'global'")
    }),
  )

  it.effect("revocation leaves bytes inspectable but makes resolution fail closed", () =>
    Effect.gen(function* () {
      const catalog = yield* SavedCodeCatalog.Service
      const admissions = yield* SavedCodeAdmission.Service
      const item = artifact({ id: "revoked", source: "return 7" })
      const saved = yield* catalog.save({
        context,
        scope: "project",
        manifest: item.manifest,
        source: item.derived.source,
      })
      yield* admissions.revoke({
        scopeKind: "project",
        scopeKey: projectRoot,
        savedID: "revoked",
        revision: saved.revision,
      })

      const listed = yield* catalog.list(context)
      const visible = listed.find((entry) => entry.handle === saved.handle)
      expect(visible?.admitted).toBe(false)
      expect(visible?.diagnostic?.kind).toBe("SavedToolDirty")

      const error = yield* catalog.resolve(context, "project/revoked").pipe(
        Effect.map(() => undefined),
        Effect.catch((cause) => Effect.succeed(cause)),
      )
      expect(error).toBeInstanceOf(SavedCodeCatalog.SavedStorageError)
      expect((error as SavedCodeCatalog.SavedStorageError).kind).toBe("SavedToolDirty")
    }),
  )

  it.effect("rejects a junction/symlink anywhere in the managed saved-tool path", () =>
    Effect.gen(function* () {
      const catalog = yield* SavedCodeCatalog.Service
      const outside = path.join(suite, "outside")
      yield* Effect.promise(() => fs.mkdir(outside, { recursive: true }))
      const codeRoot = path.join(projectRoot, ".openfork", "code")
      yield* Effect.promise(() => fs.mkdir(codeRoot, { recursive: true }))
      const link = path.join(codeRoot, "linked")
      const linked = yield* Effect.promise(async () => {
        try {
          await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir")
          return true
        } catch {
          return false
        }
      })
      if (!linked) return

      const item = artifact({ id: "linked", source: "return 9" })
      const error = yield* catalog
        .save({ context, scope: "project", manifest: item.manifest, source: item.derived.source })
        .pipe(
          Effect.map(() => undefined),
          Effect.catch((cause) => Effect.succeed(cause)),
        )

      expect(error).toBeInstanceOf(SavedCodeCatalog.SavedStorageError)
      expect((error as SavedCodeCatalog.SavedStorageError).kind).toBe("SaveRejected")
      yield* Effect.promise(() => fs.rm(link, { recursive: true, force: true }))
    }),
  )

  it.effect("same revision save is byte-idempotent and preserves first admission provenance", () =>
    Effect.gen(function* () {
      const catalog = yield* SavedCodeCatalog.Service
      const admissions = yield* SavedCodeAdmission.Service
      const first = artifact({ id: "idempotent", source: "return input", run: "run:prt_first" })
      const retry = Revision.manifest({
        derived: first.derived,
        spec: first.spec,
        origin: { run: "run:prt_retry", session: "ses_retry", message: "msg_retry" },
      })
      const a = yield* catalog.save({ context, scope: "project", manifest: first.manifest, source: first.derived.source })
      const b = yield* catalog.save({ context, scope: "project", manifest: retry, source: first.derived.source })
      expect(b.handle).toBe(a.handle)

      const admission = yield* admissions.get({
        scopeKind: "project",
        scopeKey: projectRoot,
        savedID: "idempotent",
        revision: a.revision,
      })
      expect(admission?.originRunID).toBe("run:prt_first")
    }),
  )

  it.effect("save and explicit invalidate synchronously invalidate the discovery projection cache", () =>
    Effect.gen(function* () {
      const catalog = yield* SavedCodeCatalog.Service
      const first = artifact({ id: "cache_first", source: "return 1" })
      const second = artifact({ id: "cache_second", source: "return 2" })

      const savedFirst = yield* catalog.save({
        context,
        scope: "project",
        manifest: first.manifest,
        source: first.derived.source,
      })
      const warm = yield* catalog.list(context)
      expect(warm.some((entry) => entry.handle === savedFirst.handle)).toBe(true)

      const savedSecond = yield* catalog.save({
        context,
        scope: "project",
        manifest: second.manifest,
        source: second.derived.source,
      })
      const afterSave = yield* catalog.list(context)
      expect(afterSave.some((entry) => entry.handle === savedSecond.handle)).toBe(true)

      yield* Effect.promise(() =>
        fs.rm(path.join(projectRoot, ".openfork", "code", "cache_first"), {
          recursive: true,
          force: true,
        }),
      )
      const stillCached = yield* catalog.list(context)
      expect(stillCached.some((entry) => entry.handle === savedFirst.handle)).toBe(true)

      yield* catalog.invalidate()
      const afterInvalidate = yield* catalog.list(context)
      expect(afterInvalidate.some((entry) => entry.handle === savedFirst.handle)).toBe(false)
      expect(afterInvalidate.some((entry) => entry.handle === savedSecond.handle)).toBe(true)
    }),
  )

  it.effect("external filesystem changes become visible after the bounded list-cache TTL", () =>
    Effect.gen(function* () {
      const catalog = yield* SavedCodeCatalog.Service
      const item = artifact({ id: "cache_ttl", source: "return 3" })
      const saved = yield* catalog.save({
        context,
        scope: "project",
        manifest: item.manifest,
        source: item.derived.source,
      })

      const warm = yield* catalog.list(context)
      expect(warm.some((entry) => entry.handle === saved.handle)).toBe(true)

      yield* Effect.promise(() =>
        fs.rm(path.join(projectRoot, ".openfork", "code", "cache_ttl"), {
          recursive: true,
          force: true,
        }),
      )
      const immediate = yield* catalog.list(context)
      expect(immediate.some((entry) => entry.handle === saved.handle)).toBe(true)

      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 1200)))
      const refreshed = yield* catalog.list(context)
      expect(refreshed.some((entry) => entry.handle === saved.handle)).toBe(false)
    }),
  )
})
