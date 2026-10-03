import path from "path"
import { randomUUID } from "crypto"
import { Context, Effect, Layer, Option } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { OxpConfig, scopeLegacyWorkerAgentPolicy } from "./config"
import { OxpError } from "./error"
import { OxpSchema } from "./schema"

const IS_WINDOWS = process.platform === "win32"
const NATIVE_WINDOWS = /^(?:[A-Za-z]:[\\/]|\\\\)/
const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/
const RESERVED_ALIASES = new Set(["skills"])
const RESERVED_WINDOWS_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "conin$",
  "conout$",
  "com0",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt0",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
])

export interface ResolvedRoot {
  readonly root: OxpSchema.Root
  readonly canonicalPath: string
}

export interface ResolvedPath extends ResolvedRoot {
  readonly path: string
  readonly virtualPath: string
}

export interface ResolveOptions {
  readonly rootID?: OxpSchema.RootID
  readonly allowMissing?: boolean
}

export interface Interface {
  readonly list: () => Effect.Effect<readonly OxpSchema.Root[], OxpError.Error>
  readonly approve: (candidate: string, alias?: string) => Effect.Effect<OxpSchema.Root, OxpError.Error>
  /** Reconcile OpenFork's local project catalog into OXP authorization. */
  readonly syncProjectRoots: (candidates: readonly string[]) => Effect.Effect<readonly OxpSchema.Root[], OxpError.Error>
  readonly importMany: (
    candidates: readonly { readonly path: string; readonly alias?: string }[],
  ) => Effect.Effect<readonly OxpSchema.Root[], OxpError.Error>
  readonly rename: (id: OxpSchema.RootID, alias: string) => Effect.Effect<OxpSchema.Root, OxpError.Error>
  readonly remove: (id: OxpSchema.RootID) => Effect.Effect<void, OxpError.Error>
  readonly resolveRoot: (idOrAlias: OxpSchema.RootID | string) => Effect.Effect<ResolvedRoot, OxpError.Error>
  readonly resolvePath: (input: string, options?: ResolveOptions) => Effect.Effect<ResolvedPath, OxpError.Error>
  readonly toVirtualPath: (root: OxpSchema.Root, canonicalPath: string) => string
  readonly verify: (root: OxpSchema.Root) => Effect.Effect<ResolvedRoot, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpRoot") {}
export const use = serviceUse(Service)

function rootSources(root: OxpSchema.Root): readonly OxpSchema.RootSource[] {
  return root.sources?.length ? root.sources : ["manual"]
}

export function hasSource(root: OxpSchema.Root, source: OxpSchema.RootSource): boolean {
  return rootSources(root).includes(source)
}

export function isProjectManaged(root: OxpSchema.Root): boolean {
  return hasSource(root, "project")
}

function addSource(root: OxpSchema.Root, source: OxpSchema.RootSource): OxpSchema.Root {
  const sources = [...new Set([...rootSources(root), source])]
  return { ...root, sources }
}

function removeSource(root: OxpSchema.Root, source: OxpSchema.RootSource): OxpSchema.Root | undefined {
  const sources = rootSources(root).filter((item) => item !== source)
  return sources.length ? { ...root, sources } : undefined
}

function isNativeRootPath(value: string) {
  if (IS_WINDOWS) return WINDOWS_DRIVE_ABSOLUTE.test(value)
  return path.posix.isAbsolute(value)
}

function pathIdentity(value: string) {
  if (!isNativeRootPath(value)) return `foreign:${IS_WINDOWS ? value.toLowerCase() : value}`
  const resolved = path.resolve(value)
  return IS_WINDOWS ? resolved.toLowerCase() : resolved
}

function samePath(left: string, right: string) {
  return pathIdentity(left) === pathIdentity(right)
}

export function normalizeAlias(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 32)
  return slug || "folder"
}

export function isContained(parent: string, child: string): boolean {
  if (!isNativeRootPath(parent) || !isNativeRootPath(child)) return false
  const leftRaw = path.resolve(parent)
  const rightRaw = path.resolve(child)
  const normalize = (value: string) => (IS_WINDOWS ? value.toLowerCase() : value)
  const left = normalize(leftRaw)
  const right = normalize(rightRaw)
  if (left === right) return true
  return right.startsWith(left.endsWith(path.sep) ? left : `${left}${path.sep}`)
}

