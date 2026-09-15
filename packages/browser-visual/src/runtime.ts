import { attachSnapEye } from "@zumer/snapeye/client"
import { snapdom } from "@zumer/snapdom"
import type {
  SnapEyeBaseOperationOptions,
  SnapEyeDiffOptions,
  SnapEyeRecordOptions,
  SnapEyeResult,
  SnapEyeTarget,
} from "@zumer/snapeye/client"
import { encodeGifFrames as encodeOpenForkGifFrames } from "./gifenc-safe"
import { RemoteVisualArtifactStore, type VisualRpc } from "./store"

export type VisualOperation = "capture" | "diff" | "record"

export interface VisualRedactionPolicy {
  blocks?: readonly string[]
  attributes?: ReadonlyArray<{ selector: string; names: readonly string[] }>
}

export interface RunVisualOperationInput {
  operation: VisualOperation
  name: string
  runId: string
  capability: string
  maxChunkBytes: number
  rpc: VisualRpc
  signal?: AbortSignal
  target?: SnapEyeTarget | null
  redaction?: VisualRedactionPolicy
  options?: SnapEyeBaseOperationOptions | SnapEyeDiffOptions | SnapEyeRecordOptions
  /** Internal browser-lane scheduler. Chrome uses the extension worker so
   * inactive-page timer throttling cannot turn six visual stability frames into
   * a six-second floor. Electron leaves this unset and keeps native RAF. */
  wait?: (milliseconds: number) => Promise<void>
  /** Make SnapEye's frame scheduler use `wait` rather than page RAF. */
  preferWaitForFrames?: boolean
}

/**
 * Shared browser kernel for Electron guest preload and Chrome's isolated world.
 * OpenCode owns transport/persistence; upstream SnapEye owns capture/diff/record.
 */
export const runVisualOperation = async (input: RunVisualOperationInput): Promise<SnapEyeResult> => {
  throwIfAborted(input.signal)
  const rpc: VisualRpc = async (request) => {
    throwIfAborted(input.signal)
    const response = await abortable(input.rpc(request), input.signal)
    throwIfAborted(input.signal)
    return response
  }
  const store = new RemoteVisualArtifactStore(input.capability, input.maxChunkBytes, rpc)
  const wait = (milliseconds: number) => input.wait
    ? abortable(input.wait(Math.max(0, milliseconds)), input.signal)
    : abortableWait(milliseconds, input.signal)
  const timingWindow = input.preferWaitForFrames ? waitDrivenWindow() : undefined
  const api = attachSnapEye({
    snapdom,
    store,
    ...(timingWindow ? { window: timingWindow, document: globalThis.document } : {}),
    reuse: false,
    autoOnQuery: false,
    forwardConsole: false,
    errorOverlay: false,
    hotkey: false,
    // SnapEye intentionally owns its internal frame scheduler. Supplying its
    // documented wait hook lets OpenCode make settle/readiness waits and the
    // gaps between record frames promptly cancellable without forking SnapEye.
    // A SnapDOM frame already executing may finish, but no subsequent sample or
    // artifact/result commit can proceed after the signal becomes aborted.
    wait,
    // SnapEye's stock GIF encoder uses gifenc's PnnQuant-derived adaptive
    // quantizer. OpenFork injects an equivalent browser-safe encoder that
    // learns one bounded global palette for the whole recording, avoiding both
    // MPL-derived shipping code and per-frame palette churn/local color tables.
    encodeGif: encodeOpenForkGifFrames,
    // Keep upstream deterministic defaults explicit at this trust boundary.
    stabilize: true,
    settle: true,
    svg: true,
    // OpenCode-owned browser chrome must never become part of a persisted
    // baseline. These are reserved attributes on the extension cursor/
    // highlight host and the Electron annotation host respectively. SnapEye
    // restores the prior inline display value in a finally block, so this is
    // safe even when capture/diff fails midway through cloning.
    hideSelectors: ["[data-opencode-overlay]", "[data-openfork-annotation-ui]"],
  })
  const options = withRedaction({ ...(input.options ?? {}), runId: input.runId }, input.redaction)
  try {
    throwIfAborted(input.signal)
    let result: SnapEyeResult
    try {
      result = input.operation === "capture"
        ? await api.capture(input.name, input.target, options)
        : input.operation === "diff"
          ? await api.diff(input.name, input.target, options as SnapEyeDiffOptions)
          : await api.record(input.name, input.target, options as SnapEyeRecordOptions)
    } catch (error) {
      // SnapEye deliberately normalizes operation/persistence failures. When
      // OpenCode has already revoked the operation, that normalization must not
      // erase the browser-control semantics: cancellation wins over whatever
      // secondary failure the interrupted persistence path observed.
      throwIfAborted(input.signal)
      throw error
    }
    throwIfAborted(input.signal)
    return store.lastCommittedResult ?? result
  } finally {
    api.destroy()
  }
}

