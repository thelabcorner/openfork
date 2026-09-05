import { EventEmitter } from "events"
import { Identifier } from "@/id/id"

export type GlobalEvent = {
  directory?: string
  project?: string
  workspace?: string
  payload: any
}

class GlobalBusEmitter extends EventEmitter<{
  event: [GlobalEvent]
  // Internal replay capture is deliberately separate from the legacy public
  // channel. `listenerCount("event")` is used as the allocation gate for the
  // compatibility bridge; a replay ring must not make every native event pay
  // the legacy conversion/broadcast cost when no legacy client is connected.
  "event.replay": [GlobalEvent]
  // Instance disposal is a lifecycle signal. Keeping it on its own channel
  // prevents every native event from traversing disposal-only listeners.
  "instance.disposed": [GlobalEvent]
}> {
  private readonly generatedIDs = new WeakMap<object, string>()

  override emit(eventName: "event" | "event.replay" | "instance.disposed", event: GlobalEvent): boolean {
    if (event.payload && typeof event.payload === "object" && !("id" in event.payload)) {
      // Legacy producers often reuse the same envelope for more than one
      // transport. Mutating its payload here invalidates identity-based
      // serialization caches and lets a later listener observe a different
      // event than the producer created. Copy only the missing-id shape; the
      // common already-identified path stays allocation-free.
      const payload = event.payload as object & { syncEvent?: { id?: string } }
      const id =
        this.generatedIDs.get(payload) ??
        payload.syncEvent?.id ??
        Identifier.create("evt", "ascending")
      this.generatedIDs.set(payload, id)
      event = {
        ...event,
        payload: {
          ...event.payload,
          id,
        },
      }
    }
    if (eventName === "event") {
      // Capture first so replay remains complete even if a compatibility
      // listener throws. The internal channel is not exposed to clients.
      const replayed = super.emit("event.replay", event)
      const delivered = super.emit(eventName, event)
      return delivered || replayed
    }
    return super.emit(eventName, event)
  }
}

export const GlobalBus = new GlobalBusEmitter()
