import { Show } from "solid-js"
import { IconChevronDown, IconSend, IconShield, IconShieldCheck, IconSquare, IconSliders } from "../icons"
import { ProviderBadge } from "./ProviderBadge"

export function Composer(props: {
  value: string
  onInput: (v: string) => void
  onSend: () => void
  onStop: () => void
  isGenerating: boolean
  modelLabel: string
  providerID?: string
  onModelClick: () => void
  variantLabel?: string
  onVariantClick?: () => void
  autoAccept: boolean
  onToggleAutoAccept: () => void
  onOpenLimits: () => void
  pendingPermissions: number
  pendingQuestions: number
  onPermissionClick: () => void
  onQuestionClick: () => void
}) {
  let textareaRef: HTMLTextAreaElement | undefined

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      if (props.value.trim() && !props.isGenerating) props.onSend()
    }
  }

  const hasPending = () => props.pendingPermissions > 0 || props.pendingQuestions > 0

  return (
    <div class="composer-wrap">
      <Show when={hasPending()}>
        <div class="composer-shelf">
          <Show when={props.pendingPermissions > 0}>
            <button class="pending-item amber" onClick={props.onPermissionClick}>
              <span class="status-dot amber pulse" />
              <span>{props.pendingPermissions} permission{props.pendingPermissions > 1 ? "s" : ""} pending</span>
            </button>
          </Show>
          <Show when={props.pendingQuestions > 0}>
            <button class="pending-item blue" onClick={props.onQuestionClick}>
              <span class="status-dot blue pulse" />
              <span>{props.pendingQuestions} question{props.pendingQuestions > 1 ? "s" : ""} pending</span>
            </button>
          </Show>
        </div>
      </Show>

      <div class="composer-card">
        <div class="composer-input-wrap top">
          <textarea
            ref={textareaRef}
            value={props.value}
            onInput={(e) => props.onInput(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            placeholder={props.isGenerating ? "Generating…" : "Ask anything, @ for context…"}
            rows={1}
            disabled={props.isGenerating}
          />
        </div>

        <div class="composer-toolbar persistent">
          <button class="toolbar-model-btn" onClick={props.onModelClick}>
            <Show when={props.providerID}><ProviderBadge providerID={props.providerID!} /></Show>
            <span>{props.modelLabel}</span>
            <IconChevronDown size={10} />
          </button>
          <Show when={props.variantLabel}>
            <button class="toolbar-variant-btn" onClick={props.onVariantClick}>
              <span>{props.variantLabel}</span>
              <IconChevronDown size={10} />
            </button>
          </Show>
          <span class="spacer" />
          <button class="toolbar-icon-btn" onClick={props.onOpenLimits} title="Usage & limits">
            <IconSliders size={13} />
          </button>
          <button
            class={`toolbar-icon-btn ${props.autoAccept ? "active-warn" : ""}`}
            onClick={props.onToggleAutoAccept}
            title={props.autoAccept ? "Auto-accept enabled" : "Auto-accept permissions"}
            aria-pressed={props.autoAccept}
          >
            <Show when={props.autoAccept} fallback={<IconShield size={13} />}>
              <IconShieldCheck size={13} />
            </Show>
          </button>
          <Show
            when={!props.isGenerating}
            fallback={
              <button class="composer-stop-btn" onClick={props.onStop} title="Stop">
                <IconSquare size={12} />
              </button>
            }
          >
            <button class="composer-send-btn" disabled={!props.value.trim()} onClick={() => props.value.trim() && props.onSend()} title="Send">
              <IconSend size={13} />
            </button>
          </Show>
        </div>
      </div>
    </div>
  )
}
