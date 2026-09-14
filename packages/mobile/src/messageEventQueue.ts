export type QueuedMessageEvent = { type: string; props: any }

export type MessageEventQueueStats = {
  count: number
  bytes: number
  coalesced: number
  dropped: number
}

type DeltaAccumulator = {
  fragments: string[]
  chars: number
}

// Queue-local rope metadata. The event object owns the accumulator lifetime;
// draining or dropping the event makes the fragments collectible without a
// second cleanup registry.
const deltaAccumulators = new WeakMap<object, DeltaAccumulator>()

const DEFAULT_MAX_EVENTS = 256
const DEFAULT_MAX_BYTES = 512 * 1024
const DEFAULT_MAX_CHUNK_BYTES = 64 * 1024

function sessionIDOf(event: QueuedMessageEvent) {
  const props = event.props
  return props?.sessionID ?? props?.sessionId ?? props?.info?.sessionID
}

function deltaKey(event: QueuedMessageEvent) {
  if (!event.type.endsWith(".delta")) return undefined
  const props = event.props ?? {}
  const stream = props.partID ?? props.textID ?? props.reasoningID ?? props.callID ?? props.compactionID ?? props.id
  if (!stream) return undefined
  return [
    event.type,
    props.sessionID ?? props.sessionId ?? "",
    props.messageID ?? props.assistantMessageID ?? "",
    stream,
    props.field ?? "delta",
  ].join("\u0000")
}

function retainedBytes(event: QueuedMessageEvent) {
  const delta = event.props?.delta
  return 160 + (typeof delta === "string" ? delta.length * 2 : 0)
}

/**
 * Bounded renderer admission for reconstructible stream deltas.
 *
 * Overflow is deliberately local: we discard renderer work and return the
 * affected sessions for authoritative repair instead of allowing a suspended
 * phone to turn its paint backlog into SSE/TCP backpressure on the server.
 */
export class MessageEventQueue {
  private items: QueuedMessageEvent[] = []
  private bytes = 0
  private coalesced = 0
  private dropped = 0

  constructor(
    private readonly limits = {
      maxEvents: DEFAULT_MAX_EVENTS,
      maxBytes: DEFAULT_MAX_BYTES,
      maxChunkBytes: DEFAULT_MAX_CHUNK_BYTES,
    },
  ) {}

  push(event: QueuedMessageEvent): { accepted: boolean; staleSessions: string[] } {
    const key = deltaKey(event)
    const last = this.items.at(-1)
    if (key && last && deltaKey(last) === key) {
      const previous = typeof last.props?.delta === "string" ? last.props.delta : ""
      const suffix = typeof event.props?.delta === "string" ? event.props.delta : ""
      const prior = deltaAccumulators.get(last)
      const chars = (prior?.chars ?? previous.length) + suffix.length
      if (chars * 2 <= this.limits.maxChunkBytes) {
        const accumulator = prior ?? { fragments: [previous], chars: previous.length }
        accumulator.fragments.push(suffix)
        accumulator.chars = chars
        deltaAccumulators.set(last, accumulator)
        this.bytes += suffix.length * 2
        this.coalesced++
        return { accepted: true, staleSessions: [] }
      }
    }

    const size = retainedBytes(event)
    if (this.items.length + 1 > this.limits.maxEvents || this.bytes + size > this.limits.maxBytes) {
      const stale = new Set<string>()
      for (const queued of this.items) {
        const sessionID = sessionIDOf(queued)
        if (sessionID) stale.add(sessionID)
      }
      const incoming = sessionIDOf(event)
      if (incoming) stale.add(incoming)
      this.dropped += this.items.length + 1
      this.items = []
      this.bytes = 0
      return { accepted: false, staleSessions: [...stale] }
    }

    this.items.push(event)
    this.bytes += size
    return { accepted: true, staleSessions: [] }
  }

  drain() {
    const items = this.items.map((event) => {
      const accumulator = deltaAccumulators.get(event)
      if (!accumulator) return event
      deltaAccumulators.delete(event)
      return { ...event, props: { ...event.props, delta: accumulator.fragments.join("") } }
    })
    this.items = []
    this.bytes = 0
    return items
  }

  discard() {
    const stale = new Set<string>()
    for (const event of this.items) {
      const sessionID = sessionIDOf(event)
      if (sessionID) stale.add(sessionID)
    }
    this.dropped += this.items.length
    this.items = []
    this.bytes = 0
    return [...stale]
  }

  stats(): MessageEventQueueStats {
    return { count: this.items.length, bytes: this.bytes, coalesced: this.coalesced, dropped: this.dropped }
  }
}
