import { Show, createMemo, createSignal } from "solid-js"
import type { ToolPart } from "@opencode-ai/sdk/v2/client"
import { Markdown } from "../Markdown"
import { safeExternalUrl } from "../../security"
import { IconExternalLink } from "../../icons"
import { EmptyNote, Section, inputString } from "./shared"
import { Stats } from "./primitives"
import { bytes } from "./parse"

/**
 * Fetched page content.
 *
 * `webfetch` was the one tool marked `hideDetails`, so the page it retrieved
 * was unreachable from the transcript — you could see the URL and nothing else.
 * The payload is genuinely markdown (the server converts the page), so it is
 * the one place the markdown renderer is the right answer rather than the
 * destructive default.
 */

const PREVIEW_CHARS = 1200

export function WebfetchBody(props: { part: ToolPart }) {
  const [full, setFull] = createSignal(false)
  const output = createMemo(() => {
    const state = props.part.state
    return state.status === "completed" ? ((state as { output?: string }).output ?? "") : ""
  })
  const url = createMemo(() => inputString(props.part, "url") ?? "")
  const href = createMemo(() => safeExternalUrl(url()))
  const host = createMemo(() => {
    const value = url()
    if (!value) return undefined
    try {
      return new URL(value.startsWith("http") ? value : `https://${value}`).host
    } catch {
      return undefined
    }
  })
  const words = createMemo(() => output().split(/\s+/).filter(Boolean).length)
  const preview = createMemo(() => (full() ? output() : output().slice(0, PREVIEW_CHARS)))
  const truncated = createMemo(() => !full() && output().length > PREVIEW_CHARS)

  return (
    <div class="fetch-body">
      <Stats
        items={[
          { label: "size", value: bytes(output().length) },
          { label: "words", value: words().toLocaleString() },
        ]}
      />
      <Show when={host()}>
        {(name) => (
          <div class="fetch-host">
            <span class="fetch-host-name">{name()}</span>
            <Show when={href()}>
              {(safe) => (
                <a
                  class="fetch-open"
                  href={safe()}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => event.stopPropagation()}
                >
                  Open <IconExternalLink size={9} />
                </a>
              )}
            </Show>
          </div>
        )}
      </Show>
      <Show when={output()} fallback={<EmptyNote>No content recorded.</EmptyNote>}>
        <Section label="Content">
          <div class="fetch-content">
            <Markdown text={preview()} />
          </div>
          <Show when={truncated()}>
            <button
              class="tmore"
              onClick={(event) => {
                event.stopPropagation()
                setFull(true)
              }}
            >
              Show full page ({bytes(output().length)})
            </button>
          </Show>
        </Section>
      </Show>
    </div>
  )
}
