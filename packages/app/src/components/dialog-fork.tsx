import { Component, createMemo } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { usePrompt } from "@/context/prompt"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { showToast } from "@/utils/toast"
import { extractPromptFromParts } from "@/utils/prompt"
import type { TextPart as SDKTextPart } from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { useLanguage } from "@/context/language"

interface ForkableMessage {
  id: string
  text: string
  time: string
  role: "user" | "assistant"
  completed: boolean
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { timeStyle: "short" })
}

export const DialogFork: Component<{ sessionID?: string }> = (props) => {
  const params = useParams()
  const navigate = useNavigate()
  const sync = useSync()
  const sdk = useSDK()
  const prompt = usePrompt()
  const dialog = useDialog()
  const language = useLanguage()

  const messages = createMemo((): ForkableMessage[] => {
    const sessionID = props.sessionID ?? params.id
    if (!sessionID) return []

    const msgs = sync().data.message[sessionID] ?? []
    const result: ForkableMessage[] = []

    for (const message of msgs) {
      const isUser = message.role === "user"
      const isAssistant = message.role === "assistant"
      if (!isUser && !isAssistant) continue
      // Assistant messages that are still streaming (no completed) are not forkable — will be snapped anyway, but show as disabled
      const completed = isUser ? true : !!(message as { time: { completed?: number } }).time.completed || !!(message as { error?: unknown }).error
      const parts = sync().data.part[message.id] ?? []
      const textPart = parts.find((x): x is SDKTextPart => x.type === "text" && !x.synthetic && !x.ignored)
      // For assistant without text, synthesize a label from tool activity
      let label = textPart?.text.replace(/\n/g, " ").slice(0, 200)
      if (!label) {
        if (isAssistant) {
          const toolCount = parts.filter((p) => p.type === "tool").length
          label = toolCount > 0 ? `assistant — ${toolCount} tool call(s)` : "assistant response"
        } else label = "(empty)"
      }
      result.push({
        id: message.id,
        text: label ?? "",
        time: formatTime(new Date(message.time.created)),
        role: isUser ? "user" : "assistant",
        completed,
      })
    }

    return result.reverse()
  })

  const handleSelect = (item: ForkableMessage | undefined) => {
    if (!item) return
    if (!item.completed) {
      showToast({
        title: language.t("dialog.fork.streamingBlocked.title", { defaultValue: "Cannot fork streaming message" }),
        description: language.t("dialog.fork.streamingBlocked.description", {
          defaultValue: "Wait for the response to finish.",
        }),
      })
      return
    }

    const sessionID = props.sessionID ?? params.id
    if (!sessionID) return

    const edge = item.role === "user" ? ("before" as const) : ("after" as const)
    const parts = sync().data.part[item.id] ?? []
    const restored =
      item.role === "user"
        ? extractPromptFromParts(parts, {
            directory: sdk().directory,
            attachmentName: language.t("common.attachment"),
          })
        : null
    const dir = base64Encode(sdk().directory)

    // Unified SDK supports edge/kind; cast to any to avoid stale generated types lag
    const client = sdk().client as unknown as {
      session: { fork: (p: Record<string, unknown>) => Promise<{ data: { id: string } } | { id: string }> }
    }
    client.session
      .fork({ sessionID, messageID: item.id, edge, kind: "manual" })
      .then((forked) => {
        const raw = forked as unknown as { data?: { id: string }; id?: string }
        const id = raw.data?.id ?? raw.id
        if (!id) throw new Error("fork did not return id")
        dialog.close()
        if (restored) prompt.set(restored as never, undefined, { dir, id })
        navigate(`/${dir}/session/${id}`)
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }

  return (
    <Dialog title={language.t("command.session.fork")}>
      <List
        class="flex-1 px-3 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0"
        search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("dialog.fork.empty")}
        key={(x) => x.id}
        items={messages}
        filterKeys={["text"]}
        onSelect={handleSelect}
      >
        {(item) => (
          <div class="w-full flex items-center gap-2">
            <span
              class="shrink-0 rounded px-1 py-0.5 text-[10px] font-medium leading-none"
              classList={{
                "bg-v2-background-bg-layer-02 text-v2-text-text-muted": item.role === "user",
                "bg-v2-state-bg-accent text-v2-state-fg-accent": item.role === "assistant",
                "opacity-40": !item.completed,
              }}
            >
              {item.role}
            </span>
            <span class="truncate flex-1 min-w-0 text-left font-normal" classList={{ "opacity-60": !item.completed }}>
              {item.text}
            </span>
            <span class="text-text-weak shrink-0 font-normal">{item.time}</span>
          </div>
        )}
      </List>
    </Dialog>
  )
}
