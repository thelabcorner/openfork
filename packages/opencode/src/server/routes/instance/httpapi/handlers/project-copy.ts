import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { MessageID, SessionID } from "@/session/schema"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import { Slug } from "@opencode-ai/core/util/slug"
import type { UsageRouteAttribution } from "@opencode-ai/core/usage/route-attribution"
import { LLMEvent, LLMResponse } from "@opencode-ai/llm"
import { Usage } from "@/usage/usage"
import * as MaintenanceUsage from "@/usage/maintenance"
import { Effect, Stream } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

const COPY_NAME_AGENT: Agent.Info = {
  name: "project-copy-name",
  mode: "primary",
  permission: [],
  options: {},
  native: true,
  prompt: "",
}

const routeAttribution = (
  routed: Provider.TransientRoutedModel | undefined,
): UsageRouteAttribution.Committed | undefined =>
  routed?.route.route.kind === "account"
    ? { routeKind: "account", accountID: routed.route.route.accountID }
    : routed?.route.route.kind === "public"
      ? { routeKind: "public" }
      : undefined

export const generateProjectCopyName = Effect.fn("ProjectCopyHttpApi.generateName")(function* (input: {
  readonly context?: string
  readonly projectID: string
  readonly llm: LLM.Interface
  readonly provider: Provider.Interface
  readonly usage: Usage.Interface
}) {
      const text = input.context?.trim()
      if (!text) return Slug.create()
      const fallback = yield* input.provider.defaultModel().pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!fallback) return Slug.create()
      const candidate =
        (yield* input.provider.getSmallModel(fallback.providerID)) ??
        (yield* input.provider.getModel(fallback.providerID, fallback.modelID))
      const routed = yield* input.provider.resolveTransientRoutedModel({
        providerID: candidate.providerID,
        modelID: candidate.id,
        routeIntent: { kind: "auto" },
      })
      const model = routed?.model ?? candidate
      const route = routeAttribution(routed)
      const sessionID = SessionID.descending()
      const message = { role: "user" as const, content: `Generate a short 2-3 word name that describes this task:\n${text}` }
      const streamInput: LLM.StreamInput = {
        agent: COPY_NAME_AGENT,
        user: {
          id: MessageID.ascending(),
          sessionID,
          role: "user",
          provenance: SessionTurnProvenance.host(SessionTurnProvenance.Source.ProjectCopyName),
          time: { created: Date.now() },
          agent: COPY_NAME_AGENT.name,
          model: { providerID: model.providerID, modelID: model.id },
        },
        system: [],
        small: true,
        continuity: "isolated",
        tools: {},
        model,
        sessionID,
        retries: 2,
        messages: [message],
        ...(route ? { route } : {}),
      }
      const events: LLMEvent[] = []
      const startedAt = Date.now()
      const result = yield* input.llm.stream(streamInput).pipe(
        Stream.tap((event) => Effect.sync(() => events.push(event))),
        Stream.filter(LLMEvent.is.textDelta),
        Stream.map((event) => event.text),
        Stream.mkString,
      )
      const response = LLMResponse.fromEvents(events)
      if (response) {
        yield* MaintenanceUsage.recordResponse({
          usage: input.usage,
          agent: COPY_NAME_AGENT.name,
          model,
          ...(route ? { route } : {}),
          response,
          request: { system: streamInput.system, messages: streamInput.messages, tools: streamInput.tools },
          sessionID: null,
          projectID: input.projectID,
          startedAt,
        })
      }
      const output = result.trim()
      return output ? slugify(output.split(/\s+/).slice(0, 3).join(" ")) : Slug.create()
})

export const projectCopyHandlers = HttpApiBuilder.group(InstanceHttpApi, "projectCopyName", (handlers) =>
  Effect.gen(function* () {
    const llm = yield* LLM.Service
    const provider = yield* Provider.Service
    const usage = yield* Usage.Service

    return handlers.handle("generateName", (ctx) =>
      generateProjectCopyName({
        context: ctx.payload.context,
        projectID: ctx.params.projectID,
        llm,
        provider,
        usage,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("project copy name generation failed", {
            projectID: ctx.params.projectID,
            cause,
          }).pipe(Effect.as(Slug.create())),
        ),
        Effect.map((name) => ({ name })),
      ),
    )
  }),
)

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}
