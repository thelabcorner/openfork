import path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { ExchangeError } from "@/exchange/error"
import { ExchangeTypecheck } from "@/exchange/typecheck"
import { OxpAuthority } from "./authority"
import { OxpError } from "./error"
import { OxpProcess } from "./process"
import { OxpResult } from "./result"
import { OxpRoot } from "./root"
import { OxpSchema } from "./schema"

export const Parameters = Schema.Struct({
  rootID: OxpSchema.RootID,
  workdir: Schema.optional(Schema.String),
  ...ExchangeTypecheck.Parameters.fields,
})
export type Input = Schema.Schema.Type<typeof Parameters>

export interface Interface {
  readonly execute: (input: Input, signal?: AbortSignal) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpTypecheck") {}
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

function relativeWorkdir(rootPath: string, cwd: string) {
  const relative = path.relative(rootPath, cwd)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new OxpError.PathEscape({ detail: "Typecheck subprocess workdir escapes the approved root" })
  }
  return relative === "" ? "." : relative.split(path.sep).join("/")
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const proc = yield* OxpProcess.Service
    const roots = yield* OxpRoot.Service

    const execute: Interface["execute"] = Effect.fn("OxpTypecheck.execute")(function* (input, signal) {
      const mode = ExchangeTypecheck.resolveMode(input)
      const operation = mode === "explain" ? "typecheck.explain" : "typecheck.run"
      const phase = mode === "explain" ? "read" : "spawn"
      const admitted = yield* authority.authorize({
        plane: "augmentation",
        operation,
        phase,
        rootID: input.rootID,
      })
      if (!admitted.root || "path" in admitted.root) {
        return yield* new OxpError.RootRequired({ detail: "typecheck requires one explicit approved root" })
      }
      const root = admitted.root.root
      const rootPath = admitted.root.canonicalPath
      let directory = rootPath
      if (mode !== "explain" && input.workdir) {
        const work = yield* authority.authorize({
          plane: "augmentation",
          operation: "typecheck.run",
          phase: "spawn",
          rootID: input.rootID,
          path: input.workdir,
        })
        if (!work.root) return yield* new OxpError.RootRequired({ detail: "typecheck workdir did not resolve" })
        directory = "path" in work.root ? work.root.path : work.root.canonicalPath
      }

      const result = yield* ExchangeTypecheck.execute<OxpError.Error>(
        input,
        {
          rootPath,
          directory,
          authorizePath: (absolutePath) =>
            authority
              .authorize({
                plane: "augmentation",
                operation: "typecheck.run",
                phase: "spawn",
                rootID: input.rootID,
                path: absolutePath,
              })
              .pipe(
                Effect.flatMap((pathAdmission) =>
                  pathAdmission.root && "path" in pathAdmission.root
                    ? Effect.succeed(pathAdmission.root.path)
                    : Effect.fail(new OxpError.InvalidArgument({ detail: "typecheck path did not resolve inside the approved root" })),
                ),
              ),
          toVirtualPath: (absolutePath) => roots.toVirtualPath(root, absolutePath),
          run: (request) =>
            Effect.try({
              try: () => relativeWorkdir(rootPath, request.cwd),
              catch: (error) => (OxpError.isError(error) ? error : new OxpError.PathEscape({ detail: "Typecheck subprocess workdir escapes the approved root" })),
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
        mutation: { attempted: false, committed: false },
      } satisfies OxpResult.CapabilityResult
    })

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [OxpAuthority.node, OxpProcess.node, OxpRoot.node] })
export * as OxpTypecheck from "./typecheck"
