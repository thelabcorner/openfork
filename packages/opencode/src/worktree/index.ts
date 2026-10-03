import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { path } from "@opencode-ai/core/effect/app-node-platform"
import { Global } from "@opencode-ai/core/global"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Database } from "@opencode-ai/core/database/database"
import { eq } from "drizzle-orm"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import type { ProjectV2 } from "@opencode-ai/core/project"
import { Slug } from "@opencode-ai/core/util/slug"
import { errorMessage } from "../util/error"
import { GlobalBus } from "@/bus/global"
import { Git } from "@/git"
import { Effect, Layer, Path, Schema, Scope, Context, Option } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AppProcess } from "@opencode-ai/core/process"
import { InstanceState } from "@/effect/instance-state"
import { WorktreeEvent } from "@opencode-ai/schema/worktree-event"
import { ManagedWorktreeBridge } from "./managed/bridge"
import type { ManagedCreateInitializeInput } from "./managed/request"

export const Event = WorktreeEvent

export const Info = Schema.Struct({
  name: Schema.String,
  branch: Schema.optional(Schema.String),
  directory: Schema.String,
}).annotate({ identifier: "Worktree" })
export type Info = Schema.Schema.Type<typeof Info>

export const CreateInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  startCommand: Schema.optional(
    Schema.String.annotate({ description: "Additional startup script to run after the project's start command" }),
  ),
}).annotate({ identifier: "WorktreeCreateInput" })
export type CreateInput = Schema.Schema.Type<typeof CreateInput>

export const RemoveInput = Schema.Struct({
  directory: Schema.String,
}).annotate({ identifier: "WorktreeRemoveInput" })
export type RemoveInput = Schema.Schema.Type<typeof RemoveInput>

export const ResetInput = Schema.Struct({
  directory: Schema.String,
}).annotate({ identifier: "WorktreeResetInput" })
export type ResetInput = Schema.Schema.Type<typeof ResetInput>

export class NotGitError extends Schema.TaggedErrorClass<NotGitError>()("WorktreeNotGitError", {
  message: Schema.String,
}) {}

export class NameGenerationFailedError extends Schema.TaggedErrorClass<NameGenerationFailedError>()(
  "WorktreeNameGenerationFailedError",
  {
    message: Schema.String,
  },
) {}

export class CreateFailedError extends Schema.TaggedErrorClass<CreateFailedError>()("WorktreeCreateFailedError", {
  message: Schema.String,
}) {}

/**
 * A managed creation attempt began and did not complete with an exact activated
 * binding. This is never a fallback signal: the caller explicitly opted into the
 * managed path, so a failed or ambiguous managed outcome is surfaced as a hard
 * failure while the durable binding keeps its recorded
 * `reconcile_required`/`quarantined` state.
 */
export class ManagedCreateFailedError extends Schema.TaggedErrorClass<ManagedCreateFailedError>()(
  "WorktreeManagedCreateFailedError",
  {
    reason: Schema.String,
    message: Schema.String,
  },
) {}

export class StartCommandFailedError extends Schema.TaggedErrorClass<StartCommandFailedError>()(
  "WorktreeStartCommandFailedError",
  {
    message: Schema.String,
  },
) {}

export class RemoveFailedError extends Schema.TaggedErrorClass<RemoveFailedError>()("WorktreeRemoveFailedError", {
  message: Schema.String,
}) {}

export class ResetFailedError extends Schema.TaggedErrorClass<ResetFailedError>()("WorktreeResetFailedError", {
  message: Schema.String,
}) {}

export class ListFailedError extends Schema.TaggedErrorClass<ListFailedError>()("WorktreeListFailedError", {
  message: Schema.String,
}) {}

export type Error =
  | NotGitError
  | NameGenerationFailedError
  | CreateFailedError
  | StartCommandFailedError
  | RemoveFailedError
  | ResetFailedError
  | ListFailedError
  | ManagedCreateFailedError

/**
 * Explicit caller opt-in for the managed worktree path (G5 seam).
 *
 * Supplying this object is the only way `create` may attempt managed creation;
 * omitting it keeps the historical unmanaged behavior. The caller owns every
 * product fact (worktree-store identity, storage policy, helper paths); this
 * seam invents none of it. `targetPath` and `branchName` default to the
 * computed unmanaged candidate when omitted.
 *
 * The managed path is additionally gated on readiness: it runs only when the
 * `ManagedWorktreeBridge` service is provided to the caller's layer and its
 * activation resolves ready (packaged sidecar, wired fence adapter, discovery
 * directory, control-plane root, per-launch fence config). An unavailable
 * readiness falls back to the unmanaged path. Once the managed attempt has
 * begun, every failure or ambiguous outcome throws and never falls back.
 */
