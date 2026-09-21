import { Effect, Layer } from "effect"
import { OxpAgentCatalog } from "./agent-catalog"
import { OxpRuntimeV1 } from "./runtime-v1"

async function catalogModule() {
  return import("@/agent/catalog")
}

const list: OxpAgentCatalog.Interface["list"] = (target) =>
  OxpRuntimeV1.enter(
    target,
    async () => {
      const { AgentCatalog } = await catalogModule()
      return AgentCatalog.load().pipe(
        Effect.map((snapshot) => ({
          agents: snapshot.agents,
          nativeDefaultAgent: snapshot.defaultAgentID,
        })),
      )
    },
    "Native workspace agent catalog failed",
  )

export const layer = Layer.succeed(
  OxpAgentCatalog.Service,
  OxpAgentCatalog.Service.of({ list }),
)

export * as OxpAgentCatalogV1 from "./agent-catalog-v1"
