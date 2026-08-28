import type { SubtaskPart } from "@opencode-ai/sdk/v2/client"
import { For, Show } from "solid-js"
import { IconCpu } from "../icons"
import { Sheet } from "./Sheet"

export type AgentEntry = { part: SubtaskPart; running: boolean }

export function AgentActivitySheet(props: { open: boolean; onClose: () => void; agents: AgentEntry[] }) {
  const running = () => props.agents.filter((a) => a.running).length

  return (
    <Sheet open={props.open} onClose={props.onClose} title="Agent Activity" height="tall">
      <div class="agent-summary">
        <span class="item"><IconCpu size={11} />{props.agents.length} total</span>
        <Show when={running() > 0}>
          <span class="item running"><span class="status-dot blue pulse" />{running()} running</span>
        </Show>
      </div>
      <Show
        when={props.agents.length > 0}
        fallback={
          <div class="empty-list">
            <IconCpu size={22} />
            <p>No agents spawned in this session</p>
          </div>
        }
      >
        <For each={props.agents}>
          {(agent) => (
            <div class="agent-row">
              <div class="agent-row-status">
                <Show when={agent.running} fallback={<span class="status-dot done" />}>
                  <span class="status-dot blue pulse" />
                </Show>
              </div>
              <div class="agent-row-body">
                <div class="agent-row-head">
                  <span class="name">{agent.part.agent}</span>
                </div>
                <p class="agent-row-desc">{agent.part.description}</p>
              </div>
            </div>
          )}
        </For>
      </Show>
    </Sheet>
  )
}
