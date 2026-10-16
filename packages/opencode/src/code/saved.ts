import path from "node:path"
import { randomUUID } from "node:crypto"
import * as nodeFs from "node:fs/promises"
import { Context, Effect, Layer } from "effect"
import { Global } from "@opencode-ai/core/global"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { SavedCodeAdmission } from "@opencode-ai/core/code/admission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import * as Capability from "@/tool/capability"
import * as Revision from "./revision"

const MAX_SOURCE_BYTES = 128 * 1024
const MAX_JSON_BYTES = 256 * 1024
const LIST_CACHE_TTL_MS = 1_000
const LIST_CACHE_MAX_SCOPES = 8

export type ProjectScope = {
  readonly root: string
  readonly key: string
}

export type ScopeContext = {
  readonly project: ProjectScope
}

export type ScopeLocation = {
  readonly kind: Capability.SavedScope
  readonly key: string
  readonly base: string
  readonly root: string
}

export type LoadedRevision = {
  readonly scope: Capability.SavedScope
  readonly scopeKey: string
  readonly id: string
  readonly revision: string
  readonly handle: string
  readonly root: string
  readonly source: string
  readonly envelope: Revision.RevisionEnvelope
  readonly manifest?: Revision.Manifest
  readonly admitted: boolean
  readonly diagnostic?: { readonly kind: "SavedToolDirty"; readonly message: string }
}

export type SaveInput = {
  readonly context: ScopeContext
  readonly scope: Capability.SavedScope
  readonly manifest: Revision.Manifest
  readonly source: string
}

export class SavedStorageError extends Error {
  constructor(
    readonly kind:
      | "SavedToolNotFound"
      | "SavedToolAmbiguous"
      | "SavedToolDirty"
      | "SaveRejected",
    message: string,
  ) {
    super(message)
    this.name = "SavedStorageError"
  }
}

export interface Interface {
  readonly locations: (context: ScopeContext) => readonly ScopeLocation[]
  readonly list: (context: ScopeContext) => Effect.Effect<readonly LoadedRevision[], SavedStorageError>
  readonly resolve: (
    context: ScopeContext,
    selector: string,
  ) => Effect.Effect<LoadedRevision, SavedStorageError>
  readonly save: (input: SaveInput) => Effect.Effect<LoadedRevision, SavedStorageError | EffectFlock.LockError>
  readonly invalidate: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SavedCodeCatalog") {}

function code(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) return
  const value = error.code
  return typeof value === "string" ? value : undefined
}

const error = (
  kind: SavedStorageError["kind"],
  message: string,
) => new SavedStorageError(kind, message)

const fail = (
  kind: SavedStorageError["kind"],
  message: string,
) => Effect.fail(error(kind, message))

const attempt = <A>(kind: SavedStorageError["kind"], message: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      error(kind, `${message}: ${cause instanceof Error ? cause.message : String(cause)}`),
  })

async function lstatOptional(target: string) {
  try {
    return await nodeFs.lstat(target)
  } catch (cause) {
    if (code(cause) === "ENOENT" || code(cause) === "ENOTDIR") return undefined
    throw cause
  }
}

async function assertNoLinkTraversal(base: string, segments: readonly string[]) {
  let current = base
  for (const segment of segments) {
    const next = path.join(current, segment)
    const stat = await lstatOptional(next)
    if (!stat) return
    if (stat.isSymbolicLink()) {
      throw error("SavedToolDirty", `Saved Code path traverses a symlink/junction: ${next}`)
    }
    current = next
  }
}

async function ensureDirectory(base: string, segments: readonly string[]) {
  await assertNoLinkTraversal(base, segments)
  const target = path.join(base, ...segments)
  await nodeFs.mkdir(target, { recursive: true, mode: 0o700 })
  await assertNoLinkTraversal(base, segments)
  const stat = await nodeFs.lstat(target)
  if (!stat.isDirectory()) throw error("SavedToolDirty", `Saved Code path is not a directory: ${target}`)
  return target
}

async function readBoundedRegularFile(
  base: string,
  relative: readonly string[],
  maxBytes: number,
  label: string,
): Promise<string | undefined> {
  await assertNoLinkTraversal(base, relative)
  const target = path.join(base, ...relative)
  const stat = await lstatOptional(target)
  if (!stat) return undefined
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw error("SavedToolDirty", `${label} is not a regular file: ${target}`)
  }
  if (stat.size > maxBytes) {
    throw error("SavedToolDirty", `${label} exceeds ${maxBytes} bytes.`)
  }
  const real = await nodeFs.realpath(target)
  const expected = path.resolve(target)
  if (process.platform === "win32" ? real.toLowerCase() !== expected.toLowerCase() : real !== expected) {
    throw error("SavedToolDirty", `${label} resolves outside its canonical saved path.`)
  }
  return nodeFs.readFile(target, "utf8")
}

