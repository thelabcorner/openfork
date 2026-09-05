import { For, Show } from "solid-js"
import type { OpenRouterEndpoint } from "../openrouter-endpoints"
import { sortEndpoints, uptimeTone } from "../openrouter-endpoints"
import { IconCheck, IconX } from "../icons"
import { Sheet } from "./Sheet"

/** Mirrors the desktop's `formatCostPerMillion`: grow precision rather than
 * showing "$0.00" for a real but tiny rate. */
function formatCostPerMillion(value: number): string {
  if (value === 0) return "$0.00"
  if (!Number.isFinite(value)) return "—"
  let decimals = 2
  while (decimals < 8 && Number(value.toFixed(decimals)) === 0) decimals++
  return `$${value.toFixed(decimals)}`
}

function priceLabel(endpoint: OpenRouterEndpoint) {
  return `${formatCostPerMillion(endpoint.pricing.prompt + endpoint.pricing.completion)}/M`
}

export function EndpointPickerSheet(props: {
  open: boolean
  onClose: () => void
  title: string
  /** `undefined` while loading, `null` after a failed fetch, else the list. */
  endpoints: OpenRouterEndpoint[] | null | undefined
  pinned: string | undefined
  onPick: (provider: string | undefined) => void
}) {
  const sorted = () => (props.endpoints ? sortEndpoints(props.endpoints) : [])

  return (
    <Sheet open={props.open} onClose={props.onClose} title={props.title} height="tall">
      <div class="endpoint-sheet">
        <div class="account-sheet-section">
          <div class="account-sheet-head">
            <span>Upstream provider</span>
          </div>
          <button
            type="button"
            class="account-opt"
            classList={{ selected: !props.pinned }}
            onClick={() => props.onPick(undefined)}
          >
            <span class="account-dot auto" />
            <span class="account-opt-name">Auto</span>
            <span class="account-opt-note">Let OpenRouter choose</span>
            <Show when={!props.pinned}>
              <IconCheck size={13} class="account-opt-check" />
            </Show>
          </button>
        </div>

        <div class="account-sheet-section">
          <div class="account-sheet-head">
            <span>Providers</span>
            <Show when={sorted().length > 0}>
              <span class="count">{sorted().length}</span>
            </Show>
          </div>

          <Show when={props.endpoints === undefined}>
            <div class="empty-list">
              <p>Loading providers.</p>
            </div>
          </Show>

          <Show when={props.endpoints === null}>
            <div class="empty-list">
              <p>Could not load providers.</p>
            </div>
          </Show>

          <Show when={Array.isArray(props.endpoints) && sorted().length === 0}>
            <div class="empty-list">
              <p>This model has no selectable upstream.</p>
            </div>
          </Show>

          <div class="account-list">
            <For each={sorted()}>
              {(endpoint, index) => (
                <button
                  type="button"
                  class="endpoint-opt"
                  classList={{ selected: props.pinned === endpoint.provider }}
                  onClick={() => props.onPick(endpoint.provider)}
                >
                  <span class="endpoint-opt-top">
                    <span class="endpoint-opt-name">{endpoint.providerName}</span>
                    <Show when={index() === 0}>
                      <span class="model-tag best">Best</span>
                    </Show>
                    <span class="endpoint-price tnum">{priceLabel(endpoint)}</span>
                    <Show when={props.pinned === endpoint.provider}>
                      <IconCheck size={13} class="account-opt-check" />
                    </Show>
                  </span>
                  <span class="endpoint-opt-sub">
                    <span class="endpoint-tag">{endpoint.tag}</span>
                    <Show when={typeof endpoint.uptime === "number"}>
                      <span class={`endpoint-uptime tone-${uptimeTone(endpoint.uptime!)}`}>
                        {endpoint.uptime!.toFixed(1)}%
                      </span>
                    </Show>
                  </span>
                </button>
              )}
            </For>
          </div>
        </div>
      </div>
    </Sheet>
  )
}
