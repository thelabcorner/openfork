import { Effect, Layer, LayerMap } from "effect"
import { AbsolutePath } from "@opencode-ai/schema"
import { AgentV2 } from "./agent"
import { AISDK } from "./aisdk"
import { Catalog } from "./catalog"
import { CommandV2 } from "./command"
import { Config } from "./config"
import { LayerNode } from "./effect/layer-node"
import { Node } from "./effect/app-node"
import { FileMutation } from "./file-mutation"
import { FileSystem } from "./filesystem"
import { FileIndex } from "./filesystem/index"
import { FileIndexWatcher } from "./filesystem/index-watcher"
import { FileSystemSearch } from "./filesystem/search"
import { Watcher } from "./filesystem/watcher"
import { Image } from "./image"
import { Integration } from "./integration"
import { Location } from "./location"
import { LocationMutation } from "./location-mutation"
import { LocationServiceMap } from "./location-service-map"
import { PermissionV2 } from "./permission"
import { PluginV2 } from "./plugin"
import { PluginInternal } from "./plugin/internal"
import { Policy } from "./policy"
import { ProjectCopy } from "./project/copy"
import { ProjectInventory } from "./project-inventory"
import { Pty } from "./pty"
import { QuestionV2 } from "./question"
import { Reference } from "./reference"
import { ReferenceGuidance } from "./reference/guidance"
import * as SessionRunnerLLM from "./session/runner/llm"
import { SessionRunnerModel } from "./session/runner/model"
import { SessionTodo } from "./session/todo"
import { SessionTitle } from "./session/title"
import { SkillV2 } from "./skill"
import { SkillGuidance } from "./skill/guidance"
import { Snapshot } from "./snapshot"
import { SystemContextBuiltIns } from "./system-context/builtins"
import { SystemContextRegistry } from "./system-context/registry"
import { BuiltInTools } from "./tool/builtins"
import { ReadToolFileSystem } from "./tool/read-filesystem"
import { ToolRegistry } from "./tool/registry"
import { ToolOutputStore } from "./tool-output-store"
import { Checkpoint } from "./checkpoint"
import { PromptRevisor } from "./prompt-revisor"
import { GoalAuditor } from "./goal/auditor"
import { FSUtil } from "./fs-util"

export { LocationServiceMap } from "./location-service-map"

export const locationServices = LayerNode.group([
  Location.node,
  Policy.node,
  Config.node,
  AgentV2.node,
  CommandV2.node,
  Reference.node,
  Integration.node,
  Catalog.node,
  AISDK.node,
  PluginV2.node,
  PluginInternal.node,
  ProjectCopy.node,
  ProjectCopy.refreshNode,
  ProjectInventory.node,
  FileSystemSearch.node,
  FileSystem.node,
  FileIndex.node,
  FileIndexWatcher.node,
  Watcher.node,
  Pty.node,
  SkillV2.node,
  SystemContextRegistry.node,
  SystemContextBuiltIns.node,
  LocationMutation.node,
  FileMutation.node,
  PermissionV2.node,
  ToolOutputStore.node,
  ToolRegistry.node,
  ToolRegistry.toolsNode,
  Image.node,
  SkillGuidance.node,
  ReferenceGuidance.node,
  SessionTodo.node,
  QuestionV2.node,
  ReadToolFileSystem.node,
  BuiltInTools.node,
  SessionRunnerModel.node,
  GoalAuditor.node,
  Snapshot.node,
  Checkpoint.node,
  SessionRunnerLLM.node,
  SessionTitle.node,
  PromptRevisor.node,
])

export type LocationServices = LayerNode.Output<typeof locationServices>
export type LocationError = LayerNode.Error<typeof locationServices>

/**
 * Location service identity is filesystem identity, not caller spelling.
 *
 * On Windows the same directory commonly arrives with both slash styles (and
 * sometimes different casing). Feeding those raw refs directly into LayerMap
 * creates independent long-lived location graphs: duplicate watchers, plugin
 * instances, indexes, snapshot/checkpoint services, and background work. Keep
 * the normalization at the cache boundary so every caller shares one graph.
 * `FSUtil.resolve` also collapses `.`/`..` and resolves symlinks when possible
 * on other platforms, preventing the same class of aliasing there.
 */
