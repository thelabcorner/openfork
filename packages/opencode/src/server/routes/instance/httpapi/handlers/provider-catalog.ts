import { AbsolutePath } from "@opencode-ai/core/schema"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Database } from "@opencode-ai/core/database/database"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { eq } from "drizzle-orm"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Effect, Option, Schema } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { ConfigPaths } from "@/config/paths"
import { ConfigParse } from "@/config/parse"
import { ProviderCatalogApi } from "../groups/provider-catalog"
import * as ProviderCatalog from "@/provider/catalog"
import { mergeDeep } from "remeda"
import path from "path"

function providerConfig(info: typeof ConfigV1.Info.Type) {
  return {
    provider: info.provider,
    enabled_providers: info.enabled_providers,
    disabled_providers: info.disabled_providers,
  }
}

export const providerCatalogHandlers = HttpApiBuilder.group(ProviderCatalogApi, "providerCatalog", (handlers) =>
  handlers.handle(
    "list",
    Effect.fn("ProviderCatalogHttpApi.list")(function* (ctx) {
      const fs = yield* FSUtil.Service
      let directory = (ctx.query.directory ?? ctx.request.headers["x-opencode-directory"])?.trim()
      if (ctx.query.workspace) {
        const workspaceID = Schema.decodeUnknownOption(WorkspaceV2.ID)(ctx.query.workspace)
        if (Option.isNone(workspaceID)) return yield* new HttpApiError.BadRequest({})
        const { db } = yield* Database.Service
        const workspace = yield* db
          .select({ directory: WorkspaceTable.directory })
          .from(WorkspaceTable)
          .where(eq(WorkspaceTable.id, workspaceID.value))
          .get()
          .pipe(Effect.orDie)
        if (!workspace?.directory) return yield* new HttpApiError.BadRequest({})
        // Workspace identity is authoritative if directory was omitted. If
        // both were supplied they must identify the same location.
        if (directory && (yield* fs.resolve(directory)) !== workspace.directory) {
          return yield* new HttpApiError.BadRequest({})
        }
        directory = workspace.directory
      }
      let files: string[]
      let owner: string | undefined
      if (!directory) {
        files = ConfigPaths.serverFilesInDirectory(Global.Path.config)
      } else {
        if (!path.isAbsolute(directory)) return yield* new HttpApiError.BadRequest({})
        owner = yield* fs.resolve(directory)
        const project = yield* ProjectV2.Service
        const resolved = yield* project.resolve(AbsolutePath.make(owner)).pipe(Effect.orDie)
        files = [
          ...ConfigPaths.serverFilesInDirectory(Global.Path.config),
          ...(yield* ConfigPaths.serverFiles(owner, resolved.directory).pipe(Effect.orDie)),
        ]
      }

      let config: typeof ConfigV1.Info.Type = {}
      for (const file of files) {
        const text = yield* fs.readFileStringSafe(file).pipe(Effect.orDie)
        if (!text) continue
        const parsed = ConfigParse.jsonc(text, file)
        const decoded = ConfigParse.schema(ConfigV1.Info, parsed, file)
        config = mergeDeep(config, decoded)
      }

      return yield* ProviderCatalog.Service.use((service) =>
        service.list({ ...(owner ? { directory: owner } : {}), config: providerConfig(config) }),
      )
    }),
  ),
)
