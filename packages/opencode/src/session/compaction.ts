import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Session } from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/storage"

import { Effect, Layer, Context } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { isOverflow as overflow, usable } from "./overflow"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { ProviderRouteResolution } from "@opencode-ai/core/provider-route-resolution"
import type { UsageRouteAttribution } from "@opencode-ai/core/usage/route-attribution"
import { buildPrompt } from "@opencode-ai/core/session/compaction"
import { SessionCompactionEvent } from "@opencode-ai/schema/session-compaction-event"
import { ToolOutputProjection } from "@opencode-ai/core/tool-output-projection"
import { hasUsableCompactionCheckpoint } from "./compaction-checkpoint"
import { firstFittingSuffix, isMonotoneTextSuffix } from "./lace-checkpoint-retention"

export const Event = SessionCompactionEvent

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const TOOL_OUTPUT_MAX_BYTES = 2_000
const PRUNE_PROTECTED_TOOLS = ["skill"]
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 15_000
const COMPACTION_OUTPUT_RESERVE = 2_000
const COMPACTION_TIER_ORDER = ["small", "medium", "large"] as const
type CompactionTier = (typeof COMPACTION_TIER_ORDER)[number]

const usageRoute = (
  route?: ProviderRouteResolution.RouteAttribution,
): UsageRouteAttribution.Committed | undefined => {
  if (!route) return undefined
  return route.routeKind === "account"
    ? { routeKind: "account", accountID: route.accountID! }
    : { routeKind: "public" }
}

/** Secret-free settlement attribution of a one-call (non-durable) route. */
const transientUsageRoute = (routed: Provider.TransientRoutedModel): UsageRouteAttribution.Committed =>
  routed.route.route.kind === "account"
    ? { routeKind: "account", accountID: routed.route.route.accountID }
    : { routeKind: "public" }

function parseCompactionModel(value: string): { providerID: ProviderV2.ID; modelID: ModelV2.ID } | undefined {
  const trimmed = value.trim()
  if (!trimmed || !trimmed.includes("/")) return undefined
  const [providerID, ...rest] = trimmed.split("/")
  if (!providerID || rest.length === 0) return undefined
  const modelID = rest.join("/")
  if (!modelID) return undefined
  return { providerID: ProviderV2.ID.make(providerID), modelID: ModelV2.ID.make(modelID) }
}
type Turn = {
  start: number
  end: number
  id: MessageID
}

type Tail = {
  start: number
  id: MessageID
}

type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

export const compactToolOutput = (value: string) =>
  ToolOutputProjection.project(value, {
    maxLines: Number.MAX_SAFE_INTEGER,
    maxBytes: TOOL_OUTPUT_MAX_BYTES,
    marker: "[tool output truncated; showing beginning + end]",
    strategy: "balanced",
  }).content

const serialize = (message: SessionV1.WithParts) => {
  // Goal spec/progress are STATE-shaped projections, including imported
  // historical snapshots. Historical lifetime revokes live authority but does
  // not make stale domain STATE suitable for an immutable compaction summary.
  // The runner republishes current authoritative state after compaction.
  if (SessionTurnProvenance.hasStateSemanticsTurn(message)) return ""
  if (message.info.role === "user") {
    const text = message.parts
      .filter((part): part is SessionV1.TextPart => part.type === "text" && !part.ignored)
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n")
    const files = message.parts.flatMap((part) =>
      part.type === "file" ? [`[Attached ${part.mime}: ${part.filename ?? "file"}]`] : [],
    )
    const kind = SessionTurnProvenance.semanticKind(message)
    const label =
      kind === "user"
        ? "User"
        : kind === "shell"
          ? "Shell context"
          : kind === "compaction"
            ? "Compaction context"
            : "Synthetic context"
    return [...(text ? [`[${label}]: ${text}`] : []), ...files].join("\n")
  }
  return message.parts
    .flatMap((part) => {
      if (part.type === "text") return part.text ? [`[Assistant]: ${part.text}`] : []
      if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
      if (part.type !== "tool") return []
      const call = `[Assistant tool call]: ${part.tool}(${JSON.stringify(part.state.input)})`
      if (part.state.status === "completed") {
        const attachments = (part.state.attachments ?? []).map(
          (item) => `[Attached ${item.mime}: ${item.filename ?? "file"}]`,
        )
        const output = part.state.time.compacted
          ? "[Old tool result content cleared]"
          : compactToolOutput([part.state.output, ...attachments].join("\n"))
        return [call, `[Tool result]: ${output}`]
      }
      if (part.state.status === "error") return [call, `[Tool error]: ${part.state.error}`]
      return [call]
    })
    .join("\n")
}

