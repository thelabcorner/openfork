import { Effect, Layer } from "effect"
import { OxpMcpControl } from "./mcp-control"
import { OxpRuntimeV1 } from "./runtime-v1"

async function runtimeModules() {
  const { MCP } = await import("@/mcp")
  return { MCP }
}

const enter = <A>(
  target: OxpMcpControl.Target,
  build: (
    runtime: Awaited<ReturnType<typeof runtimeModules>>,
  ) => Effect.Effect<A, unknown, any>,
) =>
  OxpRuntimeV1.enter(
    target,
    async () => build(await runtimeModules()),
    "Native MCP runtime operation failed",
  )

const list: OxpMcpControl.Interface["list"] = (target) =>
  enter(target, (runtime) =>
    runtime.MCP.Service.use((mcp) =>
      mcp.exactTools().pipe(
        Effect.map((tools) =>
          tools.map((entry) => ({
            server: entry.server,
            name: entry.def.name,
            ...(entry.def.description
              ? { description: entry.def.description }
              : {}),
            inputSchema: entry.def.inputSchema,
            readOnlyHint: entry.def.annotations?.readOnlyHint === true,
          })),
        ),
      ),
    ),
  )

const call: OxpMcpControl.Interface["call"] = (target, input) =>
  enter(target, (runtime) =>
    Effect.gen(function* () {
      const mcp = yield* runtime.MCP.Service
      yield* OxpRuntimeV1.commitGuard(
        target,
        "OXP MCP integrations authority revalidation failed",
      )
      return yield* mcp
        .invokeTool({
          server: input.server,
          tool: input.tool,
          args: input.args,
          ...(input.signal ? { signal: input.signal } : {}),
        })
        .pipe(
          Effect.map((result) => ({
            content: result.content,
            ...(result.structuredContent === undefined
              ? {}
              : { structuredContent: result.structuredContent }),
          })),
          Effect.mapError((error) =>
            error instanceof runtime.MCP.ToolNotFoundError
              ? new OxpMcpControl.ToolNotFound(
                  error.server,
                  error.tool,
                )
              : error,
          ),
        )
    }),
  )

export const layer = Layer.succeed(
  OxpMcpControl.Service,
  OxpMcpControl.Service.of({ list, call }),
)

export * as OxpMcpControlV1 from "./mcp-control-v1"
