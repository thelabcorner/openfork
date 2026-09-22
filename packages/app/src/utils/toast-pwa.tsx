import type { ToastOptions } from "@opencode-ai/ui/toast"
import { createSignal, lazy, Show, Suspense } from "solid-js"

type V2Runtime = typeof import("./toast-v2-runtime")

const loadV2Runtime = () => import("./toast-v2-runtime")
const LazyV2Region = lazy(() =>
  loadV2Runtime().then((module) => ({ default: module.ToastV2RuntimeRegion })),
)

let v2Runtime: V2Runtime | undefined
let v2RuntimePromise: Promise<V2Runtime> | undefined
let v2RegionReady = false
let nextVirtualToastID = 1_000_000_000

type PendingV2Toast = {
  options: ToastOptions | string
  cancelled: boolean
  realID?: number
}

const pendingV2Toasts = new Map<number, PendingV2Toast>()
const [v2Requested, setV2Requested] = createSignal(false)

function ensureV2Runtime() {
  if (v2Runtime) return Promise.resolve(v2Runtime)
  if (v2RuntimePromise) return v2RuntimePromise

  v2RuntimePromise = loadV2Runtime()
    .then((runtime) => {
      v2Runtime = runtime
      flushPendingV2Toasts()
      return runtime
    })
    .catch((error) => {
      v2RuntimePromise = undefined
      console.error("[toast] failed to load PWA V2 toast runtime", error)
      throw error
    })

  return v2RuntimePromise
}

function flushPendingV2Toasts() {
  if (!v2Runtime || !v2RegionReady) return

  for (const [id, pending] of pendingV2Toasts) {
    if (pending.realID !== undefined) continue
    if (pending.cancelled) {
      pendingV2Toasts.delete(id)
      continue
    }

    pending.realID = v2Runtime.showV2Toast(pending.options)
  }
}

/**
 * Standalone PWA is V2-only. Keep the shared API shape so the authoritative app
 * tree can import the same utility, but do not carry legacy Kobalte toast or the
 * legacy icon registry into connected startup.
 */
export function setV2Toast(_value: boolean) {}

export function ToastRegion(props: { v2: boolean }) {
  return (
    <Show when={props.v2 && v2Requested()}>
      <Suspense>
        <LazyV2Region
          onReady={() => {
            v2RegionReady = true
            flushPendingV2Toasts()
          }}
          onDispose={() => {
            v2RegionReady = false
          }}
        />
      </Suspense>
    </Show>
  )
}

export function showToast(options: ToastOptions | string) {
  setV2Requested(true)

  if (v2Runtime && v2RegionReady) return v2Runtime.showV2Toast(options)

  const virtualID = nextVirtualToastID++
  pendingV2Toasts.set(virtualID, { options, cancelled: false })
  void ensureV2Runtime().catch(() => {})
  return virtualID
}

export function dismissToast(toastId: number) {
  const pending = pendingV2Toasts.get(toastId)
  if (pending) {
    pending.cancelled = true
    if (pending.realID !== undefined && v2Runtime) {
      pendingV2Toasts.delete(toastId)
      return v2Runtime.dismissV2Toast(pending.realID)
    }
    return
  }

  return v2Runtime?.dismissV2Toast(toastId)
}
