import type {
  ScheduledTaskAction,
  ScheduledTaskAgendaOccurrence,
  ScheduledTaskControl,
  ScheduledTaskInfo,
  ScheduledTaskPolicy,
  ScheduledTaskPreview,
  ScheduledTaskRun,
  ScheduledTaskScheduleInput,
  ScheduledTaskSessionBindingProjection,
  ScheduledTaskSessionCandidate,
  ScheduledTaskSessionPolicy,
  ScheduledTaskTarget,
} from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useServerSDK } from "./server-sdk"

export type ScheduledTaskDraft = {
  name: string
  targetDirectory: string
  target: ScheduledTaskTarget
  sessionPolicy: ScheduledTaskSessionPolicy
  schedule: ScheduledTaskScheduleInput
  timezone: string
  action: ScheduledTaskAction
  policy: ScheduledTaskPolicy
}

/** Server-owned unread projection: `acknowledged_at IS NULL AND status IN (failed, waiting)`. */
const ATTENTION_STATUSES = new Set(["failed", "waiting"])

function finite(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One client store for scheduled tasks + runs.
 *
 * Four rules from docs/plans/scheduled-tasks/04-surface-and-ux.md § 4.1:
 *  1. a single `event.listen` subscription patches rows by id;
 *  2. one shared 1-second ticker drives every countdown (refcounted);
 *  3. events patch the store, the list query is not re-fetched per event;
 *  4. no client-side cron parsing — the server sends epoch integers and the
 *     `preview` endpoint answers "when next".
 *
 * Every scheduled-task endpoint used here, including `runNow`, is Tier 0.
 * `runNow` only durably enqueues work; the process-global runner owns the later
 * Tier 3 execution boundary.
 */
export const { use: useScheduledTasks, provider: ScheduledTasksProvider } = createSimpleContext({
  name: "ScheduledTasks",
  init: () => {
    const serverSDK = useServerSDK()
    const [state, setState] = createStore({
      tasks: {} as Record<string, ScheduledTaskInfo>,
      runs: {} as Record<string, ScheduledTaskRun>,
      bindings: {} as Record<string, ScheduledTaskSessionBindingProjection | null>,
      agenda: [] as ScheduledTaskAgendaOccurrence[],
      agendaKey: undefined as string | undefined,
      agendaLoading: false,
      agendaError: undefined as string | undefined,
      control: { paused: false, timeUpdated: 0 } as ScheduledTaskControl,
      unread: undefined as number | undefined,
      loaded: false,
      loading: false,
      error: undefined as string | undefined,
    })

    const sdk = createMemo(() => serverSDK().client.scheduledTask)
    const agendaCache = new Map<string, ScheduledTaskAgendaOccurrence[]>()
    const agendaInflight = new Map<string, Promise<ScheduledTaskAgendaOccurrence[]>>()
    const bindingInflight = new Map<string, Promise<ScheduledTaskSessionBindingProjection | null>>()
    let activeAgendaWindow: { from: number; to: number; projectID?: string } | undefined

    const agendaKey = (input: { from: number; to: number; projectID?: string }) =>
      `${input.projectID ?? "*"}:${input.from}:${input.to}`

    const invalidateAgenda = () => {
      agendaCache.clear()
      setState("agendaKey", undefined)
    }

    const upsertTask = (info: ScheduledTaskInfo) => setState("tasks", info.id, info)
    const dropTask = (id: string) =>
      setState("tasks", (tasks) => {
        if (!(id in tasks)) return tasks
        const next = { ...tasks }
        delete next[id]
        return next
      })
    const dropBinding = (id: string) =>
      setState("bindings", (bindings) => {
        if (!(id in bindings)) return bindings
        const next = { ...bindings }
        delete next[id]
        return next
      })
    const upsertRun = (run: ScheduledTaskRun) => setState("runs", run.id, run)
    const dropRunsForTask = (taskID: string) =>
      setState("runs", (runs) => {
        const next = { ...runs }
        let changed = false
        for (const run of Object.values(runs)) {
          if (run?.taskID !== taskID) continue
          delete next[run.id]
          changed = true
        }
        return changed ? next : runs
      })

    const refreshUnread = async (): Promise<number | undefined> => {
      try {
        const response = await sdk().unreadCount({ throwOnError: true })
        const value = response.data?.unread
        const normalized = typeof value === "number" && Number.isFinite(value) ? value : undefined
        if (normalized !== undefined) setState("unread", normalized)
        return normalized
      } catch {
        // The badge is a projection; a failed aggregate must not break the pane.
        return undefined
      }
    }

    const refresh = async () => {
      setState("loading", true)
      try {
        const [list, inbox, control] = await Promise.all([
          sdk().list(undefined, { throwOnError: true }),
          sdk().inbox({ limit: "200" }, { throwOnError: true }),
          sdk().getControl({ throwOnError: true }),
        ])
        const tasks: Record<string, ScheduledTaskInfo> = {}
        for (const task of list.data ?? []) tasks[task.id] = task
        const runs: Record<string, ScheduledTaskRun> = {}
        for (const run of inbox.data ?? []) runs[run.id] = run
        setState("tasks", tasks)
        setState("runs", runs)
        if (control.data) setState("control", control.data)
        await refreshUnread()
        setState("error", undefined)
        setState("loaded", true)
      } catch (error) {
        setState("error", messageOf(error))
      } finally {
        setState("loading", false)
      }
    }

    const ensureLoaded = () => {
      if (state.loaded || state.loading) return
      void refresh()
    }

    // Rule 1: exactly one subscription per server. Rows are patched by id from
    // the event payload; no re-fetch, no per-component subscription.
    createEffect(() => {
      const current = serverSDK()
      const unsub = current.event.listen((envelope) => {
        const event = envelope.details
        if (event.type === "scheduledTask.created" || event.type === "scheduledTask.updated") {
          upsertTask(event.properties.info as ScheduledTaskInfo)
          invalidateAgenda()
          if (activeAgendaWindow) void loadAgenda(activeAgendaWindow, { force: true })
          return
        }
        if (event.type === "scheduledTask.removed") {
          dropTask(event.properties.taskID)
          dropBinding(event.properties.taskID)
          invalidateAgenda()
          if (activeAgendaWindow) void loadAgenda(activeAgendaWindow, { force: true })
          return
        }
        if (
          event.type === "scheduledTask.runStarted" ||
          event.type === "scheduledTask.runSettled" ||
          event.type === "scheduledTask.runUpdated"
        ) {
          upsertRun(event.properties.run as ScheduledTaskRun)
          // Keep the badge server-authoritative instead of reconstructing it
          // from the bounded inbox window.
          void refreshUnread()
          return
        }
        if (event.type === "scheduledTask.controlChanged") {
          setState("control", event.properties.control)
          return
        }
        if (event.type === "scheduledTask.sessionBindingChanged") {
          setState("bindings", event.properties.taskID, event.properties.binding ?? null)
        }
      })
      onCleanup(unsub)
    })

    // Rule 2: one interval for every countdown. The pane retains it on mount
    // and releases on unmount; no row ever owns a timer.
    const [now, setNow] = createSignal(Date.now())
    let ticker: ReturnType<typeof setInterval> | undefined
    let tickerRefs = 0
    const stopTicker = () => {
      if (ticker !== undefined) clearInterval(ticker)
      ticker = undefined
    }
    const retainTicker = () => {
      tickerRefs += 1
      if (ticker === undefined) ticker = setInterval(() => setNow(Date.now()), 1000)
      let released = false
      return () => {
        if (released) return
        released = true
        tickerRefs = Math.max(0, tickerRefs - 1)
        if (tickerRefs === 0) stopTicker()
      }
    }
    onCleanup(() => {
      tickerRefs = 0
      stopTicker()
    })

    const preview = async (
      schedule: ScheduledTaskScheduleInput,
      timezone: string,
      count = 5,
    ): Promise<ScheduledTaskPreview> => {
      const response = await sdk().preview({ schedule, timezone, count }, { throwOnError: true })
      return response.data ?? { next: [], warnings: [], summary: "" }
    }

    const loadAgenda = async (
      input: { from: number; to: number; projectID?: string },
      options?: { force?: boolean },
    ): Promise<ScheduledTaskAgendaOccurrence[]> => {
      activeAgendaWindow = input
      const key = agendaKey(input)
      if (!options?.force) {
        const cached = agendaCache.get(key)
        if (cached) {
          setState("agenda", cached)
          setState("agendaKey", key)
          setState("agendaError", undefined)
          return cached
        }
        const pending = agendaInflight.get(key)
        if (pending) return pending
      }

      setState("agendaLoading", true)
      setState("agendaError", undefined)
      const request = sdk()
        .agenda({ from: String(input.from), to: String(input.to), limit: "5000", projectID: input.projectID }, { throwOnError: true })
        .then((response) => response.data ?? [])
        .then((rows) => {
          agendaCache.set(key, rows)
          if (agendaKey(activeAgendaWindow ?? input) === key) {
            setState("agenda", rows)
            setState("agendaKey", key)
          }
          return rows
        })
        .catch((error) => {
          if (agendaKey(activeAgendaWindow ?? input) === key) setState("agendaError", messageOf(error))
          throw error
        })
        .finally(() => {
          agendaInflight.delete(key)
          if (agendaKey(activeAgendaWindow ?? input) === key) setState("agendaLoading", false)
        })
      agendaInflight.set(key, request)
      return request
    }

    const getBinding = async (taskID: string, options?: { force?: boolean }) => {
      if (!options?.force && taskID in state.bindings) return state.bindings[taskID] ?? null
      if (!options?.force) {
        const pending = bindingInflight.get(taskID)
        if (pending) return pending
      }
      const request = sdk()
        .getBinding({ taskID }, { throwOnError: true })
        .then((response) => response.data ?? null)
        .then((binding) => {
          setState("bindings", taskID, binding)
          return binding
        })
        .finally(() => bindingInflight.delete(taskID))
      bindingInflight.set(taskID, request)
      return request
    }

    const clearBinding = async (taskID: string) => {
      await sdk().clearBinding({ taskID }, { throwOnError: true })
      setState("bindings", taskID, null)
    }

    const sessionCandidates = async (targetDirectory: string): Promise<ScheduledTaskSessionCandidate[]> => {
      const response = await sdk().sessionCandidates(
        { targetDirectory, limit: "100" },
        { throwOnError: true },
      )
      return response.data ?? []
    }

    const create = async (draft: ScheduledTaskDraft) => {
      const response = await sdk().create(draft, { throwOnError: true })
      if (response.data) upsertTask(response.data)
      return response.data
    }

    const update = async (id: string, expectedRevision: number, draft: ScheduledTaskDraft) => {
      const response = await sdk().update({ taskID: id, expectedRevision, ...draft }, { throwOnError: true })
      if (response.data) upsertTask(response.data)
      return response.data
    }

    const remove = async (id: string) => {
      await sdk().remove({ taskID: id }, { throwOnError: true })
      dropTask(id)
      dropRunsForTask(id)
      dropBinding(id)
    }

    const setEnabled = async (id: string, enabled: boolean, expectedRevision?: number) => {
      const response = await sdk().enabled({ taskID: id, enabled, expectedRevision }, { throwOnError: true })
      if (response.data) upsertTask(response.data)
      return response.data
    }

    const acknowledge = async (runID: string) => {
      await sdk().acknowledge({ runID }, { throwOnError: true })
      if (state.runs[runID]) setState("runs", runID, "acknowledgedAt", (value) => value ?? Date.now())
      setState("unread", (value) => (value === undefined ? value : Math.max(0, value - 1)))
    }

    const runNow = async (taskID: string) => {
      const response = await sdk().runNow({ taskID }, { throwOnError: true })
      if (response.data) upsertRun(response.data)
      return response.data
    }

    const setControl = async (paused: boolean) => {
      const response = await sdk().setControl({ paused }, { throwOnError: true })
      if (response.data) setState("control", response.data)
      return response.data
    }

    const tasks = createMemo(() =>
      Object.values(state.tasks)
        .filter((task): task is ScheduledTaskInfo => !!task)
        .sort((left, right) => {
          if (left.enabled !== right.enabled) return left.enabled ? -1 : 1
          const leftNext = finite(left.nextRunAt, Number.POSITIVE_INFINITY)
          const rightNext = finite(right.nextRunAt, Number.POSITIVE_INFINITY)
          if (leftNext !== rightNext) return leftNext - rightNext
          return left.name.localeCompare(right.name)
        }),
    )

    const runs = createMemo(() =>
      Object.values(state.runs)
        .filter((run): run is ScheduledTaskRun => !!run)
        .sort((left, right) => finite(right.startedAt, 0) - finite(left.startedAt, 0)),
    )

    const isUnread = (run: ScheduledTaskRun) =>
      run.acknowledgedAt === undefined && ATTENTION_STATUSES.has(run.status)

    const unreadCount = createMemo(() => state.unread ?? runs().filter(isUnread).length)

    return {
      tasks,
      runs,
      agenda: () => state.agenda,
      agendaLoading: () => state.agendaLoading,
      agendaError: () => state.agendaError,
      task: (id: string) => state.tasks[id],
      binding: (taskID: string) => state.bindings[taskID],
      control: () => state.control,
      paused: () => state.control.paused,
      loaded: () => state.loaded,
      loading: () => state.loading,
      error: () => state.error,
      unreadCount,
      now,
      retainTicker,
      ensureLoaded,
      refresh,
      preview,
      loadAgenda,
      getBinding,
      clearBinding,
      sessionCandidates,
      create,
      update,
      remove,
      setEnabled,
      acknowledge,
      runNow,
      setControl,
      isUnread,
    }
  },
})
