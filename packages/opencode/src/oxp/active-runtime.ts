/**
 * Active-only OXP execution graph. This module is imported only after an
 * enabled connector admits endpoint activation; idle Settings/state reads must
 * not import MCP transport, worker controls, provider/model catalogs, or the
 * large native execution graph.
 *
 * Keep this graph's service identity and override list aligned with OXP host
 * integration tests. Never construct a second active runtime for a live host.
 */
import { ManagedRuntime } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { OxpConfig } from "./config"
import { OxpRoot } from "./root"
import { OxpAgentCatalog } from "./agent-catalog"
import { OxpAgentCatalogV1 } from "./agent-catalog-v1"
import { OxpModelCatalog } from "./model-catalog"
import { OxpModelCatalogV1 } from "./model-catalog-v1"
import { OxpServer } from "./server"
import { OxpRequestControl } from "./request-control"
import { OxpRequestControlV1 } from "./request-control-v1"
import { OxpSessionControl } from "./session-control"
import { OxpSessionControlV1 } from "./session-control-v1"
import { OxpWorkerControl } from "./worker-control"
import { OxpWorkerControlV1 } from "./worker-control-v1"
import { OxpMcpControl } from "./mcp-control"
import { OxpMcpControlV1 } from "./mcp-control-v1"
import { OxpSystemOneControl } from "./system-one-control"
import { OxpSystemOneControlV1 } from "./system-one-control-v1"

// These are the same Effect service tags consumed by the host after active
// admission. Export identity, not synthetic sessions or service adapters.
export { OxpServer, OxpAgentCatalog }

const buildActiveLayer = () => AppNodeBuilder.build(
  LayerNode.group([
    CrossSpawnSpawner.node,
    OxpConfig.node,
    OxpRoot.node,
    OxpAgentCatalog.node,
    OxpModelCatalog.node,
    OxpServer.node,
  ]),
  [
    [OxpSessionControl.node, OxpSessionControlV1.layer],
    [OxpRequestControl.node, OxpRequestControlV1.layer],
    [OxpWorkerControl.node, OxpWorkerControlV1.layer],
    [OxpMcpControl.node, OxpMcpControlV1.layer],
    [OxpSystemOneControl.node, OxpSystemOneControlV1.layer],
    [OxpAgentCatalog.node, OxpAgentCatalogV1.layer],
    [OxpModelCatalog.node, OxpModelCatalogV1.layer],
  ],
)

let activeLayer: ReturnType<typeof buildActiveLayer> | undefined
export const makeActiveRuntime = () => ManagedRuntime.make(activeLayer ??= buildActiveLayer())