import { createMemo, For, Show } from "solid-js"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { useLanguage } from "@/context/language"
import { DrainMeter, ToneDot, type Tone } from "@/components/limits/limit-meter"
import {
  colorForTone,
  displayWindowLabel,
  formatCountdownSeconds,
  formatPercent,
  toneForRemaining,
} from "@/utils/limits-format"
import { arcPath, arcSectors, type ArcModel, type ArcSegment } from "./limit-arc"

const CENTER = 12
const RADIUS = 7.6
const STROKE = 2.2

/**
 * Healthy sectors are drawn in the neutral icon color rather than "success
 * green". The arc lives in the composer chrome, permanently on screen — a ring
 * that is loudly green 95% of the time trains you to stop looking at it, and
 * then it fails to shout on the day it turns red. Colour is reserved for
 * pressure; depth-of-neutral is what separates the sectors from each other.
 */
function sectorColor(remaining: number | null, index: number): string {
  if (remaining === null) return "var(--v2-text-text-faint)"
  if (remaining <= 10) return "var(--v2-state-fg-danger)"
  if (remaining <= 30) return "var(--v2-state-fg-warning)"
  const depth = [78, 62, 48][index] ?? 48
  return `color-mix(in srgb, var(--v2-icon-icon-base) ${depth}%, transparent)`
}

/**
 * The ring itself.
 *
 * Every sector paints a full-length track plus a fill clipped by
 * `stroke-dashoffset` against `pathLength="1"`, so a usage change animates the
 * fill along the arc instead of swapping one `d` attribute for another — the
 * old implementation rebuilt the path per render, which cannot be transitioned
 * and popped between values. An empty sector keeps a danger-tinted track: "you
 * have nothing left here" and "this sector does not exist" must not look alike.
 */
export function LimitArcGlyph(props: { model: ArcModel; size?: number }) {
  const segments = () => props.model.segments
  const sectors = createMemo(() => arcSectors(segments().length))
  const critical = () => props.model.worst !== null && props.model.worst <= 8
  const blank = () => props.model.status !== "ready" || segments().length === 0

  return (
    <span
      class="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: `${props.size ?? 20}px`, height: `${props.size ?? 20}px` }}
    >
      <svg viewBox="0 0 24 24" class="absolute inset-0 size-full" role="presentation" aria-hidden="true">
        <Show when={blank()}>
          {/*
            Unknown is drawn as an unknown: a dashed, dim ring. Painting a full
            ring here would read as "everything is available", which is exactly
            the wrong thing to tell someone whose provider quota failed to load.
          */}
          <circle
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            fill="none"
            stroke={props.model.status === "error" ? "var(--v2-state-fg-danger)" : "currentColor"}
            stroke-width={STROKE}
            stroke-linecap="round"
            stroke-dasharray="1.6 2.6"
            opacity={props.model.status === "error" ? 0.5 : 0.28}
            classList={{ "animate-pulse": props.model.status === "loading" }}
          />
        </Show>
        <For each={segments()}>
          {(segment, index) => {
            const sector = () => sectors()[index()]
            const d = createMemo(() => arcPath(CENTER, CENTER, RADIUS, sector().start, sector().end))
            const fraction = () => Math.max(0, Math.min(1, (segment.remaining ?? 0) / 100))
            const color = () => sectorColor(segment.remaining, index())
            const drained = () => segment.remaining !== null && segment.remaining <= 0
            return (
              <g>
                <path
                  d={d()}
                  fill="none"
                  stroke={drained() ? "var(--v2-state-fg-danger)" : "currentColor"}
                  stroke-width={STROKE}
                  stroke-linecap="round"
                  opacity={drained() ? 0.32 : 0.2}
                />
                <Show when={critical() && segment.binding}>
                  <path
                    d={d()}
                    fill="none"
                    stroke={color()}
                    stroke-width={STROKE + 2}
                    stroke-linecap="round"
                    pathLength="1"
                    stroke-dasharray="1"
                    stroke-dashoffset={1 - fraction()}
                    opacity="0.28"
                    class="animate-pulse"
                  />
                </Show>
                <Show when={segment.remaining !== null && segment.remaining > 0}>
                  <path
                    d={d()}
                    fill="none"
                    stroke={color()}
                    stroke-width={STROKE}
                    stroke-linecap="round"
                    pathLength="1"
                    stroke-dasharray="1"
                    stroke-dashoffset={1 - fraction()}
                    style={{
                      transition:
                        "stroke-dashoffset 520ms cubic-bezier(0.32, 0.72, 0, 1), stroke 260ms ease-out",
                    }}
                  />
                </Show>
              </g>
            )
          }}
        </For>
      </svg>
      {/*
        The provider mark sits inside the ring so the arc answers "whose limits
        am I looking at" without a hover. It is deliberately quiet at rest and
        only resolves on hover — this is chrome, not a badge.
      */}
      <Show when={props.model.brandProviderID}>
        {(id) => (
          <ProviderIcon
            id={id()}
            class="pointer-events-none relative size-[8.5px] opacity-40 transition-opacity duration-150 group-hover:opacity-90"
            style={{ transform: "translateZ(0)" }}
          />
        )}
      </Show>
    </span>
  )
}

type Translate = (key: string, params?: Record<string, string | number | boolean>) => string

function segmentLabel(segment: ArcSegment, t: Translate) {
  if (segment.windowKey) return displayWindowLabel(segment.windowKey, t)
  return segment.literal ?? segment.id
}

