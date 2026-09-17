import type {
  GoalAuditEvent,
  GoalAuditorPolicy,
  GoalDetail,
  GoalEvidence,
  GoalFocus,
  GoalInfo,
} from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useServerSDK } from "./server-sdk"

export type FocusedGoal = { focus: GoalFocus; detail: GoalDetail }

function isFocusedGoal(value: unknown): value is FocusedGoal {
  if (!value || typeof value !== "object") return false
  const candidate = value as { focus?: unknown; detail?: { goal?: { id?: unknown; status?: unknown } } }
  return (
    !!candidate.focus &&
    typeof candidate.detail?.goal?.id === "string" &&
    typeof candidate.detail?.goal?.status === "string"
  )
}
export type GoalArmIntent = {
  /** Quick Goal Mode intentionally auto-continues by default. */
  mode: "auto_continue" | "unattended"
}

export type GoalCreateAndFocusInput = {
  title: string
  objective: string
  criteria: string[]
  constraints?: string[]
  steps?: Array<{ title: string; description?: string }>
  continuationPolicy?: { mode: "manual" | "auto_continue" | "unattended" }
  auditorPolicy?: GoalAuditorPolicy
  start?: boolean
}

export function goalArmKey(input: { sessionID?: string; draftID?: string; directory: string }) {
  if (input.sessionID) return `session:${input.sessionID}`
  if (input.draftID) return `draft:${input.draftID}`
  return `draft-directory:${input.directory}`
}

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
      // Transient composer intent only. Durable Goal state starts after send.
      armed: {} as Record<string, GoalArmIntent | undefined>,
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
          setState("focused", sessionID, isFocusedGoal(response.data) ? response.data : null)
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

    const createAndFocus = async (sessionID: string, input: GoalCreateAndFocusInput) => {
      const response = await sdk().prepare({ sessionID, ...input }, { throwOnError: true })
      if (!response.data) throw new Error("Goal prepare returned no data")
      setState("focused", sessionID, response.data)
      return response.data.detail
    }

    const quickTitle = (objective: string) => {
      const line = objective.split(/\r?\n/, 1)[0]?.trim() ?? ""
      if (!line) return "Goal"
      return line.length <= 72 ? line : `${line.slice(0, 69).trimEnd()}…`
    }

    const quickStart = async (
      sessionID: string,
      input: {
        objective: string
        mode?: GoalArmIntent["mode"]
      },
    ) => {
      let current = state.focused[sessionID]
      if (current === undefined) {
        await refreshFocused(sessionID)
        current = state.focused[sessionID]
      }
      if (current) {
        // Prompt delivery may be retried after Goal creation succeeded. Treat
        // the same active objective as an idempotent prepare, never duplicate
        // the Goal simply because transport failed later in the send path.
        if (
          !["completed", "cancelled", "failed"].includes(current.detail.goal.status) &&
          current.detail.goal.objective === input.objective
        ) {
          return current.detail
        }
        throw new Error("This Session already has a focused Goal")
      }

      return createAndFocus(sessionID, {
        title: quickTitle(input.objective),
        objective: input.objective,
        // Quick mode stays zero-friction while retaining the same evidence gate
        // as structured Goals. The agent/verifier must still attach concrete
        // proof before this criterion can pass.
        criteria: ["The Goal objective is fully satisfied and the result is verified."],
        continuationPolicy: { mode: input.mode ?? "auto_continue" },
        start: true,
      })
    }

    return {
      arm(key: string) {
        return state.armed[key]
      },
      setArm(key: string, intent: GoalArmIntent | undefined) {
        setState("armed", key, intent)
      },
      toggleArm(key: string, mode: GoalArmIntent["mode"] = "auto_continue") {
        const next = state.armed[key] ? undefined : ({ mode } satisfies GoalArmIntent)
        setState("armed", key, next)
        return next
      },
      consumeArm(key: string) {
        const current = state.armed[key]
        if (current) setState("armed", key, undefined)
        return current
      },
      restoreArm(key: string, intent: GoalArmIntent | undefined) {
        if (!intent) return
        setState("armed", key, intent)
      },
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
        auditorPolicy?: GoalAuditorPolicy
      }) {
        const response = await sdk().create(input, { throwOnError: true })
        if (!response.data) throw new Error("Goal create returned no data")
        return response.data
      },
      createAndFocus,
      quickStart,
      async updateDraft(
        sessionID: string,
        input: {
          title: string
          objective: string
          criteria: string[]
          constraints?: string[]
          steps?: Array<{ title: string; description?: string }>
          auditorPolicy?: GoalAuditorPolicy
        },
      ) {
        const current = state.focused[sessionID]
        if (!current) throw new Error("No focused Goal")
        if (current.detail.goal.status !== "draft") throw new Error("Only draft Goals can edit setup")
        const response = await sdk().update(
          {
            goalID: current.detail.goal.id,
            expectedRevision: current.detail.goal.revision,
            title: input.title,
            objective: input.objective,
            criteria: input.criteria,
            constraints: input.constraints,
            steps: input.steps,
            auditorPolicy: input.auditorPolicy,
          },
          { throwOnError: true },
        )
        if (!response.data) throw new Error("Goal update returned no data")
        setState("focused", sessionID, "detail", response.data)
        return response.data
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
      async setAuditorModel(sessionID: string, model: { providerID: string; modelID: string } | undefined) {
        const current = state.focused[sessionID]
        if (!current) throw new Error("No focused Goal")
        const response = await sdk().update(
          {
            goalID: current.detail.goal.id,
            expectedRevision: current.detail.goal.revision,
            auditorPolicy: {
              ...current.detail.goal.auditorPolicy,
              model: model ? { providerID: model.providerID, id: model.modelID } : undefined,
            },
          },
          { throwOnError: true },
        )
        if (!response.data) throw new Error("Goal auditor update returned no data")
        setState("focused", sessionID, "detail", response.data)
        return response.data
      },
      async updateCriterion(sessionID: string, criterionID: string, status: "pending" | "passed" | "failed") {
        const current = state.focused[sessionID]
        if (!current) throw new Error("No focused Goal")
        const response = await sdk().criterion(
          {
            goalID: current.detail.goal.id,
            criterionID,
            expectedRevision: current.detail.goal.revision,
            status,
          },
          { throwOnError: true },
        )
        if (!response.data) throw new Error("Criterion update returned no data")
        setState("focused", sessionID, "detail", response.data)
        return response.data
      },
      /**
       * Realtime brief edit for a live Goal. The backend only allows
       * title/objective (plus policy) replacement once a Goal has left
       * draft, so criteria/steps stay read-only here by construction.
       * The updated detail flows to the agent through GoalContext on its
       * next turn; callers that need an immediate nudge should additionally
       * post {@link buildGoalUpdatedMessage}-style session text.
       */
      async updateActive(sessionID: string, input: { title: string; objective: string }) {
        const current = state.focused[sessionID]
        if (!current) throw new Error("No focused Goal")
        if (!["active", "paused", "blocked"].includes(current.detail.goal.status)) {
          throw new Error("Only live Goals can use realtime brief editing")
        }
        const response = await sdk().update(
          {
            goalID: current.detail.goal.id,
            expectedRevision: current.detail.goal.revision,
            title: input.title,
            objective: input.objective,
          },
          { throwOnError: true },
        )
        if (!response.data) throw new Error("Goal update returned no data")
        setState("focused", sessionID, "detail", response.data)
        return response.data
      },
    }
  },
})
