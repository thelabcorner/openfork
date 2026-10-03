import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { AppProcess } from "@opencode-ai/core/process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { GitTyped } from "@/git/typed"
import { OxpAuthority } from "./authority"
import { OxpError } from "./error"
import { OxpResult } from "./result"
import { OxpRoot } from "./root"
import { OxpSchema } from "./schema"

export const Parameters = Schema.Struct({
  rootID: OxpSchema.RootID,
  workdir: Schema.optional(Schema.String).annotate({
    description: "Optional path inside the approved root used to select a nested Git worktree.",
  }),
  ...GitTyped.Fields,
})
export type Input = Schema.Schema.Type<typeof Parameters>

const transportMode = (
  mode: GitTyped.Mode,
  fields: readonly string[],
  required: readonly string[] = [],
  defaultMode = false,
) => ({
  type: "object" as const,
  properties: Object.fromEntries([
    ["rootID", {}],
    ["workdir", {}],
    ["mode", { const: mode }],
    ...fields.map((name) => [name, {}] as const),
  ]),
  required: ["rootID", ...(defaultMode ? [] : ["mode"]), ...required],
  additionalProperties: false as const,
})

/**
 * Exact mode grammar for MCP clients that preserve conditional JSON Schema.
 * The top-level schema remains a flat transport-safe envelope; GitTyped
 * defensively validates again before any repository process executes.
 */
export const TransportModeConstraints = Object.freeze({
  oneOf: Object.freeze([
    transportMode("help", GitTyped.ModeFields.help),
    transportMode("status", GitTyped.ModeFields.status, [], true),
    transportMode("summary", GitTyped.ModeFields.summary),
    transportMode("diff", GitTyped.ModeFields.diff),
    transportMode("log", GitTyped.ModeFields.log),
    transportMode("show", GitTyped.ModeFields.show, ["ref"]),
    transportMode("stage", GitTyped.ModeFields.stage),
    transportMode("unstage", GitTyped.ModeFields.unstage),
    transportMode("restore", GitTyped.ModeFields.restore),
    transportMode("commit", GitTyped.ModeFields.commit, ["message"]),
    transportMode("shell", GitTyped.ModeFields.shell, ["argv"]),
  ]),
})

export interface Interface {
  readonly execute: (input: Input, signal?: AbortSignal) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpGit") {}
export const use = serviceUse(Service)

function cancelled(signal?: AbortSignal) {
  return signal?.aborted
    ? Effect.fail<OxpError.Error>(new OxpError.Cancelled({ detail: "OXP Git operation was cancelled" }))
    : Effect.void
}

function processError(
  error: unknown,
  signal?: AbortSignal,
): OxpError.Error | undefined {
  if (!(error instanceof AppProcess.AppProcessError)) return undefined
  if (signal?.aborted) {
    return new OxpError.Cancelled({
      detail: "OXP Git operation was cancelled",
    })
  }
  if (
    error.cause instanceof Error &&
    error.cause.message === "Timed out"
  ) {
    return new OxpError.Timeout({
      detail: "OXP Git operation timed out",
    })
  }
  return new OxpError.DependencyUnavailable({
    detail: OxpError.boundDetail(error.message),
  })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const app = yield* AppProcess.Service

    const execute: Interface["execute"] = (input, signal) =>
      Effect.gen(function* () {
        yield* cancelled(signal)
        const { rootID: _rootID, workdir: _workdir, ...gitInput } = input
        yield* Effect.try({
          try: () => GitTyped.validateInput(gitInput),
          catch: (cause) =>
            new OxpError.InvalidArgument({
              detail: cause instanceof Error ? cause.message.slice(0, 1000) : "Invalid OXP Git arguments",
            }),
        })
        const mode = gitInput.mode ?? "status"
        const mutating = GitTyped.isMutating(gitInput)
        const admission = yield* authority.authorize({
          plane: "augmentation",
          operation: `git.${mode}`,
          phase: mutating ? "mutate" : "read",
          rootID: input.rootID,
        })
        if (!admission.root || "path" in admission.root) {
          return yield* new OxpError.RootRequired({ detail: "Git operations require one explicit approved repository root" })
        }

        let worktree: string
        let requestedLocation = admission.root.canonicalPath
        if (input.workdir) {
          const scoped = yield* authority.authorize({
            plane: "augmentation",
            operation: `git.${mode}`,
            phase: mutating ? "mutate" : "read",
            rootID: input.rootID,
            path: input.workdir,
          })
          if (!scoped.root || !("path" in scoped.root)) {
            return yield* new OxpError.RootRequired({ detail: "Git workdir did not resolve inside the approved root" })
          }
          requestedLocation = scoped.root.path
        }
        worktree = yield* GitTyped.resolveWorktreeRoot(app, requestedLocation).pipe(
          Effect.mapError((error) =>
            processError(error, signal) ??
            new OxpError.InvalidArgument({
              detail: input.workdir
                ? "The selected OXP Git workdir is not inside a Git worktree"
                : "The approved OXP root is not itself a Git worktree; provide workdir to select a repository inside it",
            }),
          ),
        )
        const approvedRoot = FSUtil.normalizePath(admission.root.canonicalPath)
        worktree = FSUtil.normalizePath(worktree)
        if (!OxpRoot.isContained(approvedRoot, worktree)) {
          return yield* new OxpError.InvalidArgument({
            detail: "Resolved Git worktree escapes the approved OXP root",
          })
        }

        const beforeMutation = () =>
          authority.revalidate(admission, "commit").pipe(
            Effect.flatMap((fresh) => {
              if (!fresh.root || "path" in fresh.root) {
                return Effect.fail<OxpError.Error>(
                  new OxpError.AuthRevoked({ detail: "OXP Git repository authority changed before mutation" }),
                )
              }
              if (!OxpRoot.isContained(FSUtil.normalizePath(fresh.root.canonicalPath), worktree)) {
                return Effect.fail<OxpError.Error>(
                  new OxpError.AuthRevoked({ detail: "OXP Git repository identity changed before mutation" }),
                )
              }
              return Effect.void
            }),
          )

        const result = yield* GitTyped.execute(app, gitInput, worktree, signal, beforeMutation).pipe(
          Effect.mapError((error) => {
            if (OxpError.isError(error)) return error
            const process = processError(error, signal)
            if (process) return process
            return new OxpError.Conflict({
              detail: error instanceof Error ? error.message.slice(0, 1000) : "Git operation failed",
            })
          }),
        )

        // Read results are externally projected only while the same live Git
        // authority/root remains valid. For a completed mutation, do not convert
        // post-commit revocation into a retryable failure: that would create
        // ambiguous mutation retry semantics.
        if (!mutating) yield* authority.revalidate(admission, "egress")

        return {
          title: result.title,
          output: result.output,
          metadata: {
            ...result.metadata,
            root: `/${admission.root.root.alias}`,
            ...(input.workdir ? { workdir: input.workdir } : {}),
          },
          mutation: {
            attempted: mutating,
            committed: mutating && result.metadata.ok,
          },
        } satisfies OxpResult.CapabilityResult
      }).pipe(
        Effect.catch((error) =>
          OxpError.isError(error)
            ? Effect.fail(error)
            : Effect.fail(
                new OxpError.Conflict({
                  detail: String(error).slice(0, 1000) || "OXP Git operation failed",
                }),
              ),
        ),
      )

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [OxpAuthority.node, AppProcess.node],
})

export * as OxpGit from "./git"
