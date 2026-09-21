import path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { ExchangeError } from "@/exchange/error"
import { ExchangeTest } from "@/exchange/test"
import { OxpAuthority } from "./authority"
import { OxpError } from "./error"
import { OxpProcess } from "./process"
import { OxpResult } from "./result"
import { OxpSchema } from "./schema"

export const Parameters = Schema.Struct({
  rootID: OxpSchema.RootID.annotate({ description: "Approved OXP root containing the project/package whose tests should be inspected or run." }),
  workdir: Schema.optional(Schema.String).annotate({ description: "Project/package directory relative to the approved root. Defaults to the root." }),
  ...ExchangeTest.Parameters.fields,
})
export type Input = Schema.Schema.Type<typeof Parameters>

export interface Interface {
  readonly execute: (input: Input, signal?: AbortSignal) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpTest") {}
export const use = serviceUse(Service)

function mapExchangeError(error: ExchangeError.Error): OxpError.Error {
  if (error instanceof ExchangeError.InvalidArgument) return new OxpError.InvalidArgument({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.Cancelled) return new OxpError.Cancelled({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.NotFound) return new OxpError.NotFound({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.PathEscape) return new OxpError.PathEscape({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.AuthorityDenied) return new OxpError.AuthRevoked({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.Conflict) return new OxpError.Conflict({ detail: OxpError.boundDetail(error.detail) })
  return new OxpError.DependencyUnavailable({ detail: OxpError.boundDetail(error.detail) })
}

function relativeInside(rootPath: string, target: string) {
  const rel = path.relative(rootPath, target)
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new OxpError.PathEscape({ detail: "Test subprocess workdir escapes the approved root" })
  }
  return rel === "" ? "." : rel.split(path.sep).join("/")
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const proc = yield* OxpProcess.Service
    const fs = yield* FSUtil.Service
    const rg = yield* Ripgrep.Service

    const execute: Interface["execute"] = Effect.fn("OxpTest.execute")(function* (input, signal) {
      const action = input.action ?? "run"
      const operation = action === "list" ? "test.list" : "test.run"
      const phase = action === "list" ? "read" : "spawn"
      const admitted = yield* authority.authorize({ plane: "augmentation", operation, phase, rootID: input.rootID })
      if (!admitted.root || "path" in admitted.root) {
        return yield* new OxpError.RootRequired({ detail: "test requires one explicit approved root" })
      }
      const root = admitted.root
      let directory = root.canonicalPath
      if (input.workdir) {
        const scoped = yield* authority.authorize({
          plane: "augmentation",
          operation,
          phase,
          rootID: input.rootID,
          path: input.workdir,
        })
        if (!scoped.root) return yield* new OxpError.RootRequired({ detail: "test workdir did not resolve inside the approved root" })
        directory = "path" in scoped.root ? scoped.root.path : scoped.root.canonicalPath
      }
      const rootWorkdir = relativeInside(root.canonicalPath, directory)
      const workspace: ExchangeTest.Workspace = {
        rootPath: root.canonicalPath,
        directory,
        rootWorkdir,
        virtualDirectory: rootWorkdir === "." ? `/${root.root.alias}` : `/${root.root.alias}/${rootWorkdir}`,
        alias: root.root.alias,
      }

      const result = yield* ExchangeTest.execute<OxpError.Error>(
        { fs, rg },
        workspace,
        input,
        {
          authorizePath: (absolutePath) =>
            authority
              .authorize({ plane: "augmentation", operation, phase, rootID: input.rootID, path: absolutePath })
              .pipe(
                Effect.flatMap((pathAdmission) =>
                  pathAdmission.root && "path" in pathAdmission.root
                    ? Effect.succeed(pathAdmission.root.path)
                    : Effect.fail(new OxpError.InvalidArgument({ detail: "test path did not resolve inside the approved root" })),
                ),
              ),
          run: (request) =>
            Effect.try({
              try: () => relativeInside(root.canonicalPath, request.cwd),
              catch: (error) => (OxpError.isError(error) ? error : new OxpError.PathEscape({ detail: "Test subprocess workdir escapes the approved root" })),
            }).pipe(
              Effect.flatMap((workdir) =>
                proc.runArgv(
                  {
                    rootID: input.rootID,
                    workdir,
                    argv: request.argv,
                    env: request.env,
                    title: request.title,
                    operation: request.operation,
                    timeoutMs: request.timeoutMs,
                    outputCapBytes: request.outputCapBytes,
                  },
                  request.signal ?? signal,
                ),
              ),
            ),
          revalidate: () => authority.revalidate(admitted, "egress").pipe(Effect.asVoid),
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
  deps: [OxpAuthority.node, OxpProcess.node, FSUtil.node, Ripgrep.node],
})

export * as OxpTest from "./test"
