import { Show, createSignal } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import type { ReadPlayableMedia } from "./read-tool-playable-model"

/**
 * An unopened video has no decoder, network request or media DOM element.
 * The initial element is small enough to coexist with hundreds of tool rows.
 */
export function ToolPlayableMedia(props: { media: ReadPlayableMedia; onContentRendered?: () => void }) {
  const [open, setOpen] = createSignal(false)
  const label = () => props.media.name || (props.media.kind === "video" ? "Video attachment" : "Audio attachment")
  return (
    <div class="flex flex-col gap-2 p-2" data-component="tool-playable-media">
      <Show
        when={open()}
        fallback={
          <button
            type="button"
            class="flex items-center gap-2 rounded-md border border-border-weak px-3 py-2 text-13-regular text-text-strong hover:bg-surface-raised-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            onClick={() => {
              setOpen(true)
              props.onContentRendered?.()
            }}
          >
            <Icon name="open-file" size="small" />
            <span class="truncate">{label()}</span>
            <span class="ml-auto text-text-weak">{props.media.kind === "video" ? "Open video" : "Open audio"}</span>
          </button>
        }
      >
        <Show
          when={props.media.kind === "video"}
          fallback={<audio controls preload="metadata" src={props.media.url} class="w-full" aria-label={label()} />}
        >
          <video controls preload="metadata" playsinline src={props.media.url} class="max-h-[420px] w-full rounded-md bg-black object-contain" aria-label={label()} />
        </Show>
      </Show>
    </div>
  )
}