/**
 * SnapEye's `nextFrames()` intentionally prefers RAF when a Window exposes it.
 * Background Chrome tabs may not receive RAF and their 100ms fallback timer is
 * then throttled to ~1s. This proxy preserves the real browser Window for every
 * API SnapEye needs while omitting RAF/cancelRAF, causing upstream to use its
 * documented wait hook for frame progression instead.
 */
const waitDrivenWindow = (): Window & typeof globalThis => {
  const target = globalThis.window
  if (!target) throw new Error("Visual timing facade requires a browser Window")
  const bindToWindow = new Set<PropertyKey>([
    "addEventListener",
    "removeEventListener",
    "setTimeout",
    "clearTimeout",
    "fetch",
    "createImageBitmap",
  ])
  return new Proxy(target, {
    get(windowTarget, property) {
      if (property === "requestAnimationFrame" || property === "cancelAnimationFrame") return undefined
      const value = Reflect.get(windowTarget, property, windowTarget)
      return typeof value === "function" && bindToWindow.has(property) ? value.bind(windowTarget) : value
    },
    set(windowTarget, property, value) {
      return Reflect.set(windowTarget, property, value, windowTarget)
    },
    deleteProperty(windowTarget, property) {
      return Reflect.deleteProperty(windowTarget, property)
    },
  }) as Window & typeof globalThis
}

const abortError = () => new DOMException("Visual operation aborted", "AbortError")

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw abortError()
}

const abortable = <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return promise
  throwIfAborted(signal)
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      fn()
    }
    const onAbort = () => finish(() => reject(abortError()))
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    )
  })
}

const abortableWait = (milliseconds: number, signal?: AbortSignal): Promise<void> => {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)))
  throwIfAborted(signal)
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => finish(resolve), Math.max(0, milliseconds))
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      fn()
    }
    const onAbort = () => finish(() => reject(abortError()))
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

const withRedaction = <T extends SnapEyeBaseOperationOptions>(
  options: T,
  policy?: VisualRedactionPolicy,
): T => {
  const blocks = [...(policy?.blocks ?? [])]
  const attributes = [...(policy?.attributes ?? [])]
  if (blocks.length === 0 && attributes.length === 0) return options

  const current = options.snapdomOptions ?? {}
  const existingExclude = current.exclude === undefined
    ? []
    : Array.isArray(current.exclude)
      ? current.exclude
      : [current.exclude]
  const existingPlugins = current.plugins === undefined
    ? []
    : Array.isArray(current.plugins)
      ? current.plugins
      : [current.plugins]

  const redactionPlugin = attributes.length > 0
    ? {
        name: "opencode-redact-attributes-v1",
        pure: true,
        afterClone(context: { clone?: HTMLElement | SVGElement | null }) {
          const clone = context.clone
          if (!clone) return
          for (const rule of attributes) {
            const matches: Element[] = []
            if (clone.matches(rule.selector)) matches.push(clone)
            matches.push(...clone.querySelectorAll(rule.selector))
            for (const element of matches) {
              for (const name of rule.names) {
                element.removeAttribute(name)
                // SnapDOM snapshots live form state. Removing the serialized
                // attribute alone is not sufficient for reflected value-like
                // properties, so clear the detached clone's property too.
                if (name === "value" && "value" in element) {
                  try { (element as HTMLInputElement | HTMLTextAreaElement).value = "" } catch {}
                  if (element.tagName === "TEXTAREA") element.textContent = ""
                }
                if (name === "srcdoc" && element instanceof HTMLIFrameElement) {
                  try { element.srcdoc = "" } catch {}
                }
              }
            }
          }
        },
      }
    : undefined

  return {
    ...options,
    snapdomOptions: {
      ...current,
      ...(blocks.length > 0
        ? { exclude: [...existingExclude, ...blocks], excludeMode: "hide" as const }
        : {}),
      ...(redactionPlugin ? { plugins: [...existingPlugins, redactionPlugin] } : {}),
    },
  }
}

export const SNAPEYE_RUNTIME_VERSION = "0.4.0"
export const SNAPDOM_RUNTIME_VERSION = "3.0.0"
