import type {
  ScheduledTaskAgendaOccurrence,
  ScheduledTaskInfo,
  ScheduledTaskRun,
  ScheduledTaskSchedule,
} from "@opencode-ai/sdk/v2/client"
import { createSessionNavigation } from "@opencode-ai/session-ui/context"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { ScrollView, ScrollViewOverlayScrollbar } from "@opencode-ai/ui/scroll-view"
import { Switch } from "@opencode-ai/ui/switch"
import { useNavigate } from "@solidjs/router"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { ScheduledTaskEditor } from "@/components/scheduled-task-editor"
import { useLanguage } from "@/context/language"
import { useScheduledTasks } from "@/context/scheduled-tasks"
import { legacySessionHref } from "@/utils/session-route"
import {
  scheduledCalendarDays,
  scheduledCalendarWindow,
  scheduledLocalDayKey,
  scheduledRunAttentionRank,
  shiftScheduledCalendarAnchor,
  type ScheduledCalendarRange,
} from "./scheduled-page-model"

type CalendarMode = ScheduledCalendarRange
type MobilePane = "calendar" | "tasks" | "activity"

const HOUR_HEIGHT = 52
const MINUTE_HEIGHT = HOUR_HEIGHT / 60
const CALENDAR_HEIGHT = HOUR_HEIGHT * 24

function formatClock(time: { hour: number; minute: number }) {
  return `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`
}

function scheduleLabel(language: ReturnType<typeof useLanguage>, schedule: ScheduledTaskSchedule): string {
  switch (schedule.kind) {
    case "daily":
      return language.t("scheduledTasks.schedule.daily", { times: schedule.times.map(formatClock).join(", ") })
    case "weekly": {
      const days = [...schedule.weekdays]
        .sort((left, right) => left - right)
        .map((day) => language.t(`scheduledTasks.weekday.${day}` as const))
        .join(", ")
      return language.t("scheduledTasks.schedule.weekly", { days, times: schedule.times.map(formatClock).join(", ") })
    }
    case "cron":
      return language.t("scheduledTasks.schedule.cron", { expression: schedule.expression })
    case "once":
      return language.t("scheduledTasks.schedule.once", { at: new Date(Number(schedule.at)).toLocaleString() })
    default:
      return language.t("scheduledTasks.never")
  }
}

function countdown(language: ReturnType<typeof useLanguage>, nowMs: number, target: unknown): string {
  const value = Number(target)
  if (!Number.isFinite(value)) return language.t("scheduledTasks.never")
  const ms = value - nowMs
  if (ms <= 0) return language.t("scheduledTasks.countdown.overdue")
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return language.t("scheduledTasks.countdown.seconds", { count: totalSeconds })
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return language.t("scheduledTasks.countdown.minutes", { count: totalMinutes })
  const totalHours = Math.floor(totalMinutes / 60)
  if (totalHours < 24)
    return language.t("scheduledTasks.countdown.hours", { count: totalHours, minutes: totalMinutes % 60 })
  return language.t("scheduledTasks.countdown.days", { count: Math.floor(totalHours / 24), hours: totalHours % 24 })
}

function statusLabel(language: ReturnType<typeof useLanguage>, status: ScheduledTaskRun["status"] | undefined): string {
  switch (status) {
    case "queued":
      return language.t("scheduledTasks.status.queued")
    case "running":
      return language.t("scheduledTasks.status.running")
    case "waiting":
      return language.t("scheduledTasks.status.waiting")
    case "succeeded":
      return language.t("scheduledTasks.status.succeeded")
    case "failed":
      return language.t("scheduledTasks.status.failed")
    case "skipped":
      return language.t("scheduledTasks.status.skipped")
    case "abandoned":
      return language.t("scheduledTasks.status.abandoned")
    default:
      return language.t("scheduledTasks.never")
  }
}

