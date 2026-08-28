import { Spinner } from "@opencode-ai/ui/spinner"

export type RuntimeStatus = "generating" | "waiting_permission" | "waiting_question" | "retry" | "error" | "idle"

export function TensorSpinner(props: { size?: number }) {
  return <Spinner class="tensor-spinner" style={{ width: `${props.size ?? 13}px`, height: `${props.size ?? 13}px` }} />
}

export function WaveBars(props: { heights?: number[]; color?: string }) {
  const heights = props.heights ?? [4, 8, 6, 10, 5]
  return (
    <span class="wave-bars" style={{ height: `${Math.max(...heights)}px` }}>
      {heights.map((h, i) => (
        <span
          style={{
            height: `${h}px`,
            "animation-duration": `${0.8 + i * 0.1}s`,
            "animation-delay": `${i * 0.12}s`,
            background: props.color,
          }}
        />
      ))}
    </span>
  )
}

export function SessionStatusDot(props: { status: RuntimeStatus }) {
  if (props.status === "generating") return <TensorSpinner />
  if (props.status === "waiting_permission") return <span class="status-dot amber pulse" />
  if (props.status === "waiting_question") return <span class="status-dot blue pulse" />
  if (props.status === "retry") return <span class="status-dot amber pulse" />
  if (props.status === "error") return <span class="status-dot error" />
  return <span class="status-dot idle" />
}
