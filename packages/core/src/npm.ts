export * as Npm from "./npm"

import path from "path"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "module"
import { pathToFileURL } from "url"
import npa from "npm-package-arg"
import { Effect, Schema, Context, Layer, Option, FileSystem } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { EffectFlock } from "./util/effect-flock"
import { makeGlobalNode } from "./effect/app-node"
import { filesystem } from "./effect/app-node-platform"
import { LayerNode } from "./effect/layer-node"
import { makeRuntime } from "./effect/runtime"
import { NpmConfig } from "./npm-config"
import { KeyedMutex } from "./effect/keyed-mutex"

export class InstallFailedError extends Schema.TaggedErrorClass<InstallFailedError>()("NpmInstallFailedError", {
  add: Schema.Array(Schema.String).pipe(Schema.optional),
  dir: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface EntryPoint {
  readonly directory: string
  readonly entrypoint?: string
}

export interface Interface {
  readonly add: (pkg: string) => Effect.Effect<EntryPoint, InstallFailedError | EffectFlock.LockError>
  readonly install: (
    dir: string,
    input?: {
      add: {
        name: string
        version?: string
      }[]
    },
  ) => Effect.Effect<void, EffectFlock.LockError | InstallFailedError>
  readonly which: (pkg: string, bin?: string) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Npm") {}

const illegal = process.platform === "win32" ? new Set(["<", ">", ":", '"', "|", "?", "*"]) : undefined

export function sanitize(pkg: string) {
  if (!illegal) return pkg
  return Array.from(pkg, (char) => (illegal.has(char) || char.charCodeAt(0) < 32 ? "_" : char)).join("")
}

/**
 * Package specs whose resolved contents may legitimately change without the
 * config string changing. Exact semver versions stay immutable/offline-fast;
 * tags, ranges, and local directory specs are refreshed once per Npm service
 * lifetime before their first use.
 */
export function shouldRefreshPackageCache(pkg: string) {
  try {
    const parsed = npa(pkg)
    const target = parsed.type === "alias" ? (parsed as npa.AliasResult).subSpec : parsed
    return target?.type === "tag" || target?.type === "range" || target?.type === "directory"
  } catch {
    return false
  }
}

const nodeImportConditions = new Set(["node", "import", "node-addons", "default"])

function packageImportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = packageImportTarget(item)
      if (hit) return hit
    }
    return
  }
  if (!value || typeof value !== "object") return
  for (const [condition, nested] of Object.entries(value)) {
    if (!nodeImportConditions.has(condition)) continue
    const hit = packageImportTarget(nested)
    if (hit) return hit
  }
}

function packageImportEntryPoint(dir: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as Record<string, unknown>
    const exports = pkg.exports
    const rootExport =
      exports && typeof exports === "object" && !Array.isArray(exports) && "." in exports
        ? (exports as Record<string, unknown>)["."]
        : exports
    const target =
      packageImportTarget(rootExport) ??
      (typeof pkg.module === "string" ? pkg.module : undefined) ??
      (typeof pkg.main === "string" ? pkg.main : undefined)
    if (!target || target.startsWith("node:")) return
    const resolved = path.resolve(dir, target)
    if (!FSUtil.contains(dir, resolved) || !existsSync(resolved)) return
    return pathToFileURL(resolved).href
  } catch {
    return
  }
}

const resolveEntryPoint = (name: string, dir: string): EntryPoint => {
  let entrypoint: string | undefined
  try {
    // Node only honors the parent argument behind --experimental-import-meta-resolve, and
    // import() of a bare package directory fails with ERR_UNSUPPORTED_DIR_IMPORT. Prefer
    // require resolution when the package exposes that condition because importing the
    // resolved CJS/default file is valid and preserves historical behavior.
    entrypoint =
      typeof Bun !== "undefined"
        ? import.meta.resolve(name, dir)
        : pathToFileURL(createRequire(path.join(dir, "package.json")).resolve(name)).href
  } catch {
    // ESM-only packages can intentionally expose only the "import" condition.
    // createRequire().resolve() reports ERR_PACKAGE_PATH_NOT_EXPORTED for those
    // even though Node can import the package. Resolve that package-local target
    // from its manifest instead of treating a valid persistent cache as corrupt.
    entrypoint = typeof Bun === "undefined" ? packageImportEntryPoint(dir) : undefined
  }
  return {
    directory: dir,
    entrypoint,
  }
}

