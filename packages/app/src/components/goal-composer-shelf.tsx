import type { GoalInfo } from "@opencode-ai/sdk/v2/client"
import { Popover } from "@opencode-ai/ui/popover"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { For, Show, createEffect, createMemo, createSignal, type JSX } from "solid-js"
import { useGoals } from "@/context/goals"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { useNow } from "@/hooks/use-now"
import { showToast } from "@/utils/toast"
import {
  formatGoalElapsed,
  goalLifecycleAction,
  goalProgress,
  isGoalTerminal,
} from "./goal-composer-shelf-model"

type Props = { sessionID: string }

function automationLabel(language: ReturnType<typeof useLanguage>, mode: "manual" | "auto_continue" | "unattended") {
  if (mode === "manual") return language.t("goal.mode.manual")
  if (mode === "auto_continue") return language.t("goal.mode.auto_continue")
  return language.t("goal.mode.unattended")
}

function number(value: number | string) {
  return typeof value === "number" ? value : Number(value) || 0
}

export function GoalComposerShelf(props: Props) {
  const goals = useGoals()
  const language = useLanguage()
  const sync = useSync()
  const [shown, setShown] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const current = createMemo(() => goals.focused(props.sessionID))
  const detail = createMemo(() => current()?.detail)
  const goal = createMemo(() => detail()?.goal)
  const now = useNow(() => !!goal() && !isGoalTerminal(goal()!.status))
  const progress = createMemo(() => {
    const value = detail()
    if (!value) return { done: 0, total: 0, percent: 0 }
    return goalProgress(value)
  })

  createEffect(() => {
    if (!shown() || !goal()) return
    void goals.loadExpanded(goal()!.id)
  })

  const fail = (error: unknown) =>
    showToast({
      variant: "error",
      title: language.t("goal.error.title"),
      description: error instanceof Error ? error.message : String(error),
    })

  const run = async (action: () => Promise<unknown>) => {
    if (busy()) return
    setBusy(true)
    try {
      await action()
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  const toggleLifecycle = () => {
    const action = goalLifecycleAction(goal()?.status ?? "")
    if (action) return run(() => goals.transition(props.sessionID, action))
  }

  return (
    <Show when={current() !== undefined}>
      <Show when={current()} fallback={<GoalLauncher sessionID={props.sessionID} />}>
        <div
          data-component="goal-composer-shelf"
          class="mx-auto flex h-9 w-[min(100%,680px)] items-center gap-1 rounded-[10px] border border-v2-border-border-muted bg-v2-background-bg-base px-1.5 shadow-[var(--v2-elevation-floating)]"
        >
          <div class="flex min-w-0 flex-1 items-center gap-2 px-1.5">
            <GoalStatusGlyph status={goal()!.status} />
            <Popover
              open={shown()}
              onOpenChange={setShown}
              placement="top"
              gutter={6}
              onOpenAutoFocus={(event) => event.preventDefault()}
              triggerAs="button"
              triggerProps={{
                type: "button",
                class:
                  "group flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left transition-colors hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none",
              }}
              trigger={
                <>
                  <span class="min-w-0 flex-1 truncate text-[12px] font-[560] leading-4 tracking-[-0.02em] text-v2-text-text-base">
                    {goal()!.title}
                  </span>
                  <span class="shrink-0 text-[10px] font-[520] tabular-nums text-v2-text-text-faint">
                    {progress().total ? `${progress().done}/${progress().total}` : goal()!.status}
                  </span>
                  <span class="h-1.5 w-16 overflow-hidden rounded-full bg-v2-overlay-simple-overlay-hover">
                    <span
                      class="block h-full rounded-full bg-v2-icon-icon-base transition-[width] duration-150"
                      style={{ width: `${progress().percent}%` }}
                    />
                  </span>
                  <span class="shrink-0 text-[10px] tabular-nums text-v2-text-text-faint">
                    {formatGoalElapsed(now() - number(goal()!.time.created))}
                  </span>
                  <Icon name="chevron-down" size="small" class="size-3 shrink-0 text-v2-icon-icon-muted" />
                </>
              }
              class="[&_[data-slot=popover-body]]:p-0 w-[420px] max-w-[calc(100vw-24px)] overflow-hidden rounded-[10px] border border-v2-border-border-muted bg-v2-background-bg-base shadow-[var(--v2-elevation-floating)]"
            >
              <GoalPopover sessionID={props.sessionID} busy={busy()} onRun={run} />
            </Popover>
          </div>

          <Show when={["draft", "active", "paused", "blocked"].includes(goal()!.status)}>
            <TooltipV2 value={goal()!.status === "active" ? language.t("goal.pause") : language.t("goal.resume")}>
              <IconButtonV2
                type="button"
                size="small"
                variant="ghost-muted"
                disabled={busy()}
                aria-label={goal()!.status === "active" ? language.t("goal.pause") : language.t("goal.resume")}
                icon={<Icon name={goal()!.status === "active" ? "pause" : "play"} size="small" />}
                onClick={toggleLifecycle}
              />
            </TooltipV2>
          </Show>
        </div>
      </Show>
    </Show>
  )
}

function GoalStatusGlyph(props: { status: string }) {
  return (
    <span
      class="grid size-4 shrink-0 place-items-center rounded-full border border-v2-border-border-muted text-v2-icon-icon-muted"
      classList={{
        "text-v2-state-fg-success": props.status === "completed",
        "text-v2-state-fg-warning": props.status === "blocked" || props.status === "verifying",
        "text-v2-state-fg-danger": props.status === "failed",
      }}
    >
      <Icon
        name={props.status === "completed" ? "check" : props.status === "verifying" ? "hourglass" : props.status === "blocked" ? "warning" : "star"}
        size="small"
        class="size-3"
      />
    </span>
  )
}

function GoalPopover(props: { sessionID: string; busy: boolean; onRun: (action: () => Promise<unknown>) => Promise<void> }) {
  const goals = useGoals()
  const language = useLanguage()
  const current = createMemo(() => goals.focused(props.sessionID))
  const detail = createMemo(() => current()!.detail)
  const goal = createMemo(() => detail().goal)
  const expanded = createMemo(() => goals.expanded(goal().id))

  return (
    <div class="flex max-h-[min(560px,70vh)] flex-col text-v2-text-text-base">
      <div class="flex items-start gap-3 border-b border-v2-border-border-muted px-3 py-2.5">
        <GoalStatusGlyph status={goal().status} />
        <div class="min-w-0 flex-1">
          <div class="truncate text-[13px] font-[600] leading-4 tracking-[-0.02em]">{goal().title}</div>
          <div class="mt-1 text-[11px] leading-4 text-v2-text-text-muted">{goal().objective}</div>
        </div>
        <span class="rounded-md border border-v2-border-border-muted px-1.5 py-0.5 text-[9px] font-[600] uppercase tracking-[0.04em] text-v2-text-text-faint">
          {goal().status}
        </span>
      </div>

      <div class="overflow-y-auto p-2 no-scrollbar">
        <Section title={language.t("goal.criteria")} count={detail().criteria.length}>
          <For each={detail().criteria}>
            {(item) => (
              <div class="flex min-h-7 items-start gap-2 rounded-md px-2 py-1.5 hover:bg-v2-overlay-simple-overlay-hover">
                <CriterionIcon status={item.status} />
                <span class="min-w-0 flex-1 text-[11px] leading-4 text-v2-text-text-base">{item.description}</span>
              </div>
            )}
          </For>
        </Section>

        <Show when={detail().steps.length > 0}>
          <Section title={language.t("goal.steps")} count={detail().steps.length}>
            <For each={detail().steps}>
              {(item) => (
                <div class="flex min-h-7 items-start gap-2 rounded-md px-2 py-1.5 hover:bg-v2-overlay-simple-overlay-hover">
                  <CriterionIcon status={item.status === "completed" ? "passed" : item.status === "blocked" ? "failed" : "pending"} />
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-[11px] font-[540] leading-4">{item.title}</div>
                    <Show when={item.assignedSessionID}>
                      <div class="truncate text-[9px] leading-3 text-v2-text-text-faint">
                        {language.t("goal.assigned", { session: item.assignedSessionID!.slice(0, 10) })}
                      </div>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </Section>
        </Show>

        <Section title={language.t("goal.automation")}>
          <div class="grid grid-cols-3 gap-1 p-1">
            <For each={["manual", "auto_continue", "unattended"] as const}>
              {(mode) => (
                <button
                  type="button"
                  class="h-7 rounded-md px-2 text-[10px] font-[540] transition-colors hover:bg-v2-overlay-simple-overlay-hover disabled:opacity-50"
                  classList={{
                    "bg-v2-overlay-simple-overlay-pressed text-v2-text-text-base": goal().continuationPolicy.mode === mode,
                    "text-v2-text-text-muted": goal().continuationPolicy.mode !== mode,
                  }}
                  disabled={props.busy || goal().status === "verifying" || isGoalTerminal(goal().status)}
                  onClick={() => props.onRun(() => goals.setContinuationMode(props.sessionID, mode))}
                >
                  {automationLabel(language, mode)}
                </button>
              )}
            </For>
          </div>
        </Section>

        <Show when={(expanded()?.focuses?.length ?? 0) > 1}>
          <Section title={language.t("goal.workers")} count={expanded()!.focuses!.length}>
            <For each={expanded()!.focuses}>
              {(focus) => (
                <div class="flex h-7 items-center gap-2 rounded-md px-2 text-[10px] hover:bg-v2-overlay-simple-overlay-hover">
                  <Icon name="chats" size="small" class="size-3 text-v2-icon-icon-muted" />
                  <span class="min-w-0 flex-1 truncate">{focus.sessionID}</span>
                  <span class="text-v2-text-text-faint">{focus.role}</span>
                </div>
              )}
            </For>
          </Section>
        </Show>

        <Show when={(expanded()?.evidence?.length ?? 0) > 0}>
          <Section title={language.t("goal.evidence")} count={expanded()!.evidence!.length}>
            <For each={expanded()!.evidence!.slice(-5).reverse()}>
              {(item) => (
                <div class="rounded-md px-2 py-1.5 hover:bg-v2-overlay-simple-overlay-hover">
                  <div class="flex items-center gap-2 text-[9px] uppercase tracking-[0.03em] text-v2-text-text-faint">
                    <span>{item.type}</span>
                    <Show when={item.verdict}><span>· {item.verdict}</span></Show>
                  </div>
                  <div class="mt-0.5 text-[10px] leading-4 text-v2-text-text-muted">{item.summary}</div>
                </div>
              )}
            </For>
          </Section>
        </Show>

        <Show when={(expanded()?.audit?.length ?? 0) > 0}>
          <Section title={language.t("goal.history")} count={expanded()!.audit!.length}>
            <For each={expanded()!.audit!.slice(-5).reverse()}>
              {(item) => (
                <div class="flex h-6 items-center gap-2 px-2 text-[9px] text-v2-text-text-faint">
                  <Icon name="history" size="small" class="size-3" />
                  <span class="min-w-0 flex-1 truncate">{item.type.replaceAll("_", " ")}</span>
                  <span>{item.actor}</span>
                </div>
              )}
            </For>
          </Section>
        </Show>
      </div>

      <div class="flex items-center justify-between gap-2 border-t border-v2-border-border-muted p-2">
        <ButtonV2
          size="small"
          variant="ghost-muted"
          disabled={props.busy}
          onClick={() => props.onRun(() => goals.unfocus(props.sessionID))}
        >
          {language.t("goal.unfocus")}
        </ButtonV2>
        <div class="flex items-center gap-1">
          <Show when={goal().status === "active"}>
            <ButtonV2 size="small" variant="ghost-muted" disabled={props.busy} onClick={() => props.onRun(() => goals.transition(props.sessionID, "pause"))}>
              {language.t("goal.pause")}
            </ButtonV2>
          </Show>
          <Show when={goal().status === "paused" || goal().status === "blocked" || goal().status === "draft"}>
            <ButtonV2 size="small" variant="neutral" disabled={props.busy} onClick={() => props.onRun(() => goals.transition(props.sessionID, goal().status === "draft" ? "start" : "resume"))}>
              {language.t("goal.resume")}
            </ButtonV2>
          </Show>
          <Show when={!isGoalTerminal(goal().status)}>
            <ButtonV2 size="small" variant="danger" disabled={props.busy} onClick={() => props.onRun(() => goals.transition(props.sessionID, "cancel"))}>
              {language.t("goal.cancel")}
            </ButtonV2>
          </Show>
        </div>
      </div>
    </div>
  )
}

function CriterionIcon(props: { status: "pending" | "passed" | "failed" }) {
  return (
    <span
      class="mt-0.5 grid size-3.5 shrink-0 place-items-center rounded-full border border-v2-border-border-muted text-v2-text-text-faint"
      classList={{
        "text-v2-state-fg-success": props.status === "passed",
        "text-v2-state-fg-danger": props.status === "failed",
      }}
    >
      <Show when={props.status === "passed"}><Icon name="check" size="small" class="size-2.5" /></Show>
      <Show when={props.status === "failed"}><Icon name="xmark-small" size="small" class="size-2.5" /></Show>
    </span>
  )
}

function Section(props: { title: string; count?: number; children: JSX.Element }) {
  return (
    <section class="mb-1 last:mb-0">
      <div class="flex h-6 items-center gap-1.5 px-2 text-[9px] font-[620] uppercase tracking-[0.04em] text-v2-text-text-faint">
        <span>{props.title}</span>
        <Show when={props.count !== undefined}><span class="font-[440]">{props.count}</span></Show>
      </div>
      <div>{props.children}</div>
    </section>
  )
}

function GoalLauncher(props: Props) {
  const goals = useGoals()
  const sync = useSync()
  const language = useLanguage()
  const [shown, setShown] = createSignal(false)
  const [list, setList] = createSignal<GoalInfo[]>([])
  const [loading, setLoading] = createSignal(false)
  const [creating, setCreating] = createSignal(false)
  const [title, setTitle] = createSignal("")
  const [objective, setObjective] = createSignal("")
  const [criteria, setCriteria] = createSignal("")
  const [mode, setMode] = createSignal<"manual" | "auto_continue" | "unattended">("manual")
  const session = createMemo(() => sync().data.session.find((item) => item.id === props.sessionID))

  const load = async () => {
    const current = session()
    if (!current || loading()) return
    setLoading(true)
    try {
      setList((await goals.list(current.projectID, current.workspaceID)).filter((item) => !isGoalTerminal(item.status)))
    } catch {
      setList([])
    } finally {
      setLoading(false)
    }
  }
  createEffect(() => {
    if (shown()) void load()
  })

  const focus = async (goalID: string) => {
    try {
      await goals.focus(props.sessionID, goalID)
      setShown(false)
    } catch (error) {
      showToast({ variant: "error", title: language.t("goal.error.title"), description: String(error) })
    }
  }

  const create = async () => {
    const current = session()
    if (!current || !title().trim() || !objective().trim()) return
    setLoading(true)
    try {
      await goals.createAndFocus(props.sessionID, {
        projectID: current.projectID,
        workspaceID: current.workspaceID,
        title: title().trim(),
        objective: objective().trim(),
        criteria: criteria().split("\n").map((value) => value.trim()).filter(Boolean),
        continuationPolicy: { mode: mode() },
      })
      setShown(false)
    } catch (error) {
      showToast({ variant: "error", title: language.t("goal.error.title"), description: String(error) })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div class="mx-auto flex h-8 w-[min(100%,680px)] items-center justify-end">
      <Popover
        open={shown()}
        onOpenChange={setShown}
        placement="top-end"
        gutter={6}
        triggerAs="button"
        triggerProps={{
          type: "button",
          class:
            "flex h-7 items-center gap-1.5 rounded-[8px] border border-v2-border-border-muted bg-v2-background-bg-base px-2 text-[11px] font-[540] text-v2-text-text-muted shadow-[var(--v2-elevation-floating)] transition-colors hover:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none",
        }}
        trigger={<><Icon name="star" size="small" class="size-3" /><span>{language.t("goal.launcher")}</span></>}
        class="[&_[data-slot=popover-body]]:p-0 w-[380px] max-w-[calc(100vw-24px)] overflow-hidden rounded-[10px] border border-v2-border-border-muted bg-v2-background-bg-base shadow-[var(--v2-elevation-floating)]"
      >
        <div class="flex max-h-[520px] flex-col">
          <div class="flex h-9 items-center justify-between border-b border-v2-border-border-muted px-3">
            <span class="text-[12px] font-[600] text-v2-text-text-base">{language.t("goal.choose")}</span>
            <ButtonV2 size="small" variant="ghost-muted" icon={creating() ? "xmark-small" : "plus"} onClick={() => setCreating(!creating())}>
              {creating() ? language.t("goal.back") : language.t("goal.new")}
            </ButtonV2>
          </div>
          <Show
            when={creating()}
            fallback={
              <div class="max-h-[360px] overflow-y-auto p-1.5 no-scrollbar">
                <Show when={!loading()} fallback={<div class="px-2 py-6 text-center text-[11px] text-v2-text-text-faint">{language.t("goal.loading")}</div>}>
                  <Show when={list().length > 0} fallback={<div class="px-2 py-6 text-center text-[11px] text-v2-text-text-faint">{language.t("goal.empty")}</div>}>
                    <For each={list()}>
                      {(item) => (
                        <button
                          type="button"
                          class="flex min-h-10 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
                          onClick={() => void focus(item.id)}
                        >
                          <GoalStatusGlyph status={item.status} />
                          <div class="min-w-0 flex-1">
                            <div class="truncate text-[11px] font-[560] text-v2-text-text-base">{item.title}</div>
                            <div class="truncate text-[9px] text-v2-text-text-faint">{item.objective}</div>
                          </div>
                          <span class="text-[9px] uppercase text-v2-text-text-faint">{item.status}</span>
                        </button>
                      )}
                    </For>
                  </Show>
                </Show>
              </div>
            }
          >
            <div class="flex flex-col gap-2 p-3">
              <GoalField label={language.t("goal.field.title")} value={title()} onInput={setTitle} />
              <GoalField label={language.t("goal.field.objective")} value={objective()} onInput={setObjective} multiline />
              <GoalField label={language.t("goal.field.criteria")} value={criteria()} onInput={setCriteria} multiline placeholder={language.t("goal.field.criteriaPlaceholder")} />
              <div>
                <div class="mb-1 text-[9px] font-[600] uppercase tracking-[0.04em] text-v2-text-text-faint">{language.t("goal.automation")}</div>
                <div class="grid grid-cols-3 gap-1 rounded-md bg-v2-overlay-simple-overlay-hover p-1">
                  <For each={["manual", "auto_continue", "unattended"] as const}>
                    {(value) => (
                      <button
                        type="button"
                        class="h-7 rounded-md px-1 text-[10px] font-[540] text-v2-text-text-muted transition-colors"
                        classList={{ "bg-v2-background-bg-base text-v2-text-text-base shadow-sm": mode() === value }}
                        onClick={() => setMode(value)}
                      >
                        {automationLabel(language, value)}
                      </button>
                    )}
                  </For>
                </div>
              </div>
              <ButtonV2 size="normal" variant="neutral" disabled={loading() || !title().trim() || !objective().trim()} onClick={() => void create()}>
                {language.t("goal.create")}
              </ButtonV2>
            </div>
          </Show>
        </div>
      </Popover>
    </div>
  )
}

function GoalField(props: { label: string; value: string; onInput: (value: string) => void; multiline?: boolean; placeholder?: string }) {
  return (
    <label class="flex flex-col gap-1">
      <span class="text-[9px] font-[600] uppercase tracking-[0.04em] text-v2-text-text-faint">{props.label}</span>
      <Show
        when={props.multiline}
        fallback={
          <input
            value={props.value}
            placeholder={props.placeholder}
            class="h-8 rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-2 text-[12px] text-v2-text-text-base outline-none transition-colors placeholder:text-v2-text-text-faint focus:border-v2-icon-icon-muted"
            onInput={(event) => props.onInput(event.currentTarget.value)}
          />
        }
      >
        <textarea
          value={props.value}
          placeholder={props.placeholder}
          rows={3}
          class="min-h-16 resize-y rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-2 py-1.5 text-[11px] leading-4 text-v2-text-text-base outline-none transition-colors placeholder:text-v2-text-text-faint focus:border-v2-icon-icon-muted"
          onInput={(event) => props.onInput(event.currentTarget.value)}
        />
      </Show>
    </label>
  )
}