function Countdown(props: { now: number; resetAt: number | null; resetAfterSeconds: number | null }) {
  const language = useLanguage()
  const seconds = createMemo(() => {
    if (props.resetAt !== null && Number.isFinite(props.resetAt)) {
      return Math.max(0, Math.round((props.resetAt - props.now) / 1000))
    }
    if (props.resetAfterSeconds !== null && Number.isFinite(props.resetAfterSeconds)) {
      return Math.max(0, Math.round(props.resetAfterSeconds))
    }
    return null
  })
  return (
    <span class="w-[68px] shrink-0 truncate text-right text-[9.5px] leading-3 tabular-nums text-v2-text-text-faint">
      <Show when={seconds() !== null} fallback={<span class="opacity-45">—</span>}>
        {formatCountdownSeconds(seconds()!, language.t)}
      </Show>
    </span>
  )
}

/**
 * The hover card. Deliberately built from the Limits pane's own primitives
 * (`ToneDot`, `DrainMeter`, `displayWindowLabel`, `formatCountdownSeconds`) so
 * that hovering the arc and opening the pane are visibly the same surface at
 * two zoom levels, not two different opinions about the same account.
 */
export function LimitArcCard(props: { model: ArcModel; modelName?: string; now: number; hint: string }) {
  const language = useLanguage()
  const model = () => props.model
  const worstTone = (): Tone => toneForRemaining(model().worst)

  return (
    <div class="pointer-events-none flex w-[268px] flex-col text-left">
      <div class="flex items-center gap-1.5 px-2.5 pb-1.5 pt-2">
        <Show when={model().brandProviderID}>
          {(id) => <ProviderIcon id={id()} class="size-3.5 shrink-0 opacity-85" />}
        </Show>
        <span class="min-w-0 flex-1 truncate text-[11px] font-[650] leading-3 text-v2-text-text-base">
          {model().providerName ?? language.t("prompt.limits.unknownProvider")}
        </span>
        <Show when={model().planLabel}>
          <span class="shrink-0 truncate text-[8px] font-[600] uppercase leading-none tracking-[0.04em] text-v2-text-text-faint">
            {model().planLabel}
          </span>
        </Show>
        <Show when={model().stale}>
          <span class="shrink-0 rounded-[3px] bg-v2-background-bg-layer-03 px-1 py-0.5 text-[7px] font-[700] uppercase leading-none tracking-[0.04em] text-v2-text-text-faint">
            {language.t("prompt.limits.cached")}
          </span>
        </Show>
      </div>

      <Show when={props.modelName || model().scope}>
        <div class="flex items-center gap-1 px-2.5 pb-1.5 text-[9.5px] leading-3 text-v2-text-text-faint">
          <Show when={props.modelName}>
            <span class="min-w-0 truncate">{props.modelName}</span>
          </Show>
          <Show when={props.modelName && model().scope}>
            <span class="opacity-50">·</span>
          </Show>
          <Show when={model().scope}>
            <span class="min-w-0 shrink-0 truncate">
              {language.t("prompt.limits.scope", { scope: model().scope! })}
            </span>
          </Show>
        </div>
      </Show>

      <Show
        when={model().status === "ready" && model().segments.length > 0}
        fallback={
          <div class="flex items-start gap-1.5 border-t border-v2-border-border-muted/60 px-2.5 py-2 text-[10px] leading-4 text-v2-text-text-faint">
            <Show when={model().status === "error"}>
              <Icon name="warning" size="small" class="mt-px size-2.5 shrink-0 text-v2-state-fg-danger" />
            </Show>
            <span class="min-w-0 flex-1">
              {model().status === "loading"
                ? language.t("prompt.limits.loading")
                : model().status === "error"
                  ? (model().error ?? language.t("prompt.limits.error"))
                  : language.t("prompt.limits.noData")}
            </span>
          </div>
        }
      >
        <div class="flex flex-col gap-[3px] border-t border-v2-border-border-muted/60 px-2.5 py-2">
          <For each={model().segments}>
            {(segment) => {
              const tone = (): Tone => toneForRemaining(segment.remaining)
              return (
                <div class="flex items-center gap-1.5" title={segment.valueLabel ?? undefined}>
                  <ToneDot tone={tone()} pulse={segment.remaining !== null && segment.remaining <= 0} />
                  <span
                    class="min-w-0 flex-1 truncate text-[10px] leading-3"
                    classList={{
                      "font-[650] text-v2-text-text-base": segment.binding,
                      "font-[480] text-v2-text-text-weaker": !segment.binding,
                    }}
                  >
                    {segmentLabel(segment, language.t)}
                  </span>
                  <DrainMeter remaining={segment.remaining} tone={tone()} dense width={52} />
                  <span
                    class="w-[38px] shrink-0 text-right text-[10px] font-[700] leading-3 tabular-nums"
                    style={{ color: colorForTone(tone()) }}
                  >
                    {formatPercent(segment.remaining, language.intl())}
                  </span>
                  <Countdown
                    now={props.now}
                    resetAt={segment.resetAt}
                    resetAfterSeconds={segment.resetAfterSeconds}
                  />
                </div>
              )
            }}
          </For>
          <Show when={model().worst !== null && model().worst! <= 30 && model().segments.some((s) => s.binding)}>
            <div class="flex items-center gap-1 pt-1 text-[9px] leading-3" style={{ color: colorForTone(worstTone()) }}>
              <Icon name="warning" size="small" class="size-2.5 shrink-0" />
              <span class="min-w-0 truncate">
                {language.t("prompt.limits.cappedBy", {
                  label: segmentLabel(model().segments.find((s) => s.binding)!, language.t),
                })}
              </span>
            </div>
          </Show>
        </div>
      </Show>

      <div class="border-t border-v2-border-border-muted/60 px-2.5 py-1.5 text-[9px] font-[480] leading-3 text-v2-text-text-faint">
        {props.hint}
      </div>
    </div>
  )
}