export interface ManagedCreateOptions {
  /** Explicit readiness inputs; omitted fields resolve from the environment. */
  readonly activation?: ManagedWorktreeBridge.ActivationOptions
  /** Exact managed request facts. `targetPath`/`branchName` default to the candidate. */
  readonly request: {
    readonly worktreeId: string
    readonly repositoryId: string
    readonly repositoryPath?: string
    readonly storageVolumeId: string
    readonly commitish: string
    readonly storagePolicy: ManagedCreateInitializeInput["storagePolicy"]
    readonly storageProbe: ManagedCreateInitializeInput["storageProbe"]
    readonly dedupe: ManagedCreateInitializeInput["dedupe"]
    readonly targetPath?: string
    readonly branchName?: string
  }
  /** Durable binding identity supplied by the caller. */
  readonly binding: {
    readonly installationId: string
    readonly projectId: string
    readonly workspaceId?: string | null
  }
}

/**
 * Readiness-only activation reasons. Each one is positively proven before any
 * durable intent, manager invocation, or physical side effect, so the caller
 * may keep the historical unmanaged path. Any other reason — including a future
 * one — fails closed instead.
 */
const FALLBACK_ACTIVATION_REASONS: ReadonlySet<ManagedWorktreeBridge.ActivationReason> = new Set([
  "capability-unavailable",
  "fence-adapter-not-wired",
  "discovery-directory-missing",
  "control-plane-root-missing",
  "fence-config-unavailable",
])

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}

