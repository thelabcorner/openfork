import { Component, Show, createMemo } from "solid-js"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { ModelSelectorPopoverV2 } from "@/components/dialog-select-model"
import { useLanguage } from "@/context/language"
import { useLocal } from "@/context/local"
import { stripUnlimitedSuffix } from "@/utils/model-badges"

export type SettingsModelRef = { providerID: string; modelID: string }

export const SettingsModelPickerV2: Component<{
  value: SettingsModelRef | undefined
  defaultLabel: string
  action: string
  onChange: (value: SettingsModelRef | undefined) => void
}> = (props) => {
  const language = useLanguage()
  const local = useLocal()
  const model = {
    ...local.model,
    current: () => {
      const saved = props.value
      if (!saved) return undefined
      return local.model.list().find((item) => item.provider.id === saved.providerID && item.id === saved.modelID)
    },
    set: (value: SettingsModelRef | undefined) => {
      props.onChange(value ? { providerID: value.providerID, modelID: value.modelID } : undefined)
    },
  }
  const selected = createMemo(() => model.current())
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
        placement="bottom-end"
        trigger={(triggerProps) => (
          <button
            {...triggerProps}
            type="button"
            data-action={props.action}
            class="inline-flex h-6 max-w-[220px] items-center gap-1 rounded-sm px-2 pe-1 text-[13px] font-[530] leading-4 text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover"
          >
            <Show when={selected()?.provider.id ?? props.value?.providerID}>
              {(providerID) => <ProviderIcon id={providerID()} class="size-3.5 shrink-0 opacity-70" />}
            </Show>
            <span class="min-w-0 truncate" dir="auto">
              {label()}
            </span>
            <Icon name="chevron-down" class="size-4 shrink-0 text-v2-icon-icon-muted" />
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
