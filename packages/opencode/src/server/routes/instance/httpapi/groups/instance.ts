import { Command } from "@/command"
import { Format } from "@/format"
import { LSP } from "@/lsp/lsp"
import { Vcs } from "@/project/vcs"
import { Skill } from "@/skill"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"

export const VcsDiffQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  mode: Vcs.Mode,
  context: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
})

export class ApiVcsApplyError extends Schema.ErrorClass<ApiVcsApplyError>("VcsApplyError")(
  {
    name: Schema.Literal("VcsApplyError"),
    data: Schema.Struct({
      message: Schema.String,
      reason: Schema.Literals(["non-git", "not-clean"]),
    }),
  },
  { httpApiStatus: 400 },
) {}

export const InstancePaths = {
  dispose: "/instance/dispose",
  path: "/path",
  vcs: "/vcs",
  vcsStatus: "/vcs/status",
  vcsDiff: "/vcs/diff",
  vcsDiffRaw: "/vcs/diff/raw",
  vcsApply: "/vcs/apply",
  command: "/command",
  agent: "/agent",
  skill: "/skill",
  lsp: "/lsp",
  formatter: "/formatter",
} as const

export const InstanceApi = HttpApi.make("instance")
  .add(
    HttpApiGroup.make("instance")
      .add(
        HttpApiEndpoint.post("dispose", InstancePaths.dispose, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Instance disposed"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "instance.dispose",
            summary: "Dispose instance",
            description: "Clean up and dispose the current OpenFork instance, releasing all resources.",
          }),
        ),
        HttpApiEndpoint.get("vcsStatus", InstancePaths.vcsStatus, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Vcs.FileStatus), "VCS status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.status",
            summary: "Get VCS status",
            description: "Retrieve changed files in the current working tree without patches.",
          }),
        ),
        HttpApiEndpoint.get("vcsDiff", InstancePaths.vcsDiff, {
          query: VcsDiffQuery,
          success: described(Schema.Array(Vcs.FileDiff), "VCS diff"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.diff",
            summary: "Get VCS diff",
            description: "Retrieve the current git diff for the working tree or against the default branch.",
          }),
        ),
        HttpApiEndpoint.get("vcsDiffRaw", InstancePaths.vcsDiffRaw, {
          query: WorkspaceRoutingQuery,
          success: described(
            Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/x-diff; charset=utf-8" })),
            "Raw VCS diff",
          ),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.diff.raw",
            summary: "Get raw VCS diff",
            description: "Retrieve a raw patch for current uncommitted changes.",
          }),
        ),
        HttpApiEndpoint.post("vcsApply", InstancePaths.vcsApply, {
          query: WorkspaceRoutingQuery,
          payload: Vcs.ApplyInput,
          success: described(Vcs.ApplyResult, "VCS patch applied"),
          error: ApiVcsApplyError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.apply",
            summary: "Apply VCS patch",
            description: "Apply a raw patch to the current working tree.",
          }),
        ),
        HttpApiEndpoint.get("command", InstancePaths.command, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Command.Info), "List of commands"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "command.list",
            summary: "List commands",
            description: "Get a list of all available commands in the OpenFork system.",
          }),
        ),
        HttpApiEndpoint.get("skill", InstancePaths.skill, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Skill.Info), "List of skills"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "app.skills",
            summary: "List skills",
            description: "Get a list of all available skills in the OpenFork system.",
          }),
        ),
        HttpApiEndpoint.get("lsp", InstancePaths.lsp, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(LSP.Status), "LSP server status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "lsp.status",
            summary: "Get LSP status",
            description: "Get LSP server status",
          }),
        ),
        HttpApiEndpoint.get("formatter", InstancePaths.formatter, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Format.Status), "Formatter status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "formatter.status",
            summary: "Get formatter status",
            description: "Get formatter status",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "instance",
          description: "Experimental HttpApi instance read routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "OpenFork experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )

// Branch metadata is a Tier-1 read: it needs the explicit workspace location
// and Git identity only, not VCS watchers or a runtime Instance.
export const VcsBranchApi = HttpApi.make("vcs-branch")
  .add(
    HttpApiGroup.make("vcs-branch")
      .add(
        HttpApiEndpoint.get("vcs", InstancePaths.vcs, {
          query: WorkspaceRoutingQuery,
          success: described(Vcs.Info, "VCS info"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.get",
            summary: "Get VCS info",
            description: "Retrieve version control branch metadata for the explicitly routed workspace.",
          }),
        ),
      )
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "OpenFork VCS branch metadata",
      version: "0.0.1",
      description: "Explicit-location branch metadata without execution instance bootstrap.",
    }),
  )
