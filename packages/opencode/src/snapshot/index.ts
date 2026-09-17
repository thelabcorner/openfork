import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import {
  Cause,
  Duration,
  Effect,
  Layer,
  Schedule,
  Schema,
  Semaphore,
  Context,
  SynchronizedRef,
  TxReentrantLock,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { formatPatch, structuredPatch } from "diff"
import path from "path"
import { AppProcess } from "@opencode-ai/core/process"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Hash } from "@opencode-ai/core/util/hash"
import { Config } from "@/config/config"
import { Global } from "@opencode-ai/core/global"
import { Info } from "@opencode-ai/schema/file-diff"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { ProjectInventory } from "@opencode-ai/core/project-inventory"
import { AbsolutePath } from "@opencode-ai/core/schema"

export const Patch = Schema.Struct({
  hash: Schema.String,
  files: Schema.mutable(Schema.Array(Schema.String)),
})
export type Patch = typeof Patch.Type

export const FileDiff = Info
export type FileDiff = typeof FileDiff.Type

const prune = "7.days"
const limit = 2 * 1024 * 1024
const core = ["-c", "core.longpaths=true", "-c", "core.symlinks=true"]
const cfg = ["-c", "core.autocrlf=false", ...core]
const quote = [...cfg, "-c", "core.quotepath=false"]
interface GitResult {
  readonly code: ChildProcessSpawner.ExitCode
  readonly text: string
  readonly stderr: string
}

type State = Omit<Interface, "init">

