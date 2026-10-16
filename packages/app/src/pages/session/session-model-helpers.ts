import type { UserMessage } from "@opencode-ai/sdk/v2"
import { effectiveStrategy, type Info as ProviderRouteIntentInfo } from "@opencode-ai/schema/model-select/provider-route-intent"
import { isHostedAccountProvider } from "../../components/model-hosted-account-selection"

type Local = {
  session: {
    reset(): void
    restore(msg: UserMessage): void
  }
}

type ModelSelection = {
  model: {
    current(): { id: string; provider: { id: string } } | undefined
    set(model: { providerID: string; modelID: string; routeIntent?: ProviderRouteIntentInfo }): void
    routeIntent?: { current(): ProviderRouteIntentInfo | undefined }
    variant: {
      current(): string | undefined
      set(variant: string | undefined): void
    }
  }
}

type PromptState = {
  model: {
    current(): { providerID: string; modelID: string; variant?: string | null; routeIntent?: ProviderRouteIntentInfo } | undefined
    set(model: { providerID: string; modelID: string; variant?: string | null; routeIntent?: ProviderRouteIntentInfo }): void
  }
}

const sameRouteIntent = (providerID: string, left?: ProviderRouteIntentInfo, right?: ProviderRouteIntentInfo) => {
  // For hosted providers, absence of a persisted override and a legacy
  // unqualified intent both select Adaptive. Avoid state ping-pong between
  // composer and session model stores after restoring older histories.
  if (
    isHostedAccountProvider(providerID) &&
    (!left || left.kind === "auto") &&
    (!right || right.kind === "auto")
  ) return effectiveStrategy(left) === effectiveStrategy(right)
  if (left?.kind !== right?.kind) return false
  if (left?.kind === "auto" && right?.kind === "auto")
    return effectiveStrategy(left) === effectiveStrategy(right)
  if (left?.kind === "account" && right?.kind === "account")
    return left.accountID === right.accountID && left.pin === right.pin
  return true
}

export const resetSessionModel = (local: Local) => {
  local.session.reset()
}

export const syncSessionModel = (local: Local, msg: UserMessage) => {
  local.session.restore(msg)
}

export const syncPromptModel = (local: ModelSelection, prompt: PromptState) => {
  const model = local.model.current()
  if (!model) return
  const next = {
    providerID: model.provider.id,
    modelID: model.id,
    variant: local.model.variant.current(),
    routeIntent: local.model.routeIntent?.current(),
  }
  const current = prompt.model.current()
  if (
    current?.providerID === next.providerID &&
    current.modelID === next.modelID &&
    current.variant === next.variant &&
    sameRouteIntent(next.providerID, current.routeIntent, next.routeIntent)
  ) return
  prompt.model.set(next)
}

export const restorePromptModel = (local: ModelSelection, prompt: PromptState) => {
  const model = prompt.model.current()
  if (!model) return false
  const current = local.model.current()
  if (
    current?.provider.id === model.providerID &&
    current.id === model.modelID &&
    local.model.variant.current() === (model.variant ?? undefined) &&
    sameRouteIntent(model.providerID, local.model.routeIntent?.current(), model.routeIntent)
  )
    return true
  local.model.set({ providerID: model.providerID, modelID: model.modelID, routeIntent: model.routeIntent })
  local.model.variant.set(model.variant ?? undefined)
  return true
}