function validateSegmentsUnsafe(input: string): string[] {
  if (input.length === 0 || input.length > 4096) throw new OxpError.InvalidArgument({ detail: "Path is empty or too long" })
  if (input.includes("\0")) throw new OxpError.InvalidArgument({ detail: "Path contains a null byte" })
  const values = (IS_WINDOWS ? input.split(/[/\\]+/) : input.split(/\/+/)).filter((value) => value && value !== ".")
  if (values.length === 0) throw new OxpError.InvalidArgument({ detail: "Path does not name an approved root" })
  for (const value of values) {
    if (value === "..") throw new OxpError.PathEscape({ detail: "Path traversal is not allowed" })
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f]/.test(value)) throw new OxpError.InvalidArgument({ detail: "Path contains a control character" })
    if (value.length > 255) throw new OxpError.InvalidArgument({ detail: "Path segment is too long" })
    if (!IS_WINDOWS) continue
    if (value.includes(":")) throw new OxpError.InvalidArgument({ detail: "Path segment contains a colon" })
    if (/[<>"|?*]/.test(value) || /[. ]$/.test(value)) {
      throw new OxpError.InvalidArgument({ detail: "Path segment is not valid on Windows" })
    }
    if (RESERVED_WINDOWS_NAMES.has(value.split(".")[0]!.toLowerCase())) {
      throw new OxpError.InvalidArgument({ detail: "Path uses a reserved Windows device name" })
    }
  }
  return values
}

function validateSegments(input: string) {
  return Effect.try({
    try: () => validateSegmentsUnsafe(input),
    catch: (cause) =>
      OxpError.isError(cause)
        ? cause
        : new OxpError.InvalidArgument({ detail: "Path failed validation" }),
  })
}