function sameLocalDay(left: number, right: number) {
  const a = new Date(left)
  const b = new Date(right)
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function shortDate(value: number) {
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(
    new Date(value),
  )
}

function rangeLabel(mode: CalendarMode, range: { from: number; to: number }) {
  if (mode === "day") {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(new Date(range.from))
  }
  const last = range.to - 1
  const startDate = new Date(range.from)
  const endDate = new Date(last)
  const sameYear = startDate.getFullYear() === endDate.getFullYear()
  const start = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" as const }),
  }).format(startDate)
  const end = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(endDate)
  return `${start} – ${end}`
}

function sessionModeLabel(language: ReturnType<typeof useLanguage>, task: ScheduledTaskInfo) {
  switch (task.sessionPolicy.kind) {
    case "new":
      return language.t("scheduledTasks.session.badge.new")
    case "reuse":
      return language.t("scheduledTasks.session.badge.reuse")
    case "auto":
      return language.t("scheduledTasks.session.badge.auto")
    case "existing":
      return language.t("scheduledTasks.session.badge.pinned")
  }
}

function taskModelLabel(language: ReturnType<typeof useLanguage>, task: ScheduledTaskInfo) {
  const model = task.action.model
  if (!model) return language.t("scheduledTasks.model.inherit")
  const account = model.accountID ? ` @${model.accountID}` : ""
  const variant = model.variant ? ` · ${model.variant}` : ""
  return `${model.providerID}/${model.id}${account}${variant}`
}

function occurrenceMinute(occurrence: ScheduledTaskAgendaOccurrence) {
  const date = new Date(Number(occurrence.effectiveAt))
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60
}

function ScheduledRunSessionLink(props: { run: ScheduledTaskRun }) {
  const navigate = useNavigate()
  const language = useLanguage()
  const navigation = createSessionNavigation({
    sessionID: () => (props.run.directory ? props.run.sessionID : undefined),
    href: () => {
      if (!props.run.sessionID || !props.run.directory) return undefined
      return legacySessionHref(props.run.directory, props.run.sessionID)
    },
    navigateToSession: (sessionID) => {
      if (!props.run.directory) return
      navigate(legacySessionHref(props.run.directory, sessionID))
    },
  })

  return (
    <Show when={navigation.clickable()}>
      <a
        data-action="scheduled-task-open-session"
        href={navigation.href()}
        aria-label={language.t("scheduledTasks.openSession")}
        title={language.t("scheduledTasks.openSession")}
        class="inline-flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-11-regular text-text-weak transition-colors hover:bg-surface-base hover:text-text-strong focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-strong"
        onClick={navigation.navigate}
        onKeyDown={navigation.navigateKey}
      >
        <Icon name="square-arrow-top-right" size="small" />
        <span class="hidden xl:inline">{language.t("scheduledTasks.openSession")}</span>
      </a>
    </Show>
  )
}

