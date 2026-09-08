import { Effect, Layer, LayerMap } from "effect"
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

const locationServiceNodeNames = [
  "Location", "Policy", "Config", "AgentV2", "CommandV2", "Reference", "Integration", "Catalog", "AISDK",
  "PluginV2", "PluginInternal", "ProjectCopy", "ProjectCopy.refresh", "FileSystemSearch", "FileSystem", "FileIndex",
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
    LayerMap.make(
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
    ),
  )
}

// This is temporary for backwards compatibility
export const locationServiceMapLayer = buildLocationServiceMap()