interface ArboristNode {
  name: string
  path: string
}

interface ArboristTree {
  edgesOut: Map<string, { to?: ArboristNode }>
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const afs = yield* FSUtil.Service
    const global = yield* Global.Service
    const fs = yield* FileSystem.FileSystem
    const flock = yield* EffectFlock.Service
    const refreshLocks = KeyedMutex.makeUnsafe<string>()
    const refreshed = new Set<string>()
    const directory = (pkg: string) => path.join(global.cache, "packages", sanitize(pkg))
    const reify = (input: { dir: string; add?: string[] }) =>
      Effect.gen(function* () {
        yield* flock.acquire(`npm-install:${input.dir}`)
        const { Arborist } = yield* Effect.promise(() => import("@npmcli/arborist"))
        const add = input.add ?? []
        const npmOptions = yield* NpmConfig.load(input.dir)
        const arborist = new Arborist({
          ...npmOptions,
          path: input.dir,
          binLinks: true,
          progress: false,
          savePrefix: "",
          ignoreScripts: true,
        })
        return yield* Effect.tryPromise({
          try: () =>
            arborist.reify({
              ...npmOptions,
              add,
              save: true,
              saveType: "prod",
            }),
          catch: (cause) =>
            new InstallFailedError({
              cause,
              add,
              dir: input.dir,
            }),
        }) as Effect.Effect<ArboristTree, InstallFailedError>
      }).pipe(
        Effect.withSpan("Npm.reify", {
          attributes: input,
        }),
      )

    const add = Effect.fn("Npm.add")(function* (pkg: string) {
      const dir = directory(pkg)
      const name = (() => {
        try {
          return npa(pkg).name ?? pkg
        } catch {
          return pkg
        }
      })()
      const packageDir = path.join(dir, "node_modules", name)
      const mutable = shouldRefreshPackageCache(pkg)

      return yield* refreshLocks.withLock(dir)(
        Effect.gen(function* () {
          const installed = yield* afs.existsSafe(packageDir)
          if (installed && (!mutable || refreshed.has(dir))) {
            return resolveEntryPoint(name, packageDir)
          }

          // Moving tags/ranges must not be frozen forever by the persistent
          // package cache. Refresh at most once per process/service lifetime:
          // after a module has been imported, changing its files underneath the
          // same Node process would not provide reliable hot-update semantics.
          if (mutable) refreshed.add(dir)

          const tree = yield* reify({ dir, add: [pkg] }).pipe(
            Effect.catch((error) => {
              // Preserve OpenFork's offline cache behavior. A moving spec that
              // cannot reach its registry may keep using a previously valid
              // installation, but we do not retry it for every workspace.
              if (installed) {
                const cached = resolveEntryPoint(name, packageDir)
                if (cached.entrypoint) return Effect.succeed(undefined)
              }
              if (mutable) refreshed.delete(dir)
              return Effect.fail(error)
            }),
          )

          if (!tree) return resolveEntryPoint(name, packageDir)

          const first = tree.edgesOut.values().next().value?.to
          if (!first) {
            const result = resolveEntryPoint(name, packageDir)
            if (result.entrypoint) return result
            if (mutable) refreshed.delete(dir)
            return yield* new InstallFailedError({ add: [pkg], dir })
          }
          return resolveEntryPoint(first.name, first.path)
        }),
      )
    }, Effect.scoped)

