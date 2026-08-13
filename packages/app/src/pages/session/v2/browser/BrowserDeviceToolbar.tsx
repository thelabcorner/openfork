// Browser device toolbar: viewport mode (fill/freeform/preset), preset picker,
// orientation + rotate, aspect lock, and the element-badge toggle. Dense v2
// zinc (h-7 bar, 11px labels). The toolbar NEVER changes the guest CSS
// viewport directly — it only edits the ViewportSetting, which the
// presentation layer maps through zoomFactor * fit scale.

import { Show, createMemo, createSignal, For } from "solid-js"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { useLanguage } from "@/context/language"
import { BROWSER_DEVICE_PRESETS, resolveBrowserDevicePreset, type BrowserDeviceNameKey } from "./browserPresets"
import { browserViewportSettingKey, type DeviceOrientation, type ViewportSetting, type ViewportMode } from "./types"

const MODES: readonly ViewportMode[] = ["fill", "freeform", "preset"]

function modeLabel(mode: ViewportMode): "browser.mode.fill" | "browser.mode.freeform" | "browser.mode.preset" {
  switch (mode) {
    case "fill":
      return "browser.mode.fill"
    case "freeform":
      return "browser.mode.freeform"
    case "preset":
      return "browser.mode.preset"
  }
}

export function BrowserDeviceToolbar(props: {
  setting: ViewportSetting
  fillSize: { width: number; height: number }
  aspectRatioLocked: boolean
  badgesVisible: boolean
  onChange: (setting: ViewportSetting) => void
  onAspectRatioChange: (locked: boolean) => void
  onBadgesToggle: () => void
}) {
  const language = useLanguage()

  const preset = createMemo(() => resolveBrowserDevicePreset(props.setting.presetId))
  const presetOptions = createMemo(() => [...BROWSER_DEVICE_PRESETS])

  const switchMode = (mode: ViewportMode) => {
    const next: ViewportSetting = { ...props.setting, mode }
    if (mode === "preset") {
      const fallback = resolveBrowserDevicePreset("laptop") ?? presetOptions()[0]
      next.presetId = props.setting.presetId ?? fallback.id
      next.width = fallback.width
      next.height = fallback.height
    } else if (mode === "freeform") {
      next.width = props.setting.width ?? props.fillSize.width
      next.height = props.setting.height ?? props.fillSize.height
      next.presetId = null
    } else if (mode === "fill") {
      next.width = null
      next.height = null
      next.presetId = null
    }
    props.onChange(next)
  }

  const selectPreset = (id: string | null) => {
    if (!id) return
    const chosen = resolveBrowserDevicePreset(id)
    if (!chosen) return
    const width = props.setting.orientation === "landscape" ? Math.max(chosen.width, chosen.height) : Math.min(chosen.width, chosen.height)
    const height = props.setting.orientation === "landscape" ? Math.min(chosen.width, chosen.height) : Math.max(chosen.width, chosen.height)
    props.onChange({ ...props.setting, presetId: chosen.id, width, height, mode: "preset" })
  }

  const rotate = () => {
    const orientation: DeviceOrientation = props.setting.orientation === "landscape" ? "portrait" : "landscape"
    const width = props.setting.height
    const height = props.setting.width
    props.onChange({ ...props.setting, orientation, width, height })
  }

  const readout = createMemo(() => {
    if (props.setting.width == null || props.setting.height == null) return null
    return `${props.setting.width} × ${props.setting.height}`
  })

  const segButton = (mode: ViewportMode) => (
    <button
      type="button"
      data-active={props.setting.mode === mode || undefined}
      class={`h-6 rounded-[4px] px-2 text-[11px] leading-none transition-colors duration-100 ${
        props.setting.mode === mode
          ? "bg-v2-background-bg-layer-03 text-v2-text-text-base"
          : "text-v2-text-text-muted hover:text-v2-text-text-base"
      }`}
      onClick={() => switchMode(mode)}
    >
      {language.t(modeLabel(mode))}
    </button>
  )

  return (
    <div
      data-browser-device-toolbar
      class="pointer-events-auto absolute inset-x-0 top-0 z-30 flex h-7 items-center gap-1 border-b border-v2-border-border-base bg-v2-background-bg-base/90 px-1.5 backdrop-blur-sm"
    >
      <div class="flex items-center gap-0.5 rounded-[5px] bg-v2-background-bg-layer-01 p-0.5" role="group" aria-label={language.t("browser.viewportMode")}>
        <For each={MODES}>{(mode) => segButton(mode)}</For>
      </div>

      <Show when={props.setting.mode === "preset"}>
        <SelectV2<string>
          appearance="inline"
          class="h-6 w-[9.5rem] text-[11px]"
          options={presetOptions().map((p) => p.id)}
          value={(id) => id}
          label={(id) => language.t((resolveBrowserDevicePreset(id)?.nameKey ?? "browser.device.laptop") as BrowserDeviceNameKey)}
          current={props.setting.presetId ?? undefined}
          onSelect={(id) => selectPreset(id ?? null)}
        />
      </Show>

      <Show when={props.setting.mode !== "fill"}>
        <button
          type="button"
          data-active={props.setting.orientation === "landscape" || undefined}
          class="flex h-6 items-center gap-1 rounded-[4px] px-1.5 text-[11px] leading-none text-v2-text-text-muted transition-colors duration-100 hover:bg-v2-background-bg-layer-02 hover:text-v2-text-text-base"
          title={language.t("browser.rotate")}
          aria-label={language.t("browser.rotate")}
          onClick={rotate}
        >
          <RotateIcon />
        </button>
        <button
          type="button"
          data-active={props.aspectRatioLocked || undefined}
          class={`flex h-6 items-center gap-1 rounded-[4px] px-1.5 text-[11px] leading-none transition-colors duration-100 ${
            props.aspectRatioLocked
              ? "bg-v2-background-bg-layer-03 text-v2-text-text-base"
              : "text-v2-text-text-muted hover:bg-v2-background-bg-layer-02 hover:text-v2-text-text-base"
          }`}
          title={language.t("browser.aspectLock")}
          aria-pressed={props.aspectRatioLocked}
          onClick={() => props.onAspectRatioChange(!props.aspectRatioLocked)}
        >
          <AspectLockIcon locked={props.aspectRatioLocked} />
        </button>
      </Show>

      <div class="flex-1" />

      <Show when={readout()}>
        <div class="flex h-6 items-center rounded-[4px] px-1.5 text-[11px] leading-none tabular-nums text-v2-text-text-muted" data-browser-viewport-readout>
          {readout()}
        </div>
      </Show>

      <button
        type="button"
        data-active={props.badgesVisible || undefined}
        class={`flex h-6 items-center gap-1 rounded-[4px] px-1.5 text-[11px] leading-none transition-colors duration-100 ${
          props.badgesVisible
            ? "bg-v2-background-bg-layer-03 text-v2-text-text-base"
            : "text-v2-text-text-muted hover:bg-v2-background-bg-layer-02 hover:text-v2-text-text-base"
        }`}
        title={language.t("browser.badges.toggle")}
        aria-pressed={props.badgesVisible}
        onClick={props.onBadgesToggle}
      >
        <BadgeIcon />
        <span>{language.t("browser.badges")}</span>
      </button>

      <span class="sr-only">{browserViewportSettingKey(props.setting)}</span>
    </div>
  )
}

function RotateIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 8V3.5M13.5 8h-4.5"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  )
}

function AspectLockIcon(props: { locked: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.5" y="6.5" width="11" height="7" rx="1" stroke="currentColor" stroke-width="1.3" />
      <path d="M5.5 6.5V4.8a2.5 2.5 0 0 1 5 0v1.7" stroke="currentColor" stroke-width="1.3" />
      {props.locked ? <path d="M8 9.5v2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /> : null}
    </svg>
  )
}

function BadgeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.3" />
      <path d="M5 8h6M8 5v6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
    </svg>
  )
}
