import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { OxpActivityHeader } from "@/pages/oxp/oxp-activity-header"
import { OxpTimeline, type OxpTimelineSource } from "@/pages/oxp/oxp-timeline"
import { OxpInvocationDetail, type DetailState } from "@/pages/oxp/oxp-invocation-detail"
import { toolIdentity } from "@/pages/oxp/oxp-presentation"
import { say } from "@/pages/oxp/oxp-phrase"
import { useLanguage } from "@/context/language"
import { LAB_ACTIVITY, LAB_DETAILS, LAB_INVOCATIONS } from "./fixtures"
import "@/pages/oxp/oxp-activity.css"
import "./lab.css"

/**
 * OXP activity transcript lab. DEV-ONLY.
 *
 * Mounts the product's own `OxpActivityHeader` and `OxpTimeline` — not a
 * lookalike — against fixtures shaped like the real recorder output, so the
 * composition, density and every state can be reviewed without a running
 * sidecar. Detail payloads resolve behind a simulated latency so the lazy fetch,
 * the skeleton, and the cached re-open are all reviewable.
 */

type Scenario = "populated" | "empty" | "loading" | "error" | "noDetail" | "details"

const SCENARIOS: { id: Scenario; label: string }[] = [
  { id: "populated", label: "Populated" },
  { id: "details", label: "Expanded bodies" },
  { id: "loading", label: "Loading" },
  { id: "empty", label: "Empty" },
  { id: "error", label: "Error" },
  { id: "noDetail", label: "Legacy (no payloads)" },
]

const WIDTHS = [
  { id: "narrow", label: "420", value: 420 },
  { id: "compact", label: "720", value: 720 },
  { id: "desktop", label: "1080", value: 1080 },
  { id: "wide", label: "1440", value: 1440 },
] as const

export function OxpActivityLab() {
  const [scenario, setScenario] = createSignal<Scenario>("populated")
  const [width, setWidth] = createSignal<number>(1080)
  const [latency, setLatency] = createSignal(400)
  const [details, setDetails] = createStore<Record<string, DetailState>>({})

  const [now, setNow] = createSignal(Date.now())
  const timer = window.setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => window.clearInterval(timer))

  const source = createMemo<OxpTimelineSource>(() => {
    switch (scenario()) {
      case "loading":
        return { items: [], loaded: false, loading: true, more: false, capped: false }
      case "error":
        return {
          items: [],
          loaded: false,
          loading: false,
          more: false,
          capped: false,
          error: "InstanceMismatchError: the sidecar answering this port is not the one this window paired with.",
        }
      case "empty":
        return { items: [], loaded: true, loading: false, more: false, capped: false }
      default:
        return { items: LAB_INVOCATIONS, loaded: true, loading: false, more: true, capped: true }
    }
  })

  const ensureDetail = (invocationID: string) => {
    if (details[invocationID]?.loaded || details[invocationID]?.loading) return
    setDetails(invocationID, { loaded: false, loading: true })
    const payload = scenario() === "noDetail" ? undefined : LAB_DETAILS[invocationID]
    window.setTimeout(
      () => setDetails(invocationID, { data: payload, loaded: true, loading: false }),
      Math.max(0, latency()),
    )
  }

  return (
    <div data-component="oxp-lab">
      <div data-slot="oxp-lab-bar">
        <span data-slot="oxp-lab-title">OXP activity transcript</span>

        <div data-slot="oxp-lab-group" role="group" aria-label="Scenario">
          <For each={SCENARIOS}>
            {(option) => (
              <button
                type="button"
                data-slot="oxp-lab-toggle"
                aria-pressed={scenario() === option.id}
                onClick={() => {
                  setDetails({})
                  setScenario(option.id)
                }}
              >
                {option.label}
              </button>
            )}
          </For>
        </div>

        <div data-slot="oxp-lab-group" role="group" aria-label="Viewport width">
          <For each={WIDTHS}>
            {(option) => (
              <button
                type="button"
                data-slot="oxp-lab-toggle"
                aria-pressed={width() === option.value}
                onClick={() => setWidth(option.value)}
              >
                {option.label}
              </button>
            )}
          </For>
        </div>

        <label data-slot="oxp-lab-latency">
          detail latency
          <input
            type="range"
            min="0"
            max="2000"
            step="100"
            value={latency()}
            onInput={(event) => setLatency(Number(event.currentTarget.value))}
          />
          <span>{latency()}ms</span>
        </label>

        <button type="button" data-slot="oxp-lab-toggle" onClick={() => setDetails({})}>
          Reset caches
        </button>
      </div>

      <div data-slot="oxp-lab-stage">
        <Show when={scenario() !== "details"} fallback={<DetailGallery width={width()} />}>
        <div data-slot="oxp-lab-frame" style={{ width: `${width()}px` }}>
          <div data-component="oxp-activity">
            <Show when={scenario() !== "empty"} fallback={<EmptyHeader />}>
              <OxpActivityHeader
                activity={LAB_ACTIVITY}
                minuteNow={now()}
                onRename={async () => undefined}
                onArchive={() => undefined}
                onDelete={() => undefined}
                onRefresh={() => setDetails({})}
              />
            </Show>
            <OxpTimeline
              source={source()}
              now={now}
              resetKey={scenario()}
              invocationDetail={(invocationID) => details[invocationID]}
              onEnsureDetail={ensureDetail}
              onLoadOlder={async () => undefined}
              onOpenSession={() => undefined}
              onOpenScheduled={() => undefined}
            />
          </div>
        </div>
        </Show>
      </div>
    </div>
  )
}

