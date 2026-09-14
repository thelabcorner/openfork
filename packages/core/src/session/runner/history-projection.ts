import { Effect } from "effect"
import type { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { SessionEvent } from "../event"
import { SessionHistory } from "../history"
import { SessionMessage } from "../message"
import { SessionMessageUpdater } from "../message-updater"
import { SessionSchema } from "../schema"

type DatabaseService = Database.Interface["db"]
type Entry = SessionHistory.RunnerEntry

export interface RunnerHistoryProjection {
  readonly entries: (baselineSeq: number) => Effect.Effect<readonly Entry[]>
  readonly close: Effect.Effect<void>
}

const sessionDurableTypes = new Set<string>(SessionEvent.DurableDefinitions.map((definition) => definition.type))

function makeProjection(initial: readonly Entry[]) {
  const entries: Entry[] = initial.map((entry) => ({ seq: entry.seq, message: entry.message }))
  const byID = new Map<SessionMessage.ID, number>()
  const shellByCallID = new Map<string, number>()
  let latestAssistant = -1
  let appendSeq = -1
  let version = 0
  let cachedView:
    | { readonly version: number; readonly baselineSeq: number; readonly entries: readonly Entry[] }
    | undefined

  const rebuildIndexes = () => {
    byID.clear()
    shellByCallID.clear()
    latestAssistant = -1
    for (let index = 0; index < entries.length; index++) {
      const message = entries[index]!.message
      byID.set(message.id, index)
      if (message.type === "assistant") latestAssistant = index
      if (message.type === "shell") shellByCallID.set(message.callID, index)
    }
  }
  rebuildIndexes()

  const replace = (index: number, message: SessionMessage.Message) => {
    const current = entries[index]
    if (!current) return
    entries[index] = { seq: current.seq, message }
    version++
    cachedView = undefined
  }

  const adapter: SessionMessageUpdater.Adapter = {
    getCurrentAssistant: () =>
      Effect.sync(() => {
        if (latestAssistant < 0) return
        const message = entries[latestAssistant]?.message
        return message?.type === "assistant" && !message.time.completed ? message : undefined
      }),
    getAssistant: (messageID) =>
      Effect.sync(() => {
        const index = byID.get(messageID)
        if (index === undefined) return
        const message = entries[index]?.message
        return message?.type === "assistant" ? message : undefined
      }),
    getCurrentShell: (callID) =>
      Effect.sync(() => {
        const index = shellByCallID.get(callID)
        if (index === undefined) return
        const message = entries[index]?.message
        return message?.type === "shell" ? message : undefined
      }),
    updateAssistant: (assistant) =>
      Effect.sync(() => {
        const index = byID.get(assistant.id)
        if (index === undefined) return
        replace(index, assistant)
      }),
    updateShell: (shell) =>
      Effect.sync(() => {
        const index = shellByCallID.get(shell.callID)
        if (index === undefined) return
        replace(index, shell)
      }),
    appendMessage: (message) =>
      Effect.sync(() => {
        // The aggregate listener consumes each durable sequence at most once.
        // Treat an unexpected duplicate message ID as a no-op rather than
        // corrupting the positional indexes.
        if (byID.has(message.id)) return
        const index = entries.length
        entries.push({ seq: appendSeq, message })
        byID.set(message.id, index)
        if (message.type === "assistant") latestAssistant = index
        if (message.type === "shell") shellByCallID.set(message.callID, index)
        version++
        cachedView = undefined
      }),
  }

  const apply = Effect.fnUntraced(function* (event: SessionEvent.Event) {
    if (event.durable === undefined) return true
    if (event.type === SessionEvent.RevertEvent.Committed.type) {
      const boundary = byID.get(event.data.messageID)
      // A cold snapshot may start at a historical compaction. Reverting behind
      // that compaction requires rows the active projection intentionally never
      // loaded, so signal the owner to take one new authoritative snapshot.
      if (boundary === undefined) return false
      if (boundary + 1 < entries.length) {
        entries.splice(boundary + 1)
        rebuildIndexes()
        version++
        cachedView = undefined
      }
      return true
    }
    appendSeq = event.durable.seq
    yield* SessionMessageUpdater.update(adapter, event)
    return true
  })

  const view = (baselineSeq: number): readonly Entry[] => {
    if (cachedView?.version === version && cachedView.baselineSeq === baselineSeq) return cachedView.entries
    let compactionSeq: number | undefined
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]!
      if (entry.message.type !== "compaction") continue
      compactionSeq = entry.seq
      break
    }
    const visible = entries.filter((entry) => {
      if (entry.message.type === "system" && entry.seq <= baselineSeq) return false
      if (compactionSeq === undefined) return true
      return entry.seq >= compactionSeq || (entry.message.type === "system" && entry.seq > baselineSeq)
    })
    cachedView = { version, baselineSeq, entries: visible }
    return visible
  }

  return { apply, view }
}