export interface Diagnostics {
  readonly revision: number
  readonly captures: number
  readonly cacheHits: number
  readonly invalidations: number
  /**
   * Whether a completed materialization may currently be served to later
   * callers. False until an invalidation source covers Snapshot's whole
   * semantic domain (see the coverage note in `state`).
   */
  readonly completedReuse: boolean
  /** Native watcher currently owns this project root. Ownership only, not proof. */
  readonly watcherOwnedRoot: boolean
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly cleanup: () => Effect.Effect<void>
  readonly track: () => Effect.Effect<string | undefined>
  /** Mark the shared project materialization stale. */
  readonly invalidate: (reason?: string) => Effect.Effect<void>
  /**
   * Run a potentially mutating project operation. Mutations may overlap each
   * other, but captures are exclusive against them so a tree cannot observe a
   * half-applied tool operation.
   */
  readonly withMutation: <A, E, R>(effect: Effect.Effect<A, E, R>, reason?: string) => Effect.Effect<A, E, R>
  /** Internal ownership/performance observability. */
  readonly diagnostics: () => Effect.Effect<Diagnostics>
  /**
   * List files changed since `hash`. When `to` is supplied it is an already
   * captured immutable tree and no worktree refresh is performed.
   */
  readonly patch: (hash: string, to?: string) => Effect.Effect<Patch>
  readonly restore: (snapshot: string) => Effect.Effect<void>
  readonly revert: (patches: Patch[]) => Effect.Effect<void>
  readonly diff: (hash: string) => Effect.Effect<string>
  readonly diffFull: (from: string, to: string) => Effect.Effect<FileDiff[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Snapshot") {}

// Process-wide shadow-repo lock. Every Snapshot layer instance in this process
// must serialize mutations to one shadow gitdir: the earlier per-layer map let
// two instances write a single index concurrently, which is how a non-atomic
// seed copy could leave a zeroed index. Cross-process writers (separate server
// runs) are additionally protected by Git's own `index.lock`.
const shadowLocks = new Map<string, Semaphore.Semaphore>()
const shadowLock = (key: string) => {
  const hit = shadowLocks.get(key)
  if (hit) return hit

  const next = Semaphore.makeUnsafe(1)
  shadowLocks.set(key, next)
  return next
}

const layer: Layer.Layer<
  Service,
  never,
  FSUtil.Service | AppProcess.Service | Config.Service | EventV2Bridge.Service | LocationServiceMap.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const appProcess = yield* AppProcess.Service
    const config = yield* Config.Service
    const events = yield* EventV2Bridge.Service
    const locations = yield* LocationServiceMap.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Snapshot.state")(function* (ctx) {
        const state = {
          directory: ctx.directory,
          worktree: ctx.worktree,
          gitdir: path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree)),
          vcs: ctx.project.vcs,
        }

        // Native watcher ownership alone is NOT sufficient freshness proof for a
        // completed project tree: the watcher's ignore rules intentionally skip
        // generated folders (`build`, `dist`, `out`, `desktop`, caches, ...),
        // while Snapshot still stages TRACKED files under those names and every
        // non-gitignored untracked file created there.
        //
        // The canonical project inventory (`ProjectInventory`) owns the
        // Git-authoritative file domain and exposes a coverage proof. Retention
        // and untracked substitution are enabled only when that proof holds
        // (`complete`); otherwise only callers that overlap an in-flight capture
        // may share it and completed trees are discarded, so an out-of-process
        // edit can never be served from a stale memo.
        //
        // Acquisition is lazy and gated on watcher ownership: without a native
        // root subscription the proof can never hold, so we must not pay to
        // build the (large) location graph merely to read an inventory we would
        // then ignore.
        const inventory = Effect.fnUntraced(function* () {
          if (!Watcher.hasActiveRoot(ctx.directory)) return undefined
          return yield* Effect.gen(function* () {
            return yield* ProjectInventory.Service
          }).pipe(
            Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))),
            Effect.catch(() => Effect.succeed(undefined as ProjectInventory.Interface | undefined)),
          )
        })

        const inventoryDiagnostics = Effect.fnUntraced(function* () {
          const found = yield* inventory()
          if (!found) return undefined
          return yield* found.diagnostics().pipe(Effect.catch(() => Effect.succeed(undefined)))
        })

        const watcherOwnedRoot = () => Watcher.hasActiveRoot(ctx.directory)
        const completedReuse = Effect.fnUntraced(function* () {
          const diagnostics = yield* inventoryDiagnostics()
          return diagnostics?.complete === true
        })

        type CachedCapture = {
          readonly revision: number
          readonly token: object
          readonly effect: Effect.Effect<string | undefined>
        }
        type Materialization = {
          readonly revision: number
          readonly captures: number
          readonly cacheHits: number
          readonly invalidations: number
          readonly cached?: CachedCapture
        }

        const materialization = yield* SynchronizedRef.make<Materialization>({
          revision: 0,
          captures: 0,
          cacheHits: 0,
          invalidations: 0,
        })

        // Captures are exclusive writers while project mutations are shared
        // readers. The naming is intentionally inverted: independent sessions
        // may mutate concurrently, but no snapshot may scan a half-applied tool
        // operation. TxReentrantLock keeps nested brokered/delegated tools safe.
        const mutationBarrier = yield* TxReentrantLock.make()

        const invalidate = Effect.fnUntraced(function* (reason?: string) {
          const revision = yield* SynchronizedRef.modify(materialization, (current) => {
            const next: Materialization = {
              revision: current.revision + 1,
              captures: current.captures,
              cacheHits: current.cacheHits,
              invalidations: current.invalidations + 1,
            }
            return [next.revision, next] as const
          })
          if (reason) {
            yield* Effect.logDebug("snapshot materialization invalidated", {
              directory: state.directory,
              revision,
              reason,
            })
          }
        })

        // Path-specific writes (edit/write/patch and the native watcher) all
        // converge on this routed event. It is the authoritative invalidation
        // channel for completed materializations; broader/unknown tool effects
        // additionally use withMutation() below.
        const unsubscribe = yield* events.listenDirectory(Watcher.Event.Updated, ctx.directory, () =>
          invalidate("file.watcher.updated"),
        )
        yield* Effect.addFinalizer(() => unsubscribe)

        const args = (cmd: string[]) => ["--git-dir", state.gitdir, "--work-tree", state.worktree, ...cmd]

        const encodeNulTerminatedPaths = (files: string[]) => files.join("\0") + "\0"
        const encodeTopLevelLiteralPathspecs = (files: string[]) =>
          encodeNulTerminatedPaths(files.map((file) => `:(top,literal)${file}`))

        const git = Effect.fnUntraced(
          function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string>; stdin?: string }) {
            const result = yield* appProcess.run(
              ChildProcess.make("git", cmd, { cwd: opts?.cwd, env: opts?.env, extendEnv: true }),
              { stdin: opts?.stdin },
            )
            return {
              code: ChildProcessSpawner.ExitCode(result.exitCode),
              text: result.stdout.toString("utf8"),
              stderr: result.stderr.toString("utf8"),
            } satisfies GitResult
          },
          Effect.catch((err) =>
            Effect.succeed({
              code: ChildProcessSpawner.ExitCode(1),
              text: "",
              stderr: err instanceof Error ? err.message : String(err),
            }),
          ),
        )

        const ignore = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return new Set<string>()
          // check-ignore treats a leading colon as pathspec magic but accepts and echoes a protective ./ prefix.
          const checkIgnorePaths = files.map((item) => (item.startsWith(":") ? `./${item}` : item))
          const check = yield* git(
            [
              ...quote,
              "--git-dir",
              path.join(state.worktree, ".git"),
              "--work-tree",
              state.worktree,
              "check-ignore",
              "--no-index",
              "--stdin",
              "-z",
            ],
            {
              cwd: state.worktree,
              stdin: encodeNulTerminatedPaths(checkIgnorePaths),
            },
          )
          if (check.code !== 0 && check.code !== 1) return new Set<string>()
          return new Set(
            check.text
              .split("\0")
              .filter(Boolean)
              .map((item) => (item.startsWith("./:") ? item.slice(2) : item)),
          )
        })

        const drop = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return
          yield* git(
            [
              ...cfg,
              ...args(["rm", "--cached", "-f", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"]),
            ],
            {
              cwd: state.worktree,
              stdin: encodeTopLevelLiteralPathspecs(files),
            },
          )
        })

        const stage = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return
          const result = yield* git(
            [...cfg, ...args(["add", "--all", "--sparse", "--pathspec-from-file=-", "--pathspec-file-nul"])],
            {
              cwd: state.worktree,
              stdin: encodeTopLevelLiteralPathspecs(files),
            },
          )
          if (result.code === 0) return
          yield* Effect.logWarning("failed to add snapshot files", {
            exitCode: result.code,
            stderr: result.stderr,
          })
        })

        const exists = (file: string) => fs.exists(file).pipe(Effect.orDie)
        const read = (file: string) => fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")))
        const remove = (file: string) => fs.remove(file).pipe(Effect.catch(() => Effect.void))
        const locked = <A, E, R>(fx: Effect.Effect<A, E, R>) => shadowLock(state.gitdir).withPermits(1)(fx)

        const enabled = Effect.fnUntraced(function* () {
          if (state.vcs !== "git") return false
          return (yield* config.get()).snapshot !== false
        })

        const excludes = Effect.fnUntraced(function* () {
          const result = yield* git(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], {
            cwd: state.worktree,
          })
          const file = result.text.trim()
          if (!file) return
          if (!(yield* exists(file))) return
          return file
        })

        const sync = Effect.fnUntraced(function* (list: string[] = []) {
          const file = yield* excludes()
          const target = path.join(state.gitdir, "info", "exclude")
          const text = [
            file ? (yield* read(file)).trimEnd() : "",
            ...list.map((item) => `/${item.replaceAll("\\", "/")}`),
          ]
            .filter(Boolean)
            .join("\n")
          yield* fs.ensureDir(path.join(state.gitdir, "info")).pipe(Effect.orDie)
          yield* fs.writeFileString(target, text ? `${text}\n` : "").pipe(Effect.orDie)
        })

        // Reuse the hashes for the git storage between the original repo and snapshot
        // on huge repos like chromium checkout the git add --all rebuilding the
        // hashes can take minutes. By doing this we eliminating this at all
        const seed = Effect.fnUntraced(function* () {
          if (state.vcs !== "git") return

          const commonDir = yield* git(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
            cwd: state.worktree,
          })

          if (commonDir.code !== 0) return
          const source = commonDir.text.trim()
          if (!source || !(yield* exists(source))) return

          // Share the source object database (and the source's own alternates,
          // skipping any that no longer exist) so seeded blobs resolve.
          const sourceObjects = path.join(source, "objects")
          const chained = (yield* read(path.join(sourceObjects, "info", "alternates")))
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
          const alternates: string[] = []
          for (const candidate of [sourceObjects, ...chained]) {
            if (yield* exists(candidate)) alternates.push(candidate)
          }
          if (!alternates.length) return

          yield* fs.ensureDir(path.join(state.gitdir, "objects", "info")).pipe(Effect.orDie)
          yield* fs
            .writeFileString(path.join(state.gitdir, "objects", "info", "alternates"), alternates.join("\n") + "\n")
            .pipe(Effect.orDie)

          // Seed the index from the source repo so already-hashed entries are reused.
          // Atomic: a crashed or racing seed must never leave a zeroed index.
          const sourceIndex = path.join(source, "index")
          if (yield* exists(sourceIndex)) {
            yield* fs
              .copyFileAtomic(sourceIndex, path.join(state.gitdir, "index"))
              .pipe(Effect.catch(() => Effect.void))
          }
        })

        const sourceGitDir = Effect.fnUntraced(function* () {
          const commonDir = yield* git(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
            cwd: state.worktree,
          })
          if (commonDir.code !== 0) return undefined
          const source = commonDir.text.trim()
          return source || undefined
        })

        const indexValid = Effect.fnUntraced(function* () {
          const index = path.join(state.gitdir, "index")
          if (!(yield* exists(index))) return false
          return yield* fs.readFile(index).pipe(
            Effect.map((bytes) => Buffer.from(bytes).subarray(0, 4).toString("latin1") === "DIRC"),
            Effect.catch(() => Effect.succeed(false)),
          )
        })

        const seedIndex = Effect.fnUntraced(function* (source: string) {
          const sourceIndex = path.join(source, "index")
          if (!(yield* exists(sourceIndex))) return false
          yield* fs
            .copyFileAtomic(sourceIndex, path.join(state.gitdir, "index"))
            .pipe(Effect.catch(() => Effect.void))
          return yield* indexValid()
        })

        // Self-heal a missing/corrupt shadow index. Without this, one clobbered
        // write makes every later capture fail with `index file corrupt` and
        // `write-tree` return an empty hash forever.
        const healIndex = Effect.fnUntraced(function* () {
          if (yield* indexValid()) return
          yield* Effect.logWarning("snapshot git index invalid; rebuilding", {
            directory: state.directory,
            git: state.gitdir,
          })
          yield* remove(path.join(state.gitdir, "index"))
          const source = yield* sourceGitDir()
          if (source && (yield* seedIndex(source))) return
          // No reusable source index: rebuild the complete shadow index from the
          // worktree (tracked + untracked, honoring ignores).
          const result = yield* git([...cfg, ...args(["add", "--all", "--sparse", "--", "."])], {
            cwd: state.worktree,
          })
          if (result.code !== 0) {
            yield* Effect.logWarning("failed to rebuild snapshot index", {
              exitCode: result.code,
              stderr: result.stderr,
            })
          }
        })

        const add = Effect.fnUntraced(function* () {
          yield* sync()
          // The untracked set is a project-owned fact. When the canonical
          // inventory proves it covers the watcher domain, consume its
          // Git-authoritative set so repeated captures (and the other consumers
          // of the same inventory) share one project-wide enumeration. Tracked
          // deltas always come from `diff-files`, which is O(changes) and is the
          // only source that observes tracked edits under watcher-ignored
          // folders. Without the proof, fall back to Git directly.
          const fromInventory = yield* Effect.gen(function* () {
            const found = yield* inventory()
            if (!found) return undefined
            const diagnostics = yield* inventoryDiagnostics()
            if (diagnostics?.coverage !== "git" || !diagnostics.complete) return undefined
            return yield* found
              .untracked()
              .pipe(Effect.catch(() => Effect.succeed(undefined as readonly string[] | undefined)))
          })
          const [diff, other] = yield* Effect.all(
            [
              git([...quote, ...args(["diff-files", "--name-only", "-z", "--", "."])], {
                cwd: state.directory,
              }),
              fromInventory
                ? Effect.succeed({
                    code: ChildProcessSpawner.ExitCode(0),
                    text: encodeNulTerminatedPaths([...fromInventory]),
                    stderr: "",
                  } satisfies GitResult)
                : git([...quote, ...args(["ls-files", "--full-name", "--others", "--exclude-standard", "-z", "--", "."])], {
                    cwd: state.directory,
                  }),
            ],
            { concurrency: 2 },
          )
          if (diff.code !== 0 || other.code !== 0) {
            yield* Effect.logWarning("failed to list snapshot files", {
              diffCode: diff.code,
              diffStderr: diff.stderr,
              otherCode: other.code,
              otherStderr: other.stderr,
            })
            return
          }

          const tracked = diff.text.split("\0").filter(Boolean)
          const untracked = other.text.split("\0").filter(Boolean)
          const all = Array.from(new Set([...tracked, ...untracked]))
          if (!all.length) return

          // Resolve source-repo ignore rules against the exact candidate set.
          // --no-index keeps this pattern-based even when a path is already tracked.
          const ignored = yield* ignore(all)

          // Remove newly-ignored files from snapshot index to prevent re-adding
          if (ignored.size > 0) {
            const ignoredFiles = Array.from(ignored)
            yield* Effect.logInfo("removing gitignored files from snapshot", { count: ignoredFiles.length })
            yield* drop(ignoredFiles)
          }

          const allow = all.filter((item) => !ignored.has(item))
          if (!allow.length) return

          const large = new Set(
            (yield* Effect.all(
              allow.map((item) =>
                fs
                  .stat(path.join(state.worktree, item))
                  .pipe(Effect.catch(() => Effect.void))
                  .pipe(
                    Effect.map((stat) => {
                      if (!stat || stat.type !== "File") return
                      const size = typeof stat.size === "bigint" ? Number(stat.size) : stat.size
                      return size > limit ? item : undefined
                    }),
                  ),
              ),
              { concurrency: 8 },
            )).filter((item): item is string => Boolean(item)),
          )
          const block = new Set(untracked.filter((item) => large.has(item)))
          yield* sync(Array.from(block))
          // Stage only the allowed candidate paths so snapshot updates stay scoped.
          yield* stage(allow.filter((item) => !block.has(item)))
        })

        const cleanup = Effect.fnUntraced(function* () {
          return yield* locked(
            Effect.gen(function* () {
              if (!(yield* enabled())) return
              if (!(yield* exists(state.gitdir))) return
              yield* healIndex()
              const result = yield* git(args(["gc", `--prune=${prune}`]), { cwd: state.directory })
              if (result.code !== 0) {
                yield* Effect.logWarning("cleanup failed", {
                  exitCode: result.code,
                  stderr: result.stderr,
                })
                return
              }
              yield* Effect.logInfo("cleanup", { prune })
            }),
          )
        })

        const trackBody = Effect.fnUntraced(function* () {
          if (!(yield* enabled())) return
          const existed = yield* exists(state.gitdir)
          yield* fs.ensureDir(state.gitdir).pipe(Effect.orDie)
          if (!existed) {
            yield* git(["init"], {
              env: { GIT_DIR: state.gitdir, GIT_WORK_TREE: state.worktree },
            })
            yield* git(["--git-dir", state.gitdir, "config", "core.autocrlf", "false"])
            yield* git(["--git-dir", state.gitdir, "config", "core.longpaths", "true"])
            yield* git(["--git-dir", state.gitdir, "config", "core.symlinks", "true"])
            yield* git(["--git-dir", state.gitdir, "config", "core.fsmonitor", "false"])
            // Tuning for very large worktrees so the first add stays bounded.
            yield* git(["--git-dir", state.gitdir, "config", "feature.manyFiles", "true"])
            yield* git(["--git-dir", state.gitdir, "config", "index.version", "4"])
            yield* git(["--git-dir", state.gitdir, "config", "index.threads", "true"])
            yield* git(["--git-dir", state.gitdir, "config", "core.untrackedCache", "true"])
            yield* seed()
            yield* Effect.logInfo("initialized")
          }
          // A crashed or raced seed can leave a zeroed index; heal before use so
          // one bad write cannot poison every later capture.
          yield* healIndex()
          yield* add()
          const result = yield* git(args(["write-tree"]), { cwd: state.directory })
          const hash = result.text.trim()
          yield* Effect.logInfo("tracking", { hash, cwd: state.directory, git: state.gitdir })
          return hash
        })

        const track = Effect.fnUntraced(function* () {
          if (!(yield* enabled())) return

          // Tiny admission section: one in-flight capture per project revision.
          // Effect.cached is the repository-sanctioned single-flight primitive,
          // so sibling sessions that overlap one scan join it rather than
          // storing custom Deferred/Fiber state or queueing N scans behind the
          // Git mutex. Completed trees are retained only while the project
          // inventory proves coverage (see `completedReuse`); otherwise reuse is
          // limited to callers overlapping the in-flight capture.
          const shared = yield* SynchronizedRef.modifyEffect(
            materialization,
            Effect.fnUntraced(function* (current) {
              if (current.cached?.revision === current.revision) {
                return [current.cached.effect, { ...current, cacheHits: current.cacheHits + 1 }] as const
              }

              const revision = current.revision
              const token = {}
              const capture = yield* Effect.cached(
                TxReentrantLock.withWriteLock(
                  mutationBarrier,
                  locked(
                    Effect.gen(function* () {
                      yield* SynchronizedRef.update(materialization, (snapshot) => ({
                        ...snapshot,
                        captures: snapshot.captures + 1,
                      }))
                      const tree = yield* trackBody()

                      // Retain this memo only when the project inventory proves
                      // its domain is watcher-complete; never retain an
                      // undefined/failed capture. A watcher or mutation
                      // invalidation racing this capture bumps the revision, so a
                      // stale completion cannot be served as the current tree.
                      if (!(yield* completedReuse()) || !tree) {
                        yield* SynchronizedRef.update(materialization, (snapshot) =>
                          snapshot.cached?.token === token ? { ...snapshot, cached: undefined } : snapshot,
                        )
                      }
                      return tree
                    }),
                  ),
                ),
              )
              const cached: CachedCapture = { revision, token, effect: capture }
              return [capture, { ...current, cached }] as const
            }),
          )
          return yield* shared
        })

        const withMutation: Interface["withMutation"] = <A, E, R>(effect: Effect.Effect<A, E, R>, reason?: string) =>
          TxReentrantLock.withReadLock(
            mutationBarrier,
            Effect.gen(function* () {
              yield* invalidate(reason ? `${reason}:begin` : "mutation:begin")
              return yield* effect.pipe(
                Effect.ensuring(invalidate(reason ? `${reason}:end` : "mutation:end")),
              )
            }),
          )

        const diagnostics = Effect.fnUntraced(function* () {
          const current = yield* SynchronizedRef.get(materialization)
          return {
            revision: current.revision,
            captures: current.captures,
            cacheHits: current.cacheHits,
            invalidations: current.invalidations,
            completedReuse: yield* completedReuse(),
            watcherOwnedRoot: watcherOwnedRoot(),
          } satisfies Diagnostics
        })

        const patch = Effect.fnUntraced(function* (hash: string, to?: string) {
          return yield* locked(
            Effect.gen(function* () {
              // `to` came from track(), so immutable tree-to-tree comparison is
              // exact and avoids repeating the worktree/index refresh that just
              // produced that tree.
              if (!to) yield* add()
              const result = yield* git(
                [
                  ...quote,
                  ...args([
                    "diff",
                    ...(to ? [hash, to] : ["--cached", hash]),
                    "--no-ext-diff",
                    "--name-only",
                    "--",
                    ".",
                  ]),
                ],
                {
                  cwd: state.directory,
                },
              )
              if (result.code !== 0) {
                yield* Effect.logWarning("failed to get diff", { hash, exitCode: result.code })
                return { hash, files: [] }
              }
              const files = result.text
                .trim()
                .split("\n")
                .map((x) => x.trim())
                .filter(Boolean)

              // Hide ignored-file removals from the user-facing patch output.
              const ignored = yield* ignore(files)

              return {
                hash,
                files: files
                  .filter((item) => !ignored.has(item))
                  .map((x) => path.join(state.worktree, x).replaceAll("\\", "/")),
              }
            }),
          )
        })

        const restore = Effect.fnUntraced(function* (snapshot: string) {
          return yield* withMutation(locked(
            Effect.gen(function* () {
              yield* Effect.logInfo("restore", { commit: snapshot })
              const result = yield* git([...core, ...args(["read-tree", snapshot])], { cwd: state.worktree })
              if (result.code === 0) {
                const checkout = yield* git([...core, ...args(["checkout-index", "-a", "-f"])], {
                  cwd: state.worktree,
                })
                if (checkout.code === 0) return
                yield* Effect.logError("failed to restore snapshot", {
                  snapshot,
                  exitCode: checkout.code,
                  stderr: checkout.stderr,
                })
                return
              }
              yield* Effect.logError("failed to restore snapshot", {
                snapshot,
                exitCode: result.code,
                stderr: result.stderr,
              })
            }),
          ), "snapshot.restore")
        })

        const revert = Effect.fnUntraced(function* (patches: Patch[]) {
          return yield* withMutation(locked(
            Effect.gen(function* () {
              const ops: { hash: string; file: string; rel: string }[] = []
              const seen = new Set<string>()
              for (const item of patches) {
                for (const file of item.files) {
                  if (seen.has(file)) continue
                  seen.add(file)
                  ops.push({
                    hash: item.hash,
                    file,
                    rel: path.relative(state.worktree, file).replaceAll("\\", "/"),
                  })
                }
              }

              const single = Effect.fnUntraced(function* (op: (typeof ops)[number]) {
                yield* Effect.logInfo("reverting", { file: op.file, hash: op.hash })
                const result = yield* git([...core, ...args(["checkout", op.hash, "--", op.file])], {
                  cwd: state.worktree,
                })
                if (result.code === 0) return
                const tree = yield* git([...core, ...args(["ls-tree", op.hash, "--", op.rel])], {
                  cwd: state.worktree,
                })
                if (tree.code === 0 && tree.text.trim()) {
                  yield* Effect.logInfo("file existed in snapshot but checkout failed, keeping", {
                    file: op.file,
                    hash: op.hash,
                  })
                  return
                }
                yield* Effect.logInfo("file did not exist in snapshot, deleting", { file: op.file, hash: op.hash })
                yield* remove(op.file)
              })

              const clash = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)

              for (let i = 0; i < ops.length; ) {
                const first = ops[i]!
                const run = [first]
                let j = i + 1
                // Only batch adjacent files when their paths cannot affect each other.
                while (j < ops.length && run.length < 100) {
                  const next = ops[j]!
                  if (next.hash !== first.hash) break
                  if (run.some((item) => clash(item.rel, next.rel))) break
                  run.push(next)
                  j += 1
                }

                if (run.length === 1) {
                  yield* single(first)
                  i = j
                  continue
                }

                const tree = yield* git(
                  [...core, ...args(["ls-tree", "--name-only", first.hash, "--", ...run.map((item) => item.rel)])],
                  {
                    cwd: state.worktree,
                  },
                )

                if (tree.code !== 0) {
                  yield* Effect.logInfo("batched ls-tree failed, falling back to single-file revert", {
                    hash: first.hash,
                    files: run.length,
                  })
                  for (const op of run) {
                    yield* single(op)
                  }
                  i = j
                  continue
                }

                const have = new Set(
                  tree.text
                    .trim()
                    .split("\n")
                    .map((item) => item.trim())
                    .filter(Boolean),
                )
                const list = run.filter((item) => have.has(item.rel))
                if (list.length) {
                  yield* Effect.logInfo("reverting", { hash: first.hash, files: list.length })
                  const result = yield* git(
                    [...core, ...args(["checkout", first.hash, "--", ...list.map((item) => item.file)])],
                    {
                      cwd: state.worktree,
                    },
                  )
                  if (result.code !== 0) {
                    yield* Effect.logInfo("batched checkout failed, falling back to single-file revert", {
                      hash: first.hash,
                      files: list.length,
                    })
                    for (const op of run) {
                      yield* single(op)
                    }
                    i = j
                    continue
                  }
                }

                for (const op of run) {
                  if (have.has(op.rel)) continue
                  yield* Effect.logInfo("file did not exist in snapshot, deleting", { file: op.file, hash: op.hash })
                  yield* remove(op.file)
                }

                i = j
              }
            }),
          ), "snapshot.revert")
        })

        const diff = Effect.fnUntraced(function* (hash: string) {
          return yield* locked(
            Effect.gen(function* () {
              yield* add()
              const result = yield* git([...quote, ...args(["diff", "--cached", "--no-ext-diff", hash, "--", "."])], {
                cwd: state.worktree,
              })
              if (result.code !== 0) {
                yield* Effect.logWarning("failed to get diff", {
                  hash,
                  exitCode: result.code,
                  stderr: result.stderr,
                })
                return ""
              }
              return result.text.trim()
            }),
          )
        })

        const diffFull = Effect.fnUntraced(function* (from: string, to: string) {
          return yield* locked(
            Effect.gen(function* () {
              type Row = {
                file: string
                status: "added" | "deleted" | "modified"
                binary: boolean
                additions: number
                deletions: number
              }

              type Ref = {
                file: string
                side: "before" | "after"
                ref: string
              }

              const show = Effect.fnUntraced(function* (row: Row) {
                if (row.binary) return ["", ""]
                if (row.status === "added") {
                  return [
                    "",
                    yield* git([...cfg, ...args(["show", `${to}:${row.file}`])]).pipe(Effect.map((item) => item.text)),
                  ]
                }
                if (row.status === "deleted") {
                  return [
                    yield* git([...cfg, ...args(["show", `${from}:${row.file}`])]).pipe(
                      Effect.map((item) => item.text),
                    ),
                    "",
                  ]
                }
                return yield* Effect.all(
                  [
                    git([...cfg, ...args(["show", `${from}:${row.file}`])]).pipe(Effect.map((item) => item.text)),
                    git([...cfg, ...args(["show", `${to}:${row.file}`])]).pipe(Effect.map((item) => item.text)),
                  ],
                  { concurrency: 2 },
                )
              })

              const load = Effect.fnUntraced(
                function* (rows: Row[]) {
                  const refs = rows.flatMap((row) => {
                    if (row.binary) return []
                    if (row.status === "added")
                      return [{ file: row.file, side: "after", ref: `${to}:${row.file}` } satisfies Ref]
                    if (row.status === "deleted") {
                      return [{ file: row.file, side: "before", ref: `${from}:${row.file}` } satisfies Ref]
                    }
                    return [
                      { file: row.file, side: "before", ref: `${from}:${row.file}` } satisfies Ref,
                      { file: row.file, side: "after", ref: `${to}:${row.file}` } satisfies Ref,
                    ]
                  })
                  if (!refs.length) return new Map<string, { before: string; after: string }>()

                  const batch = yield* appProcess.run(
                    ChildProcess.make("git", [...cfg, ...args(["cat-file", "--batch"])], {
                      cwd: state.directory,
                      extendEnv: true,
                    }),
                    { stdin: refs.map((item) => item.ref).join("\n") + "\n" },
                  )
                  if (batch.exitCode !== 0) {
                    yield* Effect.logInfo(
                      "git cat-file --batch failed during snapshot diff, falling back to per-file git show",
                      {
                        stderr: batch.stderr.toString("utf8"),
                        refs: refs.length,
                      },
                    )
                    return
                  }
                  const out = batch.stdout

                  const fail = (msg: string, extra?: Record<string, string>) => {
                    return undefined
                  }

                  const map = new Map<string, { before: string; after: string }>()
                  const dec = new TextDecoder()
                  let i = 0
                  for (const ref of refs) {
                    let end = i
                    while (end < out.length && out[end] !== 10) end += 1
                    if (end >= out.length) {
                      return fail(
                        "git cat-file --batch returned a truncated header during snapshot diff, falling back to per-file git show",
                      )
                    }

                    const head = dec.decode(out.slice(i, end))
                    i = end + 1
                    const hit = map.get(ref.file) ?? { before: "", after: "" }
                    if (head.endsWith(" missing")) {
                      map.set(ref.file, hit)
                      continue
                    }

                    const match = head.match(/^[0-9a-f]+ blob (\d+)$/)
                    if (!match) {
                      return fail(
                        "git cat-file --batch returned an unexpected header during snapshot diff, falling back to per-file git show",
                        { head },
                      )
                    }

                    const size = Number(match[1])
                    if (!Number.isInteger(size) || size < 0 || i + size >= out.length || out[i + size] !== 10) {
                      return fail(
                        "git cat-file --batch returned truncated content during snapshot diff, falling back to per-file git show",
                        { head },
                      )
                    }

                    const text = dec.decode(out.slice(i, i + size))
                    if (ref.side === "before") hit.before = text
                    if (ref.side === "after") hit.after = text
                    map.set(ref.file, hit)
                    i += size + 1
                  }

                  if (i !== out.length) {
                    return fail(
                      "git cat-file --batch returned trailing data during snapshot diff, falling back to per-file git show",
                    )
                  }

                  return map
                },
                Effect.scoped,
                Effect.catch(() =>
                  Effect.succeed<Map<string, { before: string; after: string }> | undefined>(undefined),
                ),
              )

              const result: FileDiff[] = []
              const status = new Map<string, "added" | "deleted" | "modified">()

              const statuses = yield* git(
                [...quote, ...args(["diff", "--no-ext-diff", "--name-status", "--no-renames", from, to, "--", "."])],
                { cwd: state.directory },
              )

              for (const line of statuses.text.trim().split("\n")) {
                if (!line) continue
                const [code, file] = line.split("\t")
                if (!code || !file) continue
                status.set(file, code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified")
              }

              const numstat = yield* git(
                [...quote, ...args(["diff", "--no-ext-diff", "--no-renames", "--numstat", from, to, "--", "."])],
                {
                  cwd: state.directory,
                },
              )

              const rows = numstat.text
                .trim()
                .split("\n")
                .filter(Boolean)
                .flatMap((line) => {
                  const [adds, dels, file] = line.split("\t")
                  if (!file) return []
                  const binary = adds === "-" && dels === "-"
                  const additions = binary ? 0 : parseInt(adds)
                  const deletions = binary ? 0 : parseInt(dels)
                  return [
                    {
                      file,
                      status: status.get(file) ?? "modified",
                      binary,
                      additions: Number.isFinite(additions) ? additions : 0,
                      deletions: Number.isFinite(deletions) ? deletions : 0,
                    } satisfies Row,
                  ]
                })

              // Hide ignored-file removals from the user-facing diff output.
              const ignored = yield* ignore(rows.map((r) => r.file))
              if (ignored.size > 0) {
                const filtered = rows.filter((r) => !ignored.has(r.file))
                rows.length = 0
                rows.push(...filtered)
              }

              const step = 100
              const patch = (file: string, before: string, after: string) =>
                formatPatch(structuredPatch(file, file, before, after, "", "", { context: Number.MAX_SAFE_INTEGER }))

              for (let i = 0; i < rows.length; i += step) {
                const run = rows.slice(i, i + step)
                const text = yield* load(run)

                for (const row of run) {
                  const hit = text?.get(row.file) ?? { before: "", after: "" }
                  const [before, after] = row.binary ? ["", ""] : text ? [hit.before, hit.after] : yield* show(row)
                  result.push({
                    file: row.file,
                    patch: row.binary ? "" : patch(row.file, before, after),
                    additions: row.additions,
                    deletions: row.deletions,
                    status: row.status,
                  })
                }
              }

              return result
            }),
          )
        })

        yield* cleanup().pipe(
          Effect.catchCause((cause) => Effect.logError("cleanup loop failed", { cause: Cause.pretty(cause) })),
          Effect.repeat(Schedule.spaced(Duration.hours(1))),
          Effect.delay(Duration.minutes(1)),
          Effect.forkScoped,
        )

        return { cleanup, track, invalidate, withMutation, diagnostics, patch, restore, revert, diff, diffFull }
      }),
    )

    return Service.of({
      init: Effect.fn("Snapshot.init")(function* () {
        yield* InstanceState.get(state)
      }),
      cleanup: Effect.fn("Snapshot.cleanup")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.cleanup())
      }),
      track: Effect.fn("Snapshot.track")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.track())
      }),
      invalidate: Effect.fn("Snapshot.invalidate")(function* (reason?: string) {
        return yield* InstanceState.useEffect(state, (s) => s.invalidate(reason))
      }),
      withMutation: <A, E, R>(effect: Effect.Effect<A, E, R>, reason?: string) =>
        InstanceState.useEffect(state, (s) => s.withMutation(effect, reason)),
      diagnostics: Effect.fn("Snapshot.diagnostics")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.diagnostics())
      }),
      patch: Effect.fn("Snapshot.patch")(function* (hash: string, to?: string) {
        return yield* InstanceState.useEffect(state, (s) => s.patch(hash, to))
      }),
      restore: Effect.fn("Snapshot.restore")(function* (snapshot: string) {
        return yield* InstanceState.useEffect(state, (s) => s.restore(snapshot))
      }),
      revert: Effect.fn("Snapshot.revert")(function* (patches: Patch[]) {
        return yield* InstanceState.useEffect(state, (s) => s.revert(patches))
      }),
      diff: Effect.fn("Snapshot.diff")(function* (hash: string) {
        return yield* InstanceState.useEffect(state, (s) => s.diff(hash))
      }),
      diffFull: Effect.fn("Snapshot.diffFull")(function* (from: string, to: string) {
        return yield* InstanceState.useEffect(state, (s) => s.diffFull(from, to))
      }),
    })
  }),
)

// Concrete fallback node for the canonical location map. Node identity is the
// service key, so the server's canonical map replaces this by name at the app
// boundary (see server.ts). Tests that compile this node directly still get a
// working (lazily-built) map.
const locationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, AppProcess.node, Config.node, EventV2Bridge.node, locationServiceMapNode],
})

export * as Snapshot from "."