async function writeTempFile(target: string, content: string) {
  const directory = path.dirname(target)
  await nodeFs.mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  )
  const handle = await nodeFs.open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(content, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  return temporary
}

async function writeImmutable(target: string, content: string) {
  const existing = await lstatOptional(target)
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw error("SavedToolDirty", `Immutable saved object is not a regular file: ${target}`)
    }
    const current = await nodeFs.readFile(target, "utf8")
    if (current !== content) {
      throw error("SavedToolDirty", `Immutable saved object already exists with different bytes: ${target}`)
    }
    return
  }

  const temporary = await writeTempFile(target, content)
  try {
    try {
      // Hard-link commit is atomic and no-clobber. Unlike rename-over-target it
      // cannot replace an immutable object another process committed first.
      await nodeFs.link(temporary, target)
    } catch (cause) {
      if (code(cause) !== "EEXIST") throw cause
    }
    const current = await nodeFs.readFile(target, "utf8")
    if (current !== content) {
      throw error("SavedToolDirty", `Concurrent immutable saved object differs from expected bytes: ${target}`)
    }
  } finally {
    await nodeFs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function writeAtomic(target: string, content: string) {
  const temporary = await writeTempFile(target, content)
  try {
    await nodeFs.rename(temporary, target)
  } finally {
    await nodeFs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

function revisionHex(revision: string) {
  if (!/^sha256:[0-9a-f]{64}$/.test(revision)) {
    throw error("SavedToolDirty", "Saved executable revision is not a canonical sha256 identity.")
  }
  return revision.slice("sha256:".length)
}

function sourceHex(sourceHash: string) {
  if (!/^sha256:[0-9a-f]{64}$/.test(sourceHash)) {
    throw error("SavedToolDirty", "Saved source hash is not a canonical sha256 identity.")
  }
  return sourceHash.slice("sha256:".length)
}

function envelopeFromManifest(manifest: Revision.Manifest): Revision.RevisionEnvelope {
  return {
    format: manifest.format,
    runtime: manifest.runtime,
    sourceHash: manifest.sourceHash,
    inputSchema: manifest.inputSchema,
    ...(manifest.outputSchema ? { outputSchema: manifest.outputSchema } : {}),
    dependencies: manifest.dependencies,
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const locks = yield* EffectFlock.Service
    const admissions = yield* SavedCodeAdmission.Service

    const globalBase = yield* attempt(
      "SavedToolDirty",
      "Failed to canonicalize global config root",
      () => nodeFs.realpath(global.config),
    ).pipe(Effect.orDie)
    const globalRoot = path.join(globalBase, "code")
    let generation = 0
    const listCache = new Map<
      string,
      {
        readonly generation: number
        readonly expiresAt: number
        readonly items: readonly LoadedRevision[]
      }
    >()

    const listCacheKey = (location: ScopeLocation) => `${location.kind}\u0000${location.key}`
    const cacheList = (location: ScopeLocation, items: readonly LoadedRevision[]) => {
      const key = listCacheKey(location)
      listCache.delete(key)
      listCache.set(key, {
        generation,
        expiresAt: Date.now() + LIST_CACHE_TTL_MS,
        items: Object.freeze([...items]),
      })
      while (listCache.size > LIST_CACHE_MAX_SCOPES) {
        const oldest = listCache.keys().next().value as string | undefined
        if (oldest === undefined) break
        listCache.delete(oldest)
      }
      return items
    }

    const locations = (context: ScopeContext): readonly ScopeLocation[] => [
      {
        kind: "project",
        key: context.project.key,
        base: context.project.root,
        root: path.join(context.project.root, ".openfork", "code"),
      },
      {
        kind: "global",
        key: globalRoot,
        base: globalBase,
        root: globalRoot,
      },
    ]

    const relativeRoot = (location: ScopeLocation) =>
      location.kind === "project" ? [".openfork", "code"] : ["code"]

    const toolRelative = (location: ScopeLocation, id: string, ...rest: string[]) => [
      ...relativeRoot(location),
      id,
      ...rest,
    ]

    const readJson = (location: ScopeLocation, relative: readonly string[], label: string) =>
      attempt("SavedToolDirty", `Failed to read ${label}`, async () => {
        const text = await readBoundedRegularFile(location.base, relative, MAX_JSON_BYTES, label)
        if (text === undefined) return undefined
        try {
          return JSON.parse(text) as unknown
        } catch {
          throw error("SavedToolDirty", `${label} is not valid JSON.`)
        }
      })

    const loadExact = Effect.fn("SavedCodeCatalog.loadExact")(function* (
      location: ScopeLocation,
      id: string,
      revision: string,
      manifestHint?: Revision.Manifest,
      admittedHint?: SavedCodeAdmission.Info,
    ) {
      Revision.validateID(id)
      const revisionDigest = revisionHex(revision)
      const envelopeValue = yield* readJson(
        location,
        toolRelative(location, id, "revisions", `${revisionDigest}.json`),
        "saved revision envelope",
      )
      if (envelopeValue === undefined) {
        return yield* fail("SavedToolNotFound", `Saved revision not found: ${Capability.savedIdentity(location.kind, id, revision).ref}`)
      }

      let envelope: Revision.RevisionEnvelope
      try {
        envelope = Revision.parseEnvelope(envelopeValue)
      } catch (cause) {
        return yield* fail("SavedToolDirty", cause instanceof Error ? cause.message : String(cause))
      }
      const source = yield* attempt("SavedToolDirty", "Failed to read saved source", async () => {
        const value = await readBoundedRegularFile(
          location.base,
          toolRelative(location, id, "revisions", "source", `${sourceHex(envelope.sourceHash)}.ts`),
          MAX_SOURCE_BYTES,
          "saved source",
        )
        if (value === undefined) throw error("SavedToolDirty", "Saved revision source object is missing.")
        return value
      })
      try {
        Revision.verify({ source, envelope, expectedRevision: revision })
      } catch (cause) {
        return yield* fail("SavedToolDirty", cause instanceof Error ? cause.message : String(cause))
      }

      if (manifestHint) {
        if (manifestHint.id !== id || manifestHint.revision !== revision) {
          return yield* fail("SavedToolDirty", "Saved alias manifest identity does not match its revision.")
        }
        if (Revision.canonicalJson(envelopeFromManifest(manifestHint)) !== Revision.canonicalJson(envelope)) {
          return yield* fail("SavedToolDirty", "Saved alias manifest semantic envelope differs from its immutable revision.")
        }
      }

      const admitted =
        admittedHint ??
        (yield* admissions.get({
          scopeKind: location.kind,
          scopeKey: location.key,
          savedID: id,
          revision,
        }))
      const admissionMatches = admitted?.sourceHash === envelope.sourceHash

      return {
        scope: location.kind,
        scopeKey: location.key,
        id,
        revision,
        handle: Capability.savedIdentity(location.kind, id, revision).ref,
        root: path.join(location.root, id),
        source: Revision.canonicalSource(source),
        envelope,
        ...(manifestHint ? { manifest: manifestHint } : {}),
        admitted: admissionMatches,
        ...(!admissionMatches
          ? {
              diagnostic: {
                kind: "SavedToolDirty" as const,
                message: admitted
                  ? "Saved revision admission source hash does not match filesystem bytes."
                  : "Saved revision exists on disk but has not been admitted for execution.",
              },
            }
          : {}),
      } satisfies LoadedRevision
    })

    const readCurrentManifest = Effect.fn("SavedCodeCatalog.readCurrentManifest")(function* (
      location: ScopeLocation,
      id: string,
    ) {
      const value = yield* readJson(location, toolRelative(location, id, "tool.json"), "saved alias manifest")
      if (value === undefined) return undefined
      try {
        const manifest = Revision.parseManifest(value)
        if (manifest.id !== id) {
          return yield* fail("SavedToolDirty", `Saved manifest id '${manifest.id}' does not match directory '${id}'.`)
        }
        return manifest
      } catch (cause) {
        return yield* fail("SavedToolDirty", cause instanceof Error ? cause.message : String(cause))
      }
    })

    const listLocation = Effect.fn("SavedCodeCatalog.listLocation")(function* (location: ScopeLocation) {
      const cacheKey = listCacheKey(location)
      const cached = listCache.get(cacheKey)
      if (cached && cached.generation === generation && cached.expiresAt > Date.now()) {
        listCache.delete(cacheKey)
        listCache.set(cacheKey, cached)
        return cached.items
      }

      const admissionRows = yield* admissions.list({ scopeKind: location.kind, scopeKey: location.key })
      const admittedByHandle = new Map(
        admissionRows.map((row) => [
          Capability.savedIdentity(location.kind, row.savedID, row.revision).ref,
          row,
        ]),
      )
      const results = new Map<string, LoadedRevision>()

      // Every admitted immutable revision remains exactly callable even after a
      // human-facing alias advances.
      for (const row of admissionRows) {
        const loaded = yield* loadExact(location, row.savedID, row.revision, undefined, row).pipe(
          Effect.catch((error) =>
            error.kind === "SavedToolNotFound"
              ? Effect.succeed(undefined)
              : Effect.fail(error),
          ),
        )
        if (loaded) results.set(loaded.handle, loaded)
      }

      const rootStat = yield* attempt("SavedToolDirty", "Failed to inspect saved-code root", () =>
        lstatOptional(location.root),
      )
      if (!rootStat) {
        return cacheList(
          location,
          [...results.values()].sort((a, b) => a.handle.localeCompare(b.handle)),
        )
      }
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        return yield* fail("SavedToolDirty", `Saved-code root is not a regular directory: ${location.root}`)
      }
      const entries = yield* attempt("SavedToolDirty", "Failed to enumerate saved-code root", () =>
        nodeFs.readdir(location.root, { withFileTypes: true }),
      )
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue
        const id = entry.name
        try {
          Revision.validateID(id)
        } catch {
          continue
        }
        const manifest = yield* readCurrentManifest(location, id).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        )
        if (!manifest) continue
        const handle = Capability.savedIdentity(location.kind, id, manifest.revision).ref
        const loaded = yield* loadExact(
          location,
          id,
          manifest.revision,
          manifest,
          admittedByHandle.get(handle),
        ).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (loaded) results.set(handle, loaded)
      }
      return cacheList(
        location,
        [...results.values()].sort((a, b) => a.handle.localeCompare(b.handle)),
      )
    })

    const list: Interface["list"] = Effect.fn("SavedCodeCatalog.list")(function* (context) {
      const result: LoadedRevision[] = []
      for (const location of locations(context)) {
        result.push(...(yield* listLocation(location)))
      }
      return result
    })

    const resolveLocation = (context: ScopeContext, scope: Capability.SavedScope) =>
      locations(context).find((location) => location.kind === scope)!

    const resolveExact = (context: ScopeContext, scope: Capability.SavedScope, id: string, revision: string) =>
      loadExact(resolveLocation(context, scope), id, revision)

    const resolveCurrent = Effect.fn("SavedCodeCatalog.resolveCurrent")(function* (
      context: ScopeContext,
      scope: Capability.SavedScope,
      id: string,
    ) {
      const location = resolveLocation(context, scope)
      const manifest = yield* readCurrentManifest(location, id)
      if (!manifest) return yield* fail("SavedToolNotFound", `Saved tool not found: ${scope}/${id}`)
      const loaded = yield* loadExact(location, id, manifest.revision, manifest)
      if (!loaded.admitted) {
        return yield* fail("SavedToolDirty", loaded.diagnostic?.message ?? "Saved tool is not admitted.")
      }
      return loaded
    })

    const resolve: Interface["resolve"] = Effect.fn("SavedCodeCatalog.resolve")(function* (context, selector) {
      if (selector.startsWith("saved:")) {
        let identity: Capability.Identity
        try {
          identity = Capability.identityFromRef(selector)
        } catch {
          return yield* fail("SavedToolNotFound", "Saved tool handle is invalid or non-canonical.")
        }
        if (!identity.ref.startsWith("saved:")) {
          return yield* fail("SavedToolNotFound", "Selector is not a saved-tool handle.")
        }
        const [scope, id, revision] = identity.segments
        if ((scope !== "project" && scope !== "global") || !id || !revision) {
          return yield* fail("SavedToolNotFound", "Saved tool handle is incomplete.")
        }
        const loaded = yield* resolveExact(context, scope, id, revision)
        if (!loaded.admitted) {
          return yield* fail("SavedToolDirty", loaded.diagnostic?.message ?? "Saved tool is not admitted.")
        }
        return loaded
      }

      const slash = selector.indexOf("/")
      if (slash > 0) {
        const scope = selector.slice(0, slash)
        const id = selector.slice(slash + 1)
        if ((scope !== "project" && scope !== "global") || id.includes("/")) {
          return yield* fail("SavedToolNotFound", "Scoped saved-tool selector must be project/<id> or global/<id>.")
        }
        try {
          Revision.validateID(id)
        } catch (cause) {
          return yield* fail("SavedToolNotFound", cause instanceof Error ? cause.message : String(cause))
        }
        return yield* resolveCurrent(context, scope, id)
      }

      try {
        Revision.validateID(selector)
      } catch (cause) {
        return yield* fail("SavedToolNotFound", cause instanceof Error ? cause.message : String(cause))
      }
      const found: LoadedRevision[] = []
      for (const scope of ["project", "global"] as const) {
        const item = yield* resolveCurrent(context, scope, selector).pipe(
          Effect.catch((error) =>
            error.kind === "SavedToolNotFound" ? Effect.succeed(undefined) : Effect.fail(error),
          ),
        )
        if (item) found.push(item)
      }
      if (found.length === 0) return yield* fail("SavedToolNotFound", `Saved tool not found: ${selector}`)
      if (found.length > 1) {
        return yield* fail(
          "SavedToolAmbiguous",
          `Saved tool '${selector}' exists in both project and global scope; use an explicit scoped alias.`,
        )
      }
      return found[0]!
    })

    const save: Interface["save"] = Effect.fn("SavedCodeCatalog.save")(function* (input) {
      const location = resolveLocation(input.context, input.scope)
      const manifest = input.manifest
      Revision.validateID(manifest.id)
      if (Buffer.byteLength(input.source, "utf8") > MAX_SOURCE_BYTES) {
        return yield* fail("SaveRejected", `Saved source exceeds ${MAX_SOURCE_BYTES} bytes.`)
      }
      if (Revision.sha256(Revision.canonicalSource(input.source)) !== manifest.sourceHash) {
        return yield* fail("SaveRejected", "Saved source does not match manifest sourceHash.")
      }

      const lockKey = `saved-code:${location.kind}:${location.key}:${manifest.id}`
      return yield* locks.withLock(
        Effect.gen(function* () {
          yield* attempt("SaveRejected", "Failed to prepare saved-tool directory", async () => {
            const rootSegments = relativeRoot(location)
            await ensureDirectory(location.base, rootSegments)
            await ensureDirectory(location.base, [...rootSegments, manifest.id])
            await ensureDirectory(location.base, [...rootSegments, manifest.id, "revisions"])
            await ensureDirectory(location.base, [...rootSegments, manifest.id, "revisions", "source"])
          })

          const toolRoot = path.join(location.root, manifest.id)
          const sourcePath = path.join(
            toolRoot,
            "revisions",
            "source",
            `${sourceHex(manifest.sourceHash)}.ts`,
          )
          const envelopePath = path.join(
            toolRoot,
            "revisions",
            `${revisionHex(manifest.revision)}.json`,
          )
          const reviewPath = path.join(toolRoot, "code.ts")
          const manifestPath = path.join(toolRoot, "tool.json")
          const source = Revision.canonicalSource(input.source)
          const envelopeText = Revision.canonicalJson(envelopeFromManifest(manifest))
          const manifestText = Revision.canonicalJson(manifest)

          yield* attempt("SaveRejected", "Failed to commit immutable saved source", () =>
            writeImmutable(sourcePath, source),
          )
          yield* attempt("SaveRejected", "Failed to commit immutable saved revision", () =>
            writeImmutable(envelopePath, envelopeText),
          )
          yield* attempt("SaveRejected", "Failed to update reviewable saved source", () =>
            writeAtomic(reviewPath, source),
          )
          // Filesystem visibility commit: current alias moves only after every
          // immutable executable object is durable and reviewable source exists.
          yield* attempt("SaveRejected", "Failed to commit saved alias manifest", () =>
            writeAtomic(manifestPath, manifestText),
          )

          yield* admissions
            .admit({
              scopeKind: location.kind,
              scopeKey: location.key,
              savedID: manifest.id,
              revision: manifest.revision,
              sourceHash: manifest.sourceHash,
              origin: "code-save",
              originRunID: manifest.origin.run,
            })
            .pipe(
              Effect.mapError((cause) =>
                error("SaveRejected", `Saved admission failed: ${cause.message}`),
              ),
            )
          generation++
          listCache.clear()

          const loaded = yield* loadExact(location, manifest.id, manifest.revision, manifest)
          if (!loaded.admitted) return yield* fail("SaveRejected", "Saved revision was written but admission did not become visible.")
          return loaded
        }),
        lockKey,
      )
    })

    const invalidate: Interface["invalidate"] = Effect.fn("SavedCodeCatalog.invalidate")(function* () {
      generation++
      listCache.clear()
    })

    return Service.of({ locations, list, resolve, save, invalidate })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Global.node, EffectFlock.node, SavedCodeAdmission.node],
})

export * as SavedCodeCatalog from "./saved"