/**
 * Active-run history projection.
 *
 * One Session owns one projection while its drain is active. The initial state
 * is read once from a consistent WAL snapshot. Durable events for that exact
 * aggregate then update the projection inline after commit, so tool
 * continuations and queued/steered turns never re-materialize the full history.
 */
export const makeRunnerHistoryProjection = Effect.fn("SessionRunnerHistory.make")(function* (input: {
  readonly events: EventV2.Interface
  readonly readDb: DatabaseService
  readonly sessionID: SessionSchema.ID
}) {
  let projection: ReturnType<typeof makeProjection> | undefined
  let frontier = -1
  let loadedBaselineSeq = Number.POSITIVE_INFINITY
  let loading = true
  let stale = false
  const buffered: EventV2.Payload[] = []

  const apply = Effect.fnUntraced(function* (event: EventV2.Payload) {
    const seq = event.durable?.seq
    if (seq === undefined || seq <= frontier) return
    frontier = seq
    if (!sessionDurableTypes.has(event.type)) return
    const data = event.data as { readonly sessionID?: string }
    if (data.sessionID !== input.sessionID) return
    const current = projection
    if (!current) {
      stale = true
      return
    }
    const valid = yield* current.apply(event as SessionEvent.Event)
    if (!valid) stale = true
  })

  const onEvent = (event: EventV2.Payload) => {
    if (loading || stale || projection === undefined) {
      buffered.push(event)
      return Effect.void
    }
    // Never let an in-memory acceleration layer break durable publication. A
    // projection defect degrades to one cold snapshot on the next turn.
    return apply(event).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          stale = true
          buffered.push(event)
        }).pipe(Effect.andThen(Effect.logError("Active runner history projection failed", { cause }))),
      ),
    )
  }

  const close = yield* input.events.listenAggregate(input.sessionID, onEvent)

  const reload = Effect.fnUntraced(function* (baselineSeq: number) {
    loading = true
    const snapshot = yield* SessionHistory.snapshotForRunner(input.readDb, input.sessionID, baselineSeq)
    projection = makeProjection(snapshot.entries)
    frontier = snapshot.frontier
    loadedBaselineSeq = baselineSeq
    stale = false

    // The listener was installed before the snapshot. Anything committed while
    // SQLite held that read snapshot is buffered here; sequence filtering makes
    // the handoff exact, including events that committed during a cooperative
    // decode yield.
    while (buffered.length > 0) {
      const pending = buffered.splice(0).sort((a, b) => (a.durable?.seq ?? -1) - (b.durable?.seq ?? -1))
      for (const event of pending) yield* apply(event)
      if (stale) break
    }
    loading = false
  })

  const entries = Effect.fn("SessionRunnerHistory.entries")(function* (baselineSeq: number) {
    if (projection === undefined || stale || baselineSeq < loadedBaselineSeq) yield* reload(baselineSeq)
    if (!projection || stale) {
      // A revert can race a reload and point behind the snapshot's compaction.
      // Retry once from the now-current authoritative projection.
      yield* reload(baselineSeq)
    }
    return projection!.view(baselineSeq)
  })

  return { entries, close } satisfies RunnerHistoryProjection
})
