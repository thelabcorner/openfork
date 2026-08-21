export * as Snapshot from "./snapshot"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Config } from "./config"
import { File } from "./file"
import { FSUtil } from "./fs-util"
import { Git } from "./git"
import { Global } from "./global"
import { Location } from "./location"
import { AppProcess } from "./process"
import { AbsolutePath, RelativePath } from "./schema"
import { Hash } from "./util/hash"

export const ID = Schema.String.pipe(Schema.brand("Snapshot.ID"))
export type ID = typeof ID.Type

export class Error extends Schema.TaggedErrorClass<Error>()("Snapshot.Error", {
  operation: Schema.Literals(["capture", "files", "diff", "preview", "restore"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface CompareInput {
  readonly from: ID
  readonly to: ID
}

export interface DiffInput extends CompareInput {
  readonly context?: number
  readonly paths?: readonly RelativePath[]
}

export interface RestoreInput {
  /** Paths are relative to the project root. */
  readonly files: ReadonlyMap<RelativePath, ID>
}

export interface PreviewInput extends RestoreInput {
  readonly context?: number
}

export interface Interface {
  /**
   * Capture the current Location-scoped filesystem state as a content-addressed
   * tree. Returns `undefined` when snapshots are disabled, unsupported, or the
   * best-effort capture fails.
   */
  readonly capture: () => Effect.Effect<ID | undefined>

  /**
   * List project-relative paths changed between two captured trees without
   * loading file contents or generating patches.
   */
  readonly files: (input: CompareInput) => Effect.Effect<readonly RelativePath[], Error>

  /**
   * Generate structured per-file diffs between two captured trees. `context`
   * controls unchanged lines around each unified diff hunk.
   */
  readonly diff: (input: DiffInput) => Effect.Effect<readonly File.Diff[], Error>

  /**
   * Preview the filesystem result of a selective restore without modifying the
   * worktree. Each project-relative path maps to the tree it would be restored
   * from.
   */
  readonly preview: (input: PreviewInput) => Effect.Effect<readonly File.Diff[], Error>

  /**
   * Restore selected project-relative paths from their associated trees. A path
   * absent from its selected tree is removed; paths outside the map are untouched.
   */
  readonly restore: (input: RestoreInput) => Effect.Effect<void, Error>

  /**
   * Replace the snapshot index with a captured tree and check out all its entries.
   * Files absent from the tree remain untouched. Prefer selective `restore` when
   * only known paths should change.
   */
  readonly checkout: (snapshot: ID) => Effect.Effect<void, Error>

  /**
   * Pin a captured tree object inside the shadow repository so it survives
   * `Snapshot.cleanup()` GC pruning (which runs `git gc --prune=7.days`). A
   * detached commit is created from the tree and referenced under
   * `refs/opencode/retained/<hash>`; the ref keeps the object reachable. Idempotent.
   */
  readonly retain: (hash: ID) => Effect.Effect<void, any>

  /**
   * Drop the pin created by `retain` for a tree object. Safe to call when no pin
   * exists.
   */
  readonly release: (hash: ID) => Effect.Effect<void, any>

  /**
   * Stable identity of the snapshot store for the current project + worktree.
   * Checkpoints captured against a different epoch (e.g. worktree recreated,
   * path reused, repository replaced) must not be diffed or restored.
   */
  readonly epoch: () => Effect.Effect<string, any>

  /**
   * Best-effort list of files that were excluded from the `to` snapshot because
   * they exceeded the snapshot size limit (new untracked files larger than 2 MiB).
   * Used to surface `partial` checkpoint status. Detection is worktree-based and
   * approximate: it reports oversized worktree files absent from the `to` tree.
   */
  readonly excludedFiles: (input: CompareInput) => Effect.Effect<readonly ExcludedFile[], any>
}

export interface ExcludedFile {
  readonly path: RelativePath
  readonly reason: string
  readonly size?: number
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Snapshot") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const appProcess = yield* AppProcess.Service
    const source = yield* git.repo.discover(location.project.directory)
    const worktree = source
      ? AbsolutePath.make(yield* fs.realPath(source.worktree).pipe(Effect.orDie))
      : location.project.directory
    const gitDirectory = AbsolutePath.make(path.join(global.data, "snapshot", location.project.id, Hash.fast(worktree)))

    const scope = Effect.fnUntraced(function* () {
      const relative = path.relative(worktree, location.directory)
      if (relative.startsWith("..") || path.isAbsolute(relative))
        return yield* new Error({ operation: "capture", message: "Location is outside the project" })
      return RelativePath.make(relative.replaceAll("\\", "/") || ".")
    })

    const repository = Effect.fnUntraced(function* () {
      if (!source) return yield* new Error({ operation: "capture", message: "Project is not a Git repository" })
      if (yield* fs.existsSafe(path.join(gitDirectory, "HEAD")))
        return new Git.Repository({
          worktree,
          gitDirectory,
          commonDirectory: gitDirectory,
        })
      return yield* git.repo
        .create({
          worktree,
          gitDirectory,
          seed: source,
        })
        .pipe(Effect.mapError((cause) => failure("capture", cause)))
    })

    const enabled = Effect.fnUntraced(function* () {
      if (location.vcs?.type !== "git") return false
      return Config.latest(yield* config.entries(), "snapshots") !== false
    })

    const capture = Effect.fn("Snapshot.capture")(function* () {
      if (!(yield* enabled())) return undefined
      return yield* Effect.gen(function* () {
        const repo = yield* repository()
        return ID.make(
          yield* git.tree.capture({
            repository: repo,
            scopes: [yield* scope()],
            ignores: source,
            maximumUntrackedFileBytes: 2 * 1024 * 1024,
          }),
        )
      }).pipe(
        Effect.catch((cause) => Effect.logWarning("failed to capture snapshot", { cause }).pipe(Effect.as(undefined))),
      )
    })

    const compare = Effect.fnUntraced(function* (operation: "files" | "diff", input: CompareInput) {
      const repo = yield* repository().pipe(Effect.mapError((cause) => failure(operation, cause)))
      return { repository: repo, from: Git.TreeID.make(input.from), to: Git.TreeID.make(input.to) }
    })

    const files = Effect.fn("Snapshot.files")(function* (input: CompareInput) {
      const comparison = yield* compare("files", input)
      const files = yield* git.tree.files(comparison).pipe(Effect.mapError((cause) => failure("files", cause)))
      if (!source) return files
      const ignored = yield* git.index
        .ignored({ repository: source, paths: files })
        .pipe(Effect.mapError((cause) => failure("files", cause)))
      return files.filter((file) => !ignored.has(file))
    })

    const diff = Effect.fn("Snapshot.diff")(function* (input: DiffInput) {
      const comparison = yield* compare("diff", input)
      const files = yield* git.tree.files(comparison).pipe(Effect.mapError((cause) => failure("diff", cause)))
      const ignored = source
        ? yield* git.index
            .ignored({ repository: source, paths: files })
            .pipe(Effect.mapError((cause) => failure("diff", cause)))
        : new Set<RelativePath>()
      return yield* git.tree
        .diff({
          ...comparison,
          context: input.context,
          paths: (input.paths ?? files).filter((file) => !ignored.has(file)),
        })
        .pipe(Effect.mapError((cause) => failure("diff", cause)))
    })

    const plan = Effect.fnUntraced(function* (operation: "preview" | "restore", input: RestoreInput) {
      const files = new Map<RelativePath, Git.TreeID>()
      for (const [file, snapshot] of input.files) {
        const absolute = path.resolve(worktree, file)
        if (!FSUtil.contains(worktree, absolute))
          return yield* new Error({ operation, message: `Path escapes the project: ${file}` })
        files.set(file, Git.TreeID.make(snapshot))
      }
      return files
    })

    const preview = Effect.fn("Snapshot.preview")(function* (input: PreviewInput) {
      if (!(yield* enabled())) return yield* new Error({ operation: "preview", message: "Snapshots are disabled" })
      const repo = yield* repository().pipe(Effect.mapError((cause) => failure("preview", cause)))
      const files = yield* plan("preview", input)
      const current = yield* git.tree
        .capture({
          repository: repo,
          scopes: Array.from(files.keys()),
          ignores: source,
          maximumUntrackedFileBytes: 2 * 1024 * 1024,
        })
        .pipe(Effect.mapError((cause) => failure("preview", cause)))
      return yield* git.tree
        .preview({
          repository: repo,
          current,
          files,
          context: input.context,
        })
        .pipe(Effect.mapError((cause) => failure("preview", cause)))
    })

    const restore = Effect.fn("Snapshot.restore")(function* (input: RestoreInput) {
      if (!(yield* enabled())) return yield* new Error({ operation: "restore", message: "Snapshots are disabled" })
      const repo = yield* repository().pipe(Effect.mapError((cause) => failure("restore", cause)))
      yield* git.tree
        .restore({ repository: repo, files: yield* plan("restore", input) })
        .pipe(Effect.mapError((cause) => failure("restore", cause)))
    })

    const checkout = Effect.fn("Snapshot.checkout")(function* (snapshot: ID) {
      const repo = yield* repository().pipe(Effect.mapError((cause) => failure("restore", cause)))
      yield* git.tree
        .checkout({ repository: repo, tree: Git.TreeID.make(snapshot) })
        .pipe(Effect.mapError((cause) => failure("restore", cause)))
    })

    const epoch = Effect.fnUntraced(function* () {
      return Hash.fast(`${location.project.id}:${worktree}`)
    })

    const retain = Effect.fn("Snapshot.retain")(function* (hash: ID) {
      if (!(yield* enabled())) return
      const repo = yield* repository().pipe(Effect.mapError((cause) => failure("capture", cause)))
      const ref = `refs/opencode/retained/${hash}`
      const commit = yield* appProcess
        .run(
          ChildProcess.make("git", ["--git-dir", repo.gitDirectory, "--work-tree", repo.worktree, "commit-tree", hash, "-m", `opencode retain ${hash}`]),
          { stdin: "ignore" },
        )
        .pipe(Effect.mapError((cause) => new Error({ operation: "capture", message: `failed to retain ${hash}`, cause })))
      if (commit.exitCode !== 0)
        return yield* new Error({
          operation: "capture",
          message: `commit-tree failed for ${hash}: ${commit.stderr.toString("utf8").trim()}`,
        })
      const update = yield* appProcess
        .run(
          ChildProcess.make("git", ["--git-dir", repo.gitDirectory, "update-ref", ref, commit.stdout.toString("utf8").trim()]),
          { stdin: "ignore" },
        )
        .pipe(Effect.mapError((cause) => new Error({ operation: "capture", message: `failed to pin ${ref}`, cause })))
      if (update.exitCode !== 0)
        return yield* new Error({
          operation: "capture",
          message: `update-ref failed for ${ref}: ${update.stderr.toString("utf8").trim()}`,
        })
    })

    const release = Effect.fn("Snapshot.release")(function* (hash: ID) {
      if (!(yield* enabled())) return
      const repo = yield* repository().pipe(Effect.mapError((cause) => failure("capture", cause)))
      const ref = `refs/opencode/retained/${hash}`
      yield* appProcess
        .run(ChildProcess.make("git", ["--git-dir", repo.gitDirectory, "update-ref", "-d", ref]), { stdin: "ignore" })
        .pipe(Effect.catch(() => Effect.void))
    })

    const excludedFiles = Effect.fn("Snapshot.excludedFiles")(function* (input: CompareInput) {
      if (!(yield* enabled())) return []
      const repo = yield* repository().pipe(Effect.mapError((cause) => failure("files", cause)))
      const toTree = Git.TreeID.make(input.to)
      const inTo = new Set(yield* git.tree.files({ repository: repo, from: toTree, to: toTree }))
      const list = (args: string[]) =>
        appProcess.run(
          ChildProcess.make("git", ["--git-dir", repo.gitDirectory, "--work-tree", repo.worktree, ...args]),
          { stdin: "ignore" },
        )
      const [untracked, modified] = yield* Effect.all(
        [
          list(["ls-files", "--others", "--exclude-standard", "-z"]).pipe(Effect.map((r) => r.stdout.toString("utf8"))),
          list(["diff-files", "--name-only", "-z"]).pipe(Effect.map((r) => r.stdout.toString("utf8"))),
        ],
        { concurrency: 2 },
      )
      const candidates = Array.from(new Set([...untracked, ...modified].join("\0").split("\0").filter(Boolean)))
      if (!candidates.length) return []
      const excluded = yield* Effect.forEach(
        candidates,
        (file): Effect.Effect<ExcludedFile | undefined> =>
          Effect.gen(function* () {
            if (inTo.has(RelativePath.make(file))) return undefined
            const info = yield* fs.stat(path.resolve(repo.worktree, file)).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!info || info.type !== "File") return undefined
            const size = typeof info.size === "bigint" ? Number(info.size) : info.size
            if (size > 2 * 1024 * 1024) return { path: RelativePath.make(file), reason: "new-file-too-large", size }
            return undefined
          }),
        { concurrency: 8 },
      )
      return excluded.filter((item) => item !== undefined) as unknown as readonly ExcludedFile[]
    })

    return Service.of({ capture, files, diff, preview, restore, checkout, retain, release, epoch, excludedFiles })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(Config.locationLayer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, FSUtil.node, Git.node, Global.node, Location.node, AppProcess.node],
})

export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    capture: () => Effect.succeed(undefined),
    files: () => Effect.succeed([]),
    diff: () => Effect.succeed([]),
    preview: () => Effect.succeed([]),
    restore: () => Effect.void,
    checkout: () => Effect.void,
    retain: () => Effect.void as any,
    release: () => Effect.void as any,
    epoch: () => Effect.succeed("noop") as any,
    excludedFiles: () => Effect.succeed([]) as any,
  }),
)

function failure(operation: Error["operation"], cause: unknown) {
  if (cause instanceof Error && cause.operation === operation) return cause
  return new Error({
    operation,
    message: cause instanceof globalThis.Error ? cause.message : String(cause),
    cause,
  })
}

/** Legacy persisted session diff shape. */
export type LegacyFileDiff = {
  file?: string
  patch?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}