function allocateAlias(folderPath: string, roots: readonly OxpSchema.Root[]): OxpSchema.RootAlias {
  const base = normalizeAlias(path.basename(folderPath) || "folder")
  const taken = new Set([...RESERVED_ALIASES, ...roots.map((root) => root.alias.toLowerCase())])
  if (!taken.has(base)) return OxpSchema.RootAlias.make(base)
  for (let index = 2; index < Number.MAX_SAFE_INTEGER; index++) {
    const suffix = `-${index}`
    const candidate = `${base.slice(0, Math.max(1, 32 - suffix.length))}${suffix}`
    if (!taken.has(candidate)) return OxpSchema.RootAlias.make(candidate)
  }
  throw new OxpError.Conflict({ detail: "Unable to allocate an approved-root alias" })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const fs = yield* FSUtil.Service

    const fingerprint = Effect.fnUntraced(function* (canonical: string) {
      const info = yield* fs.stat(canonical).pipe(
        Effect.mapError(() => new OxpError.RootChanged({ detail: "Approved root is not available" })),
      )
      if (info.type !== "Directory") {
        return yield* new OxpError.RootChanged({ detail: "Approved root is no longer a directory" })
      }
      const ino = Number(Option.getOrElse(info.ino, () => 0))
      return ino > 0 ? `inode:${ino}` : undefined
    })

    const canonicalExisting = Effect.fnUntraced(function* (candidate: string) {
      return yield* fs.realPath(candidate).pipe(
        Effect.mapError(() => new OxpError.NotFound({ detail: "Path does not exist" })),
      )
    })

    const verify = Effect.fn("OxpRoot.verify")(function* (root: OxpSchema.Root) {
      if (!isNativeRootPath(root.path)) {
        return yield* new OxpError.RootChanged({ detail: `Approved root /${root.alias} is not valid for this host OS` })
      }
      const current = yield* fs.realPath(root.path).pipe(
        Effect.mapError(() => new OxpError.RootChanged({ detail: `Approved root /${root.alias} is unavailable or changed` })),
      )
      if (!isContained(root.path, current) || !isContained(current, root.path)) {
        return yield* new OxpError.RootChanged({ detail: `Approved root /${root.alias} changed on disk` })
      }
      const currentFingerprint = yield* fingerprint(current)
      if (root.identityFingerprint && currentFingerprint && root.identityFingerprint !== currentFingerprint) {
        return yield* new OxpError.RootChanged({ detail: `Approved root /${root.alias} was replaced on disk` })
      }
      return { root, canonicalPath: current } satisfies ResolvedRoot
    })

    const list = Effect.fn("OxpRoot.list")(function* () {
      return (yield* config.get()).roots
    })

    const prepare = Effect.fnUntraced(function* (candidate: string) {
      if (IS_WINDOWS) {
        if (candidate.startsWith("\\\\") || candidate.startsWith("//")) {
          return yield* new OxpError.InvalidArgument({ detail: "UNC/network roots are not supported" })
        }
        if (!WINDOWS_DRIVE_ABSOLUTE.test(candidate)) {
          return yield* new OxpError.InvalidArgument({ detail: "Approved root must use a fully qualified Windows drive path" })
        }
      } else if (!path.posix.isAbsolute(candidate)) {
        return yield* new OxpError.InvalidArgument({ detail: "Approved root must use an absolute POSIX path" })
      }
      const canonical = yield* canonicalExisting(candidate)
      const parsed = path.parse(canonical)
      const wholeFilesystem = IS_WINDOWS ? parsed.root.toLowerCase() === canonical.toLowerCase() : parsed.root === canonical
      if (wholeFilesystem) {
        return yield* new OxpError.InvalidArgument({ detail: "Approving an entire drive/filesystem is not allowed" })
      }
      const identityFingerprint = yield* fingerprint(canonical)
      return { canonical, identityFingerprint }
    })

    // Project selection is itself durable user authorization. Unlike the manual
    // picker, a selected project may temporarily disappear from disk (detached
    // drive, deleted checkout, etc.). Preserve the selected pathname without a
    // filesystem fingerprint in that case so the root projects as unavailable
    // and automatically becomes usable again when the selected project returns.
    const prepareProject = Effect.fnUntraced(function* (candidate: string) {
      if (IS_WINDOWS) {
        if (candidate.startsWith("\\\\") || candidate.startsWith("//")) {
          return yield* new OxpError.InvalidArgument({ detail: "UNC/network project roots are not supported" })
        }
        if (!WINDOWS_DRIVE_ABSOLUTE.test(candidate)) {
          return yield* new OxpError.InvalidArgument({ detail: "Project root must use a fully qualified Windows drive path" })
        }
      } else if (!path.posix.isAbsolute(candidate)) {
        return yield* new OxpError.InvalidArgument({ detail: "Project root must use an absolute POSIX path" })
      }
      const lexical = path.resolve(candidate)
      const lexicalParsed = path.parse(lexical)
      const lexicalWholeFilesystem = IS_WINDOWS
        ? lexicalParsed.root.toLowerCase() === lexical.toLowerCase()
        : lexicalParsed.root === lexical
      if (lexicalWholeFilesystem) {
        return yield* new OxpError.InvalidArgument({ detail: "Approving an entire drive/filesystem is not allowed" })
      }
      const current = yield* fs.realPath(lexical).pipe(
        Effect.map(Option.some),
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(Option.none<string>()),
        ),
        Effect.mapError(() => new OxpError.DependencyUnavailable({ detail: "Unable to canonicalize project root" })),
      )
      if (Option.isNone(current)) return { canonical: lexical, identityFingerprint: undefined }
      const canonical = current.value
      const parsed = path.parse(canonical)
      const wholeFilesystem = IS_WINDOWS ? parsed.root.toLowerCase() === canonical.toLowerCase() : parsed.root === canonical
      if (wholeFilesystem) {
        return yield* new OxpError.InvalidArgument({ detail: "Approving an entire drive/filesystem is not allowed" })
      }
      return { canonical, identityFingerprint: yield* fingerprint(canonical) }
    })

    const approve = Effect.fn("OxpRoot.approve")(function* (candidate: string, requestedAlias?: string) {
      const { canonical, identityFingerprint } = yield* prepare(candidate)
      const id = OxpSchema.RootID.make(randomUUID())
      let created: OxpSchema.Root | undefined

      yield* config.update((current) => {
        const workerPolicy = scopeLegacyWorkerAgentPolicy(current)
        const exact = current.roots.find((root) => samePath(root.path, canonical))
        if (exact) {
          if (hasSource(exact, "project")) {
            throw new OxpError.Conflict({
              detail: "This folder is already authorized by the OpenFork project selector",
            })
          }
          created = addSource(exact, "manual")
          return {
            ...current,
            roots: current.roots.map((root) => root.id === exact.id ? created! : root),
            workerPolicy,
          }
        }
        for (const other of current.roots) {
          if (hasSource(other, "manual") && (isContained(other.path, canonical) || isContained(canonical, other.path))) {
            throw new OxpError.Conflict({ detail: `Approved root overlaps /${other.alias}` })
          }
        }
        const alias = requestedAlias
          ? OxpSchema.RootAlias.make(normalizeAlias(requestedAlias))
          : allocateAlias(canonical, current.roots)
        if (RESERVED_ALIASES.has(alias) || current.roots.some((root) => root.alias.toLowerCase() === alias.toLowerCase())) {
          throw new OxpError.Conflict({ detail: `Approved-root alias /${alias} is reserved or already in use` })
        }
        created = { id, alias, path: canonical, approvedAt: Date.now(), identityFingerprint, sources: ["manual"] }
        return {
          ...current,
          roots: [...current.roots, created],
          workerPolicy,
        }
      })
      if (!created) return yield* new OxpError.Conflict({ detail: "Approved root was not committed" })
      return created
    })

    const syncProjectRoots = Effect.fn("OxpRoot.syncProjectRoots")(function* (candidates: readonly string[]) {
      if (candidates.length > OxpSchema.MAX_ROOTS) {
        return yield* new OxpError.InvalidArgument({ detail: "OpenFork project catalog contains too many roots" })
      }
      const preparedRaw = yield* Effect.forEach(
        candidates,
        (candidate) => prepareProject(candidate),
        { concurrency: 8 },
      )
      const prepared = [
        ...new Map(preparedRaw.map((item) => [pathIdentity(item.canonical), item] as const)).values(),
      ]
      let reconciled: readonly OxpSchema.Root[] = []

      yield* config.update((current) => {
        const workerPolicy = scopeLegacyWorkerAgentPolicy(current)
        const desired = new Set(prepared.map((item) => pathIdentity(item.canonical)))
        const removed = new Set<OxpSchema.RootID>()
        const next: OxpSchema.Root[] = []

        for (const root of current.roots) {
          if (!hasSource(root, "project") || desired.has(pathIdentity(root.path))) {
            next.push(root)
            continue
          }
          const retained = removeSource(root, "project")
          if (retained) next.push(retained)
          else removed.add(root.id)
        }

        for (const item of prepared) {
          const index = next.findIndex((root) => samePath(root.path, item.canonical))
          if (index !== -1) {
            const root = next[index]!
            next[index] = {
              ...addSource(root, "project"),
              path: item.canonical,
              // A live project selection is fresh authorization for the current
              // directory object. If the path is temporarily missing, retain an
              // existing fingerprint rather than weakening a prior binding.
              identityFingerprint: item.identityFingerprint ?? root.identityFingerprint,
            }
            continue
          }
          next.push({
            id: OxpSchema.RootID.make(randomUUID()),
            alias: allocateAlias(item.canonical, next),
            path: item.canonical,
            approvedAt: Date.now(),
            ...(item.identityFingerprint ? { identityFingerprint: item.identityFingerprint } : {}),
            sources: ["project"],
          })
        }

        if (next.length > OxpSchema.MAX_ROOTS) {
          throw new OxpError.InvalidArgument({ detail: "OXP approved-root limit exceeded" })
        }
        reconciled = next
        return {
          ...current,
          roots: next,
          workerPolicy: {
            ...workerPolicy,
            agentRoots: (workerPolicy.agentRoots ?? []).filter(
              (entry) => !removed.has(entry.rootID),
            ),
          },
        }
      })
      return reconciled
    })

    const importMany = Effect.fn("OxpRoot.importMany")(function* (
      candidates: readonly { readonly path: string; readonly alias?: string }[],
    ) {
      if (candidates.length > 64) {
        return yield* new OxpError.InvalidArgument({ detail: "Legacy import contains too many approved roots" })
      }
      const prepared = yield* Effect.forEach(
        candidates,
        (candidate) =>
          prepare(candidate.path).pipe(
            Effect.map((value) => ({
              ...value,
              requestedAlias: candidate.alias ? normalizeAlias(candidate.alias) : undefined,
            })),
          ),
        { concurrency: 8 },
      )
      const seen = new Set<string>()
      for (const item of prepared) {
        const key = IS_WINDOWS ? item.canonical.toLowerCase() : item.canonical
        if (seen.has(key)) continue
        seen.add(key)
      }

      let imported: readonly OxpSchema.Root[] = []
      yield* config.update((current) => {
        const workerPolicy = scopeLegacyWorkerAgentPolicy(current)
        const next = [...current.roots]
        for (const item of prepared) {
          const exactIndex = next.findIndex((root) =>
            isContained(root.path, item.canonical) && isContained(item.canonical, root.path),
          )
          if (exactIndex !== -1) {
            const exact = next[exactIndex]!
            // Project selection is already user authorization. Legacy/manual
            // import must not silently make that authority survive after the
            // project is removed from OpenFork.
            if (!hasSource(exact, "project")) next[exactIndex] = addSource(exact, "manual")
            continue
          }
          for (const other of next) {
            if (hasSource(other, "manual") && (isContained(other.path, item.canonical) || isContained(item.canonical, other.path))) {
              throw new OxpError.Conflict({ detail: `Imported root overlaps /${other.alias}` })
            }
          }
          const requestedBase = item.requestedAlias ?? normalizeAlias(path.basename(item.canonical) || "folder")
          const taken = new Set([...RESERVED_ALIASES, ...next.map((root) => root.alias.toLowerCase())])
          let alias = requestedBase
          if (taken.has(alias)) {
            let allocated: string | undefined
            for (let index = 2; index < Number.MAX_SAFE_INTEGER; index++) {
              const suffix = `-${index}`
              const candidate = `${requestedBase.slice(0, Math.max(1, 32 - suffix.length))}${suffix}`
              if (!taken.has(candidate)) {
                allocated = candidate
                break
              }
            }
            if (!allocated) throw new OxpError.Conflict({ detail: "Unable to allocate an imported root alias" })
            alias = allocated
          }
          next.push({
            id: OxpSchema.RootID.make(randomUUID()),
            alias: OxpSchema.RootAlias.make(alias),
            path: item.canonical,
            approvedAt: Date.now(),
            identityFingerprint: item.identityFingerprint,
            sources: ["manual"],
          })
        }
        if (next.length > OxpSchema.MAX_ROOTS) {
          throw new OxpError.InvalidArgument({ detail: "Legacy import would exceed the approved-root limit" })
        }
        imported = next
        return { ...current, roots: next, workerPolicy }
      })
      return imported
    })

    const rename = Effect.fn("OxpRoot.rename")(function* (id: OxpSchema.RootID, requested: string) {
      const alias = OxpSchema.RootAlias.make(normalizeAlias(requested))
      if (RESERVED_ALIASES.has(alias)) return yield* new OxpError.Conflict({ detail: `Alias /${alias} is reserved` })
      let renamed: OxpSchema.Root | undefined
      yield* config.update((current) => {
        if (current.roots.some((root) => root.id !== id && root.alias.toLowerCase() === alias.toLowerCase())) {
          throw new OxpError.Conflict({ detail: `Alias /${alias} is already in use` })
        }
        const roots = current.roots.map((root) => {
          if (root.id !== id) return root
          renamed = { ...root, alias }
          return renamed
        })
        if (!renamed) throw new OxpError.RootNotFound({ detail: "Approved root does not exist" })
        return { ...current, roots }
      })
      return renamed!
    })

    const remove = Effect.fn("OxpRoot.remove")(function* (id: OxpSchema.RootID) {
      yield* config.update((current) => {
        const existing = current.roots.find((root) => root.id === id)
        if (existing && hasSource(existing, "project")) {
          throw new OxpError.Conflict({ detail: "OpenFork project roots are managed by the project selector" })
        }
        const roots = current.roots.filter((root) => root.id !== id)
        if (roots.length === current.roots.length) throw new OxpError.RootNotFound({ detail: "Approved root does not exist" })
        const workerPolicy = scopeLegacyWorkerAgentPolicy(current)
        return {
          ...current,
          roots,
          workerPolicy: {
            ...workerPolicy,
            agentRoots: (workerPolicy.agentRoots ?? []).filter(
              (entry) => entry.rootID !== id,
            ),
          },
        }
      })
    })

    const resolveRoot = Effect.fn("OxpRoot.resolveRoot")(function* (idOrAlias: OxpSchema.RootID | string) {
      const roots = (yield* config.get()).roots
      const needle = String(idOrAlias).replace(/^[/\\]+/, "").toLowerCase()
      const root = roots.find((entry) => entry.id === idOrAlias || entry.alias.toLowerCase() === needle)
      if (!root) return yield* new OxpError.RootNotFound({ detail: "Approved root does not exist" })
      return yield* verify(root)
    })

    const deepestExisting = Effect.fnUntraced(function* (absolute: string) {
      let current = path.resolve(absolute)
      const missing: string[] = []
      while (true) {
        const real = yield* fs.realPath(current).pipe(
          Effect.map(Option.some),
          Effect.catchIf(
            (error) => error.reason._tag === "NotFound",
            () => Effect.succeed(Option.none<string>()),
          ),
          Effect.mapError(() => new OxpError.DependencyUnavailable({ detail: "Unable to canonicalize path" })),
        )
        if (Option.isSome(real)) return { real: real.value, missing }
        const parent = path.dirname(current)
        if (parent === current) return yield* new OxpError.NotFound({ detail: "Path has no existing parent" })
        missing.unshift(path.basename(current))
        current = parent
      }
    })

    const toVirtualPath = (root: OxpSchema.Root, canonicalPath: string) => {
      const relative = path.relative(root.path, canonicalPath)
      return relative ? `/${root.alias}/${relative.split(path.sep).join("/")}` : `/${root.alias}`
    }

    const resolveWithinRoot = Effect.fnUntraced(function* (
      root: OxpSchema.Root,
      rootReal: string,
      rest: readonly string[],
      allowMissing: boolean,
    ) {
      const candidate = rest.length === 0 ? rootReal : path.join(rootReal, ...rest)
      if (!isContained(rootReal, candidate)) return yield* new OxpError.PathEscape({ detail: "Path escapes its approved root" })
      const resolved = yield* deepestExisting(candidate)
      if (!isContained(rootReal, resolved.real)) {
        return yield* new OxpError.PathEscape({ detail: "Path escapes its approved root via a link" })
      }
      if (resolved.missing.length > 0 && !allowMissing) return yield* new OxpError.NotFound({ detail: "Path does not exist" })
      const finalPath = resolved.missing.length ? path.join(resolved.real, ...resolved.missing) : resolved.real
      if (!isContained(rootReal, finalPath)) return yield* new OxpError.PathEscape({ detail: "Path escapes its approved root" })
      return {
        root,
        canonicalPath: rootReal,
        path: finalPath,
        virtualPath: toVirtualPath(root, finalPath),
      } satisfies ResolvedPath
    })

    const resolveNative = Effect.fnUntraced(function* (
      input: string,
      allowMissing: boolean,
      requestedRootID?: OxpSchema.RootID,
    ) {
      if (IS_WINDOWS && input.startsWith("\\\\")) return yield* new OxpError.PathEscape({ detail: "UNC/network paths are not authorized" })
      const stripped = IS_WINDOWS
        ? input.replace(/^[A-Za-z]:[\\/]+/, "").replace(/^\\\\[^\\/]+[\\/]+[^\\/]+[\\/]*/, "")
        : input.replace(/^\/+/, "")
      const nativeSegments = (IS_WINDOWS ? stripped.split(/[/\\]+/) : stripped.split(/\/+/)).filter(Boolean)
      for (const segment of nativeSegments) yield* validateSegments(segment)

      const lexical = path.resolve(input)
      const roots = (yield* config.get()).roots
      const requestedRoot = requestedRootID ? roots.find((entry) => entry.id === requestedRootID) : undefined
      if (requestedRootID && !requestedRoot) {
        return yield* new OxpError.RootNotFound({ detail: "Approved root does not exist" })
      }
      const root = requestedRoot ?? roots
        .filter((entry) => isContained(entry.path, lexical))
        .sort((a, b) => b.path.length - a.path.length)[0]
      if (!root) return yield* new OxpError.PathEscape({ detail: "Native path is outside the approved roots" })
      if (!isContained(root.path, lexical)) {
        return yield* new OxpError.PathEscape({ detail: "Native path does not belong to the requested approved root" })
      }
      const verified = yield* verify(root)
      const resolved = yield* deepestExisting(lexical)
      if (!isContained(verified.canonicalPath, resolved.real)) {
        return yield* new OxpError.PathEscape({ detail: "Path escapes its approved root via a link" })
      }
      if (resolved.missing.length > 0 && !allowMissing) return yield* new OxpError.NotFound({ detail: "Path does not exist" })
      const finalPath = resolved.missing.length ? path.join(resolved.real, ...resolved.missing) : resolved.real
      return {
        root,
        canonicalPath: verified.canonicalPath,
        path: finalPath,
        virtualPath: toVirtualPath(root, finalPath),
      } satisfies ResolvedPath
    })

    const resolvePath = Effect.fn("OxpRoot.resolvePath")(function* (input: string, options: ResolveOptions = {}) {
      const trimmed = input.trim()
      if (!trimmed) return yield* new OxpError.InvalidArgument({ detail: "Path is empty" })
      const roots = (yield* config.get()).roots
      if (/^(?:\.)(?:[/\\]+\.)*[/\\]*$/.test(trimmed)) {
        let root: OxpSchema.Root | undefined
        if (options.rootID) root = roots.find((entry) => entry.id === options.rootID)
        else if (roots.length === 1) root = roots[0]
        if (!root) {
          return yield* (options.rootID
            ? new OxpError.RootNotFound({ detail: "Approved root does not exist" })
            : new OxpError.RootRequired({ detail: "Relative path requires one explicit approved root" }))
        }
        const verified = yield* verify(root)
        return yield* resolveWithinRoot(root, verified.canonicalPath, [], options.allowMissing ?? false)
      }
      const nativeWindows = IS_WINDOWS && NATIVE_WINDOWS.test(trimmed)
      const firstPosix = !IS_WINDOWS && trimmed.startsWith("/") ? trimmed.split("/").find(Boolean)?.toLowerCase() : undefined
      const nativePosix = !IS_WINDOWS && trimmed.startsWith("/") && !roots.some((root) => root.alias.toLowerCase() === firstPosix)
      if (nativeWindows || nativePosix) {
        return yield* resolveNative(trimmed, options.allowMissing ?? false, options.rootID)
      }

      let root: OxpSchema.Root
      let rest: string[]
      const absoluteVirtual = IS_WINDOWS ? /^[/\\]/.test(trimmed) : trimmed.startsWith("/")
      if (absoluteVirtual) {
        const parts = yield* validateSegments(trimmed)
        const found = roots.find((entry) => entry.alias.toLowerCase() === parts[0]!.toLowerCase())
        if (!found) return yield* new OxpError.RootNotFound({ detail: `Unknown approved root /${parts[0]}` })
        if (options.rootID && found.id !== options.rootID) {
          return yield* new OxpError.PathEscape({ detail: "Virtual path does not belong to the requested approved root" })
        }
        root = found
        rest = parts.slice(1)
      } else {
        rest = yield* validateSegments(trimmed)
        if (options.rootID) {
          const found = roots.find((entry) => entry.id === options.rootID)
          if (!found) return yield* new OxpError.RootNotFound({ detail: "Approved root does not exist" })
          root = found
        } else if (roots.length === 1) {
          root = roots[0]!
        } else {
          return yield* new OxpError.RootRequired({ detail: "Relative path requires one explicit approved root" })
        }
      }
      const verified = yield* verify(root)
      return yield* resolveWithinRoot(root, verified.canonicalPath, rest, options.allowMissing ?? false)
    })

    return Service.of({ list, approve, syncProjectRoots, importMany, rename, remove, resolveRoot, resolvePath, toVirtualPath, verify })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [OxpConfig.node, FSUtil.node] })

export * as OxpRoot from "./root"
