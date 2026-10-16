import type { SessionLimitRecoveryInfo } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useServerSDK } from "./server-sdk"

type Recovery = SessionLimitRecoveryInfo

export function acceptRecoveryProjection(
  current: Recovery | null | undefined,
  clearedGeneration: number | undefined,
  incoming: Recovery,
) {
  if (clearedGeneration !== undefined && incoming.generation <= clearedGeneration) return false
  return !current || incoming.generation >= current.generation
}

export type LimitRecoveryAction =
  | "resume"
  | "auto-resume"
  | "cancel-auto-resume"
  | "snooze-until-reset"
  | "unsnooze"
  | "cancel"

/**
 * Lightweight projection cache for the durable server-owned recovery cursor.
 *
 * The generated SDK is the transport authority. Events update an already-known
 * Session in-place so a reset choice never causes a redundant GET; the first
 * mounted shelf does one coalesced bootstrap read.
 */
export const { use: useLimitRecovery, provider: LimitRecoveryProvider } = createSimpleContext({
  name: "LimitRecovery",
  init: () => {
    const serverSDK = useServerSDK()
    const [state, setState] = createStore({
      bySession: {} as Record<string, Recovery | null | undefined>,
      clearedGeneration: {} as Record<string, number | undefined>,
    })
    const inflight = new Map<string, Promise<void>>()

    const api = () => serverSDK().client.sessionLimitRecovery

    const refresh = (sessionID: string) => {
      const existing = inflight.get(sessionID)
      if (existing) return existing
      const generationAtStart = state.bySession[sessionID]?.generation
      const clearedAtStart = state.clearedGeneration[sessionID]
      const request = api()
        .get({ sessionID }, { throwOnError: true })
        .then((response) => {
          const value = response.data ?? null
          const current = state.bySession[sessionID]
          const clearedGeneration = state.clearedGeneration[sessionID]
          // GET is authoritative only if no newer projection activity happened
          // while it was in flight. A genuinely newer server generation may
          // still advance the local projection.
          const projectionAdvanced =
            current?.generation !== generationAtStart || clearedGeneration !== clearedAtStart
          if (value === null) {
            if (!projectionAdvanced) setState("bySession", sessionID, null)
          } else if (
            acceptRecoveryProjection(current, clearedGeneration, value) &&
            (!projectionAdvanced || !current || value.generation >= current.generation)
          ) {
            setState("bySession", sessionID, value)
          }
        })
        .catch(() => {
          // Older sidecars do not expose this feature yet; keep the shelf inert.
          if (state.bySession[sessionID] === undefined) setState("bySession", sessionID, null)
        })
        .finally(() => inflight.delete(sessionID))
      inflight.set(sessionID, request)
      return request
    }

    createEffect(() => {
      const unsubscribe = serverSDK().event.listen((envelope) => {
        const event = envelope.details as {
          type: string
          properties?: {
           recovery?: Recovery
           sessionID?: string
            generation?: number
          }
        }
        if (event.type === "session.limit_recovery.updated") {
          const value = event.properties?.recovery
          if (value) {
            const current = state.bySession[value.sessionID]
            // Cross-runtime publications can race even though each durable
            // mutation is generation-fenced. Never let an older Updated event
            // regress a newer local projection.
            if (acceptRecoveryProjection(current, state.clearedGeneration[value.sessionID], value)) {
              setState("bySession", value.sessionID, value)
            }
          }
          return
        }
        if (event.type === "session.limit_recovery.cleared") {
          const sessionID = event.properties?.sessionID
          const generation = event.properties?.generation
          if (!sessionID) return
          const current = state.bySession[sessionID]
          // Retain a generation tombstone so a delayed Updated(N) cannot
          // resurrect a cursor after Cleared(N). A delayed clear for N also
          // cannot erase an already-published N+1.
          if (generation === undefined) {
            setState("bySession", sessionID, null)
          } else {
            const cleared = state.clearedGeneration[sessionID]
            if (cleared === undefined || generation > cleared) {
              setState("clearedGeneration", sessionID, generation)
            }
            if (!current || current.generation <= generation) setState("bySession", sessionID, null)
          }
        }
      })
      onCleanup(unsubscribe)
    })

    const mutate = async (sessionID: string, action: LimitRecoveryAction) => {
      const current = state.bySession[sessionID]
      if (!current) return
      const generation = current.generation
      const client = api()

      if (action === "cancel") {
        await client.cancel({ sessionID, generation }, { throwOnError: true })
        const cleared = state.clearedGeneration[sessionID]
        if (cleared === undefined || generation > cleared) setState("clearedGeneration", sessionID, generation)
        if (!state.bySession[sessionID] || state.bySession[sessionID]!.generation <= generation) {
          setState("bySession", sessionID, null)
        }
        return
      }

      const response =
        action === "resume"
          ? await client.resume({ sessionID, generation }, { throwOnError: true })
          : action === "auto-resume"
          ? await client.autoResume({ sessionID, generation, enabled: true }, { throwOnError: true })
          : action === "cancel-auto-resume"
            ? await client.autoResume({ sessionID, generation, enabled: false }, { throwOnError: true })
            : action === "snooze-until-reset"
              ? await client.snooze({ sessionID, generation }, { throwOnError: true })
              : await client.wake({ sessionID, generation }, { throwOnError: true })

      const value = response.data ?? null
      const latest = state.bySession[sessionID]
      const clearedGeneration = state.clearedGeneration[sessionID]
      if (value === null) {
        if (latest?.generation === generation) setState("bySession", sessionID, null)
      } else if (acceptRecoveryProjection(latest, clearedGeneration, value)) {
        setState("bySession", sessionID, value)
      }
    }

    return {
      recovery(sessionID: string) {
        if (state.bySession[sessionID] === undefined) void refresh(sessionID)
        return state.bySession[sessionID]
      },
      refresh,
      mutate,
    }
  },
})
