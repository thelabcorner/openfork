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

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const app = yield* AppProcess.Service

    const execute: Interface["execute"] = (input, signal) =>
      Effect.gen(function* () {
        yield* cancelled(signal)
        const mode = input.mode ?? "status"
        const mutating = GitTyped.isMutating(input)
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
          Effect.mapError(() => new OxpError.InvalidArgument({
            detail: input.workdir
              ? "The selected OXP Git workdir is not inside a Git worktree"
              : "The approved OXP root is not itself a Git worktree; provide workdir to select a repository inside it",
          })),
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

        const result = yield* GitTyped.execute(app, input, worktree, signal, beforeMutation).pipe(
          Effect.mapError((error) => {
            if (OxpError.isError(error)) return error
            if (signal?.aborted) return new OxpError.Cancelled({ detail: "OXP Git operation was cancelled" })
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
