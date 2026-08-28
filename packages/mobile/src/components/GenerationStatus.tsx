import { Show, createSignal, onCleanup, onMount } from "solid-js"
import { formatTimer } from "../format"
import { IconSquare } from "../icons"
import { TensorSpinner } from "./SessionStatus"

export function GenerationStatus(props: { activity: string; startedAt: number; onStop: () => void }) {
  const [now, setNow] = createSignal(Date.now())
  let interval: ReturnType<typeof setInterval> | undefined

  onMount(() => {
    interval = setInterval(() => setNow(Date.now()), 1000)
  })
  onCleanup(() => interval && clearInterval(interval))

  const elapsed = () => Math.max(0, Math.floor((now() - props.startedAt) / 1000))

  return (
    <div class="gen-status">
      <div class="gen-left">
        <TensorSpinner size={16} />
        <div class="gen-info">
          <div class="gen-activity">
            <span class="label">{props.activity}</span>
          </div>
          <div class="gen-sub-row">
            <span class="tnum">{formatTimer(elapsed())}</span>
          </div>
        </div>
      </div>
      <button class="gen-stop-btn" onClick={props.onStop}>
        <IconSquare size={9} />
        <span>Stop</span>
      </button>
    </div>
  )
}