function summaryText(message: SessionV1.WithParts) {
  const text = message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

function completedCompactions(messages: SessionV1.WithParts[]) {
  const users = new Map<MessageID, { index: number; checkpointID?: MessageID }>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    const marker = msg.parts.find((part): part is SessionV1.CompactionPart => part.type === "compaction")
    if (!marker || marker.pending === true) continue
    users.set(msg.info.id, { index: i, checkpointID: marker.checkpoint_message_id })
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant" || !hasUsableCompactionCheckpoint(msg)) return []
    const marker = users.get(msg.info.parentID)
    if (!marker || (marker.checkpointID && marker.checkpointID !== msg.info.id)) return []
    return [{ userIndex: marker.index, assistantIndex, summary: summaryText(msg) }]
  })
}

function preserveRecentBudget(input: { cfg: ConfigV1.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

function turns(messages: SessionV1.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (!SessionTurnProvenance.isSemanticUserTurn(msg)) continue
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

function splitTurn(input: {
  messages: SessionV1.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: SessionV1.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    // A long sequence of finished text-only assistant messages is monotone
    // under the V1 model-message projection: dropping the oldest message
    // cannot make the suffix larger. Use exact suffix estimates with a
    // logarithmic number of projections instead of reserializing every
    // successively shorter suffix (quadratic on pathological turns).
    //
    // All complex turns retain the existing conservative linear search:
    // provider continuation, tool causality, and multimedia parts need
    // dedicated atomicity and serialization proof before binary search.
    const suffix = input.messages.slice(input.turn.start + 1, input.turn.end)
    if (isMonotoneTextSuffix(suffix)) {
      const starts = suffix.map((_, index) => input.turn.start + index + 1)
      const start = yield* firstFittingSuffix({
        starts,
        budget: input.budget,
        estimate: (start) =>
          input.estimate({
            messages: input.messages.slice(start, input.turn.end),
            model: input.model,
          }),
      })
      return start === undefined ? undefined : { start, id: input.messages[start]!.info.id }
    }
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      const size = yield* input.estimate({
        messages: input.messages.slice(start, input.turn.end),
        model: input.model,
      })
      if (size > input.budget) continue
      return {
        start,
        id: input.messages[start]!.info.id,
      } satisfies Tail
    }
    return undefined
  })
}

export interface Interface {
  readonly isOverflow: (input: {
    tokens: SessionV1.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
  readonly process: (input: {
    parentID: MessageID
    messages: SessionV1.WithParts[]
    sessionID: SessionID
    auto: boolean
    continueAfter?: boolean
    overflow?: boolean
    route?: ProviderRouteResolution.RouteAttribution
  }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    /** Canonical worker-root turn; compaction is a derived host boundary, never a new authority root. */
    sourceMessageID: MessageID
    auto: boolean
    continueAfter?: boolean
    overflow?: boolean
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: SessionV1.Assistant["tokens"]
      model: Provider.Model
    }) {
      return overflow({
        cfg: yield* config.get(),
        tokens: input.tokens,
        model: input.model,
        outputTokenMax: flags.outputTokenMax,
      })
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: SessionV1.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      return Token.estimate(JSON.stringify(msgs))
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: SessionV1.WithParts[]
      cfg: ConfigV1.Info
      model: Provider.Model
    }) {
      const limit = input.cfg.compaction?.tail_turns
      if (limit !== undefined && limit <= 0) return { head: input.messages, tail_start_id: undefined }
      const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const all = turns(input.messages)
      if (!all.length) return { head: input.messages, tail_start_id: undefined }
      const recent = limit === undefined ? all : all.slice(-limit)

      let total = 0
      let keep: Tail | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]!
        // estimate lazily so cost stays proportional to the retained tail, not the whole session
        const size = yield* estimate({
          messages: input.messages.slice(turn.start, turn.end),
          model: input.model,
        })
        if (total + size <= budget) {
          total += size
          keep = { start: turn.start, id: turn.id }
          continue
        }
        const remaining = budget - total
        const split = yield* splitTurn({
          messages: input.messages,
          turn,
          model: input.model,
          budget: remaining,
          estimate,
        })
        if (split) keep = split
        else if (!keep) {
          yield* Effect.logInfo("tail fallback", { budget, size, total })
        }
        break
      }

      if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined }
      return {
        head: input.messages.slice(0, keep.start),
        tail_start_id: keep.id,
      }
    })

    type CompactionResolvedCandidate = {
      readonly tier: CompactionTier
      readonly model: Provider.Model
      readonly route?: ProviderRouteResolution.RouteAttribution
      /**
       * Secret-free settlement attribution for a transient route. A one-call
       * route has no durable lease, so it cannot reuse `route`/`lease`.
       */
      readonly usage?: UsageRouteAttribution.Committed
      readonly lease?: ProviderRouteResolution.ProviderRouteLease
      readonly ref: { providerID: ProviderV2.ID; modelID: ModelV2.ID; accountID?: string }
    }

    const resolveTierCandidates = Effect.fn("SessionCompaction.resolveTierCandidates")(function* (input: {
      cfg: ConfigV1.Info
      sessionID: SessionID
      route?: ProviderRouteResolution.RouteAttribution
      agentModel?: { providerID: ProviderV2.ID; modelID: ModelV2.ID; accountID?: string }
    }) {
      const raw = input.cfg.compaction?.models
      const tierDefs: Array<{
        tier: CompactionTier
        raw?: string
        ref?: { providerID: ProviderV2.ID; modelID: ModelV2.ID; accountID?: string }
      }> = [
        { tier: "small", raw: raw?.small },
        { tier: "medium", raw: raw?.medium },
        { tier: "large", raw: raw?.large },
      ]
      if (!tierDefs[2]!.raw && input.agentModel) {
        tierDefs[2] = { tier: "large", ref: input.agentModel }
      }

      const candidates: CompactionResolvedCandidate[] = []
      for (const def of tierDefs) {
        const parsed:
          | { providerID: ProviderV2.ID; modelID: ModelV2.ID; accountID?: string }
          | undefined = def.ref ?? (def.raw ? parseCompactionModel(def.raw) : undefined)
        if (!parsed) {
          if (def.raw) {
            yield* Effect.logWarning("compaction tier model parse failed", { tier: def.tier, raw: def.raw })
          }
          continue
        }

        if (
          input.route?.providerID === parsed.providerID &&
          !(Provider.isHostedZenProvider(parsed.providerID) && input.route.routeKind === "public")
        ) {
          const inherited = yield* provider
            .resolveInheritedRoutedModel({
              sessionID: input.sessionID,
              providerID: parsed.providerID,
              modelID: parsed.modelID,
              route: input.route,
              executionPurpose: "special-agent",
            })
            .pipe(Effect.option)
          if (inherited._tag === "None") {
            yield* Effect.logWarning("compaction tier model unavailable on committed route", {
              tier: def.tier,
              providerID: parsed.providerID,
              modelID: parsed.modelID,
            })
            continue
          }
          candidates.push({
            tier: def.tier,
            model: inherited.value.model,
            route: inherited.value.route.attribution,
            lease: inherited.value.route.lease,
            ref: parsed,
          })
          continue
        }

        // Configured compaction tiers/agent models are explicit maintenance
        // overrides. A provider distinct from the parent may use its own
        // provider/account, but maintenance must never create or rebind a
        // durable ProviderRoute row on the parent Session. Resolve one
        // non-persistent route and settle it under its own attribution.
        const routed = yield* provider
          .resolveTransientRoutedModel({
            providerID: parsed.providerID,
            modelID: parsed.modelID,
            ...(parsed.accountID
              ? { accountID: parsed.accountID }
              : { routeIntent: { kind: "auto" as const } }),
            executionPurpose: "special-agent",
          })
          .pipe(Effect.option)
        if (routed._tag === "None") {
          yield* Effect.logWarning("compaction override route unavailable", {
            tier: def.tier,
            providerID: parsed.providerID,
            modelID: parsed.modelID,
          })
          continue
        }
        if (routed.value) {
          if (Provider.isHostedZenProvider(parsed.providerID) && routed.value.route.route.kind !== "account") continue
          candidates.push({
            tier: def.tier,
            model: routed.value.model,
            usage: transientUsageRoute(routed.value),
            ref: parsed,
          })
          continue
        }

        // Only providers the OpenCode routing domain does not own may keep the
        // mature direct-provider path. A hosted provider that reached this point
        // has no authoritative route, so spending an ambient credential (or the
        // hosted Public free tier) here is exactly the regression to prevent.
        if (Provider.isHostedZenProvider(parsed.providerID)) {
          yield* Effect.logWarning("compaction override skipped: hosted provider has no authoritative route", {
            tier: def.tier,
            providerID: parsed.providerID,
            modelID: parsed.modelID,
          })
          continue
        }

        const direct = yield* provider
          .getModel(parsed.providerID, parsed.modelID, parsed.accountID)
          .pipe(Effect.option)
        if (direct._tag === "None") {
          yield* Effect.logWarning("compaction tier model unavailable", {
            tier: def.tier,
            providerID: parsed.providerID,
            modelID: parsed.modelID,
          })
          continue
        }
        candidates.push({ tier: def.tier, model: direct.value, ref: parsed })
      }

      candidates.sort((a, b) => {
        const ca = a.model.limit.context || Number.MAX_SAFE_INTEGER
        const cb = b.model.limit.context || Number.MAX_SAFE_INTEGER
        return ca - cb
      })
      return candidates
    })

    const pickCompactionModel = Effect.fn("SessionCompaction.pickCompactionModel")(function* (input: {
      candidates: CompactionResolvedCandidate[]
      needed: number
      fallback: Provider.Model
      fallbackRoute?: ProviderRouteResolution.RouteAttribution
      fallbackLease?: ProviderRouteResolution.ProviderRouteLease
      fallbackUsage?: UsageRouteAttribution.Committed
    }) {
      if (input.candidates.length === 0) {
        return {
          model: input.fallback,
          tier: "session" as const,
          route: input.fallbackRoute,
          lease: input.fallbackLease,
          ...(input.fallbackUsage ? { usage: input.fallbackUsage } : {}),
        }
      }
      for (const c of input.candidates) {
        const ctx = c.model.limit.context
        if (!ctx || ctx === 0) return c
        if (input.needed < ctx - COMPACTION_OUTPUT_RESERVE) return c
      }
      const largest = input.candidates.at(-1)!
      const largestCtx = largest.model.limit.context || Number.MAX_SAFE_INTEGER
      if (input.needed < largestCtx - COMPACTION_OUTPUT_RESERVE) return largest
      yield* Effect.logWarning("compaction prompt exceeds all tier contexts, falling back to session model", {
        needed: input.needed,
        tiers: input.candidates.map((c) => ({ tier: c.tier, context: c.model.limit.context })),
        fallback: input.fallback.limit.context,
      })
      return {
        model: input.fallback,
        tier: "session" as const,
        route: input.fallbackRoute,
        lease: input.fallbackLease,
        ...(input.fallbackUsage ? { usage: input.fallbackUsage } : {}),
      }
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return
      yield* Effect.logInfo("pruning")

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      // Only an admitted, promoted checkpoint is a pruning barrier. A blank,
      // interrupted or still-pending attempt must not prematurely terminate
      // tool-output reduction in the surviving full history.
      const admittedSummaries = new Set(
        completedCompactions(msgs).map((entry) => msgs[entry.assistantIndex]!.info.id),
      )
      let total = 0
      let pruned = 0
      const toPrune: SessionV1.ToolPart[] = []
      let turns = 0

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (SessionTurnProvenance.isSemanticUserTurn(msg)) turns++
        if (turns < 2) continue
        if (msg.info.role === "assistant" && admittedSummaries.has(msg.info.id)) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          if (part.state.time.compacted) break loop
          const estimate = Token.estimate(part.state.output)
          total += estimate
          if (total <= PRUNE_PROTECT) continue
          pruned += estimate
          toPrune.push(part)
        }
      }

      yield* Effect.logInfo("found", { pruned, total })
      if (pruned > PRUNE_MINIMUM) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            part.state.time.compacted = Date.now()
            yield* session.updatePart(part)
          }
        }
        yield* Effect.logInfo("pruned", { count: toPrune.length })
      }
    })

    const processCompactionEffect = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: SessionV1.WithParts[]
      sessionID: SessionID
      auto: boolean
      continueAfter?: boolean
      overflow?: boolean
      route?: ProviderRouteResolution.RouteAttribution
    }) {
      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const compactionPart = parent.parts.find((part): part is SessionV1.CompactionPart => part.type === "compaction")

      let messages = input.messages
      let replay:
        | {
            info: SessionV1.User
            parts: SessionV1.Part[]
          }
        | undefined
      if (input.overflow) {
        const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = input.messages[i]
          if (SessionTurnProvenance.isSemanticUserTurn(msg) && msg.info.role === "user") {
            replay = { info: msg.info, parts: msg.parts }
            messages = input.messages.slice(0, i)
            break
          }
        }
        const hasContent = replay && messages.some(SessionTurnProvenance.isSemanticUserTurn)
        if (!hasContent) {
          replay = undefined
          messages = input.messages
        }
      }

      const agent = yield* agents.get("compaction")
      const cfg = yield* config.get()
      let sessionModel: Provider.Model
      let sessionRoute: ProviderRouteResolution.RouteAttribution | undefined
      let sessionLease: ProviderRouteResolution.ProviderRouteLease | undefined
      let sessionUsage: UsageRouteAttribution.Committed | undefined
      if (
        input.route &&
        !(Provider.isHostedZenProvider(userMessage.model.providerID) && input.route.routeKind === "public")
      ) {
        const inherited = yield* provider
          .resolveInheritedRoutedModel({
            sessionID: input.sessionID,
            providerID: userMessage.model.providerID,
            modelID: userMessage.model.modelID,
            route: input.route,
            executionPurpose: "special-agent",
          })
          .pipe(Effect.orDie)
        sessionModel = inherited.model
        sessionRoute = inherited.route.attribution
        sessionLease = inherited.route.lease
      } else {
        // No usable committed parent route (legacy Session, or a worker bound
        // to OpenCode-only Public). Choose an account-backed transient route
        // for this one compaction, never changing the parent's durable binding.
        // Maintenance still must not spend an ambient hosted credential:
        // resolve one transient route, fail closed for a hosted provider, and
        // keep the direct-provider path only for providers the OpenCode
        // routing domain positively declines to own.
        const transient = yield* provider
          .resolveTransientRoutedModel({
            providerID: userMessage.model.providerID,
            modelID: userMessage.model.modelID,
            ...(userMessage.model.accountID
              ? { accountID: userMessage.model.accountID }
              : { routeIntent: { kind: "auto" as const } }),
            executionPurpose: "special-agent",
          })
          .pipe(Effect.option)
        if (transient._tag === "Some" && transient.value &&
            (!Provider.isHostedZenProvider(userMessage.model.providerID) || transient.value.route.route.kind === "account")) {
          sessionModel = transient.value.model
          sessionUsage = transientUsageRoute(transient.value)
        } else if (Provider.isHostedZenProvider(userMessage.model.providerID)) {
          return yield* new Provider.RouteResolutionError({
            providerID: userMessage.model.providerID,
            modelID: userMessage.model.modelID,
            cause: new Error(
              "No authoritative OpenCode route resolved for this hosted compaction request; refusing ambient credential fallback",
            ),
          })
        } else {
          sessionModel = yield* provider
            .getModel(userMessage.model.providerID, userMessage.model.modelID, userMessage.model.accountID)
            .pipe(Effect.orDie)
        }
      }
      const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      const prior = completedCompactions(history)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      // Budget/select is gated on the session model window (overflow predicate) — not the tier model.
      const selected = yield* select({
        messages: history.filter((_, index) => !hidden.has(index)),
        cfg,
        model: sessionModel,
      })
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      // Provider-context transforms operate on an isolated copy only; compaction
      // selection remains authoritative historical input and must not be mutated
      // by plugin code.
      const msgs = yield* plugin.transformChatMessages(selected.head)
      const conversation = msgs.map(serialize).filter(Boolean).join("\n\n")
      const customPrompt = cfg.compaction?.prompt?.trim() ? cfg.compaction.prompt.trim() : undefined
      const nextPrompt =
        compacting.prompt ??
        [
          buildPrompt({
            previousSummary,
            context: [conversation],
            customPrompt,
          }),
          ...compacting.context,
        ]
          .filter(Boolean)
          .join("\n\n")
      // Tier-aware model selection: pick smallest tier whose window fits the prompt + reserve.
      const needed = Token.estimate(nextPrompt) + COMPACTION_OUTPUT_RESERVE
      const tierCandidates = yield* resolveTierCandidates({
        cfg,
        sessionID: input.sessionID,
        ...(sessionRoute ? { route: sessionRoute } : {}),
        agentModel: agent.model,
      })
      const picked = yield* pickCompactionModel({
        candidates: tierCandidates,
        needed,
        fallback: sessionModel,
        ...(sessionRoute ? { fallbackRoute: sessionRoute } : {}),
        ...(sessionLease ? { fallbackLease: sessionLease } : {}),
        ...(sessionUsage ? { fallbackUsage: sessionUsage } : {}),
      })
      const model = picked.model
      const selectedRoute = picked.route
      const selectedLease = picked.lease
      // A transient cross-provider override settles under its own one-call
      // attribution. It has no durable lease, so never forward one for it.
      const selectedUsage = picked.usage ?? usageRoute(selectedRoute)
      yield* Effect.logInfo("compaction tier selected", {
        sessionID: input.sessionID,
        tier: picked.tier,
        providerID: model.providerID,
        modelID: model.id,
        needed,
        context: model.limit.context,
        headSize: selected.head.length,
        routeKind: selectedUsage?.routeKind ?? "legacy",
        routeAccountID: selectedUsage?.accountID ?? null,
      })
      const ctx = yield* InstanceState.context
      const msg: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        variant: userMessage.model.variant,
        summary: true,
        path: {
          cwd: ctx.directory,
          root: ctx.worktree,
        },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
        },
      }
      yield* session.updateMessage(msg)
      const processor = yield* processors.create({
        assistantMessage: msg,
        sessionID: input.sessionID,
        model,
        durableHistory: messages,
        ...(selectedUsage ? { routeAttribution: selectedUsage } : {}),
        ...(selectedLease ? { routeLease: selectedLease } : {}),
      })
      const result = yield* processor.process({
        user: userMessage,
        agent,
        sessionID: input.sessionID,
        tools: {},
        system: [],
        continuity: "isolated",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: [
                  nextPrompt,
                  ...(compacting.prompt ? ["The following is the conversation history:", conversation] : []),
                ]
                  .filter(Boolean)
                  .join("\n\n"),
              },
            ],
          },
        ],
        model,
      })

      if (result === "compact") {
        processor.message.error = new SessionV1.ContextOverflowError({
          message: replay
            ? "Conversation history too large to compact - exceeds model context limit"
            : "Session too large to compact - context exceeds model limit even after stripping media",
        }).toObject()
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        return "stop"
      }

      // Inference completing is not proof of a promotable checkpoint. The
      // persisted text/finish state, not the processor's return code, is what
      // the effective-history reader will consume after restart. Check it
      // before committing a tail boundary or admitting auto-continuation.
      const currentMessages = yield* session.messages({ sessionID: input.sessionID })
      const checkpoint = currentMessages.find((item) => item.info.id === msg.id)
      const currentMarker = currentMessages
        .find((item) => item.info.id === input.parentID)?.parts
        .find((part): part is SessionV1.CompactionPart => part.type === "compaction")
      // A stale runner cannot intentionally replace an already promoted
      // candidate. This is a defensive check, NOT a substitute for a DB CAS
      // transaction when concurrent compaction owners race after this read.
      if (compactionPart && (!currentMarker || (
        currentMarker.pending !== true &&
        currentMarker.checkpoint_message_id &&
        currentMarker.checkpoint_message_id !== msg.id
      ))) {
        processor.message.error = new SessionV1.APIError({
          message: "Compaction checkpoint superseded by another committed attempt.",
          isRetryable: false,
        }).toObject()
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        return "stop"
      }
      if (processor.message.error || !checkpoint || !hasUsableCompactionCheckpoint(checkpoint)) {
        if (!processor.message.error) {
          processor.message.error = new SessionV1.APIError({
            message: "Compaction produced no complete usable text checkpoint; original history was retained.",
            isRetryable: false,
          }).toObject()
        }
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        yield* Effect.logWarning("compaction checkpoint rejected", {
          sessionID: input.sessionID,
          checkpointID: msg.id,
          hasPersistedMessage: Boolean(checkpoint),
        })
        return "stop"
      }

      if (currentMarker && (
        currentMarker.pending === true ||
        currentMarker.checkpoint_message_id !== msg.id ||
        (selected.tail_start_id && currentMarker.tail_start_id !== selected.tail_start_id)
      )) {
        yield* session.updatePart({
          ...currentMarker,
          ...(currentMarker.pending === true ? { pending: false } : {}),
          checkpoint_message_id: msg.id,
          ...(selected.tail_start_id ? { tail_start_id: selected.tail_start_id } : {}),
        })
      }

      const hasNewerUserMessage = currentMessages.some(
        (message) =>
          SessionTurnProvenance.isSemanticUserTurn(message) &&
          message.info.id !== input.parentID &&
          (message.info.time.created > userMessage.time.created ||
            (message.info.time.created === userMessage.time.created && message.info.id > userMessage.id)),
      )

      if (result === "continue" && (input.auto || input.continueAfter) && !hasNewerUserMessage) {
        if (replay) {
          const original = replay.info
          const replayMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            provenance: SessionTurnProvenance.hostDerived(SessionTurnProvenance.Source.CompactionReplay, replay.info),
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: original.agent,
            model: original.model,
            format: original.format,
            tools: original.tools,
            system: original.system,
          })
          for (const part of replay.parts) {
            if (part.type === "compaction") continue
            const replayPart =
              part.type === "file" && MessageV2.isMedia(part.mime)
                ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                : part
            yield* session.updatePart({
              ...replayPart,
              id: PartID.ascending(),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
            })
          }
        }

        if (!replay) {
          const info = yield* provider.getProvider(userMessage.model.providerID)
          if (
            (yield* plugin.trigger(
              "experimental.compaction.autocontinue",
              {
                sessionID: input.sessionID,
                agent: userMessage.agent,
                model: sessionModel,
                provider: {
                  source: info.source,
                  info,
                  options: info.options,
                },
                message: userMessage,
                overflow: input.overflow === true,
              },
              { enabled: true },
            )).enabled
          ) {
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              provenance: SessionTurnProvenance.hostDerived(SessionTurnProvenance.Source.CompactionContinue, parent.info),
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: userMessage.agent,
              model: userMessage.model,
            })
            const text =
              (input.overflow
                ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                : "") +
              "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              // Internal marker for auto-compaction followups so provider plugins
              // can distinguish them from manual post-compaction user prompts.
              // This is not a stable plugin contract and may change or disappear.
              metadata: { compaction_continue: true },
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }
      }

      if (processor.message.error) return "stop"
      if (result === "continue") {
        yield* events.publish(Event.Compacted, { sessionID: input.sessionID })
      }
      return result
    })
    // Wrap the Effect.fn builder in a real callable: errors are unexpected
    // here (the compaction driver owns failure handling), so surface them as
    // defects instead of leaking a NotFoundError channel.
    const processCompaction: Interface["process"] = (input) =>
      processCompactionEffect(input).pipe(Effect.orDie)

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID; accountID?: string }
      sourceMessageID: MessageID
      auto: boolean
      continueAfter?: boolean
      overflow?: boolean
    }) {
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        provenance: SessionTurnProvenance.host(SessionTurnProvenance.Source.Compaction, {
          sourceMessageID: input.sourceMessageID,
        }),
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        pending: true,
        ...(input.continueAfter ? { continueAfter: true } : {}),
        overflow: input.overflow,
      })
    })

    return Service.of({
      isOverflow,
      prune,
      process: processCompaction,
      create,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Config.node,
    Session.node,
    Agent.node,
    Plugin.node,
    SessionProcessor.node,
    Provider.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
  ],
})

export * as SessionCompaction from "./compaction"
