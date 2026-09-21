import path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ExchangeArchive } from "@/exchange/archive"
import { ExchangeError } from "@/exchange/error"
import { OxpAuthority } from "./authority"
import { OxpError } from "./error"
import { OxpProcess } from "./process"
import { OxpResult } from "./result"
import { OxpSchema } from "./schema"

export const Parameters = Schema.Struct({
  rootID: OxpSchema.RootID.annotate({
    description: "Approved OXP root containing the archive and any source/destination paths.",
  }),
  ...ExchangeArchive.Parameters.fields,
})
export type Input = Schema.Schema.Type<typeof Parameters>

export interface Interface {
  readonly execute: (
    input: Input,
    signal?: AbortSignal,
  ) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpArchive") {}
export const use = serviceUse(Service)

type ApprovedPath = ExchangeArchive.ApprovedPath & {
  readonly admission: OxpAuthority.Admission
}

function mapExchangeError(error: ExchangeError.Error): OxpError.Error {
  if (error instanceof ExchangeError.InvalidArgument) return new OxpError.InvalidArgument({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.Cancelled) return new OxpError.Cancelled({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.NotFound) return new OxpError.NotFound({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.PathEscape) return new OxpError.PathEscape({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.AuthorityDenied) return new OxpError.AuthRevoked({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.Conflict) return new OxpError.Conflict({ detail: OxpError.boundDetail(error.detail) })
  return new OxpError.DependencyUnavailable({ detail: OxpError.boundDetail(error.detail) })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const proc = yield* OxpProcess.Service
    const fs = yield* FSUtil.Service

    const approved = Effect.fn("OxpArchive.approved")(function* (
      rootID: OxpSchema.RootID,
      inputPath: string,
      operation: "archive.read" | "archive.write",
      allowMissing = false,
    ) {
      const admission = yield* authority.authorize({
        plane: "augmentation",
        operation,
        phase: operation === "archive.write" ? "mutate" : "read",
        rootID,
        path: inputPath,
        allowMissing,
      })
      if (!admission.root || !("path" in admission.root)) {
        return yield* new OxpError.InvalidArgument({ detail: "archive path did not resolve inside the approved root" })
      }
      return {
        native: admission.root.path,
        virtual: admission.root.virtualPath,
        rootPath: admission.root.canonicalPath,
        admission,
      } satisfies ApprovedPath
    })

    const execute: Interface["execute"] = Effect.fn("OxpArchive.execute")(function* (input, signal) {
      if (signal?.aborted) return yield* new OxpError.Cancelled({ detail: "OXP archive request was cancelled" })

      const admissions = new Map<string, OxpAuthority.Admission>()
      const resolve = (
        operation: "archive.read" | "archive.write",
        inputPath: string,
        allowMissing = false,
      ) =>
        approved(input.rootID, inputPath, operation, allowMissing).pipe(
          Effect.tap((item) =>
            Effect.sync(() => {
              admissions.set(item.native, item.admission)
            }),
          ),
          Effect.map((item) => ({
            native: item.native,
            virtual: item.virtual,
            rootPath: item.rootPath,
          }) satisfies ExchangeArchive.ApprovedPath),
        )

      const revalidate = (item: ExchangeArchive.ApprovedPath) => {
        const admission = admissions.get(item.native)
        if (!admission) {
          return Effect.fail(
            new OxpError.DependencyUnavailable({ detail: "Archive write admission was not retained for commit revalidation" }),
          )
        }
        return authority.revalidate(admission, "commit").pipe(Effect.asVoid)
      }

      const result = yield* ExchangeArchive.execute<OxpError.Error>(
        fs,
        input,
        {
          resolveRead: (inputPath) => resolve("archive.read", inputPath),
          resolveWrite: (inputPath, allowMissing) => resolve("archive.write", inputPath, allowMissing),
          runSystem: (tool, args, runSignal) =>
            proc
              .runArgv(
                {
                  rootID: input.rootID,
                  argv: [tool, ...args],
                  title: `archive system backend: ${path.basename(tool)}`,
                  operation: "archive.system",
                  timeoutMs: 120_000,
                  outputCapBytes: ExchangeArchive.SYSTEM_OUTPUT_CAP,
                },
                runSignal ?? signal,
              )
              .pipe(
                Effect.flatMap((run) =>
                  run.timedOut
                    ? Effect.fail(
                        new OxpError.Busy({ detail: "Archive system backend exceeded the 120 second execution bound" }),
                      )
                    : Effect.succeed({
                        code: run.exitCode ?? 1,
                        stdout: new TextEncoder().encode(run.stdout),
                        stderr: run.stderr,
                      }),
                ),
              ),
          beforeCreateCommit: revalidate,
          beforeExtractMutation: (destination) => revalidate(destination),
        },
        signal,
      ).pipe(Effect.mapError((error) => (OxpError.isError(error) ? error : mapExchangeError(error))))

      return {
        title: result.title,
        output: result.output,
        structured: result.metadata,
        metadata: result.metadata,
        mutation: result.mutation,
      } satisfies OxpResult.CapabilityResult
    })

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [OxpAuthority.node, OxpProcess.node, FSUtil.node],
})

export * as OxpArchive from "./archive"
