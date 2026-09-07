import type { GoalAuditEvent, GoalDetail, GoalEvidence, GoalFocus, GoalInfo } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useServerSDK } from "./server-sdk"

export type FocusedGoal = { focus: GoalFocus; detail: GoalDetail }

type ExpandedGoal = {
  evidence?: GoalEvidence[]
  audit?: GoalAuditEvent[]
  focuses?: GoalFocus[]
}

export const { use: useGoals, provider: GoalsProvider } = createSimpleContext({
  name: "Goals",
  init: () => {
    const serverSDK = useServerSDK()
    const [state, setState] = createStore({
      focused: {} as Record<string, FocusedGoal | null | undefined>,
      expanded: {} as Record<string, ExpandedGoal | undefined>,
    })
    const focusedInflight = new Map<string, Promise<void>>()
    const goalInflight = new Map<string, Promise<void>>()
    const expandedInflight = new Map<string, Promise<void>>()

    const sdk = createMemo(() => serverSDK().client.goal)

    const refreshFocused = (sessionID: string) => {
      const existing = focusedInflight.get(sessionID)
      if (existing) return existing
      const promise = sdk()
        .focused({ sessionID }, { throwOnError: true })
        .then((response) => {
          setState("focused", sessionID, (response.data ?? null) as FocusedGoal | null)
        })
        .catch(() => {
          // Older servers or a transient route failure should make Goal Mode
          // inert rather than destabilizing the composer.
          setState("focused", sessionID, null)
        })
        .finally(() => focusedInflight.delete(sessionID))
      focusedInflight.set(sessionID, promise)
      return promise
    }

    const refreshGoal = (goalID: string) => {
      const existing = goalInflight.get(goalID)
      if (existing) return existing
      const promise = sdk()
        .get({ goalID }, { throwOnError: true })
        .then((response) => {
          const detail = response.data
          if (!detail) return
          for (const [sessionID, current] of Object.entries(state.focused)) {
            if (current?.detail.goal.id !== goalID) continue
            setState("focused", sessionID, "detail", detail)
          }
        })
        .catch(() => undefined)
        .finally(() => goalInflight.delete(goalID))
      goalInflight.set(goalID, promise)
      return promise
    }

    const loadExpanded = (goalID: string, force = false) => {
      if (!force && state.expanded[goalID]?.evidence && state.expanded[goalID]?.audit && state.expanded[goalID]?.focuses) {
        return Promise.resolve()
      }
      const existing = expandedInflight.get(goalID)
      if (existing) return existing
      const promise = Promise.all([
        sdk().evidence({ goalID }, { throwOnError: true }),
        sdk().audit({ goalID }, { throwOnError: true }),
        sdk().focuses({ goalID }, { throwOnError: true }),
      ])
        .then(([evidence, audit, focuses]) => {
          setState("expanded", goalID, {
            evidence: evidence.data ?? [],
            audit: audit.data ?? [],
            focuses: focuses.data ?? [],
          })
        })
        .catch(() => undefined)
        .finally(() => expandedInflight.delete(goalID))
      expandedInflight.set(goalID, promise)
      return promise
    }

    // Subscribe once per selected server. Goal updates are low frequency, so
    // refresh only the exact affected Session/Goal rather than invalidating the
    // entire application query graph.
    createEffect(() => {
      const current = serverSDK()
      const unsub = current.event.listen((envelope) => {
        const event = envelope.details
        const type = event.type as string
        const properties = event.properties as { goalID?: string; sessionID?: string } | undefined
        if (type === "goal.focused" && properties?.sessionID) {
          void refreshFocused(properties.sessionID)
          return
        }
        if (type === "goal.unfocused" && properties?.sessionID) {
          setState("focused", properties.sessionID, null)
          return
        }
        if ((type === "goal.updated" || type === "goal.created") && properties?.goalID) {
          void refreshGoal(properties.goalID)
          if (state.expanded[properties.goalID]) void loadExpanded(properties.goalID, true)
        }
      })
      onCleanup(unsub)
    })

    let activationQueued = new Set<string>()
    const focused = (sessionID: string): FocusedGoal | null | undefined => {
      const value = state.focused[sessionID]
      if (value !== undefined || activationQueued.has(sessionID)) return value
      activationQueued.add(sessionID)
      queueMicrotask(() => {
        activationQueued.delete(sessionID)
        void refreshFocused(sessionID)
      })
      return value
    }

    return {
      focused,
      refreshFocused,
      refreshGoal,
      expanded(goalID: string) {
        return state.expanded[goalID]
      },
      loadExpanded,
      async list(projectID: string, workspaceID?: string): Promise<GoalInfo[]> {
        const response = await sdk().list({ projectID, workspaceID }, { throwOnError: true })
        return response.data ?? []
      },
      async create(input: {
        projectID: string
        workspaceID?: string
        title: string
        objective: string
        criteria: string[]
        constraints?: string[]
        continuationPolicy?: { mode: "manual" | "auto_continue" | "unattended" }
      }) {
        const response = await sdk().create(input, { throwOnError: true })
        if (!response.data) throw new Error("Goal create returned no data")
        return response.data
      },
      async createAndFocus(
        sessionID: string,
        input: {
          projectID: string
          workspaceID?: string
          title: string
          objective: string
          criteria: string[]
          constraints?: string[]
          continuationPolicy?: { mode: "manual" | "auto_continue" | "unattended" }
        },
      ) {
        const created = await sdk().create(input, { throwOnError: true })
        if (!created.data) throw new Error("Goal create returned no data")
        let detail = created.data
        if (detail.criteria.length > 0) {
          const started = await sdk().transition(
            { goalID: detail.goal.id, expectedRevision: detail.goal.revision, action: "start" },
            { throwOnError: true },
          )
          if (started.data) detail = started.data
        }
        await sdk().focus({ sessionID, goalID: detail.goal.id, role: "owner" }, { throwOnError: true })
        setState("focused", sessionID, { focus: { sessionID, goalID: detail.goal.id, role: "owner", focusedAt: Date.now() }, detail })
        return detail
      },
      async focus(sessionID: string, goalID: string, role: "owner" | "worker" | "verifier" = "owner") {
        await sdk().focus({ sessionID, goalID, role }, { throwOnError: true })
        await refreshFocused(sessionID)
      },
      async unfocus(sessionID: string) {
        await sdk().unfocus({ sessionID }, { throwOnError: true })
        setState("focused", sessionID, null)
      },
      async transition(
        sessionID: string,
        action:
          | "start"
          | "pause"
          | "resume"
          | "block"
          | "request_verification"
          | "verification_pass"
          | "verification_fail"
          | "cancel"
          | "fail",
        blocker?: string,
      ) {
        const current = state.focused[sessionID]
        if (!current) throw new Error("No focused Goal")
        const response = await sdk().transition(
          { goalID: current.detail.goal.id, expectedRevision: current.detail.goal.revision, action, blocker },
          { throwOnError: true },
        )
        if (response.data) setState("focused", sessionID, "detail", response.data)
        if (response.data?.goal.status === "completed" || response.data?.goal.status === "cancelled" || response.data?.goal.status === "failed") {
          await sdk().unfocus({ sessionID }, { throwOnError: true }).catch(() => undefined)
          setState("focused", sessionID, null)
        }
        return response.data
      },
      async setContinuationMode(sessionID: string, mode: "manual" | "auto_continue" | "unattended") {
        const current = state.focused[sessionID]
        if (!current) throw new Error("No focused Goal")
        const response = await sdk().update(
          {
            goalID: current.detail.goal.id,
            expectedRevision: current.detail.goal.revision,
            continuationPolicy: { ...current.detail.goal.continuationPolicy, mode },
          },
          { throwOnError: true },
        )
        if (response.data) setState("focused", sessionID, "detail", response.data)
        return response.data
      },
    }
  },
})
