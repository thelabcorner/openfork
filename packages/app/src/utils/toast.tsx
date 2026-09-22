import {
  Toast,
  showToast as showLegacyToast,
  toaster as legacyToaster,
  type ToastOptions,
} from "@opencode-ai/ui/toast"
import { createSignal, lazy, Show, Suspense } from "solid-js"

type V2Runtime = typeof import("./toast-v2-runtime")

const deferV2UntilFirstUse = import.meta.env.VITE_OPENCODE_PWA === "true"
const loadV2Runtime = () => import("./toast-v2-runtime")
const LazyV2Region = lazy(() =>
  loadV2Runtime().then((module) => ({ default: module.ToastV2RuntimeRegion })),
)

let v2 = false
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
      console.error("[toast] failed to load V2 toast runtime", error)
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

export function setV2Toast(value: boolean) {
  v2 = value

  // Desktop/web V2 layouts preserve their existing eager-ready behavior. The
  // mobile PWA deliberately defers this runtime because a healthy launch often
  // never renders a toast at all.
  if (value && !deferV2UntilFirstUse) void ensureV2Runtime().catch(() => {})
}

export function ToastRegion(props: { v2: boolean }) {
  if (!props.v2) return <Toast.Region />

  return (
    <Show when={!deferV2UntilFirstUse || v2Requested()}>
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
  if (!v2) return showLegacyToast(options)

  setV2Requested(true)

  if (v2Runtime && v2RegionReady) return v2Runtime.showV2Toast(options)

  const virtualID = nextVirtualToastID++
  pendingV2Toasts.set(virtualID, { options, cancelled: false })
  void ensureV2Runtime().catch(() => {})
  return virtualID
}

// v1 and v2 ids come from separate registries, so dismissal has to use the same
// implementation that issued the id. The first V2 toast can carry a virtual id
// while its demand-loaded renderer is mounting; map that id to the real runtime
// id once available without making callers asynchronous.
export function dismissToast(toastId: number) {
  if (!v2) return legacyToaster.dismiss(toastId)

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