/**
 * Every expanded body at once.
 *
 * `BasicTool` mounts its content behind `requestAnimationFrame`, which headless
 * review browsers do not run — so this pane renders the detail component
 * directly, inside the same `tool-content` card the collapsible would give it,
 * to make the rich renderers reviewable without driving the collapse animation.
 */
function DetailGallery(props: { width: number }) {
  const language = useLanguage()
  const items = LAB_INVOCATIONS.filter((item) => LAB_DETAILS[item.id])
  return (
    <div data-slot="oxp-lab-gallery" style={{ width: `${props.width}px` }}>
      <For each={items}>
        {(item) => (
          <section data-slot="oxp-lab-gallery-item">
            <h2 data-slot="oxp-lab-gallery-title">
              {say(language, toolIdentity(item).title)}
              <span>{toolIdentity(item).subtitle}</span>
            </h2>
            <div data-slot="tool-content" data-variant="card">
              <OxpInvocationDetail
                item={item}
                state={{ data: LAB_DETAILS[item.id], loaded: true, loading: false }}
                duration="6.5s"
                linkBusy={undefined}
                onOpenSession={() => undefined}
                onOpenScheduled={() => undefined}
              />
            </div>
          </section>
        )}
      </For>
      <section data-slot="oxp-lab-gallery-item">
        <h2 data-slot="oxp-lab-gallery-title">Legacy record<span>no captured payload</span></h2>
        <div data-slot="tool-content" data-variant="card">
          <OxpInvocationDetail
            item={LAB_INVOCATIONS[0]!}
            state={{ loaded: true, loading: false }}
            duration="41ms"
            onOpenSession={() => undefined}
            onOpenScheduled={() => undefined}
          />
        </div>
      </section>
      <section data-slot="oxp-lab-gallery-item">
        <h2 data-slot="oxp-lab-gallery-title">Loading<span>lazy detail in flight</span></h2>
        <div data-slot="tool-content" data-variant="card">
          <OxpInvocationDetail
            item={LAB_INVOCATIONS[1]!}
            state={{ loaded: false, loading: true }}
            duration="318ms"
            onOpenSession={() => undefined}
            onOpenScheduled={() => undefined}
          />
        </div>
      </section>
      <section data-slot="oxp-lab-gallery-item">
        <h2 data-slot="oxp-lab-gallery-title">Detail failed<span>fetch error</span></h2>
        <div data-slot="tool-content" data-variant="card">
          <OxpInvocationDetail
            item={LAB_INVOCATIONS[1]!}
            state={{ loaded: false, loading: false, error: "Request timed out after 10000ms" }}
            duration="318ms"
            onOpenSession={() => undefined}
            onOpenScheduled={() => undefined}
          />
        </div>
      </section>
    </div>
  )
}

function EmptyHeader() {
  return (
    <OxpActivityHeader
      activity={undefined}
      minuteNow={Date.now()}
      onRename={async () => undefined}
      onArchive={() => undefined}
      onDelete={() => undefined}
      onRefresh={() => undefined}
    />
  )
}
