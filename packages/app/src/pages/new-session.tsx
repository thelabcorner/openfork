import { useSearchParams } from "@solidjs/router"
import { createEffect, createSignal, lazy, on, onMount, Show, Suspense, untrack } from "solid-js"
import { usePrompt, type Prompt } from "@/context/prompt"

const NewSessionEnhanced = lazy(() => import("@/pages/new-session-enhanced"))

/** The draft-only V2 session page. The basic editor stays usable while the full composer loads on focus. */
export default function NewSessionPage() {
  const prompt = usePrompt()
  const [searchParams, setSearchParams] = useSearchParams<{ draftId?: string; prompt?: string }>()
  const [enhance, setEnhance] = createSignal(false)
  const [focused, setFocused] = createSignal(false)
  const loadEnhanced = () => setEnhance(true)

  // Start loading the complete draft surface as soon as its route is entered.
  // The small input remains usable while that graph loads, but the page must
  // never depend on a click to reveal its project, workspace, and composer UI.
  onMount(loadEnhanced)

  createEffect(
    on(
      () => prompt.ready(),
      (ready) => {
        if (!ready) return
        untrack(() => {
          const initial = searchParams.prompt
          if (initial) {
            prompt.set([{ type: "text", content: initial, start: 0, end: initial.length }], initial.length)
            setSearchParams({ ...searchParams, prompt: undefined })
          }
        })
      },
      { defer: true },
    ),
  )

  return (
    <Suspense fallback={<NewSessionFastInput loadEnhanced={loadEnhanced} focused={focused} setFocused={setFocused} />}>
      <Show when={enhance()} fallback={<NewSessionFastInput loadEnhanced={loadEnhanced} focused={focused} setFocused={setFocused} />}>
        <NewSessionEnhanced />
      </Show>
    </Suspense>
  )
}

function NewSessionFastInput(props: { loadEnhanced: () => void; focused: () => boolean; setFocused: (value: boolean) => void }) {
  const prompt = usePrompt()
  const text = () => prompt.current().filter((part) => part.type === "text").map((part) => part.content).join("")
  let input: HTMLTextAreaElement | undefined
  let suppressAutoFocusDemand = false

  createEffect(() => {
    if (!prompt.ready() || !input || document.activeElement === input) return
    suppressAutoFocusDemand = true
    input.focus()
    if (document.activeElement !== input) suppressAutoFocusDemand = false
  })

  return (
    <div class="relative size-full overflow-hidden flex flex-col">
      <div class="@container relative flex flex-col min-h-0 h-full flex-1">
        <div
          data-component="session-new-design"
          class="relative flex-1 min-h-0 overflow-hidden rounded-[10px] bg-v2-background-bg-deep"
        >
          <div class="absolute inset-x-0 top-[25.375%] flex justify-center px-6">
            <div class="w-full max-w-[720px]">
              <textarea
                ref={input}
                data-component="new-session-fast-input"
                aria-label="Message"
                rows={3}
                value={text()}
                placeholder="What would you like to work on?"
                class="w-full resize-none rounded-[10px] border border-v2-border-border-weak bg-v2-background-bg-base p-4 text-v2-text-text-base outline-none focus:border-v2-border-border-base"
                onFocus={() => {
                  props.setFocused(true)
                  if (suppressAutoFocusDemand) {
                    suppressAutoFocusDemand = false
                    return
                  }
                  props.loadEnhanced()
                }}
                onBlur={() => props.setFocused(false)}
                onPointerDown={props.loadEnhanced}
                onInput={(event) => {
                  const value = event.currentTarget.value
                  const current = prompt.current()
                  const first = current.findIndex((part) => part.type === "text")
                  const next: Prompt = current.filter((part) => part.type !== "text")
                  if (value) next.splice(Math.max(first, 0), 0, { type: "text", content: value, start: 0, end: value.length })
                  prompt.set(next, value.length)
                  props.loadEnhanced()
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault()
                    props.loadEnhanced()
                  }
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
