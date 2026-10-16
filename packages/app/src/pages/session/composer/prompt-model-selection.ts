import { batch, createMemo, startTransition } from "solid-js"
import { useModels } from "@/context/models"
import type { ModelKey, ModelSelection } from "@/context/local"
import { cycleModelVariant, getConfiguredAgentVariant, resolveModelVariant } from "@/context/model-variant"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useProviders } from "@/hooks/use-providers"
import { resolveDefaultModel } from "@/hooks/provider-catalog"
import { Model as ModelContract } from "@opencode-ai/schema/model"
import { splitModelIDForProvider } from "@/utils/model-account-identity"

export function createPromptModelSelection(input: { agent: () => { model?: ModelKey; variant?: string } | undefined }) {
  const sdk = useSDK()
  const sync = useSync()
  const models = useModels()
  const prompt = usePrompt()
  const providers = useProviders(() => sdk().directory)
  const connected = createMemo(() => new Set(providers.connected().map((item) => item.id)))

  const valid = (model: ModelKey) => {
    const provider = providers.all().get(model.providerID)
    if (!provider || !connected().has(model.providerID)) return false
    const exact = provider.models[model.modelID]
    if (exact) return ModelContract.isLanguageModel(provider.id, exact)
    const base = splitModelIDForProvider(model.modelID, model.providerID).baseModelID
    const resolved = provider.models[base]
    return base !== model.modelID && !!resolved && ModelContract.isLanguageModel(provider.id, resolved)
  }

  const configured = () => {
    const model = resolveDefaultModel(providers.defaultModel(), sync().data.config.model)
    if (!model) return
    if (valid(model)) return model
  }

  const recent = () => models.recent.list().find(valid)
  const fallback = () => {
    const defaults = providers.default()
    return providers.connected().flatMap((provider) => {
      const preferred = defaults[provider.id]
      const preferredModel = preferred ? provider.models[preferred] : undefined
      const modelID =
        preferredModel && ModelContract.isLanguageModel(provider.id, preferredModel)
          ? preferred
          : Object.values(provider.models).find(
              (model) => ModelContract.isLanguageModel(provider.id, model),
            )?.id
      return modelID ? [{ providerID: provider.id, modelID }] : []
    })[0]
  }

  const currentKey = () =>
    [prompt.model.current(), input.agent()?.model, configured(), recent(), fallback()].find(
      (item): item is ModelKey => !!item && valid(item),
    )
  const current = () => {
    const key = currentKey()
    if (!key) return
    return models.find(key)
  }
  const recentModels = createMemo(() =>
    models.recent
      .list()
      .map(models.find)
      .filter((item): item is NonNullable<typeof item> => !!item),
  )

  const selection = {
    ready: models.ready,
    current,
    routeIntent: {
      current: () => currentKey()?.routeIntent,
    },
    recent: recentModels,
    list: models.list,
    cycle(direction: 1 | -1) {
      const items = recentModels()
      const item = current()
      if (!item) return
      const index = items.findIndex((entry) => entry.provider.id === item.provider.id && entry.id === item.id)
      if (index === -1) return
      const next = items[(index + direction + items.length) % items.length]
      if (next) selection.set({ providerID: next.provider.id, modelID: next.id })
    },
    set(item: ModelKey | undefined, options?: { recent?: boolean }) {
      // A model choice is the next prompt's execution input. Do not defer it
      // behind a transition: submit may run immediately after the picker closes.
      batch(() => {
        const previous = prompt.model.current()
        if (
          item &&
          !item.routeIntent &&
          previous?.providerID === item.providerID &&
          previous.routeIntent?.kind === "auto" &&
          !splitModelIDForProvider(item.modelID, item.providerID).accountID
        ) {
          item = { ...item, routeIntent: previous.routeIntent }
        }
        // A caller that explicitly supplies a variant (for example, adopting
        // the currently running model) wins. Ordinary model-picker changes
        // keep the user's current variant when the new model supports it.
        prompt.model.set(item ? { ...item, variant: item.variant ?? prompt.model.current()?.variant } : undefined)
        if (!item) return
        models.setVisibility(item, true)
        if (options?.recent) models.recent.push(item)
      })
    },
    visible: models.visible,
    setVisibility: models.setVisibility,
    favorite: {
      isFavorite: models.favorite.isFavorite,
      toggle: models.favorite.toggle,
    },
    subProvider: {
      current() {
        const model = current()
        if (!model) return
        return models.subProvider.get({ providerID: model.provider.id, modelID: model.id })
      },
      get(item: ModelKey) {
        return models.subProvider.get({ providerID: item.providerID, modelID: item.modelID })
      },
      set(item: ModelKey, value: string | undefined) {
        models.subProvider.set({ providerID: item.providerID, modelID: item.modelID }, value)
      },
    },
    order: {
      get: models.order.get,
      set: models.order.set,
      clear: models.order.clear,
    },
    variant: {
      configured() {
        const item = input.agent()
        const model = current()
        if (!item || !model) return
        return getConfiguredAgentVariant({
          agent: { model: item.model, variant: item.variant },
          model: { providerID: model.provider.id, modelID: model.id, variants: model.variants },
        })
      },
      selected() {
        return prompt.model.current()?.variant
      },
      current() {
        const resolved = resolveModelVariant({
          variants: this.list(),
          selected: this.selected(),
          configured: this.configured(),
        })
        if (resolved) return resolved
        const model = current()
        if (!model) return
        const saved = models.variant.get({ providerID: model.provider.id, modelID: model.id })
        if (saved && this.list().includes(saved)) return saved
      },
      list() {
        return Object.keys(current()?.variants ?? {})
      },
      set(value: string | undefined) {
        startTransition(() =>
          batch(() => {
            const model = current()
            if (!model) return
            prompt.model.set({
              providerID: model.provider.id,
              modelID: model.id,
              variant: value ?? null,
              routeIntent: prompt.model.current()?.routeIntent,
            })
            models.variant.set({ providerID: model.provider.id, modelID: model.id }, value)
          }),
        )
      },
      cycle() {
        const variants = this.list()
        if (variants.length === 0) return
        this.set(
          cycleModelVariant({
            variants,
            selected: this.selected(),
            configured: this.configured(),
          }),
        )
      },
    },
  } satisfies ModelSelection

  return selection
}
