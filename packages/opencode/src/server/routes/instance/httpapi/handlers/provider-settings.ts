import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Credential } from "@opencode-ai/core/credential"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Integration } from "@opencode-ai/schema/integration"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"

const configSource = (
  value: { npm?: string; models?: Record<string, unknown> } | undefined,
): "custom" | "config" =>
  value?.npm === "@ai-sdk/openai-compatible" && Object.keys(value.models ?? {}).length > 0 ? "custom" : "config"

export const providerSettingsHandlers = HttpApiBuilder.group(RootHttpApi, "provider-settings", (handlers) =>
  Effect.gen(function* () {
    const changed = (events: EventV2.Interface, integrationID: Integration.ID) =>
      Effect.all(
        [
          events.publish(Integration.Event.ConnectionUpdated, { integrationID }),
          events.publish(Integration.Event.Updated, {}),
        ],
        { discard: true },
      )

    const list = Effect.fn("ProviderSettingsHttpApi.list")(function* () {
      const models = yield* ModelsDev.Service
      const config = yield* Config.Service
      const auth = yield* Auth.Service
      const credential = yield* Credential.Service
      const [catalog, globalConfig, legacyCredentials, storedCredentials] = yield* Effect.all(
        [models.get(), config.getGlobal(), auth.all().pipe(Effect.orDie), credential.all()],
        { concurrency: 4 },
      )
      const saved = Map.groupBy(storedCredentials, (item) => String(item.integrationID))
      const configured = globalConfig.provider ?? {}
      const disabled = new Set(globalConfig.disabled_providers ?? [])
      const enabled = globalConfig.enabled_providers ? new Set(globalConfig.enabled_providers) : undefined
      const ids = new Set([...Object.keys(catalog), ...Object.keys(configured)])

      return {
        providers: [...ids]
          .filter((id) => !disabled.has(id) && (!enabled || enabled.has(id)))
          .map((id) => {
            const modelProvider = catalog[id]
            const configuredProvider = configured[id]
            const env = configuredProvider?.env ?? modelProvider?.env ?? []
            const hasEnvironment = env.some((name) => !!process.env[name])
            const hasConfig = configuredProvider !== undefined
            const credentialConnections = (saved.get(id) ?? [])
              .toReversed()
              .map((item) => ({
                type: "credential" as const,
                id: item.id,
                label: item.label,
                ...(item.active ? { active: true as const } : {}),
              }))
            const envConnections = env.filter((name) => !!process.env[name]).map((name) => ({ type: "env" as const, name }))
            const connections = [...credentialConnections, ...envConnections]
            const source = hasConfig
              ? configSource(configuredProvider)
              : hasEnvironment
                ? ("env" as const)
                : ("api" as const)
            const hasPaidModels = Object.values(modelProvider?.models ?? {}).some(
              (model) => (model.cost?.input ?? 0) > 0 || (model.cost?.output ?? 0) > 0,
            )
            return {
              id,
              name: configuredProvider?.name ?? modelProvider?.name ?? id,
              source,
              connected: connections.length > 0 || legacyCredentials[id] !== undefined || hasConfig,
              hasPaidModels,
              connections,
            }
          })
          .sort((a, b) => a.id.localeCompare(b.id)),
      }
    })

    const modelList = Effect.fn("ProviderSettingsHttpApi.models")(function* () {
      const models = yield* ModelsDev.Service
      const config = yield* Config.Service
      const auth = yield* Auth.Service
      const credential = yield* Credential.Service
      const [catalog, globalConfig, legacyCredentials, storedCredentials] = yield* Effect.all(
        [models.get(), config.getGlobal(), auth.all().pipe(Effect.orDie), credential.all()],
        { concurrency: 4 },
      )
      const saved = Map.groupBy(storedCredentials, (item) => String(item.integrationID))
      const configured = globalConfig.provider ?? {}
      const disabled = new Set(globalConfig.disabled_providers ?? [])
      const enabled = globalConfig.enabled_providers ? new Set(globalConfig.enabled_providers) : undefined
      const ids = new Set([...Object.keys(catalog), ...Object.keys(configured)])
      const output: Array<{
        providerID: string
        providerName: string
        modelID: string
        name: string
        family?: string
        releaseDate: string
      }> = []

      for (const id of ids) {
        if (disabled.has(id) || (enabled && !enabled.has(id))) continue
        const modelProvider = catalog[id]
        const configuredProvider = configured[id]
        const env = configuredProvider?.env ?? modelProvider?.env ?? []
        const connected =
          env.some((name) => !!process.env[name]) ||
          legacyCredentials[id] !== undefined ||
          (saved.get(id)?.length ?? 0) > 0 ||
          configuredProvider !== undefined
        if (!connected) continue

        const providerName = configuredProvider?.name ?? modelProvider?.name ?? id
        const seen = new Set<string>()
        for (const [modelID, model] of Object.entries(modelProvider?.models ?? {})) {
          seen.add(modelID)
          output.push({
            providerID: id,
            providerName,
            modelID,
            name: model.name ?? modelID,
            family: model.family,
            releaseDate: model.release_date ?? "",
          })
        }
        for (const [modelID, model] of Object.entries(configuredProvider?.models ?? {})) {
          if (seen.has(modelID)) continue
          output.push({
            providerID: id,
            providerName,
            modelID,
            name: model.name ?? modelID,
            releaseDate: model.release_date ?? "",
          })
        }
      }

      output.sort(
        (a, b) =>
          a.providerName.localeCompare(b.providerName) ||
          a.name.localeCompare(b.name) ||
          a.modelID.localeCompare(b.modelID),
      )
      return { models: output }
    })

    const connectKey = Effect.fn("ProviderSettingsHttpApi.connectKey")(function* (ctx: {
      params: { providerID: Integration.ID }
      payload: { key: string; label?: string }
    }) {
      const credential = yield* Credential.Service
      const events = yield* EventV2.Service
      yield* credential.add({
        integrationID: ctx.params.providerID,
        label: ctx.payload.label,
        value: Credential.Key.make({ type: "key", key: ctx.payload.key }),
      })
      yield* changed(events, ctx.params.providerID)
      return HttpApiSchema.NoContent.make()
    })

    const credentialUpdate = Effect.fn("ProviderSettingsHttpApi.credentialUpdate")(function* (ctx: {
      params: { credentialID: Credential.ID }
      payload: { label: string }
    }) {
      const credential = yield* Credential.Service
      const events = yield* EventV2.Service
      const current = yield* credential.get(ctx.params.credentialID)
      yield* credential.update(ctx.params.credentialID, { label: ctx.payload.label })
      if (current) yield* changed(events, current.integrationID)
      return HttpApiSchema.NoContent.make()
    })

    const credentialRemove = Effect.fn("ProviderSettingsHttpApi.credentialRemove")(function* (ctx: {
      params: { credentialID: Credential.ID }
    }) {
      const credential = yield* Credential.Service
      const events = yield* EventV2.Service
      const current = yield* credential.get(ctx.params.credentialID)
      yield* credential.remove(ctx.params.credentialID)
      if (current) yield* changed(events, current.integrationID)
      return HttpApiSchema.NoContent.make()
    })

    const credentialSelect = Effect.fn("ProviderSettingsHttpApi.credentialSelect")(function* (ctx: {
      params: { credentialID: Credential.ID }
    }) {
      const credential = yield* Credential.Service
      const events = yield* EventV2.Service
      const current = yield* credential.get(ctx.params.credentialID)
      yield* credential.select(ctx.params.credentialID)
      if (current) yield* changed(events, current.integrationID)
      return HttpApiSchema.NoContent.make()
    })

    return handlers
      .handle("list", list)
      .handle("models", modelList)
      .handle("connectKey", connectKey)
      .handle("credentialUpdate", credentialUpdate)
      .handle("credentialRemove", credentialRemove)
      .handle("credentialSelect", credentialSelect)
  }),
)