    const install: Interface["install"] = Effect.fn("Npm.install")(function* (dir, input) {
      const canWrite = yield* afs.access(dir, { writable: true }).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      )
      if (!canWrite) return

      const add = input?.add.map((pkg) => [pkg.name, pkg.version].filter(Boolean).join("@")) ?? []
      if (
        yield* Effect.gen(function* () {
          const nodeModulesExists = yield* afs.existsSafe(path.join(dir, "node_modules"))
          if (!nodeModulesExists) {
            yield* reify({ add, dir })
            return true
          }
          return false
        }).pipe(Effect.withSpan("Npm.checkNodeModules"))
      )
        return

      yield* Effect.gen(function* () {
        const pkg = yield* afs.readJson(path.join(dir, "package.json")).pipe(Effect.orElseSucceed(() => ({})))
        const lock = yield* afs.readJson(path.join(dir, "package-lock.json")).pipe(Effect.orElseSucceed(() => ({})))

        const pkgAny = pkg as any
        const lockAny = lock as any
        const declared = new Set([
          ...Object.keys(pkgAny?.dependencies || {}),
          ...Object.keys(pkgAny?.devDependencies || {}),
          ...Object.keys(pkgAny?.peerDependencies || {}),
          ...Object.keys(pkgAny?.optionalDependencies || {}),
          ...(input?.add || []).map((pkg) => pkg.name),
        ])

        const root = lockAny?.packages?.[""] || {}
        const locked = new Set([
          ...Object.keys(root?.dependencies || {}),
          ...Object.keys(root?.devDependencies || {}),
          ...Object.keys(root?.peerDependencies || {}),
          ...Object.keys(root?.optionalDependencies || {}),
        ])

        for (const name of declared) {
          if (!locked.has(name)) {
            yield* reify({ dir, add })
            return
          }
        }
      }).pipe(Effect.withSpan("Npm.checkDirty"))

      return
    }, Effect.scoped)

    const which = Effect.fn("Npm.which")(function* (pkg: string, bin?: string) {
      const dir = directory(pkg)
      const binDir = path.join(dir, "node_modules", ".bin")

      const pick = Effect.fnUntraced(function* () {
        const files = yield* fs.readDirectory(binDir).pipe(Effect.catch(() => Effect.succeed([] as string[])))

        if (files.length === 0) return Option.none<string>()
        // Caller picked a specific bin (e.g. pyright exposes both `pyright` and
        // `pyright-langserver`); trust the hint if the package provides it.
        if (bin) return files.includes(bin) ? Option.some(bin) : Option.none<string>()
        if (files.length === 1) return Option.some(files[0])

        const pkgJson = yield* afs.readJson(path.join(dir, "node_modules", pkg, "package.json")).pipe(Effect.option)

        if (Option.isSome(pkgJson)) {
          const parsed = pkgJson.value as { bin?: string | Record<string, string> }
          if (parsed?.bin) {
            const unscoped = pkg.startsWith("@") ? pkg.split("/")[1] : pkg
            const parsedBin = parsed.bin
            if (typeof parsedBin === "string") return Option.some(unscoped)
            const keys = Object.keys(parsedBin)
            if (keys.length === 1) return Option.some(keys[0])
            return parsedBin[unscoped] ? Option.some(unscoped) : Option.some(keys[0])
          }
        }

        return Option.some(files[0])
      })

      return Option.getOrUndefined(
        yield* Effect.gen(function* () {
          const bin = yield* pick()
          if (Option.isSome(bin)) {
            return Option.some(path.join(binDir, bin.value))
          }

          yield* fs.remove(path.join(dir, "package-lock.json")).pipe(Effect.orElseSucceed(() => {}))

          yield* add(pkg)

          const resolved = yield* pick()
          if (Option.isNone(resolved)) return Option.none<string>()
          return Option.some(path.join(binDir, resolved.value))
        }).pipe(
          Effect.scoped,
          Effect.orElseSucceed(() => Option.none<string>()),
        ),
      )
    })

    return Service.of({
      add,
      install,
      which,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Global.node, filesystem, EffectFlock.node],
})

const { runPromise } = makeRuntime(Service, LayerNode.compile(node))

export async function install(...args: Parameters<Interface["install"]>) {
  return runPromise((svc) => svc.install(...args))
}

export async function add(...args: Parameters<Interface["add"]>) {
  return runPromise((svc) => svc.add(...args))
}

export async function which(...args: Parameters<Interface["which"]>) {
  return runPromise((svc) => svc.which(...args))
}