function failedRemoves(...chunks: string[]) {
  return chunks.filter(Boolean).flatMap((chunk) =>
    chunk
      .split("\n")
      .map((line) => line.trim())
      .flatMap((line) => {
        const match = line.match(/^warning:\s+failed to remove\s+(.+):\s+/i)
        if (!match) return []
        const value = match[1]?.trim().replace(/^['"]|['"]$/g, "")
        if (!value) return []
        return [value]
      }),
  )
}

// ---------------------------------------------------------------------------
// Effect service
// ---------------------------------------------------------------------------

export interface Interface {
  readonly makeWorktreeInfo: (options?: { name?: string; detached?: boolean }) => Effect.Effect<Info, Error>
  readonly createFromInfo: (info: Info, startCommand?: string) => Effect.Effect<void, Error>
  readonly create: (input?: CreateInput, managed?: ManagedCreateOptions) => Effect.Effect<Info, Error>
  readonly list: () => Effect.Effect<(Omit<Info, "branch"> & { branch?: string })[], Error>
  readonly remove: (input: RemoveInput) => Effect.Effect<boolean, Error>
  readonly reset: (input: ResetInput) => Effect.Effect<boolean, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Worktree") {}

type GitResult = { code: number; text: string; stderr: string }

const layer: Layer.Layer<
  Service,
  never,
  | FSUtil.Service
  | Path.Path
  | AppProcess.Service
  | Git.Service
  | Project.Service
  | InstanceStore.Service
  | Database.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const fs = yield* FSUtil.Service
    const pathSvc = yield* Path.Path
    const appProcess = yield* AppProcess.Service
    const { db } = yield* Database.Service
    const gitSvc = yield* Git.Service
    const project = yield* Project.Service
    const store = yield* InstanceStore.Service

    const git = Effect.fnUntraced(function* (args: string[], opts: { cwd: string }) {
      // Worktree materialization must use the shared Git service. A private
      // raw-Git path here previously bypassed its deterministic checkout
      // policy and let Git for Windows inherit system core.autocrlf=true.
      const result = yield* gitSvc.run(args, { cwd: opts.cwd })
      return {
        code: result.exitCode,
        text: result.text(),
        stderr: result.stderr.toString("utf8"),
      } satisfies GitResult
    })

    const MAX_NAME_ATTEMPTS = 26
    const candidate = Effect.fn("Worktree.candidate")(function* (input: {
      root: string
      name?: string
      detached?: boolean
    }) {
      const ctx = yield* InstanceState.context
      for (const attempt of Array.from({ length: MAX_NAME_ATTEMPTS }, (_, i) => i)) {
        const name = input.name ? (attempt === 0 ? input.name : `${input.name}-${Slug.create()}`) : Slug.create()
        const branch = input.detached ? undefined : `opencode/${name}`
        const directory = pathSvc.join(input.root, name)

        if (yield* fs.exists(directory).pipe(Effect.orDie)) continue

        if (branch) {
          const ref = `refs/heads/${branch}`
          const branchCheck = yield* git(["show-ref", "--verify", "--quiet", ref], { cwd: ctx.worktree })
          if (branchCheck.code === 0) continue
        }

        return { name, directory, ...(branch ? { branch } : {}) }
      }
      return yield* new NameGenerationFailedError({ message: "Failed to generate a unique worktree name" })
    })

    const makeWorktreeInfo = Effect.fn("Worktree.makeWorktreeInfo")(function* (input?: {
      name?: string
      detached?: boolean
    }) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" })
      }

      const root = pathSvc.join(Global.Path.data, "worktree", ctx.project.id)
      yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.orDie)

      return yield* candidate({ root, name: input?.name ? slugify(input.name) : "", detached: input?.detached })
    })

    const registerSandbox = Effect.fnUntraced(function* (directory: string) {
      const ctx = yield* InstanceState.context
      yield* project.addSandbox(ctx.project.id, directory).pipe(Effect.catch(() => Effect.void))
    })

    const setup = Effect.fnUntraced(function* (info: Info) {
      const ctx = yield* InstanceState.context
      const created = yield* git(
        info.branch
          ? ["worktree", "add", "--no-checkout", "-b", info.branch, info.directory]
          : ["worktree", "add", "--no-checkout", "--detach", info.directory, "HEAD"],
        { cwd: ctx.worktree },
      )
      if (created.code !== 0) {
        return yield* new CreateFailedError({
          message: created.stderr || created.text || "Failed to create git worktree",
        })
      }

      yield* registerSandbox(info.directory)
    })

    const boot = Effect.fnUntraced(function* (info: Info, startCommand?: string) {
      const ctx = yield* InstanceState.context
      const workspaceID = yield* InstanceState.workspaceID
      const projectID = ctx.project.id
      const extra = startCommand?.trim()

      const populated = yield* git(["reset", "--hard"], { cwd: info.directory })
      if (populated.code !== 0) {
        const message = populated.stderr || populated.text || "Failed to populate worktree"
        yield* Effect.logError("worktree checkout failed", { directory: info.directory, message })
        GlobalBus.emit("event", {
          directory: info.directory,
          project: ctx.project.id,
          workspace: workspaceID,
          payload: { type: Event.Failed.type, properties: { message } },
        })
        return
      }

      const booted = yield* store.load({ directory: info.directory }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.gen(function* () {
            const message = errorMessage(error)
            yield* Effect.logError("worktree bootstrap failed", { directory: info.directory, message })
            GlobalBus.emit("event", {
              directory: info.directory,
              project: ctx.project.id,
              workspace: workspaceID,
              payload: { type: Event.Failed.type, properties: { message } },
            })
            return false
          }),
        ),
      )
      if (!booted) return

      GlobalBus.emit("event", {
        directory: info.directory,
        project: ctx.project.id,
        workspace: workspaceID,
        payload: {
          type: Event.Ready.type,
          properties: { name: info.name, ...(info.branch ? { branch: info.branch } : {}) },
        },
      })

      yield* runStartScripts(info.directory, { projectID, extra })
    })

    const createFromInfo = Effect.fn("Worktree.createFromInfo")(function* (info: Info, startCommand?: string) {
      yield* setup(info)
      yield* boot(info, startCommand).pipe(
        Effect.catchCause((cause) => Effect.logError("worktree bootstrap failed", { cause })),
        Effect.forkIn(scope),
      )
    })

    const createManaged = Effect.fn("Worktree.createManaged")(function* (
      input: CreateInput | undefined,
      managed: ManagedCreateOptions,
    ) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" })
      }

      // The candidate stays the unmanaged fallback layout and the default
      // managed target/branch when the caller does not override them.
      const info = yield* makeWorktreeInfo({ name: input?.name })

      const bridge = Option.getOrUndefined(yield* Effect.serviceOption(ManagedWorktreeBridge.Service))
      if (bridge === undefined) {
        yield* createFromInfo(info, input?.startCommand)
        return info
      }

      const branchName = managed.request.branchName ?? info.branch
      if (branchName === undefined) {
        return yield* new CreateFailedError({ message: "Managed worktree creation requires a branch name." })
      }
      const targetPath = managed.request.targetPath ?? info.directory

      const outcome = yield* bridge
        .createManagedWorktree({
          ...(managed.activation ?? {}),
          request: {
            worktreeId: managed.request.worktreeId,
            repositoryId: managed.request.repositoryId,
            ...(managed.request.repositoryPath === undefined ? {} : { repositoryPath: managed.request.repositoryPath }),
            storageVolumeId: managed.request.storageVolumeId,
            targetPath,
            branchName,
            commitish: managed.request.commitish,
            storagePolicy: managed.request.storagePolicy,
            storageProbe: managed.request.storageProbe,
            dedupe: managed.request.dedupe,
          },
          binding: {
            directory: targetPath,
            installationId: managed.binding.installationId,
            projectId: managed.binding.projectId,
            ...(managed.binding.workspaceId === undefined ? {} : { workspaceId: managed.binding.workspaceId }),
          },
        })
        .pipe(
          Effect.catch((error) =>
            Effect.fail(
              new ManagedCreateFailedError({
                reason: error._tag,
                message: `Managed worktree creation failed (${error.message.length === 0 ? error._tag : `${error._tag}: ${error.message}`}).`,
              }),
            ),
          ),
        )

      if (outcome.state === "created") {
        // The manager already materialized the worktree, so the unmanaged
        // `git worktree add` is skipped; sandbox registration and the boot
        // order continue exactly as in the unmanaged path.
        const managedInfo: Info = { name: info.name, branch: branchName, directory: outcome.result.targetPath }
        yield* registerSandbox(outcome.result.targetPath)
        yield* boot(managedInfo, input?.startCommand).pipe(
          Effect.catchCause((cause) => Effect.logError("worktree bootstrap failed", { cause })),
          Effect.forkIn(scope),
        )
        return managedInfo
      }

      if (FALLBACK_ACTIVATION_REASONS.has(outcome.reason)) {
        yield* createFromInfo(info, input?.startCommand)
        return info
      }

      return yield* new ManagedCreateFailedError({
        reason: outcome.reason,
        message: `Managed worktree creation did not complete (${outcome.reason}): ${outcome.detail}`,
      })
    })

    const create = Effect.fn("Worktree.create")(function* (input?: CreateInput, managed?: ManagedCreateOptions) {
      if (managed !== undefined) return yield* createManaged(input, managed)
      const info = yield* makeWorktreeInfo({ name: input?.name })
      yield* createFromInfo(info, input?.startCommand)
      return info
    })

    const canonical = Effect.fnUntraced(function* (input: string) {
      const abs = pathSvc.resolve(input)
      const real = yield* fs.realPath(abs).pipe(Effect.catch(() => Effect.succeed(abs)))
      const normalized = pathSvc.normalize(real)
      return process.platform === "win32" ? normalized.toLowerCase() : normalized
    })

    function parseWorktreeList(text: string) {
      return text
        .split("\n")
        .map((line) => line.trim())
        .reduce<{ path?: string; branch?: string }[]>((acc, line) => {
          if (!line) return acc
          if (line.startsWith("worktree ")) {
            acc.push({ path: line.slice("worktree ".length).trim() })
            return acc
          }
          const current = acc[acc.length - 1]
          if (!current) return acc
          if (line.startsWith("branch ")) {
            current.branch = line.slice("branch ".length).trim()
          }
          return acc
        }, [])
    }

    const locateWorktree = Effect.fnUntraced(function* (
      entries: { path?: string; branch?: string }[],
      directory: string,
    ) {
      for (const item of entries) {
        if (!item.path) continue
        const key = yield* canonical(item.path)
        if (key === directory) return item
      }
      return undefined
    })

    const list = Effect.fn("Worktree.list")(function* () {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        return []
      }

      const result = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
      if (result.code !== 0) {
        return yield* new ListFailedError({ message: result.stderr || result.text || "Failed to read git worktrees" })
      }

      const primary = yield* canonical(ctx.project.worktree)
      const primaryName = pathSvc.basename(primary).toLowerCase()
      return yield* Effect.forEach(parseWorktreeList(result.text), (entry) =>
        Effect.gen(function* () {
          if (!entry.path) return undefined
          const directory = yield* canonical(entry.path)
          if (directory === primary) return undefined
          const name = pathSvc.basename(directory).toLowerCase()
          return {
            name: name === primaryName ? pathSvc.basename(pathSvc.dirname(directory)) : name,
            directory,
            ...(entry.branch ? { branch: entry.branch.replace(/^refs\/heads\//, "") } : {}),
          }
        }),
      ).pipe(Effect.map((items) => items.filter((item) => item !== undefined)))
    })

    function stopFsmonitor(target: string) {
      return fs.exists(target).pipe(
        Effect.orDie,
        Effect.flatMap((exists) => (exists ? git(["fsmonitor--daemon", "stop"], { cwd: target }) : Effect.void)),
      )
    }

    function cleanDirectory(target: string) {
      return Effect.tryPromise({
        try: async () => {
          const fsp = await import("fs/promises")
          const attempts = process.platform === "win32" ? 50 : 5
          for (const attempt of Array.from({ length: attempts }, (_, i) => i)) {
            try {
              await fsp.rm(target, { recursive: true, force: true })
              return
            } catch (error) {
              if (attempt === attempts - 1) throw error
              await new Promise((resolve) => setTimeout(resolve, 100))
            }
          }
        },
        catch: (error) =>
          new RemoveFailedError({ message: errorMessage(error) || "Failed to remove git worktree directory" }),
      })
    }

    const remove = Effect.fn("Worktree.remove")(function* (input: RemoveInput) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" })
      }

      const directory = yield* canonical(input.directory)

      // Preserve the loaded path casing for the store cache; `directory` is lowercased on Windows.
      if (directory !== (yield* canonical(ctx.worktree))) yield* store.disposeDirectory(input.directory)

      const list = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
      if (list.code !== 0) {
        return yield* new RemoveFailedError({ message: list.stderr || list.text || "Failed to read git worktrees" })
      }

      const entries = parseWorktreeList(list.text)
      const entry = yield* locateWorktree(entries, directory)

      if (!entry?.path) {
        const directoryExists = yield* fs.exists(directory).pipe(Effect.orDie)
        if (directoryExists) {
          yield* stopFsmonitor(directory)
          yield* cleanDirectory(directory)
        }
        return true
      }

      // Git may return the original casing when a caller supplied a normalized Windows path.
      yield* store.disposeDirectory(entry.path)
      yield* stopFsmonitor(entry.path)
      const removed = yield* git(["worktree", "remove", "--force", entry.path], { cwd: ctx.worktree })
      if (removed.code !== 0) {
        const next = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
        if (next.code !== 0) {
          return yield* new RemoveFailedError({
            message: removed.stderr || removed.text || next.stderr || next.text || "Failed to remove git worktree",
          })
        }

        const stale = yield* locateWorktree(parseWorktreeList(next.text), directory)
        if (stale?.path) {
          return yield* new RemoveFailedError({
            message: removed.stderr || removed.text || "Failed to remove git worktree",
          })
        }
      }

      yield* cleanDirectory(entry.path)

      const branch = entry.branch?.replace(/^refs\/heads\//, "")
      if (branch) {
        const deleted = yield* git(["branch", "-D", branch], { cwd: ctx.worktree })
        if (deleted.code !== 0) {
          return yield* new RemoveFailedError({
            message: deleted.stderr || deleted.text || "Failed to delete worktree branch",
          })
        }
      }

      return true
    })

    const gitExpect = Effect.fnUntraced(function* (
      args: string[],
      opts: { cwd: string },
      error: (r: GitResult) => Error,
    ) {
      const result = yield* git(args, opts)
      if (result.code !== 0) return yield* error(result)
      return result
    })

    const runStartCommand = Effect.fnUntraced(
      function* (directory: string, cmd: string) {
        const [shell, args] = process.platform === "win32" ? ["cmd", ["/c", cmd]] : ["bash", ["-lc", cmd]]
        const result = yield* appProcess.run(
          ChildProcess.make(shell, args as string[], { cwd: directory, extendEnv: true, stdin: "ignore" }),
        )
        return { code: result.exitCode, stderr: result.stderr.toString("utf8") }
      },
      Effect.catch(() => Effect.succeed({ code: 1, stderr: "" })),
    )

    const runStartScript = Effect.fnUntraced(function* (directory: string, cmd: string, kind: string) {
      const text = cmd.trim()
      if (!text) return true
      const result = yield* runStartCommand(directory, text)
      if (result.code === 0) return true
      yield* Effect.logError("worktree start command failed", { kind, directory, message: result.stderr })
      return false
    })

    const runStartScripts = Effect.fnUntraced(function* (
      directory: string,
      input: { projectID: ProjectV2.ID; extra?: string },
    ) {
      const row = yield* db
        .select()
        .from(ProjectTable)
        .where(eq(ProjectTable.id, input.projectID))
        .get()
        .pipe(Effect.orDie)
      const project = row ? Project.fromRow(row) : undefined
      const startup = project?.commands?.start?.trim() ?? ""
      const ok = yield* runStartScript(directory, startup, "project")
      if (!ok) return false
      yield* runStartScript(directory, input.extra ?? "", "worktree")
      return true
    })

    const prune = Effect.fnUntraced(function* (root: string, entries: string[]) {
      const base = yield* canonical(root)
      yield* Effect.forEach(
        entries,
        (entry) =>
          Effect.gen(function* () {
            const target = yield* canonical(pathSvc.resolve(root, entry))
            if (target === base) return
            if (!target.startsWith(`${base}${pathSvc.sep}`)) return
            yield* fs.remove(target, { recursive: true }).pipe(Effect.ignore)
          }),
        // Removing worktrees is recursive filesystem I/O. Keep cleanup from
        // monopolizing the runtime when git reports a large failed batch.
        { concurrency: 4 },
      )
    })

    const sweep = Effect.fnUntraced(function* (root: string) {
      const first = yield* git(["clean", "-ffdx"], { cwd: root })
      if (first.code === 0) return first

      const entries = failedRemoves(first.stderr, first.text)
      if (!entries.length) return first

      yield* prune(root, entries)
      return yield* git(["clean", "-ffdx"], { cwd: root })
    })

    const reset = Effect.fn("Worktree.reset")(function* (input: ResetInput) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" })
      }

      const directory = yield* canonical(input.directory)
      const primary = yield* canonical(ctx.worktree)
      if (directory === primary) {
        return yield* new ResetFailedError({ message: "Cannot reset the primary workspace" })
      }

      const list = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
      if (list.code !== 0) {
        return yield* new ResetFailedError({ message: list.stderr || list.text || "Failed to read git worktrees" })
      }

      const entry = yield* locateWorktree(parseWorktreeList(list.text), directory)
      if (!entry?.path) {
        return yield* new ResetFailedError({ message: "Worktree not found" })
      }

      const worktreePath = entry.path

      const base = yield* gitSvc.defaultBranch(ctx.worktree)
      if (!base) {
        return yield* new ResetFailedError({ message: "Default branch not found" })
      }

      const sep = base.ref.indexOf("/")
      if (base.ref !== base.name && sep > 0) {
        const remote = base.ref.slice(0, sep)
        const branch = base.ref.slice(sep + 1)
        yield* gitExpect(
          ["fetch", remote, branch],
          { cwd: ctx.worktree },
          (r) => new ResetFailedError({ message: r.stderr || r.text || `Failed to fetch ${base.ref}` }),
        )
      }

      yield* gitExpect(
        ["reset", "--hard", base.ref],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: r.stderr || r.text || "Failed to reset worktree to target" }),
      )

      const cleanResult = yield* sweep(worktreePath)
      if (cleanResult.code !== 0) {
        return yield* new ResetFailedError({
          message: cleanResult.stderr || cleanResult.text || "Failed to clean worktree",
        })
      }

      yield* gitExpect(
        ["submodule", "update", "--init", "--recursive", "--force"],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: r.stderr || r.text || "Failed to update submodules" }),
      )

      yield* gitExpect(
        ["submodule", "foreach", "--recursive", "git", "reset", "--hard"],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: r.stderr || r.text || "Failed to reset submodules" }),
      )

      yield* gitExpect(
        ["submodule", "foreach", "--recursive", "git", "clean", "-fdx"],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: r.stderr || r.text || "Failed to clean submodules" }),
      )

      const status = yield* git(["-c", "core.fsmonitor=false", "status", "--porcelain=v1"], { cwd: worktreePath })
      if (status.code !== 0) {
        return yield* new ResetFailedError({ message: status.stderr || status.text || "Failed to read git status" })
      }

      if (status.text.trim()) {
        return yield* new ResetFailedError({ message: `Worktree reset left local changes:\n${status.text.trim()}` })
      }

      yield* runStartScripts(worktreePath, { projectID: ctx.project.id }).pipe(
        Effect.catchCause((cause) => Effect.logError("worktree start task failed", { cause })),
        Effect.forkIn(scope),
      )

      return true
    })

    return Service.of({ makeWorktreeInfo, createFromInfo, create, list, remove, reset })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, path, AppProcess.node, Git.node, Project.node, InstanceStore.node, Database.node],
})

export * as Worktree from "."
