import { Context, Effect, Layer, LayerMap, Types } from "effect"
import type { PluginContext } from "@opencode-ai/plugin/v2/effect"
import { AbsolutePath } from "../schema"
import { LayerNode } from "../effect/layer-node"
import { makeLocationNode, Node } from "../effect/app-node"
import { Config } from "../config"
import { AgentV2 } from "../agent"
import { ConfigAgentPlugin } from "../config/plugin/agent"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Location } from "../location"
import { AgentPlugin } from "../plugin/agent"

export interface Interface {
  readonly list: () => Effect.Effect<AgentV2.Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentCatalog") {}

type PluginAgentDraft = Parameters<Parameters<PluginContext["agent"]["transform"]>[0]>[0]

/**
 * Agent configuration is a Tier-2 catalog. Reuse the same built-in and
 * config-agent plugins as the location runtime, without constructing the full
 * execution graph (plugin package loading, tools, watchers, PTY, snapshots,
 * session runner, and indexes) merely to enumerate choices.
 *
 * This intentionally applies the two authoritative built-in/config plugins.
 * Arbitrary runtime plugin hooks remain execution-owned and are not run as a
 * side effect of catalog reads.
 */
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    const mutable = <T>(value: T) => value as Types.DeepMutable<T>
    const agentContext: PluginContext["agent"] = {
      reload: agents.reload,
      transform: (callback) =>
        agents.transform((draft) => {
          const exposed: PluginAgentDraft = {
            list: () => mutable(draft.list()),
            get: (id) => mutable(draft.get(AgentV2.ID.make(id))),
            default: (id) => draft.default(id === undefined ? undefined : AgentV2.ID.make(id)),
            update: (id, update) =>
              draft.update(AgentV2.ID.make(id), (agent) => update(agent as never)),
            remove: (id) => draft.remove(AgentV2.ID.make(id)),
          }
          const result = callback(exposed)
          return Effect.isEffect(result) ? result : Effect.void
        }),
    }
    const pluginContext = { agent: agentContext } as PluginContext

    // Keep the order used by PluginInternal: native defaults first, then
    // location config and agent/mode markdown overlays.
    yield* AgentPlugin.Plugin.effect(pluginContext)
    yield* ConfigAgentPlugin.Plugin.effect(pluginContext)

    return Service.of({ list: agents.all })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [AgentV2.node, Config.node, FSUtil.node, Global.node, Location.node],
})

type CatalogServices = LayerNode.Output<typeof node>
type CatalogError = LayerNode.Error<typeof node>

export class MapService extends Context.Service<
  MapService,
  LayerMap.LayerMap<Location.Ref, CatalogServices, CatalogError>
>()("@opencode/AgentCatalogMap") {
  static get(ref: Location.Ref) {
    return Layer.unwrap(Effect.map(MapService, (catalogs) => catalogs.get(ref)))
  }

  static contextEffect(ref: Location.Ref) {
    return Effect.flatMap(MapService, (catalogs) => catalogs.contextEffect(ref))
  }
}

export const mapNode = LayerNode.unbound(MapService, Node.tags.values.global)

export function buildMap(replacements: LayerNode.Replacements = []): Layer.Layer<MapService> {
  return Layer.effect(
    MapService,
    Effect.gen(function* () {
      const map = yield* LayerMap.make(
        (ref: Location.Ref) => {
          const bound = [[Location.node, Location.boundNode(ref)]] as LayerNode.Replacements
          const allReplacements = replacements.concat(bound)
          const graph = LayerNode.hoist(LayerNode.group([node]), Node.tags.values.global, allReplacements)
          return LayerNode.compile(graph.node).pipe(
            Layer.fresh,
            Layer.provide(LayerNode.compile(graph.hoisted)),
          )
        },
        { idleTimeToLive: "60 minutes" },
      )

      return { ...map, get: (ref: Location.Ref) => map.get(canonical(ref)) }
    }),
  )
}

function canonical(ref: Location.Ref): Location.Ref {
  return Location.Ref.make({
    directory: AbsolutePath.make(FSUtil.resolve(ref.directory)),
    workspaceID: ref.workspaceID,
  })
}