function TimedCalendar(props: {
  days: number[]
  occurrences: ScheduledTaskAgendaOccurrence[]
  now: number
  selectedTaskID?: string
  task: (id: string) => ScheduledTaskInfo | undefined
  onSelectTask: (id: string) => void
}) {
  const language = useLanguage()
  let viewport: HTMLDivElement | undefined
  const occurrencesByDay = createMemo(() => {
    const result = new Map<string, ScheduledTaskAgendaOccurrence[]>()
    for (const item of props.occurrences) {
      const key = scheduledLocalDayKey(Number(item.effectiveAt))
      const bucket = result.get(key)
      if (bucket) bucket.push(item)
      else result.set(key, [item])
    }
    return result
  })
  const occurrencesFor = (day: number) => occurrencesByDay().get(scheduledLocalDayKey(day)) ?? []
  const nowMinute = () => {
    const date = new Date(props.now)
    return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60
  }

  return (
    <div class="relative min-h-0 flex-1 bg-background-base">
      <ScrollView
        class="h-full [&_.scroll-view__viewport]:overflow-x-auto"
        viewportRef={(element) => (viewport = element)}
      >
        <div class="min-w-[720px]">
          <div
            class="sticky top-0 z-20 grid border-b border-border-weaker-base bg-background-base"
            style={{ "grid-template-columns": `52px repeat(${props.days.length}, minmax(128px, 1fr))` }}
          >
            <div class="h-10 border-r border-border-weaker-base" />
            <For each={props.days}>
              {(day) => (
                <div
                  class="flex h-10 items-center justify-center border-r border-border-weaker-base px-2 text-11-medium text-text-weak last:border-r-0"
                  classList={{ "text-text-strong": sameLocalDay(day, props.now) }}
                >
                  {shortDate(day)}
                </div>
              )}
            </For>
          </div>
          <div
            class="grid"
            style={{ "grid-template-columns": `52px repeat(${props.days.length}, minmax(128px, 1fr))` }}
          >
            <div class="relative border-r border-border-weaker-base" style={{ height: `${CALENDAR_HEIGHT}px` }}>
              <For each={Array.from({ length: 24 }, (_, hour) => hour)}>
                {(hour) => (
                  <span
                    class="absolute right-2 -translate-y-1/2 text-[10px] tabular-nums text-text-weak"
                    style={{ top: `${hour * HOUR_HEIGHT}px` }}
                  >
                    {new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(new Date(2000, 0, 1, hour))}
                  </span>
                )}
              </For>
            </div>
            <For each={props.days}>
              {(day) => (
                <div
                  class="relative border-r border-border-weaker-base last:border-r-0"
                  style={{ height: `${CALENDAR_HEIGHT}px` }}
                >
                  <For each={Array.from({ length: 24 }, (_, hour) => hour)}>
                    {(hour) => (
                      <div
                        class="absolute inset-x-0 border-t border-border-weaker-base"
                        style={{ top: `${hour * HOUR_HEIGHT}px` }}
                      />
                    )}
                  </For>
                  <For each={occurrencesFor(day)}>
                    {(occurrence) => {
                      const task = () => props.task(occurrence.taskID)
                      const selected = () => props.selectedTaskID === occurrence.taskID
                      return (
                        <button
                          type="button"
                          class="absolute inset-x-1 z-10 min-h-5 overflow-hidden rounded border border-border-weak-base bg-surface-base px-1.5 py-0.5 text-left text-[10px] leading-4 text-text-strong shadow-xs hover:bg-surface-raised-base focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-strong"
                          classList={{ "ring-1 ring-border-strong": selected(), "opacity-55": !task()?.enabled }}
                          style={{ top: `${Math.max(0, occurrenceMinute(occurrence) * MINUTE_HEIGHT)}px` }}
                          onClick={() => props.onSelectTask(occurrence.taskID)}
                          title={task()?.name}
                        >
                          <span class="block truncate font-medium">{task()?.name ?? occurrence.taskID}</span>
                          <span class="block truncate tabular-nums text-text-weak">
                            {new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
                              new Date(Number(occurrence.effectiveAt)),
                            )}
                          </span>
                        </button>
                      )
                    }}
                  </For>
                  <Show when={sameLocalDay(day, props.now)}>
                    <div
                      class="pointer-events-none absolute inset-x-0 z-10 border-t border-text-strong/50"
                      style={{ top: `${nowMinute() * MINUTE_HEIGHT}px` }}
                      aria-label={language.t("scheduledTasks.calendar.currentTime")}
                    >
                      <span class="absolute -left-1 -top-1 size-2 rounded-full bg-text-strong" />
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </div>
      </ScrollView>
      <ScrollViewOverlayScrollbar viewport={() => viewport} orientation="horizontal" />
    </div>
  )
}

function MonthCalendar(props: {
  days: number[]
  occurrences: ScheduledTaskAgendaOccurrence[]
  now: number
  selectedTaskID?: string
  task: (id: string) => ScheduledTaskInfo | undefined
  onSelectTask: (id: string) => void
}) {
  let viewport: HTMLDivElement | undefined
  const leading = () => (new Date(props.days[0] ?? props.now).getDay() + 6) % 7
  const occurrencesByDay = createMemo(() => {
    const result = new Map<string, ScheduledTaskAgendaOccurrence[]>()
    for (const item of props.occurrences) {
      const key = scheduledLocalDayKey(Number(item.effectiveAt))
      const bucket = result.get(key)
      if (bucket) bucket.push(item)
      else result.set(key, [item])
    }
    for (const bucket of result.values()) bucket.sort((a, b) => Number(a.effectiveAt) - Number(b.effectiveAt))
    return result
  })
  const occurrencesFor = (day: number) => occurrencesByDay().get(scheduledLocalDayKey(day)) ?? []

  return (
    <div class="relative min-h-0 flex-1 bg-background-base">
      <ScrollView
        class="h-full [&_.scroll-view__viewport]:overflow-x-auto"
        viewportRef={(element) => (viewport = element)}
      >
        <div class="min-w-[720px] p-2">
          <div class="grid grid-cols-7 border-l border-t border-border-weaker-base">
            <For each={Array.from({ length: leading() })}>
              {() => <div class="min-h-28 border-b border-r border-border-weaker-base bg-surface-base/20" />}
            </For>
            <For each={props.days}>
              {(day) => {
                const events = () => occurrencesFor(day)
                return (
                  <div
                    class="min-h-28 border-b border-r border-border-weaker-base p-1.5"
                    classList={{ "bg-surface-base/40": sameLocalDay(day, props.now) }}
                  >
                    <div class="mb-1 flex items-center justify-between">
                      <span
                        class="text-11-medium tabular-nums text-text-weak"
                        classList={{ "text-text-strong": sameLocalDay(day, props.now) }}
                      >
                        {new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric" }).format(new Date(day))}
                      </span>
                    </div>
                    <div class="flex flex-col gap-0.5">
                      <For each={events().slice(0, 4)}>
                        {(occurrence) => {
                          const task = () => props.task(occurrence.taskID)
                          return (
                            <button
                              type="button"
                              class="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-left text-[10px] leading-4 text-text-weak hover:bg-surface-base hover:text-text-strong"
                              classList={{
                                "bg-surface-base text-text-strong": props.selectedTaskID === occurrence.taskID,
                                "opacity-50": !task()?.enabled,
                              }}
                              onClick={() => props.onSelectTask(occurrence.taskID)}
                              title={task()?.name}
                            >
                              <span class="shrink-0 tabular-nums">
                                {new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
                                  new Date(Number(occurrence.effectiveAt)),
                                )}
                              </span>
                              <span class="min-w-0 truncate">{task()?.name ?? occurrence.taskID}</span>
                            </button>
                          )
                        }}
                      </For>
                      <Show when={events().length > 4}>
                        <span class="px-1 text-[10px] text-text-weak">+{events().length - 4}</span>
                      </Show>
                    </div>
                  </div>
                )
              }}
            </For>
          </div>
        </div>
      </ScrollView>
      <ScrollViewOverlayScrollbar viewport={() => viewport} orientation="horizontal" />
    </div>
  )
}

export function ScheduledPage() {
  const store = useScheduledTasks()
  const dialog = useDialog()
  const language = useLanguage()
  const [pendingDelete, setPendingDelete] = createSignal<string | undefined>(undefined)
  const [busy, setBusy] = createSignal<string | undefined>(undefined)
  const [mode, setMode] = createSignal<CalendarMode>("week")
  const [anchor, setAnchor] = createSignal(Date.now())
  const [selectedTaskID, setSelectedTaskID] = createSignal<string | undefined>()
  const [taskQuery, setTaskQuery] = createSignal("")
  const [mobilePane, setMobilePane] = createSignal<MobilePane>("calendar")
  const [activityCollapsed, setActivityCollapsed] = createSignal(false)

  const range = createMemo(() => scheduledCalendarWindow(mode(), anchor()))
  const days = createMemo(() => scheduledCalendarDays(range()))
  const selectedTask = createMemo(() => {
    const id = selectedTaskID()
    return id ? store.task(id) : undefined
  })
  const visibleTasks = createMemo(() => {
    const query = taskQuery().trim().toLowerCase()
    if (!query) return store.tasks()
    return store.tasks().filter((task) => {
      const model = taskModelLabel(language, task).toLowerCase()
      return (
        task.name.toLowerCase().includes(query) ||
        scheduleLabel(language, task.schedule).toLowerCase().includes(query) ||
        model.includes(query)
      )
    })
  })
  const activityRuns = createMemo(() =>
    [...store.runs()].sort((left, right) => {
      const delta =
        scheduledRunAttentionRank({ status: left.status, unread: store.isUnread(left) }) -
        scheduledRunAttentionRank({ status: right.status, unread: store.isUnread(right) })
      if (delta !== 0) return delta
      return Number(right.startedAt) - Number(left.startedAt)
    }),
  )

  onMount(() => {
    store.ensureLoaded()
    onCleanup(store.retainTicker())
  })

  createEffect(() => {
    const current = range()
    void store.loadAgenda({ from: current.from, to: current.to }).catch(() => undefined)
  })

  const openEditor = (task?: ScheduledTaskInfo) => {
    void dialog.show(() => <ScheduledTaskEditor task={task} />)
  }

  const runTask = async (task: ScheduledTaskInfo) => {
    setBusy(task.id)
    try {
      await store.runNow(task.id)
    } finally {
      setBusy(undefined)
    }
  }

  const confirmDelete = async (task: ScheduledTaskInfo) => {
    setPendingDelete(undefined)
    setBusy(task.id)
    try {
      await store.remove(task.id)
      if (selectedTaskID() === task.id) setSelectedTaskID(undefined)
    } finally {
      setBusy(undefined)
    }
  }

  const shiftRange = (direction: -1 | 1) => {
    setAnchor((value) => shiftScheduledCalendarAnchor(mode(), value, direction))
  }

  return (
    <div
      data-component="scheduled-tasks-page"
      class="m-2 flex min-h-0 min-w-0 flex-1 self-stretch flex-col overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)] contain-strict"
    >
      <header class="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border-weaker-base px-3 lg:px-4">
        <div class="flex min-w-0 items-center gap-2">
          <h1 class="text-14-medium text-text-strong">{language.t("scheduledTasks.title")}</h1>
          <Show when={store.paused()}>
            <span class="rounded border border-border-weaker-base px-1.5 py-0.5 text-[10px] text-text-weak">
              {language.t("scheduledTasks.paused")}
            </span>
          </Show>
          <span class="hidden truncate text-11-regular text-text-weak sm:inline">{rangeLabel(mode(), range())}</span>
        </div>
        <div class="flex shrink-0 items-center gap-1.5">
          <div class="hidden items-center rounded-md border border-border-weaker-base sm:flex">
            <button
              type="button"
              class="h-7 px-2 text-12-regular text-text-weak hover:bg-surface-base hover:text-text-strong"
              aria-label={language.t("scheduledTasks.calendar.previous")}
              onClick={() => shiftRange(-1)}
            >
              ‹
            </button>
            <button
              type="button"
              class="h-7 border-x border-border-weaker-base px-2 text-11-medium text-text-strong hover:bg-surface-base"
              onClick={() => setAnchor(Date.now())}
            >
              {language.t("scheduledTasks.calendar.today")}
            </button>
            <button
              type="button"
              class="h-7 px-2 text-12-regular text-text-weak hover:bg-surface-base hover:text-text-strong"
              aria-label={language.t("scheduledTasks.calendar.next")}
              onClick={() => shiftRange(1)}
            >
              ›
            </button>
          </div>
          <div class="flex items-center rounded-md border border-border-weaker-base p-0.5">
            <For each={["day", "week", "month"] as const}>
              {(item) => (
                <button
                  type="button"
                  class="h-6 rounded px-2 text-[10px] font-medium text-text-weak hover:text-text-strong"
                  classList={{ "bg-surface-base text-text-strong": mode() === item }}
                  onClick={() => setMode(item)}
                >
                  {language.t(
                    item === "day"
                      ? "scheduledTasks.calendar.24h"
                      : item === "week"
                        ? "scheduledTasks.calendar.7d"
                        : "scheduledTasks.calendar.30d",
                  )}
                </button>
              )}
            </For>
          </div>
          <Switch checked={!store.paused()} onChange={(checked) => void store.setControl(!checked)}>
            <span class="hidden xl:inline">
              {language.t(store.paused() ? "scheduledTasks.resume" : "scheduledTasks.pause")}
            </span>
          </Switch>
          <Button type="button" size="small" variant="primary" onClick={() => openEditor()}>
            {language.t("scheduledTasks.new")}
          </Button>
        </div>
      </header>

      <Show when={store.paused() || store.error()}>
        <div class="shrink-0 border-b border-border-weaker-base px-4 py-1.5 text-11-regular text-text-weak">
          {store.error() ? language.t("scheduledTasks.loadFailed") : language.t("scheduledTasks.pausedHint")}
        </div>
      </Show>

      <nav class="flex h-9 shrink-0 items-center gap-1 border-b border-border-weaker-base px-2 lg:hidden">
        <For each={["calendar", "tasks", "activity"] as const}>
          {(pane) => (
            <button
              type="button"
              class="h-7 rounded px-2.5 text-11-medium text-text-weak"
              classList={{ "bg-surface-base text-text-strong": mobilePane() === pane }}
              onClick={() => setMobilePane(pane)}
            >
              {language.t(
                pane === "calendar"
                  ? "scheduledTasks.calendar.title"
                  : pane === "tasks"
                    ? "scheduledTasks.tasks"
                    : "scheduledTasks.activity",
              )}
            </button>
          )}
        </For>
      </nav>

      <div
        class="min-h-0 flex-1 lg:flex"
        classList={{ flex: mobilePane() !== "activity", hidden: mobilePane() === "activity" }}
      >
        <section
          class="relative min-h-0 min-w-0 flex-1 flex-col lg:flex"
          classList={{ flex: mobilePane() === "calendar", hidden: mobilePane() !== "calendar" }}
        >
          <Show when={store.agendaError()}>
            <div class="absolute inset-x-3 top-3 z-30 rounded-md border border-border-weaker-base bg-background-base px-3 py-2 text-11-regular text-text-strong shadow-sm">
              {language.t("scheduledTasks.calendar.loadFailed")}
            </div>
          </Show>
          <Show
            when={mode() === "month"}
            fallback={
              <TimedCalendar
                days={days()}
                occurrences={store.agenda()}
                now={store.now()}
                selectedTaskID={selectedTaskID()}
                task={store.task}
                onSelectTask={setSelectedTaskID}
              />
            }
          >
            <MonthCalendar
              days={days()}
              occurrences={store.agenda()}
              now={store.now()}
              selectedTaskID={selectedTaskID()}
              task={store.task}
              onSelectTask={setSelectedTaskID}
            />
          </Show>
          <Show when={store.agendaLoading()}>
            <div class="pointer-events-none absolute bottom-2 left-2 rounded border border-border-weaker-base bg-background-base/90 px-2 py-1 text-[10px] text-text-weak">
              {language.t("scheduledTasks.calendar.loading")}
            </div>
          </Show>
        </section>

        <aside
          class="min-h-0 w-full shrink-0 flex-col border-l border-border-weaker-base bg-background-base lg:flex lg:w-[330px]"
          classList={{ flex: mobilePane() === "tasks", hidden: mobilePane() !== "tasks" }}
        >
          <div class="flex h-10 shrink-0 items-center gap-2 border-b border-border-weaker-base px-2.5">
            <span class="text-11-medium uppercase tracking-wide text-text-weak">
              {language.t("scheduledTasks.tasks")}
            </span>
            <span class="text-[10px] tabular-nums text-text-weak">{store.tasks().length}</span>
            <input
              type="search"
              value={taskQuery()}
              onInput={(event) => setTaskQuery(event.currentTarget.value)}
              placeholder={language.t("scheduledTasks.search.placeholder")}
              class="ml-auto h-6 w-32 rounded border border-border-weaker-base bg-transparent px-2 text-11-regular text-text-strong outline-none placeholder:text-text-weak focus:border-border-strong"
            />
          </div>
          <ScrollView class="min-h-0 flex-1">
            <div class="p-1.5">
              <Show
                when={visibleTasks().length > 0}
                fallback={
                  <p class="px-2 py-4 text-11-regular text-text-weak">{language.t("scheduledTasks.empty.tasks")}</p>
                }
              >
                <For each={visibleTasks()}>
                  {(task) => (
                    <div
                      class="group rounded-md border border-transparent px-2 py-2"
                      classList={{
                        "border-border-weaker-base bg-surface-base": selectedTaskID() === task.id,
                        "hover:bg-surface-base/60": selectedTaskID() !== task.id,
                      }}
                    >
                      <div class="flex items-start gap-2">
                        <button
                          type="button"
                          class="min-w-0 flex-1 text-left"
                          onClick={() => setSelectedTaskID(task.id)}
                        >
                          <div class="flex min-w-0 items-center gap-1.5">
                            <span
                              class="size-1.5 shrink-0 rounded-full bg-text-strong"
                              classList={{ "opacity-25": !task.enabled || store.paused() }}
                            />
                            <span class="min-w-0 flex-1 truncate text-12-medium text-text-strong">{task.name}</span>
                            <span class="shrink-0 rounded border border-border-weaker-base px-1 py-px text-[9px] text-text-weak">
                              {sessionModeLabel(language, task)}
                            </span>
                          </div>
                          <span class="mt-0.5 block truncate pl-3 text-[10px] text-text-weak">
                            {scheduleLabel(language, task.schedule)}
                          </span>
                          <span class="mt-0.5 block truncate pl-3 text-[10px] text-text-weak">
                            {taskModelLabel(language, task)}
                          </span>
                          <span class="mt-1 flex items-center gap-1.5 pl-3 text-[10px] text-text-weak">
                            <span>
                              {task.enabled
                                ? `${language.t("scheduledTasks.next")}: ${countdown(language, store.now(), task.nextRunAt)}`
                                : language.t("scheduledTasks.disabled")}
                            </span>
                            <Show when={task.lastRunStatus}>
                              <span>· {statusLabel(language, task.lastRunStatus)}</span>
                            </Show>
                          </span>
                        </button>
                        <Switch
                          checked={task.enabled}
                          aria-label={task.name}
                          onChange={(checked) =>
                            void store.setEnabled(task.id, checked, Number(task.revision)).catch(() => undefined)
                          }
                        />
                      </div>
                      <Show when={selectedTaskID() === task.id}>
                        <div class="mt-2 flex items-center gap-1 border-t border-border-weaker-base pt-1.5">
                          <Button
                            type="button"
                            size="small"
                            variant="ghost"
                            disabled={busy() === task.id}
                            onClick={() => void runTask(task)}
                          >
                            {language.t("scheduledTasks.runNow")}
                          </Button>
                          <Button type="button" size="small" variant="ghost" onClick={() => openEditor(task)}>
                            {language.t("scheduledTasks.edit")}
                          </Button>
                          <Show
                            when={pendingDelete() === task.id}
                            fallback={
                              <Button
                                type="button"
                                size="small"
                                variant="ghost"
                                onClick={() => setPendingDelete(task.id)}
                              >
                                {language.t("scheduledTasks.delete")}
                              </Button>
                            }
                          >
                            <Button
                              type="button"
                              size="small"
                              variant="primary"
                              disabled={busy() === task.id}
                              onClick={() => void confirmDelete(task)}
                            >
                              {language.t("scheduledTasks.confirm")}
                            </Button>
                            <Button
                              type="button"
                              size="small"
                              variant="ghost"
                              onClick={() => setPendingDelete(undefined)}
                            >
                              {language.t("common.cancel")}
                            </Button>
                          </Show>
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </ScrollView>
        </aside>
      </div>

      <section
        class="min-h-0 flex-1 flex-col border-t border-border-weaker-base bg-background-base lg:flex lg:flex-none lg:shrink-0"
        classList={{
          flex: mobilePane() === "activity",
          hidden: mobilePane() !== "activity",
          "lg:h-9": activityCollapsed(),
          "lg:h-[190px]": !activityCollapsed(),
        }}
      >
        <div class="flex h-9 shrink-0 items-center gap-2 px-3">
          <h2 class="text-11-medium uppercase tracking-wide text-text-weak">{language.t("scheduledTasks.activity")}</h2>
          <Show when={store.unreadCount() > 0}>
            <span class="rounded border border-border-weaker-base px-1.5 py-px text-[9px] text-text-strong">
              {language.t("scheduledTasks.unread", { count: store.unreadCount() })}
            </span>
          </Show>
          <Button
            type="button"
            size="small"
            variant="ghost"
            class="ml-auto hidden lg:inline-flex"
            onClick={() => setActivityCollapsed((value) => !value)}
          >
            {language.t(activityCollapsed() ? "scheduledTasks.activity.expand" : "scheduledTasks.activity.collapse")}
          </Button>
          <Button type="button" size="small" variant="ghost" onClick={() => void store.refresh()}>
            {language.t("scheduledTasks.refresh")}
          </Button>
        </div>
        <ScrollView
          class="min-h-0 flex-1 border-t border-border-weaker-base"
          classList={{ "lg:hidden": activityCollapsed() }}
        >
          <Show
            when={activityRuns().length > 0}
            fallback={<p class="px-3 py-4 text-11-regular text-text-weak">{language.t("scheduledTasks.empty.runs")}</p>}
          >
            <For each={activityRuns()}>
              {(run) => (
                <div
                  class="flex min-h-8 items-center gap-2 border-b border-border-weaker-base px-3 py-1.5 last:border-b-0"
                  classList={{ "bg-surface-base": store.isUnread(run) }}
                >
                  <span
                    class="size-1.5 shrink-0 rounded-full bg-text-weak"
                    classList={{
                      "bg-text-strong": run.status === "waiting" || run.status === "running" || store.isUnread(run),
                      "opacity-40":
                        run.status === "succeeded" || run.status === "skipped" || run.status === "abandoned",
                    }}
                  />
                  <span class="w-32 shrink-0 truncate text-11-medium text-text-strong">
                    {store.task(run.taskID)?.name ?? run.taskID}
                  </span>
                  <span class="w-16 shrink-0 text-[10px] text-text-weak">{statusLabel(language, run.status)}</span>
                  <span class="min-w-0 flex-1 truncate text-[10px] text-text-weak">
                    {new Date(Number(run.startedAt)).toLocaleString()}
                    {run.errorMessage ? ` · ${run.errorMessage}` : ""}
                  </span>
                  <ScheduledRunSessionLink run={run} />
                  <Show when={store.isUnread(run)}>
                    <Button type="button" size="small" variant="ghost" onClick={() => void store.acknowledge(run.id)}>
                      {language.t("scheduledTasks.acknowledge")}
                    </Button>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </ScrollView>
      </section>
    </div>
  )
}
