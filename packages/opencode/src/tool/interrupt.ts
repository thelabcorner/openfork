import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"

type Entry = {
  controller: AbortController
  parent: AbortSignal
  onParentAbort: () => void
}

export interface Interface {
  readonly track: (input: { sessionID: string; callID: string; parent: AbortSignal }) => Effect.Effect<AbortSignal>
  readonly kill: (input: { sessionID: string; callID: string }) => Effect.Effect<boolean>
  readonly release: (input: { sessionID: string; callID: string }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ToolInterrupt") {}

// \u0000 separator keeps session/call pairs unambiguous; both ids are opaque strings.
const key = (sessionID: string, callID: string) => `${sessionID}\u0000${callID}`

function trackEntry(
  entries: Map<string, Entry>,
  input: { sessionID: string; callID: string; parent: AbortSignal },
): AbortSignal {
  const id = key(input.sessionID, input.callID)
  const existing = entries.get(id)
  if (existing) return existing.controller.signal
  const controller = new AbortController()
  const onParentAbort = () => controller.abort(input.parent.reason)
  if (input.parent.aborted) {
    controller.abort(input.parent.reason)
    return controller.signal
  }
  input.parent.addEventListener("abort", onParentAbort, { once: true })
  entries.set(id, { controller, parent: input.parent, onParentAbort })
  return controller.signal
}

function killEntry(entries: Map<string, Entry>, input: { sessionID: string; callID: string }): boolean {
  const entry = entries.get(key(input.sessionID, input.callID))
  // The entry stays registered so the executor's release() remains the single
  // cleanup point; a second kill is a harmless no-op.
  if (!entry || entry.controller.signal.aborted) return false
  entry.controller.abort()
  return true
}

function releaseEntry(entries: Map<string, Entry>, input: { sessionID: string; callID: string }): void {
  const id = key(input.sessionID, input.callID)
  const entry = entries.get(id)
  if (!entry) return
  entry.parent.removeEventListener("abort", entry.onParentAbort)
  entries.delete(id)
}

const make = Effect.gen(function* () {
  const entries = new Map<string, Entry>()

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const entry of entries.values()) entry.parent.removeEventListener("abort", entry.onParentAbort)
      entries.clear()
    }),
  )

  return {
    track: (input: { sessionID: string; callID: string; parent: AbortSignal }) =>
      Effect.sync(() => trackEntry(entries, input)),
    kill: (input: { sessionID: string; callID: string }) => Effect.sync(() => killEntry(entries, input)),
    release: (input: { sessionID: string; callID: string }) => Effect.sync(() => releaseEntry(entries, input)),
  }
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make(() => make)
    return Service.of({
      track: (input) => InstanceState.useEffect(state, (entries) => entries.track(input)),
      kill: (input) => InstanceState.useEffect(state, (entries) => entries.kill(input)),
      release: (input) => InstanceState.useEffect(state, (entries) => entries.release(input)),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })

export * as ToolInterrupt from "./interrupt"
