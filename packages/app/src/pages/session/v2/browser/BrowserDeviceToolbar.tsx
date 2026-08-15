// Browser device toolbar: viewport mode (fill/freeform/preset), preset picker,
// orientation + rotate, aspect lock, and the element-badge toggle. Dense v2
// zinc (h-7 bar, 11px labels). The toolbar NEVER changes the guest CSS
// viewport directly — it only edits the ViewportSetting, which the
// presentation layer maps through zoomFactor * fit scale.

import { Show, createEffect, createMemo, createSignal, For } from "solid-js"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { useLanguage } from "@/context/language"
import { BROWSER_DEVICE_PRESETS, resolveBrowserDevicePreset, type BrowserDeviceNameKey } from "./browserPresets"
import { aspectRatioOf, resizeAtAspectRatio } from "./browserViewportLayout"
import {
  browserViewportSettingKey,
  VIEWPORT_MAX_AREA,
  VIEWPORT_MAX_SIZE,
  VIEWPORT_MIN_SIZE,
  type DeviceOrientation,
  type ViewportSetting,
  type ViewportMode,
} from "./types"

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

  const presetOptions = createMemo(() => [...BROWSER_DEVICE_PRESETS])

  const switchMode = (mode: ViewportMode) => {
    const next: ViewportSetting = { ...props.setting, mode }
    if (mode === "preset") {
      const fallback = resolveBrowserDevicePreset("ipad-air") ?? presetOptions()[0]
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

  // Exact-dimension inputs: typed as strings so transient invalid states
  // (empty, mid-edit) don't get clobbered by re-renders. Resynced from the
  // authoritative setting whenever it changes externally (rotate, preset
  // pick, mode switch, or our own committed edit) — never while the user is
  // simply typing, since that doesn't touch props.setting.
  const [draftWidth, setDraftWidth] = createSignal("")
  const [draftHeight, setDraftHeight] = createSignal("")

  createEffect(() => {
    void browserViewportSettingKey(props.setting)
    setDraftWidth(props.setting.width != null ? String(props.setting.width) : "")
    setDraftHeight(props.setting.height != null ? String(props.setting.height) : "")
  })

  function parseDimension(raw: string): number | null {
    const trimmed = raw.trim()
    if (!/^\d+$/.test(trimmed)) return null
    const value = Number(trimmed)
    if (value < VIEWPORT_MIN_SIZE || value > VIEWPORT_MAX_SIZE) return null
    return value
  }

  // While aspect lock is on, the ratio comes from the last COMMITTED size
  // (props.setting), not the live drafts — matches the resize-handle path:
  // "aspect lock is local UI state that derives the current ratio from the
  // latest fixed viewport," not a value that drifts as the drafts change.
  const lockedRatio = createMemo(() =>
    props.aspectRatioLocked ? aspectRatioOf(props.setting.width ?? 0, props.setting.height ?? 0) : null,
  )

  const onWidthInput = (value: string) => {
    setDraftWidth(value)
    const ratio = lockedRatio()
    const width = parseDimension(value)
    if (!ratio || width == null) return
    setDraftHeight(String(resizeAtAspectRatio({ width, height: width / ratio }, "width", ratio).height))
  }

  const onHeightInput = (value: string) => {
    setDraftHeight(value)
    const ratio = lockedRatio()
    const height = parseDimension(value)
    if (!ratio || height == null) return
    setDraftWidth(String(resizeAtAspectRatio({ width: height * ratio, height }, "height", ratio).width))
  }

  const submitDimensions = (event: SubmitEvent) => {
    event.preventDefault()
    const width = parseDimension(draftWidth())
    const height = parseDimension(draftHeight())
    if (width == null || height == null || width * height > VIEWPORT_MAX_AREA) return
    // Typing an exact size is a manual override, same as dragging a rail —
    // it converts a preset to freeform rather than silently keeping a preset
    // identity that no longer matches the entered dimensions.
    props.onChange({ ...props.setting, mode: "freeform", presetId: null, width, height })
  }

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
      class="flex h-7 shrink-0 items-center gap-1 border-b border-v2-border-border-base bg-v2-background-bg-base px-1.5"
    >
      <div class="flex items-center gap-0.5 rounded-[5px] bg-v2-background-bg-layer-01 p-0.5" role="group" aria-label={language.t("browser.viewportMode")}>
        <For each={MODES}>{(mode) => segButton(mode)}</For>
      </div>

      {/* Dimensions live right next to the mode switch in every mode: an
          editable W×H form for freeform/preset, a read-only live readout for
          fill (its size is derived from the panel, not user-set). */}
      <Show
        when={props.setting.mode !== "fill"}
        fallback={
          <div
            class="flex h-6 items-center rounded-[4px] bg-v2-background-bg-layer-01 px-1.5 text-[11px] leading-none tabular-nums text-v2-text-text-muted"
            data-browser-viewport-readout
          >
            W {props.fillSize.width} × H {props.fillSize.height}
          </div>
        }
      >
        <form class="flex h-6 items-center gap-1" onSubmit={submitDimensions} data-browser-dimension-form>
          <span class="text-[10px] text-v2-text-text-muted" aria-hidden="true">
            W
          </span>
          <input
            class="h-6 w-11 rounded-[4px] border border-transparent bg-v2-background-bg-layer-01 px-1 text-center text-[11px] leading-none tabular-nums text-v2-text-text-base outline-none transition-colors duration-100 focus:border-v2-border-border-strong aria-[invalid=true]:border-v2-text-text-warning"
            value={draftWidth()}
            onInput={(event) => onWidthInput(event.currentTarget.value)}
            inputmode="numeric"
            aria-label={language.t("browser.dimension.width")}
            aria-invalid={parseDimension(draftWidth()) == null}
            data-testid="browser-viewport-width"
          />
          <span class="text-[10px] text-v2-text-text-muted" aria-hidden="true">
            ×
          </span>
          <span class="text-[10px] text-v2-text-text-muted" aria-hidden="true">
            H
          </span>
          <input
            class="h-6 w-11 rounded-[4px] border border-transparent bg-v2-background-bg-layer-01 px-1 text-center text-[11px] leading-none tabular-nums text-v2-text-text-base outline-none transition-colors duration-100 focus:border-v2-border-border-strong aria-[invalid=true]:border-v2-text-text-warning"
            value={draftHeight()}
            onInput={(event) => onHeightInput(event.currentTarget.value)}
            inputmode="numeric"
            aria-label={language.t("browser.dimension.height")}
            aria-invalid={parseDimension(draftHeight()) == null}
            data-testid="browser-viewport-height"
          />
        </form>
      </Show>

      <Show when={props.setting.mode === "preset"}>
        <SelectV2<string>
          appearance="inline"
          class="h-6 w-[9.5rem] text-[11px]"
          options={presetOptions().map((p) => p.id)}
          value={(id) => id}
          label={(id) => language.t((resolveBrowserDevicePreset(id)?.nameKey ?? "browser.device.ipad-air") as BrowserDeviceNameKey)}
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
