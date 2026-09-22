import { Component, Show, createMemo, onCleanup } from "solid-js"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { ModelSelectorPopoverV2, type ModelSelectorModelState } from "@/components/dialog-select-model"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { stripUnlimitedSuffix } from "@/utils/model-badges"
import { SettingsModelCatalogScope, useSettingsModelCatalogScope } from "./model-catalog-scope"

export type SettingsModelRef = { providerID: string; modelID: string }

type SettingsModelPickerProps = {
  value: SettingsModelRef | undefined
  defaultLabel: string
  action: string
  onChange: (value: SettingsModelRef | undefined) => void
  compact?: boolean
}

function tryUseModels() {
  try {
    return useModels()
  } catch {
    return undefined
  }
}

export const SettingsModelPickerV2: Component<SettingsModelPickerProps> = (props) => {
  // Session/composer surfaces already own a ModelsProvider. Routed settings do
  // not, so fall back to the narrow lazy catalog scope rather than manufacturing
  // a full Local/session context tree per picker.
  if (tryUseModels()) return <SettingsModelPickerContent {...props} />
  return (
    <SettingsModelCatalogScope>
      <SettingsModelPickerContent {...props} />
    </SettingsModelCatalogScope>
  )
}

const SettingsModelPickerContent: Component<SettingsModelPickerProps> = (props) => {
  const language = useLanguage()
  const models = useModels()
  const scope = useSettingsModelCatalogScope()
  const pickerToken = {}
  onCleanup(() => scope?.setPickerOpen(pickerToken, false))

  const selected = createMemo(() => {
    const saved = props.value
    if (!saved) return undefined
    return models.find(saved)
  })
  const recent = createMemo(() =>
    models.recent.list().flatMap((key) => {
      const item = models.find(key)
      return item ? [item] : []
    }),
  )
  const model = {
    current: selected,
    recent,
    list: models.list,
    set: (value: SettingsModelRef | undefined) => {
      props.onChange(value ? { providerID: value.providerID, modelID: value.modelID } : undefined)
    },
    visible: models.visible,
    favorite: models.favorite,
    subProvider: models.subProvider,
    order: models.order,
  } satisfies ModelSelectorModelState
  const label = createMemo(() => {
    const item = selected()
    if (item) return stripUnlimitedSuffix(item.name)
    const saved = props.value
    if (saved) return `${saved.providerID}/${saved.modelID}`
    return props.defaultLabel
  })

  return (
    <div class="flex min-w-0 items-center gap-1.5">
      <ModelSelectorPopoverV2
        model={model}
        directory={scope?.directory()}
        placement="bottom-end"
        commitSelectionBeforeClose
        lightweight
        onOpenChange={(open) => scope?.setPickerOpen(pickerToken, open)}
        trigger={(triggerProps) => (
          <button
            {...triggerProps}
            type="button"
            data-action={props.action}
            class={
              props.compact
                ? "inline-flex h-5 max-w-[180px] items-center gap-1 rounded-sm px-1.5 pe-1 text-[10px] font-[540] leading-3 text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base"
                : "inline-flex h-6 max-w-[220px] items-center gap-1 rounded-sm px-2 pe-1 text-[13px] font-[530] leading-4 text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover"
            }
          >
            <Show when={selected()?.provider.id ?? props.value?.providerID}>
              {(providerID) => (
                <ProviderIcon
                  id={providerID()}
                  class={props.compact ? "size-3 shrink-0 opacity-70" : "size-3.5 shrink-0 opacity-70"}
                />
              )}
            </Show>
            <span class="min-w-0 truncate" dir="auto">
              {label()}
            </span>
            <Icon
              name="chevron-down"
              class={
                props.compact ? "size-3 shrink-0 text-v2-icon-icon-muted" : "size-4 shrink-0 text-v2-icon-icon-muted"
              }
            />
          </button>
        )}
      />
      <Show when={props.value}>
        <TooltipV2 placement="top" gutter={4} value={props.defaultLabel}>
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="small"
            icon={<Icon name="close" />}
            aria-label={language.t("common.clear")}
            onClick={() => props.onChange(undefined)}
          />
        </TooltipV2>
      </Show>
    </div>
  )
}