export function canonicalLocationRef(ref: Location.Ref): Location.Ref {
  const directory = AbsolutePath.make(FSUtil.resolve(ref.directory))
  return Location.Ref.make({ directory, workspaceID: ref.workspaceID })
}

const locationServiceNodeNames = [
  "Location", "Policy", "Config", "AgentV2", "CommandV2", "Reference", "Integration", "Catalog", "AISDK",
  "PluginV2", "PluginInternal", "ProjectCopy", "ProjectCopy.refresh", "ProjectInventory", "FileSystemSearch", "FileSystem", "FileIndex",
  "FileIndexWatcher", "Watcher", "Pty", "SkillV2", "SystemContextRegistry", "SystemContextBuiltIns", "LocationMutation",
  "FileMutation", "PermissionV2", "ToolOutputStore", "ToolRegistry", "ToolRegistry.tools", "Image", "SkillGuidance",
  "ReferenceGuidance", "SessionTodo", "QuestionV2", "ReadToolFileSystem", "BuiltInTools", "SessionRunnerModel",
  "GoalAuditor", "Snapshot", "Checkpoint", "SessionRunnerLLM", "SessionTitle", "PromptRevisor",
] as const

export function buildLocationServiceMap(
  replacements: LayerNode.Replacements = [],
): Layer.Layer<LocationServiceMap.Service> {
  return Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      const map = yield* LayerMap.make(
        (ref: Location.Ref) => {
        const missing = locationServices.dependencies.flatMap((node, index) =>
          node ? [] : [locationServiceNodeNames[index] ?? `index:${index}`],
        )
        if (missing.length > 0) {
          throw new Error(`Location service graph contains uninitialized nodes: ${missing.join(", ")}`)
        }
        const seen = new Set<LayerNode.Node<unknown, unknown, any>>()
        const inspect = (node: LayerNode.Node<unknown, unknown, any>, trail: string[]) => {
          if (seen.has(node)) return
          seen.add(node)
          for (let index = 0; index < node.dependencies.length; index++) {
            const dependency = node.dependencies[index]
            if (!dependency) {
              throw new Error(`Location service graph has undefined dependency: ${[...trail, node.name, `deps[${index}]`].join(" -> ")}`)
            }
            inspect(dependency, [...trail, node.name])
          }
        }
        inspect(locationServices, [])
        const allReplacements = replacements.concat([[Location.node, Location.boundNode(ref)]])
        // Apply replacements during hoist, not afterward: replacements can
        // introduce new tagged dependencies (Location.boundNode depends on
        // Project), and the hoist walk is the only pass that can still slice
        // those back out.
        const location = LayerNode.hoist(locationServices, Node.tags.values.global, allReplacements)

        return LayerNode.compile(location.node).pipe(
          Layer.fresh,
          Layer.tap(() =>
            Effect.logInfo("booting location services", {
              directory: ref.directory,
              workspaceID: ref.workspaceID,
            }),
          ),
          Layer.provide(LayerNode.compile(location.hoisted)),
        )
        },
        { idleTimeToLive: "60 minutes" },
      )

      // LayerMap keys complex objects by structural hash/equality, so rebuilding
      // an equivalent canonical Location.Ref is sufficient to collapse aliases.
      // Preserve the underlying rcMap for observability/introspection while
      // ensuring *every* cache operation crosses the same canonical boundary.
      return {
        ...map,
        get: (ref: Location.Ref) => map.get(canonicalLocationRef(ref)),
        contextEffect: (ref: Location.Ref) => map.contextEffect(canonicalLocationRef(ref)),
        invalidate: (ref: Location.Ref) => map.invalidate(canonicalLocationRef(ref)),
      }
    }),
  )
}

// This is temporary for backwards compatibility
export const locationServiceMapLayer = buildLocationServiceMap()
