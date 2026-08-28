import type { PermissionV2Reply, PermissionV2Request } from "@opencode-ai/sdk/v2/client"
import { For, Show } from "solid-js"
import { IconAlertTriangle, IconHelpCircle, IconShield, IconShieldCheck, IconTerminal } from "../icons"
import { Sheet } from "./Sheet"

// Known non-shell permission actions get a friendlier header than the
// generic "Permission requested" + terminal-styled resource list, which
// otherwise reads like a bash prompt even when it isn't one (e.g. the
// question tool gates itself behind a `action: "question"` permission
// before it ever publishes the real question).
const ACTION_COPY: Record<string, { title: string; subtitle: string; icon: (size: number) => any; showResources?: boolean }> = {
  question: {
    title: "The agent wants to ask you a question",
    subtitle: "Allow to see the question",
    icon: (size) => <IconHelpCircle size={size} />,
    showResources: false,
  },
}

export function PermissionPrompt(props: {
  open: boolean
  onClose: () => void
  request: PermissionV2Request
  onReply: (reply: PermissionV2Reply) => void
  error?: string
}) {
  const copy = () => ACTION_COPY[props.request.action]
  const showResources = () => copy()?.showResources !== false

  return (
    <Sheet open={props.open} onClose={props.onClose} height="auto">
      <div class="prompt-sheet-body">
        <div class="prompt-head">
          <div class="prompt-icon info">
            <Show when={copy()} fallback={<IconShield size={15} />}>
              {(c) => c().icon(15)}
            </Show>
          </div>
          <div>
            <h3>{copy()?.title ?? "Permission requested"}</h3>
            <p>{copy()?.subtitle ?? props.request.action}</p>
          </div>
        </div>

        <Show when={showResources()}>
          <div>
            <div class="command-label">
              <IconTerminal size={10} />
              <span>Resources</span>
            </div>
            <div class="command-block medium">
              <For each={props.request.resources}>{(r) => <div>{r}</div>}</For>
            </div>
          </div>
        </Show>

        <Show when={props.error}>
          <div class="prompt-error">
            <IconAlertTriangle size={12} />
            <span>{props.error}</span>
          </div>
        </Show>

        <div class="prompt-actions">
          <button class="btn-solid" onClick={() => props.onReply("once")}>
            Allow once
          </button>
          <button class="btn-outline" onClick={() => props.onReply("always")}>
            <IconShieldCheck size={12} />
            Always allow
          </button>
          <button class="btn-danger" onClick={() => props.onReply("reject")}>
            Deny
          </button>
        </div>
      </div>
    </Sheet>
  )
}
