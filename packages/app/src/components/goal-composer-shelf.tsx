import type { GoalDetail, GoalInfo, OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useSpring } from "@opencode-ai/ui/motion-spring"
import { Popover } from "@opencode-ai/ui/popover"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { ScrollViewOverlayScrollbar } from "@opencode-ai/ui/scroll-view"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { For, Show, createEffect, createMemo, createSignal, on, untrack, type JSX } from "solid-js"
import { ModelSelectorPopoverV2 } from "./dialog-select-model"
import { useGoals } from "@/context/goals"
import { useLanguage } from "@/context/language"
import { useLocal } from "@/context/local"
import { useSDK } from "@/context/sdk"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { useNow } from "@/hooks/use-now"
import { stripUnlimitedSuffix } from "@/utils/model-badges"
import { showToast } from "@/utils/toast"
import {
  formatGoalElapsed,
  goalLifecycleAction,
  goalProgress,
  isGoalTerminal,
  nextCriterionStatus,
} from "./goal-composer-shelf-model"
import {
  applyRevisedGoalObjective,
  buildGoalRevisorDraft,
  buildGoalRevisorGuidance,
  buildGoalStartMessage,
  buildGoalUpdatedMessage,
} from "./goal-revisor"
import { promptRevisionClarifications, promptRevisionResponse } from "./prompt-input/prompt-revision"

type Props = { sessionID: string; promptText?: () => string }
type LauncherProps = { sessionID?: string; armKey: string; promptText?: () => string }
type GoalModelRef = { providerID: string; modelID: string }
type GoalTone = "muted" | "success" | "warning" | "danger"

/** One label/typography scale for every dense row inside the Goal surfaces. */
const LABEL = "text-[9px] font-[620] uppercase leading-[14px] tracking-[0.055em] text-v2-text-text-faint"
const BODY = "text-[11px] leading-[15px] text-v2-text-text-base"
const META = "text-[10px] leading-[14px] text-v2-text-text-muted"

function automationLabel(language: ReturnType<typeof useLanguage>, mode: "manual" | "auto_continue" | "unattended") {
  if (mode === "manual") return language.t("goal.mode.manual")
  if (mode === "auto_continue") return language.t("goal.mode.auto_continue")
  return language.t("goal.mode.unattended")
}

function number(value: number | string) {
  return typeof value === "number" ? value : Number(value) || 0
}

function lines(value: string) {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
}

function firstLine(value: string) {
  return value.split(/\r?\n/, 1)[0]?.trim() ?? ""
}

function titleFromObjective(objective: string) {
  const line = firstLine(objective)
  if (!line) return "Goal"
  return line.length <= 72 ? line : `${line.slice(0, 69).trimEnd()}…`
}

function lifecycleLabel(language: ReturnType<typeof useLanguage>, status: string) {
  if (status === "draft") return language.t("goal.start")
  if (status === "active") return language.t("goal.pause")
  return language.t("goal.resume")
}

function goalTone(status: string): GoalTone {
  if (status === "completed") return "success"
  if (status === "blocked" || status === "verifying") return "warning"
  if (status === "failed" || status === "cancelled") return "danger"
  return "muted"
}

function goalStatusIcon(status: string) {
  if (status === "completed") return "check" as const
  if (status === "verifying") return "hourglass" as const
  if (status === "blocked" || status === "failed") return "warning" as const
  if (status === "cancelled") return "xmark-small" as const
  if (status === "active") return "star-filled" as const
  if (status === "paused") return "pause" as const
  return "star" as const
}

function promptDraftText(promptText?: () => string) {
  return (promptText?.() ?? "").trim()
}

/** Post plain text into the session so a started/edited brief reaches the agent immediately. */
async function postSessionText(client: Pick<OpencodeClient, "session">, sessionID: string, text: string) {
  await client.session.prompt({ sessionID, parts: [{ type: "text", text }] }, { throwOnError: true })
}

export function GoalComposerShelf(props: Props) {
  const goals = useGoals()
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const current = createMemo(() => goals.focused(props.sessionID))
  const detail = createMemo(() => current()?.detail)
  const goal = createMemo(() => detail()?.goal)
  const now = useNow(() => !!goal() && !isGoalTerminal(goal()!.status))
  const elapsed = createMemo(() => {
    const value = goal()
    if (!value) return ""
    return formatGoalElapsed((number(value.time.completed ?? 0) || now()) - number(value.time.created))
  })
  const progress = createMemo(() => {
    const value = detail()
    if (!value) return { done: 0, total: 0, percent: 0 }
    return goalProgress(value)
  })
  const criteria = createMemo(() => detail()?.criteria ?? [])
  /** Collapsed subtitle: whatever the Goal is actually waiting on right now. */
  const preview = createMemo(() => {
    const value = detail()
    if (!value) return ""
    if (value.goal.status === "draft" && value.criteria.length === 0) return language.t("goal.startRequiresCriterion")
    const step = value.steps.find((item) => item.status === "active")
    if (step) return step.title
    const pending = value.criteria.find((item) => item.status === "pending")
    if (pending) return pending.description
    return firstLine(value.goal.objective)
  })

  // A different Goal is a different surface: never inherit the previous one's
  // expansion, or focusing a Goal silently reopens a panel the user closed.
  createEffect(on(() => goal()?.id, () => setOpen(false), { defer: true }))

  createEffect(() => {
    if (!open() || !goal()) return
    // Treat opening the Goal surface as an authoritative refresh boundary.
    // SSE normally keeps evidence/audit/focus state current, but reconnects or
    // a missed event must never strand verification controls on stale data.
    void goals.loadExpanded(goal()!.id, true)
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

  const lifecycleBlocked = createMemo(() => goal()?.status === "draft" && criteria().length === 0)

  // Expansion animates exactly like the todo dock it stacks on: one spring
  // driving max-height against the measured panel, so the two surfaces open
  // and close with the same motion instead of one popping and one sliding.
  const reveal = useSpring(() => (open() ? 1 : 0), { visualDuration: 0.3, bounce: 0 })
  const shown = createMemo(() => Math.max(0, Math.min(1, reveal())))
  const mounted = createMemo(() => open() || shown() > 0.001)
  const [panel, setPanel] = createSignal<HTMLDivElement | undefined>()
  const [height, setHeight] = createSignal(0)
  createEffect(() => {
    const el = panel()
    if (!el) return
    const update = () => setHeight(el.getBoundingClientRect().height)
    update()
    createResizeObserver(el, update)
  })

  return (
    <Show when={current()}>
      <div
        data-component="goal-composer-shelf"
        data-goal-status={goal()!.status}
        data-expanded={open() ? "true" : undefined}
        class="mb-1.5 w-full min-w-0 overflow-hidden rounded-xl border-[0.5px] border-v2-border-border-base bg-v2-background-bg-base"
      >
        <div
          data-slot="goal-summary"
          data-action="goal-toggle"
          role="button"
          tabIndex={0}
          aria-expanded={open()}
          // Named explicitly: the row seats its own buttons, and a name computed
          // from contents would swallow their labels into this one.
          aria-label={goal()!.title}
          title={`${goal()!.title} · ${goal()!.status} · ${elapsed()}`}
          class="flex h-[42px] min-w-0 cursor-default items-center gap-2 pl-3 pr-2 transition-colors"
          classList={{
            "border-b border-v2-border-border-muted bg-v2-background-bg-layer-01": open(),
            "hover:bg-v2-overlay-simple-overlay-hover/50": !open(),
          }}
          onClick={() => setOpen((value) => !value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return
            event.preventDefault()
            setOpen((value) => !value)
          }}
        >
          <GoalStatusGlyph status={goal()!.status} />
          <span class="max-w-[46%] shrink-0 truncate text-[13px] font-[500] leading-5 tracking-[-0.04px] text-v2-text-text-base">
            {goal()!.title}
          </span>
          <span class="min-w-0 flex-1 truncate text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-faint">
            {preview()}
          </span>

          <div class="ml-auto flex shrink-0 items-center gap-2 pl-1">
            <GoalCriteriaTicks items={criteria()} />
            <Show when={progress().total > 0}>
              <span class="shrink-0 text-[11px] font-[520] tabular-nums leading-4 text-v2-text-text-muted">
                {progress().done}/{progress().total}
              </span>
            </Show>
            <span class="shrink-0 text-[11px] tabular-nums leading-4 text-v2-text-text-faint">{elapsed()}</span>
            <GoalStatusChip status={goal()!.status} />
            <span class="h-4 w-px shrink-0 bg-v2-border-border-muted" />
            <Show when={["draft", "active", "paused", "blocked"].includes(goal()!.status)}>
              <TooltipV2
                value={
                  lifecycleBlocked()
                    ? language.t("goal.startRequiresCriterion")
                    : lifecycleLabel(language, goal()!.status)
                }
              >
                <IconButtonV2
                  type="button"
                  size="small"
                  variant="ghost-muted"
                  class="shrink-0"
                  disabled={busy() || lifecycleBlocked()}
                  aria-label={lifecycleLabel(language, goal()!.status)}
                  icon={<Icon name={goal()!.status === "active" ? "pause" : "play"} size="small" />}
                  onClick={(event: MouseEvent) => {
                    event.stopPropagation()
                    void toggleLifecycle()
                  }}
                />
              </TooltipV2>
            </Show>
            <IconButtonV2
              type="button"
              size="small"
              variant="ghost-muted"
              class="shrink-0"
              data-action="goal-toggle-button"
              aria-label={language.t(open() ? "goal.collapse" : "goal.expand")}
              icon={
                <Icon
                  name="chevron-down"
                  size="small"
                  class="size-3 transition-transform duration-150"
                  classList={{ "rotate-180": open() }}
                />
              }
              onClick={(event: MouseEvent) => {
                event.stopPropagation()
                setOpen((value) => !value)
              }}
            />
          </div>
        </div>

        <div
          data-slot="goal-panel"
          aria-hidden={!open()}
          class="overflow-hidden"
          classList={{ "pointer-events-none": shown() < 0.98 }}
          style={{
            "max-height": `${height() * shown()}px`,
            opacity: `${shown()}`,
            visibility: shown() < 0.001 ? "hidden" : "visible",
          }}
        >
          <div ref={setPanel}>
            <Show when={mounted()}>
              <GoalPanel sessionID={props.sessionID} busy={busy()} onRun={run} promptText={props.promptText} />
            </Show>
          </div>
        </div>
      </div>
    </Show>
  )
}

/**
 * Criterion ribbon: one tick per acceptance criterion, so the collapsed row
 * carries the same shape of information as the expanded checklist. A single
 * percentage bar hides which checks failed; ticks do not.
 */
function GoalCriteriaTicks(props: { items: { status: string }[] }) {
  const shown = createMemo(() => props.items.slice(0, 10))
  const overflow = createMemo(() => props.items.length - shown().length)
  return (
    <Show when={props.items.length > 0}>
      <div class="flex shrink-0 items-center gap-[3px]" aria-hidden="true">
        <For each={shown()}>
          {(item) => (
            <span
              class="h-[3px] w-2.5 rounded-full transition-colors duration-150"
              classList={{
                "bg-v2-state-fg-success": item.status === "passed",
                "bg-v2-state-fg-danger": item.status === "failed",
                "bg-v2-border-border-strong": item.status !== "passed" && item.status !== "failed",
              }}
            />
          )}
        </For>
        <Show when={overflow() > 0}>
          <span class="text-[9px] font-[540] tabular-nums leading-[14px] text-v2-text-text-faint">+{overflow()}</span>
        </Show>
      </div>
    </Show>
  )
}

function GoalStatusGlyph(props: { status: string }) {
  const tone = () => goalTone(props.status)
  return (
    <span
      class="grid size-4 shrink-0 place-items-center rounded-full border border-v2-border-border-muted text-v2-icon-icon-muted"
      classList={{
        "text-v2-state-fg-success": tone() === "success",
        "text-v2-state-fg-warning": tone() === "warning",
        "text-v2-state-fg-danger": tone() === "danger",
      }}
    >
      <Icon name={goalStatusIcon(props.status)} size="small" class="size-3" />
    </span>
  )
}

function GoalStatusChip(props: { status: string }) {
  const tone = () => goalTone(props.status)
  return (
    <span
      class="shrink-0 rounded-[4px] border border-v2-border-border-muted px-1 text-[9px] font-[620] uppercase leading-[15px] tracking-[0.05em] text-v2-text-text-faint"
      classList={{
        "text-v2-state-fg-success": tone() === "success",
        "text-v2-state-fg-warning": tone() === "warning",
        "text-v2-state-fg-danger": tone() === "danger",
      }}
    >
      {props.status}
    </span>
  )
}

/**
 * Expanded Goal panel. Structured like the question card and the IDE tool
 * windows it borrows from: a scrollable stack of hairline-separated sections,
 * a keyboard-first checklist, one settings strip, and a sticky action bar.
 * It is inline - never a popover - so it stacks with the todo dock instead of
 * floating over it.
 */
function GoalPanel(props: {
  sessionID: string
  busy: boolean
  onRun: (action: () => Promise<unknown>) => Promise<void>
  promptText?: () => string
}) {
  const goals = useGoals()
  const language = useLanguage()
  const sdk = useSDK()
  const current = createMemo(() => goals.focused(props.sessionID))
  const detail = createMemo(() => current()!.detail)
  const goal = createMemo(() => detail().goal)
  const expanded = createMemo(() => goals.expanded(goal().id))
  const draft = createMemo(() => goal().status === "draft")
  const locked = createMemo(() => props.busy || goal().status === "verifying" || isGoalTerminal(goal().status))
  const auditorModel = createMemo<GoalModelRef | undefined>(() => {
    const model = goal().auditorPolicy.model
    return model ? { providerID: model.providerID, modelID: model.id } : undefined
  })
  const latestAudit = createMemo(() => (expanded()?.audit ?? []).findLast((item) => item.type === "audited"))
  const latestAuditDecision = createMemo(() => {
    const value = latestAudit()?.payload.decision
    return typeof value === "string" ? value : undefined
  })
  const latestAuditRationale = createMemo(() => {
    const value = latestAudit()?.payload.rationale
    return typeof value === "string" ? value : undefined
  })
  const latestAuditContinuation = createMemo(() => {
    const value = latestAudit()?.payload.continuationPrompt
    return typeof value === "string" && value.trim() ? value.trim() : undefined
  })
  /** Evidence attached per criterion - the visible reason completion is gated. */
  const evidenceCount = createMemo(() => {
    const counts = new Map<string, number>()
    for (const item of expanded()?.evidence ?? []) {
      if (!item.criterionID) continue
      counts.set(item.criterionID, (counts.get(item.criterionID) ?? 0) + 1)
    }
    return counts
  })
  const criteriaPassed = createMemo(() => detail().criteria.filter((item) => item.status === "passed").length)
  const verificationReady = createMemo(() => {
    if (detail().criteria.length === 0 || detail().criteria.some((item) => item.status !== "passed")) return false
    return detail().criteria.every((item) => (evidenceCount().get(item.id) ?? 0) > 0)
  })
  const activityCount = createMemo(
    () => (expanded()?.evidence?.length ?? 0) + (expanded()?.audit?.length ?? 0) + (expanded()?.focuses?.length ?? 0),
  )
  const hasComposerText = createMemo(() => promptDraftText(props.promptText).length > 0)
  const startTooltip = createMemo(() => {
    if (detail().criteria.length === 0) return language.t("goal.startRequiresCriterion")
    if (hasComposerText()) return language.t("goal.startAndSendHint")
    return language.t("goal.readyToStart")
  })
  /** Footer status line: the one sentence that explains the current gate. */
  const status = createMemo(() => {
    if (draft()) return detail().criteria.length === 0 ? language.t("goal.startRequiresCriterion") : startTooltip()
    if (goal().status === "verifying")
      return verificationReady() ? language.t("goal.complete") : language.t("goal.completeRequires")
    if (goal().status === "active" && goal().continuationPolicy.mode === "auto_continue")
      return language.t("goal.autoContinueHint")
    return language.t("goal.criterion.cycle")
  })

  /** Start a draft and make sure the agent actually receives work. */
  const startAndDispatch = () =>
    props.onRun(async () => {
      const composerText = promptDraftText(props.promptText)
      const snapshot = goals.focused(props.sessionID)?.detail
      if (!snapshot) throw new Error("No focused Goal")
      await goals.transition(props.sessionID, "start")
      if (composerText) {
        // The composer draft stays untouched: the user presses Send next and
        // the prompt travels with the now-active goal already in context.
        return
      }
      const live = goals.focused(props.sessionID)?.detail ?? snapshot
      await postSessionText(
        sdk().client,
        props.sessionID,
        buildGoalStartMessage({
          objective: live.goal.objective,
          criteria: live.criteria.map((item) => item.description),
        }),
      )
      showToast({ variant: "success", title: language.t("goal.startedAndSent") })
    })

  const cycleCriterion = (criterionID: string, status: string) =>
    props.onRun(() => goals.updateCriterion(props.sessionID, criterionID, nextCriterionStatus(status)))

  return (
    <div class="flex min-w-0 flex-col bg-v2-background-bg-base text-v2-text-text-base">
      <div class="flex max-h-[min(46vh,320px)] min-w-0 flex-col overflow-y-auto overscroll-contain no-scrollbar">
        <div class="flex min-w-0 flex-col divide-y divide-v2-border-border-muted">
          <Show
            when={draft()}
            fallback={
              <GoalBriefEditor
                sessionID={props.sessionID}
                detail={detail}
                busy={props.busy}
                promptText={props.promptText}
                onRun={props.onRun}
              />
            }
          >
            <GoalDraftSetup
              sessionID={props.sessionID}
              detail={detail}
              busy={props.busy}
              promptText={props.promptText}
              onRun={props.onRun}
            />
          </Show>

          <Show when={!draft()}>
            <GoalCriteriaChecklist
              items={detail().criteria}
              passed={criteriaPassed()}
              evidence={evidenceCount()}
              disabled={props.busy || isGoalTerminal(goal().status)}
              onCycle={(item) => void cycleCriterion(item.id, item.status)}
            />
          </Show>

          <Show when={!draft() && detail().steps.length > 0}>
            <Disclosure
              title={language.t("goal.steps")}
              meta={`${detail().steps.filter((item) => item.status === "completed").length}/${detail().steps.length}`}
            >
              <For each={detail().steps}>
                {(item) => (
                  <div class="flex min-w-0 items-start gap-2 px-2.5 py-1">
                    <CriterionIcon
                      status={item.status === "completed" ? "passed" : item.status === "blocked" ? "failed" : "pending"}
                    />
                    <div class="min-w-0 flex-1">
                      <div class={`truncate ${BODY}`}>{item.title}</div>
                      <Show when={item.assignedSessionID}>
                        <div class="truncate text-[9px] leading-[13px] text-v2-text-text-faint">
                          {language.t("goal.assigned", { session: item.assignedSessionID!.slice(0, 10) })}
                        </div>
                      </Show>
                    </div>
                  </div>
                )}
              </For>
            </Disclosure>
          </Show>

          <Show when={!draft()}>
            {/* Settings strip: both policies that change how the Goal runs, on
                one line, the way an IDE seats run-configuration controls. */}
            <div class="flex h-8 min-w-0 shrink-0 items-center gap-2 px-2.5">
              <span class={`shrink-0 ${LABEL}`}>{language.t("goal.automation")}</span>
              <div class="flex shrink-0 items-center gap-px rounded-[5px] bg-v2-overlay-simple-overlay-hover/60 p-px">
                <For each={["manual", "auto_continue", "unattended"] as const}>
                  {(mode) => (
                    <button
                      type="button"
                      class="h-5 rounded-[4px] px-1.5 text-[9px] font-[600] uppercase leading-[14px] tracking-[0.04em] transition-colors enabled:hover:text-v2-text-text-base disabled:opacity-50"
                      classList={{
                        "bg-v2-background-bg-base text-v2-text-text-base shadow-sm":
                          goal().continuationPolicy.mode === mode,
                        "text-v2-text-text-muted": goal().continuationPolicy.mode !== mode,
                      }}
                      disabled={locked()}
                      onClick={() => props.onRun(() => goals.setContinuationMode(props.sessionID, mode))}
                    >
                      {automationLabel(language, mode)}
                    </button>
                  )}
                </For>
              </div>
              <div class="ml-auto flex min-w-0 items-center justify-end gap-1.5">
                <span class={`shrink-0 ${LABEL}`}>{language.t("goal.auditor")}</span>
                <GoalAuditorModelPicker
                  value={auditorModel()}
                  action="goal-auditor-model"
                  disabled={locked()}
                  onChange={(model) => void props.onRun(() => goals.setAuditorModel(props.sessionID, model))}
                />
              </div>
            </div>
          </Show>

          <Show when={draft() ? undefined : latestAuditDecision()}>
            {(decision) => (
              <div class="min-w-0 px-2.5 py-1.5">
                <div class="flex min-w-0 items-center gap-1.5">
                  <span class={LABEL}>{language.t("goal.auditor.latest")}</span>
                  <span
                    class="shrink-0 text-[9px] font-[620] uppercase leading-[14px] tracking-[0.04em]"
                    classList={{
                      "text-v2-state-fg-success": decision() === "complete",
                      "text-v2-state-fg-warning": decision() === "blocked",
                      "text-v2-text-text-muted": decision() !== "complete" && decision() !== "blocked",
                    }}
                  >
                    {decision()}
                  </span>
                </div>
                <Show when={latestAuditRationale()}>
                  {(rationale) => <div class={`mt-0.5 ${META}`}>{rationale()}</div>}
                </Show>
                <Show when={latestAuditContinuation()}>
                  {(continuation) => (
                    <div class="mt-1 overflow-hidden rounded-[5px] border border-v2-border-border-muted bg-v2-background-bg-layer-01">
                      <div class="flex h-5 items-center border-b border-v2-border-border-muted px-1.5">
                        <span class={LABEL}>{language.t("goal.auditor.nextCycle")}</span>
                      </div>
                      <div class={`max-h-20 overflow-y-auto whitespace-pre-wrap px-1.5 py-1 no-scrollbar ${META}`}>
                        {continuation()}
                      </div>
                    </div>
                  )}
                </Show>
              </div>
            )}
          </Show>

          <Show when={activityCount() > 0}>
            <Disclosure title={language.t("goal.activity")} meta={`${activityCount()}`} defaultOpen={false}>
              <For each={(expanded()?.focuses ?? []).slice(-3)}>
                {(focus) => (
                  <ActivityRow icon="chats" meta={focus.role}>
                    {focus.sessionID}
                  </ActivityRow>
                )}
              </For>
              <For each={(expanded()?.evidence ?? []).slice(-3).reverse()}>
                {(item) => (
                  <ActivityRow icon="shield-check" meta={item.verdict ?? item.type} detail={item.summary}>
                    {item.type}
                  </ActivityRow>
                )}
              </For>
              <For each={(expanded()?.audit ?? []).slice(-3).reverse()}>
                {(item) => (
                  <ActivityRow icon="history" meta={item.actor}>
                    {item.type.replaceAll("_", " ")}
                  </ActivityRow>
                )}
              </For>
            </Disclosure>
          </Show>
        </div>
      </div>

      {/* Action bar: status sentence on the left, decisions on the right. */}
      <div class="flex h-8 min-w-0 shrink-0 items-center gap-2 border-t border-v2-border-border-muted bg-v2-background-bg-layer-01 pl-2.5 pr-1.5">
        <span class="min-w-0 flex-1 truncate text-[10px] font-[440] leading-4 text-v2-text-text-faint">
          {status()}
        </span>

        <div class="flex shrink-0 items-center gap-1">
          <Show when={!isGoalTerminal(goal().status)}>
            <TooltipV2 placement="top" gutter={4} value={language.t("goal.cancel")}>
              <IconButtonV2
                type="button"
                size="small"
                variant="ghost-muted"
                class="shrink-0 !text-v2-icon-icon-muted hover:!text-v2-state-fg-danger"
                disabled={props.busy}
                aria-label={language.t("goal.cancel")}
                icon={<Icon name="trash" size="small" class="size-3" />}
                onClick={() => props.onRun(() => goals.transition(props.sessionID, "cancel"))}
              />
            </TooltipV2>
          </Show>
          <TooltipV2 placement="top" gutter={4} value={language.t("goal.unfocusHint")}>
            <ButtonV2
              size="small"
              variant="ghost-muted"
              class="shrink-0 whitespace-nowrap"
              disabled={props.busy}
              onClick={() => props.onRun(() => goals.unfocus(props.sessionID))}
            >
              {language.t("goal.unfocus")}
            </ButtonV2>
          </TooltipV2>

          <Show when={goal().status === "active"}>
            <ButtonV2
              size="small"
              variant="contrast"
              class="shrink-0 whitespace-nowrap"
              disabled={props.busy}
              onClick={() => props.onRun(() => goals.transition(props.sessionID, "request_verification"))}
            >
              {language.t("goal.verify")}
            </ButtonV2>
          </Show>

          <Show when={goal().status === "verifying"}>
            <TooltipV2 placement="top" gutter={4} value={language.t("goal.resumeWork")}>
              <IconButtonV2
                type="button"
                size="small"
                variant="neutral"
                class="shrink-0"
                disabled={props.busy}
                aria-label={language.t("goal.resumeWork")}
                icon={<Icon name="reset" size="small" />}
                onClick={() => props.onRun(() => goals.transition(props.sessionID, "verification_fail"))}
              />
            </TooltipV2>
            <TooltipV2
              placement="top"
              gutter={4}
              value={verificationReady() ? language.t("goal.complete") : language.t("goal.completeRequires")}
            >
              <ButtonV2
                size="small"
                variant="contrast"
                class="shrink-0 whitespace-nowrap"
                disabled={props.busy || !verificationReady()}
                onClick={() => props.onRun(() => goals.transition(props.sessionID, "verification_pass"))}
              >
                {language.t("goal.complete")}
              </ButtonV2>
            </TooltipV2>
          </Show>

          <Show when={goal().status === "paused" || goal().status === "blocked"}>
            <ButtonV2
              size="small"
              variant="contrast"
              class="shrink-0 whitespace-nowrap"
              disabled={props.busy}
              onClick={() => props.onRun(() => goals.transition(props.sessionID, "resume"))}
            >
              {language.t("goal.resume")}
            </ButtonV2>
          </Show>

          <Show when={draft()}>
            <TooltipV2 placement="top" gutter={4} value={startTooltip()}>
              <ButtonV2
                size="small"
                variant="contrast"
                class="shrink-0 whitespace-nowrap"
                disabled={props.busy || detail().criteria.length === 0}
                onClick={startAndDispatch}
              >
                {hasComposerText() ? language.t("goal.startAndSend") : language.t("goal.start")}
              </ButtonV2>
            </TooltipV2>
          </Show>
        </div>
      </div>
    </div>
  )
}

/**
 * Acceptance checklist. Borrowed wholesale from the question card's option
 * list: 26px rows, roving tabindex, digit shortcuts, hover-revealed keybinds.
 * Clicking (or pressing the row's digit) cycles pending -> passed -> failed.
 */
function GoalCriteriaChecklist(props: {
  items: GoalDetail["criteria"]
  passed: number
  evidence: Map<string, number>
  disabled: boolean
  onCycle: (item: GoalDetail["criteria"][number]) => void
}) {
  const language = useLanguage()
  let rows: HTMLButtonElement[] = []
  const [cursor, setCursor] = createSignal(-1)

  const focusRow = (target: number) => {
    const list = props.items
    if (list.length === 0) return
    const next = ((target % list.length) + list.length) % list.length
    setCursor(next)
    rows[next]?.focus()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || props.disabled) return
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
    if (!plain) return
    if (event.key === "ArrowDown") {
      event.preventDefault()
      focusRow(cursor() + 1)
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      focusRow(cursor() - 1)
      return
    }
    if (/^[1-9]$/.test(event.key)) {
      const index = Number(event.key) - 1
      const item = props.items[index]
      if (!item) return
      event.preventDefault()
      props.onCycle(item)
      focusRow(index)
    }
  }

  return (
    <section class="min-w-0 bg-v2-background-bg-base">
      <div class="flex h-7 min-w-0 items-center gap-1.5 px-2.5">
        <span class={`shrink-0 ${LABEL}`}>{language.t("goal.criteria")}</span>
        <span class="shrink-0 text-[9px] font-[440] tabular-nums leading-[14px] text-v2-text-text-faint">
          {props.passed}/{props.items.length}
        </span>
      </div>
      <Show
        when={props.items.length > 0}
        fallback={<EmptyRow>{language.t("goal.startRequiresCriterion")}</EmptyRow>}
      >
        <div class="flex min-w-0 flex-col gap-px px-1 pb-1" onKeyDown={onKeyDown}>
          <For each={props.items}>
            {(item, index) => {
              const count = () => props.evidence.get(item.id) ?? 0
              const missing = () => item.status === "passed" && count() === 0
              return (
                <button
                  type="button"
                  ref={(el) => (rows[index()] = el)}
                  data-goal-criterion={item.id}
                  data-status={item.status}
                  tabIndex={cursor() === index() || (cursor() < 0 && index() === 0) ? 0 : -1}
                  disabled={props.disabled}
                  title={language.t("goal.criterion.cycle")}
                  onFocus={() => setCursor(index())}
                  onClick={() => props.onCycle(item)}
                  class="group flex min-h-[26px] w-full min-w-0 shrink-0 items-center gap-2 rounded-[6px] px-1.5 text-start outline-none transition-colors hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover disabled:pointer-events-none disabled:opacity-50"
                >
                  <CriterionIcon status={item.status as "pending" | "passed" | "failed"} />
                  <span
                    class="min-w-0 flex-1 truncate text-[12px] leading-4"
                    classList={{
                      "font-[440] text-v2-text-text-muted line-through decoration-v2-border-border-strong":
                        item.status === "passed",
                      "font-[450] text-v2-text-text-base": item.status !== "passed",
                    }}
                  >
                    {item.description}
                  </span>
                  <Show when={missing()}>
                    <span class="shrink-0 text-v2-state-fg-warning" title={language.t("goal.criterion.needsEvidence")}>
                      <Icon name="warning" size="small" class="size-3" />
                    </span>
                  </Show>
                  <Show when={count() > 0}>
                    <span
                      class="shrink-0 text-[9px] font-[540] tabular-nums leading-[14px] text-v2-text-text-faint"
                      title={language.t("goal.criterion.evidence", { count: String(count()) })}
                    >
                      {count()}x
                    </span>
                  </Show>
                  <Show when={index() < 9}>
                    <KeybindV2
                      keys={[String(index() + 1)]}
                      variant="ghost"
                      class="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                    />
                  </Show>
                </button>
              )
            }}
          </For>
        </div>
      </Show>
    </section>
  )
}

/**
 * Collapsible section with an IDE-style disclosure triangle. Secondary detail
 * (steps, activity) folds away so the panel opens on the parts that decide
 * what happens next.
 */
function Disclosure(props: { title: string; meta?: string; defaultOpen?: boolean; children: JSX.Element }) {
  const [open, setOpen] = createSignal(props.defaultOpen ?? true)
  return (
    <section class="min-w-0 bg-v2-background-bg-base">
      <button
        type="button"
        aria-expanded={open()}
        onClick={() => setOpen((value) => !value)}
        class="flex h-7 w-full min-w-0 items-center gap-1.5 px-2 text-left outline-none transition-colors hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover"
      >
        <Icon
          name="chevron-down"
          size="small"
          class="size-3 shrink-0 text-v2-icon-icon-muted transition-transform duration-150"
          classList={{ "-rotate-90": !open() }}
        />
        <span class={`shrink-0 ${LABEL}`}>{props.title}</span>
        <Show when={props.meta}>
          <span class="shrink-0 text-[9px] font-[440] tabular-nums leading-[14px] text-v2-text-text-faint">
            {props.meta}
          </span>
        </Show>
      </button>
      <Show when={open()}>
        <div class="min-w-0 pb-1">{props.children}</div>
      </Show>
    </section>
  )
}

function EmptyRow(props: { children: JSX.Element }) {
  return <div class="px-2.5 pb-1.5 text-[10px] leading-[14px] text-v2-text-text-faint">{props.children}</div>
}

function ActivityRow(props: { icon: string; meta?: string; detail?: string; children: JSX.Element }) {
  return (
    <div class="flex min-w-0 items-start gap-1.5 px-2.5 py-1">
      <Icon name={props.icon} size="small" class="mt-px size-3 shrink-0 text-v2-icon-icon-muted" />
      <div class="min-w-0 flex-1">
        <div class="flex min-w-0 items-center gap-1.5">
          <span class="min-w-0 flex-1 truncate text-[10px] font-[540] leading-[14px] text-v2-text-text-base">
            {props.children}
          </span>
          <Show when={props.meta}>
            <span class="shrink-0 text-[9px] uppercase leading-[14px] tracking-[0.03em] text-v2-text-text-faint">
              {props.meta}
            </span>
          </Show>
        </div>
        <Show when={props.detail}>
          <div class={`line-clamp-2 ${META}`}>{props.detail}</div>
        </Show>
      </div>
    </div>
  )
}

/** Live brief editor for active/paused/blocked goals with realtime save + resend. */
function GoalBriefEditor(props: {
  sessionID: string
  detail: () => GoalDetail
  busy: boolean
  onRun: (action: () => Promise<unknown>) => Promise<void>
  promptText?: () => string
}) {
  const goals = useGoals()
  const language = useLanguage()
  const sdk = useSDK()
  const [title, setTitle] = createSignal("")
  const [objective, setObjective] = createSignal("")
  const editable = createMemo(() => ["active", "paused", "blocked"].includes(props.detail().goal.status))

  // Seed from the server, but never clobber an in-flight edit: SSE bumps the
  // focused detail on every goal event, and re-seeding blindly would wipe
  // whatever the user is typing into the live brief.
  let seeded: { id: string; title: string; objective: string } | undefined
  const seed = (detail: GoalDetail) => {
    seeded = { id: detail.goal.id, title: detail.goal.title, objective: detail.goal.objective }
    setTitle(detail.goal.title)
    setObjective(detail.goal.objective)
  }
  createEffect(() => {
    const detail = props.detail()
    untrack(() => {
      const untouched = !seeded || (title() === seeded.title && objective() === seeded.objective)
      if (seeded && seeded.id === detail.goal.id && !untouched) return
      seed(detail)
    })
  })

  const dirty = createMemo(() => {
    const detail = props.detail()
    return title().trim() !== detail.goal.title || objective().trim() !== detail.goal.objective
  })
  const valid = createMemo(() => !!title().trim() && !!objective().trim())

  const refine = createGoalRefine({
    objective,
    criteriaText: () =>
      props
        .detail()
        .criteria.map((item) => item.description)
        .join("\n"),
    promptText: props.promptText,
    disabled: () => props.busy || !editable(),
    onApply: setObjective,
  })

  const save = (notify: boolean) =>
    props.onRun(async () => {
      const next = await goals.updateActive(props.sessionID, { title: title().trim(), objective: objective().trim() })
      seed(next)
      if (!notify) return
      await postSessionText(
        sdk().client,
        props.sessionID,
        buildGoalUpdatedMessage({ title: next.goal.title, objective: next.goal.objective }),
      )
      showToast({ variant: "success", title: language.t("goal.sentToAgent") })
    })

  return (
    <>
      <Section title={language.t("goal.brief")} action={refine.trigger()}>
        <div class="flex min-w-0 flex-col border-t border-v2-border-border-muted">
          <GoalInlineField
            singleLine
            label={language.t("goal.field.title")}
            value={title()}
            disabled={!editable()}
            onInput={setTitle}
            placeholder={language.t("goal.field.titlePlaceholder")}
          />
          <GoalInlineField
            label={language.t("goal.field.objective")}
            value={objective()}
            disabled={!editable()}
            rows={2}
            onInput={setObjective}
            placeholder={language.t("goal.field.objectivePlaceholder")}
          />
        </div>
        {refine.questions()}
        <Show when={editable() && dirty()}>
          <div class="flex h-8 min-w-0 items-center justify-end gap-1 border-t border-v2-border-border-muted px-2">
            <ButtonV2
              size="small"
              variant="ghost-muted"
              class="shrink-0 whitespace-nowrap"
              disabled={props.busy || !valid()}
              onClick={() => void save(false)}
            >
              {language.t("goal.saveBrief")}
            </ButtonV2>
            <TooltipV2 placement="top" gutter={4} value={language.t("goal.briefHint")}>
              <ButtonV2
                size="small"
                variant="contrast"
                class="shrink-0 whitespace-nowrap"
                disabled={props.busy || !valid()}
                onClick={() => void save(true)}
              >
                {language.t("goal.saveAndSend")}
              </ButtonV2>
            </TooltipV2>
          </div>
        </Show>
      </Section>
    </>
  )
}

function GoalDraftSetup(props: {
  sessionID: string
  detail: () => GoalDetail
  busy: boolean
  onRun: (action: () => Promise<unknown>) => Promise<void>
  promptText?: () => string
}) {
  const goals = useGoals()
  const language = useLanguage()
  const [title, setTitle] = createSignal("")
  const [objective, setObjective] = createSignal("")
  const [criteria, setCriteria] = createSignal("")
  const [auditorModel, setAuditorModel] = createSignal<GoalModelRef | undefined>()

  const modelRef = (detail: GoalDetail) => {
    const model = detail.goal.auditorPolicy.model
    return model ? { providerID: model.providerID, modelID: model.id } : undefined
  }
  const modelKey = (model: GoalModelRef | undefined) => (model ? `${model.providerID}/${model.modelID}` : "")

  // Same in-flight-edit protection as the live brief editor.
  let seeded: { id: string; title: string; objective: string; criteria: string; model: string } | undefined
  const seed = (detail: GoalDetail) => {
    const criteriaText = detail.criteria.map((item) => item.description).join("\n")
    const model = modelRef(detail)
    seeded = {
      id: detail.goal.id,
      title: detail.goal.title,
      objective: detail.goal.objective,
      criteria: criteriaText,
      model: modelKey(model),
    }
    setTitle(detail.goal.title)
    setObjective(detail.goal.objective)
    setCriteria(criteriaText)
    setAuditorModel(model)
  }
  createEffect(() => {
    const detail = props.detail()
    untrack(() => {
      const untouched =
        !seeded ||
        (title() === seeded.title &&
          objective() === seeded.objective &&
          criteria() === seeded.criteria &&
          modelKey(auditorModel()) === seeded.model)
      if (seeded && seeded.id === detail.goal.id && !untouched) return
      seed(detail)
    })
  })

  const dirty = createMemo(() => {
    const detail = props.detail()
    return (
      title().trim() !== detail.goal.title ||
      objective().trim() !== detail.goal.objective ||
      lines(criteria()).join("\n") !== detail.criteria.map((item) => item.description).join("\n") ||
      modelKey(auditorModel()) !== modelKey(modelRef(detail))
    )
  })

  const refine = createGoalRefine({
    objective,
    criteriaText: criteria,
    promptText: props.promptText,
    disabled: () => props.busy,
    onApply: setObjective,
  })

  const save = () =>
    props.onRun(async () => {
      const next = await goals.updateDraft(props.sessionID, {
        title: title().trim(),
        objective: objective().trim(),
        criteria: lines(criteria()),
        auditorPolicy: {
          ...props.detail().goal.auditorPolicy,
          model: auditorModel() ? { providerID: auditorModel()!.providerID, id: auditorModel()!.modelID } : undefined,
        },
      })
      seed(next)
    })

  return (
    <Section title={language.t("goal.setup")} action={refine.trigger()}>
      <div class="flex min-w-0 flex-col border-t border-v2-border-border-muted">
        <GoalInlineField
          singleLine
          label={language.t("goal.field.title")}
          value={title()}
          onInput={setTitle}
          placeholder={language.t("goal.field.titlePlaceholder")}
        />
        <GoalInlineField
          label={language.t("goal.field.objective")}
          value={objective()}
          rows={3}
          onInput={setObjective}
          placeholder={language.t("goal.field.objectivePlaceholder")}
        />
        <GoalInlineField
          label={language.t("goal.field.criteria")}
          value={criteria()}
          rows={2}
          onInput={setCriteria}
          placeholder={language.t("goal.field.criteriaPlaceholder")}
          description={language.t("goal.field.criteriaDescription")}
        />
        <div class="flex h-7 min-w-0 items-center gap-1.5 px-2.5">
          <span class={`shrink-0 ${LABEL}`}>{language.t("goal.auditor")}</span>
          <div class="ml-auto flex min-w-0 items-center justify-end">
            <GoalAuditorModelPicker
              value={auditorModel()}
              action="goal-draft-auditor-model"
              disabled={props.busy}
              onChange={setAuditorModel}
            />
          </div>
        </div>
      </div>
      {refine.questions()}
      <Show when={dirty()}>
        <div class="flex h-8 min-w-0 items-center justify-end gap-1 border-t border-v2-border-border-muted px-2">
          <ButtonV2
            size="small"
            variant="neutral"
            class="shrink-0 whitespace-nowrap"
            disabled={props.busy || !title().trim() || !objective().trim()}
            onClick={save}
          >
            {language.t("goal.saveSetup")}
          </ButtonV2>
        </div>
      </Show>
    </Section>
  )
}

type GoalRefineInput = {
  objective: () => string
  criteriaText: () => string
  promptText?: () => string
  disabled?: () => boolean
  onApply: (value: string) => void
}

type GoalRevisorQuestion = {
  question: string
  header: string
  options: { label: string; description: string }[]
  multiple?: boolean
  custom?: boolean
}

type GoalRevisorFlow = {
  token: number
  draft: string
  guidance: string
  clarifications: { question: string; answers: string[]; detail?: string }[]
  round: number
}

/**
 * Goal revisor: reuses the existing prompt-revisor service. It composes the
 * objective + done-when + composer text into one draft, asks the revisor to
 * author a comprehensive goal-objective document, and writes the revision
 * back into the editable objective field. No new backend is required and no
 * goal-objective.md file is created: the goal's `objective` itself is the
 * durable markdown brief the agent reads through GoalContext.
 *
 * Returns the trigger and the clarification panel separately so callers can
 * seat the trigger in a section header and the panel in the section body.
 */
function createGoalRefine(input: GoalRefineInput) {
  const sdk = useSDK()
  const settings = useSettings()
  const local = useLocal()
  const language = useLanguage()
  const [busy, setBusy] = createSignal(false)
  const [pending, setPending] = createSignal<
    { flow: GoalRevisorFlow; items: GoalRevisorQuestion[]; round: number } | undefined
  >()
  const [answers, setAnswers] = createSignal<string[][]>([])
  const [details, setDetails] = createSignal<string[]>([])
  let request = 0

  const sourceText = () => promptDraftText(input.promptText)
  const canRun = () =>
    !busy() && !input.disabled?.() && (!!input.objective().trim() || !!input.criteriaText().trim() || !!sourceText())

  const send = async (flow: GoalRevisorFlow) => {
    if (flow.token !== request) return
    setBusy(true)
    try {
      const configured = settings.general.promptRevision()?.model
      const current = local.model.current()
      const result = await sdk().api.promptRevisor.revise({
        prompt: flow.draft,
        sessionID: undefined,
        guidance: flow.guidance,
        model: configured ? { providerID: configured.providerID, id: configured.modelID } : undefined,
        fallbackModel: current
          ? { providerID: current.provider.id, id: current.id, variant: local.model.variant.current() ?? undefined }
          : undefined,
        clarifications: flow.clarifications,
        clarificationRound: flow.round,
      })
      if (flow.token !== request) return
      if (result.type === "question") {
        setPending({
          flow,
          items: result.questions as unknown as GoalRevisorQuestion[],
          round: result.clarificationRound,
        })
        setAnswers(result.questions.map(() => []))
        setDetails(result.questions.map(() => ""))
        return
      }
      input.onApply(applyRevisedGoalObjective(result.prompt))
      setPending(undefined)
    } catch (error) {
      if (flow.token !== request) return
      showToast({
        variant: "error",
        title: language.t("goal.reviseFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      if (flow.token === request) setBusy(false)
    }
  }

  const run = () => {
    if (!canRun()) {
      if (!input.objective().trim() && !input.criteriaText().trim() && !sourceText()) {
        showToast({ title: language.t("goal.reviseNeedsInput") })
      }
      return
    }
    const token = ++request
    setPending(undefined)
    void send({
      token,
      draft: buildGoalRevisorDraft({
        objective: input.objective(),
        criteria: input.criteriaText(),
        promptText: sourceText(),
      }),
      guidance: buildGoalRevisorGuidance(),
      clarifications: [],
      round: 0,
    })
  }

  const submit = () => {
    const current = pending()
    if (!current || busy()) return
    const response = promptRevisionResponse(current.items, answers(), details())
    const clarifications = promptRevisionClarifications(current.items, response)
    void send({ ...current.flow, clarifications, round: current.round })
  }

  const cancel = () => {
    request += 1
    setBusy(false)
    setPending(undefined)
  }

  const toggle = (index: number, label: string, multiple: boolean) => {
    if (busy()) return
    setAnswers((current) => {
      const next = current.map((entry) => [...entry])
      if (!multiple) {
        next[index] = [label]
        return next
      }
      const entry = next[index] ?? []
      next[index] = entry.includes(label) ? entry.filter((item) => item !== label) : [...entry, label]
      return next
    })
  }

  const trigger = () => (
    <TooltipV2 placement="top" gutter={4} value={language.t("goal.reviseHint")}>
      <button
        type="button"
        data-action="goal-refine"
        disabled={!canRun()}
        onClick={run}
        class="inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-[5px] px-1.5 text-[10px] font-[560] leading-[14px] text-v2-text-text-muted outline-none transition-colors enabled:hover:bg-v2-overlay-simple-overlay-hover enabled:hover:text-v2-text-text-base focus-visible:bg-v2-overlay-simple-overlay-hover disabled:opacity-40"
      >
        <Icon name="pencil-sparkles" size="small" class="size-3" />
        {busy() ? language.t("goal.revising") : language.t("goal.revise")}
      </button>
    </TooltipV2>
  )

  const questions = () => (
    <Show when={pending()}>
      {(current) => (
        <div class="min-w-0 border-t border-v2-border-border-muted bg-v2-background-bg-base">
          <div class="flex h-6 items-center px-2.5">
            <span class={LABEL}>{language.t("goal.reviseQuestion")}</span>
          </div>
          <div class="flex min-w-0 flex-col gap-1.5 px-2.5 pb-1.5">
            <For each={current().items}>
              {(item, index) => {
                const multiple = () => item.multiple === true
                const selected = (label: string) => answers()[index()]?.includes(label) ?? false
                return (
                  <div class="min-w-0">
                    <div class={BODY}>{item.question}</div>
                    <Show when={item.options.length > 0}>
                      <div class="mt-1 flex flex-col gap-0.5" role={multiple() ? "group" : "radiogroup"}>
                        <For each={item.options}>
                          {(option) => (
                            <button
                              type="button"
                              disabled={busy()}
                              role={multiple() ? "checkbox" : "radio"}
                              aria-checked={selected(option.label)}
                              onClick={() => toggle(index(), option.label, multiple())}
                              class="flex min-h-6 w-full min-w-0 items-start gap-1.5 rounded-[4px] border px-1.5 py-1 text-left transition-colors disabled:opacity-50"
                              classList={{
                                "border-v2-border-border-strong bg-v2-overlay-simple-overlay-pressed": selected(
                                  option.label,
                                ),
                                "border-v2-border-border-muted hover:border-v2-border-border-strong hover:bg-v2-overlay-simple-overlay-hover":
                                  !selected(option.label),
                              }}
                            >
                              <span
                                class="mt-px flex size-3 shrink-0 items-center justify-center border border-v2-border-border-strong"
                                classList={{ "rounded-[3px]": multiple(), "rounded-full": !multiple() }}
                              >
                                <Show when={selected(option.label)}>
                                  <Show
                                    when={multiple()}
                                    fallback={<span class="size-1.5 rounded-full bg-v2-icon-icon-base" />}
                                  >
                                    <Icon name="check" size="small" class="size-2 text-v2-icon-icon-base" />
                                  </Show>
                                </Show>
                              </span>
                              <span class="min-w-0 flex-1">
                                <span class="block text-[10px] font-[540] leading-[14px] text-v2-text-text-base">
                                  {option.label}
                                </span>
                                <Show when={option.description}>
                                  <span class="block text-[9px] leading-[13px] text-v2-text-text-muted">
                                    {option.description}
                                  </span>
                                </Show>
                              </span>
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>
                    <Show when={item.custom !== false}>
                      <input
                        value={details()[index()] ?? ""}
                        placeholder={language.t("prompt.revision.guidance.placeholder")}
                        class="mt-1 box-border h-6 w-full min-w-0 rounded-[4px] border border-v2-border-border-muted bg-v2-background-bg-base px-1.5 text-[10px] leading-[14px] text-v2-text-text-base outline-none transition-colors placeholder:text-v2-text-text-faint focus:border-v2-border-border-strong"
                        onInput={(event) => {
                          const value = event.currentTarget.value
                          setDetails((entries) => {
                            const next = [...entries]
                            next[index()] = value
                            return next
                          })
                        }}
                      />
                    </Show>
                  </div>
                )
              }}
            </For>
            <div class="flex items-center justify-end gap-1">
              <ButtonV2 size="small" variant="ghost-muted" disabled={busy()} onClick={cancel}>
                {language.t("common.cancel")}
              </ButtonV2>
              <ButtonV2 size="small" variant="contrast" disabled={busy()} onClick={submit}>
                {language.t("prompt.revision.guidance.run")}
              </ButtonV2>
            </div>
          </div>
        </div>
      )}
    </Show>
  )

  return { trigger, questions, busy }
}

function CriterionIcon(props: { status: "pending" | "passed" | "failed" }) {
  return (
    <span
      class="mt-0.5 grid size-3.5 shrink-0 place-items-center rounded-full border border-v2-border-border-muted text-v2-text-text-faint"
      classList={{
        "border-v2-state-fg-success text-v2-state-fg-success": props.status === "passed",
        "border-v2-state-fg-danger text-v2-state-fg-danger": props.status === "failed",
      }}
    >
      <Show when={props.status === "passed"}>
        <Icon name="check" size="small" class="size-2.5" />
      </Show>
      <Show when={props.status === "failed"}>
        <Icon name="xmark-small" size="small" class="size-2.5" />
      </Show>
    </span>
  )
}

/**
 * Flat section: a dense header row that can seat one inline control, plus an
 * optional body. Sections never nest cards — the popover body separates them
 * with a single hairline, matching the prompt revisor surfaces.
 */
function Section(props: { title: string; meta?: string; action?: JSX.Element; children?: JSX.Element }) {
  return (
    <section class="min-w-0 bg-v2-background-bg-base">
      <div class="flex h-7 min-w-0 items-center gap-1.5 px-2.5">
        <span class={`shrink-0 ${LABEL}`}>{props.title}</span>
        <Show when={props.meta}>
          <span class="shrink-0 text-[9px] font-[440] tabular-nums leading-[14px] text-v2-text-text-faint">
            {props.meta}
          </span>
        </Show>
        <Show when={props.action}>
          <div class="ml-auto flex min-w-0 items-center justify-end gap-1">{props.action}</div>
        </Show>
      </div>
      <Show when={props.children}>
        <div class="min-w-0">{props.children}</div>
      </Show>
    </section>
  )
}

function GoalAuditorModelPicker(props: {
  value: GoalModelRef | undefined
  action: string
  disabled?: boolean
  onChange: (value: GoalModelRef | undefined) => void
}) {
  const local = useLocal()
  const language = useLanguage()
  const model = {
    ...local.model,
    current: () => {
      const saved = props.value
      if (!saved) return undefined
      return local.model.list().find((item) => item.provider.id === saved.providerID && item.id === saved.modelID)
    },
    set: (value: GoalModelRef | undefined) => props.onChange(value),
  }
  const selected = createMemo(() => model.current())
  const label = createMemo(() => {
    const item = selected()
    if (item) return stripUnlimitedSuffix(item.name)
    if (props.value) return `${props.value.providerID}/${props.value.modelID}`
    return language.t("goal.auditor.inherit")
  })

  return (
    <>
      <ModelSelectorPopoverV2
        model={model}
        placement="top-end"
        commitSelectionBeforeClose
        lightweight
        trigger={(triggerProps) => (
          <button
            {...triggerProps}
            type="button"
            data-action={props.action}
            disabled={props.disabled}
            title={language.t("goal.auditor.modelDescription")}
            class="group inline-flex h-6 min-w-0 max-w-[170px] shrink items-center gap-1 overflow-hidden rounded-[5px] px-1.5 text-[10px] font-[540] leading-[14px] text-v2-text-text-base outline-none transition-colors hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover disabled:pointer-events-none disabled:opacity-50"
          >
            <Show when={selected()?.provider.id ?? props.value?.providerID}>
              {(providerID) => <ProviderIcon id={providerID()} class="size-3 shrink-0 opacity-70" />}
            </Show>
            <span class="min-w-0 truncate" dir="auto">
              {label()}
            </span>
            <Icon name="chevron-down" size="small" class="size-3 shrink-0 text-v2-icon-icon-muted" />
          </button>
        )}
      />
      <Show when={props.value}>
        <TooltipV2 placement="top" gutter={4} value={language.t("goal.auditor.inherit")}>
          <IconButtonV2
            type="button"
            size="small"
            variant="ghost-muted"
            class="shrink-0"
            disabled={props.disabled}
            aria-label={language.t("common.clear")}
            icon={<Icon name="close" size="small" class="size-3" />}
            onClick={() => props.onChange(undefined)}
          />
        </TooltipV2>
      </Show>
    </>
  )
}

export function GoalComposerLauncher(props: LauncherProps) {
  const goals = useGoals()
  const sync = useSync()
  const sdk = useSDK()
  const language = useLanguage()
  const [shown, setShown] = createSignal(false)
  const [list, setList] = createSignal<GoalInfo[]>([])
  const [listLoading, setListLoading] = createSignal(false)
  const [submitting, setSubmitting] = createSignal(false)
  const [creating, setCreating] = createSignal(false)
  const [objective, setObjective] = createSignal("")
  const [criteria, setCriteria] = createSignal("")
  const [auditorModel, setAuditorModel] = createSignal<GoalModelRef | undefined>()
  const current = createMemo(() => (props.sessionID ? goals.focused(props.sessionID) : null))
  const session = createMemo(() =>
    props.sessionID ? sync().data.session.find((item) => item.id === props.sessionID) : undefined,
  )
  const armed = createMemo(() => !!goals.arm(props.armKey))
  const refine = createGoalRefine({
    objective,
    criteriaText: criteria,
    promptText: props.promptText,
    disabled: submitting,
    onApply: setObjective,
  })

  const load = async () => {
    const current = session()
    if (!current || listLoading()) return
    setListLoading(true)
    try {
      const available = (await goals.list(current.projectID, current.workspaceID)).filter(
        (item) => !isGoalTerminal(item.status),
      )
      setList(available)
      // The common case is creating a Goal, not managing an existing one. Skip
      // the empty chooser so the split-button popover opens directly onto the
      // two-field brief when there is nothing useful to choose from.
      if (available.length === 0) setCreating(true)
    } catch {
      setList([])
    } finally {
      setListLoading(false)
    }
  }
  createEffect(() => {
    if (shown()) void load()
  })

  const focus = async (goalID: string) => {
    if (!props.sessionID) return
    try {
      await goals.focus(props.sessionID, goalID)
      setShown(false)
    } catch (error) {
      showToast({ variant: "error", title: language.t("goal.error.title"), description: String(error) })
    }
  }

  const create = async (start: boolean) => {
    const current = session()
    const sessionID = props.sessionID
    if (!sessionID || !current || !objective().trim()) return
    const acceptance = lines(criteria())
    if (start && acceptance.length === 0) return
    setSubmitting(true)
    try {
      const detail = await goals.createAndFocus(sessionID, {
        title: titleFromObjective(objective()),
        objective: objective().trim(),
        criteria: acceptance,
        continuationPolicy: { mode: "auto_continue" },
        auditorPolicy: auditorModel()
          ? { model: { providerID: auditorModel()!.providerID, id: auditorModel()!.modelID } }
          : undefined,
        start,
      })
      const composerText = promptDraftText(props.promptText)
      if (start && !composerText) {
        // No composer text: the agent would otherwise sit idle on a fresh
        // active goal, so dispatch the brief itself as the first work item.
        await postSessionText(
          sdk().client,
          sessionID,
          buildGoalStartMessage({ objective: detail.goal.objective, criteria: acceptance }),
        )
        showToast({ variant: "success", title: language.t("goal.startedAndSent") })
      }
      setObjective("")
      setCriteria("")
      setAuditorModel(undefined)
      setCreating(false)
      setShown(false)
    } catch (error) {
      showToast({ variant: "error", title: language.t("goal.error.title"), description: String(error) })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Show when={current() === null}>
      <div data-goal-split-control="" class="flex shrink-0 items-center">
        <TooltipV2 placement="top" value={armed() ? language.t("goal.armed") : language.t("goal.armHint")}>
          <IconButtonV2
            type="button"
            size="large"
            variant="ghost-muted"
            aria-label={language.t("goal.launcher")}
            aria-pressed={armed()}
            data-goal-launcher=""
            data-goal-armed={armed() ? "true" : "false"}
            class={`shrink-0 !rounded-r-[3px] ${armed() ? "!text-v2-icon-icon-accent bg-v2-overlay-simple-overlay-hover" : ""}`}
            icon={<Icon name={armed() ? "star-filled" : "star"} size="small" />}
            onClick={() => goals.toggleArm(props.armKey)}
          />
        </TooltipV2>
        <Popover
          open={shown()}
          onOpenChange={setShown}
          placement="top-start"
          gutter={6}
          flip
          slide
          fitViewport
          shift={2}
          overflowPadding={8}
          onOpenAutoFocus={(event) => event.preventDefault()}
          ownedPortalSelector='[data-component="menu-v2-content"]'
          triggerAs={IconButtonV2}
          triggerProps={{
            type: "button",
            size: "large",
            variant: "ghost-muted",
            "aria-label": language.t("goal.setup"),
            "data-goal-menu": "",
            class: "shrink-0 !w-5 !rounded-l-[3px]",
          }}
          trigger={<Icon name="chevron-down" size="small" class="size-3" />}
          class="[&_[data-slot=popover-body]]:p-0 w-[390px] max-w-[calc(100vw-16px)] overflow-hidden rounded-[8px] border border-v2-border-border-muted bg-v2-background-bg-base shadow-[var(--v2-elevation-floating)]"
          style={{
            "max-height": "min(360px, var(--kb-popper-content-available-height, calc(100dvh - 16px)))",
          }}
        >
          <div class="flex min-h-0 min-w-0 flex-col overflow-hidden bg-v2-background-bg-base">
            <div class="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2.5">
              <div class="flex min-w-0 items-center gap-1.5">
                <Icon
                  name={creating() ? "star" : "history"}
                  size="small"
                  class="size-3.5 shrink-0 text-v2-icon-icon-muted"
                />
                <span class="truncate text-[11px] font-[600] leading-4 text-v2-text-text-base">
                  {creating() ? language.t("goal.new") : language.t("goal.choose")}
                </span>
              </div>
              <Show
                when={creating()}
                fallback={
                  <ButtonV2 size="small" variant="ghost-muted" icon="plus" onClick={() => setCreating(true)}>
                    {language.t("goal.new")}
                  </ButtonV2>
                }
              >
                <div class="flex min-w-0 items-center gap-1">
                  <span class={`shrink-0 ${LABEL}`}>{language.t("goal.auditor")}</span>
                  <GoalAuditorModelPicker
                    value={auditorModel()}
                    action="goal-create-auditor-model"
                    disabled={submitting()}
                    onChange={setAuditorModel}
                  />
                  <TooltipV2 placement="top" gutter={4} value={language.t("goal.back")}>
                    <IconButtonV2
                      type="button"
                      size="small"
                      variant="ghost-muted"
                      aria-label={language.t("goal.back")}
                      icon={<Icon name="close" size="small" />}
                      onClick={() => setCreating(false)}
                    />
                  </TooltipV2>
                </div>
              </Show>
            </div>
            <Show
              when={creating()}
              fallback={
                <div class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-v2-background-bg-base py-1 no-scrollbar">
                  <Show
                    when={!listLoading()}
                    fallback={
                      <div class="px-2.5 py-6 text-center text-[11px] text-v2-text-text-faint">
                        {language.t("goal.loading")}
                      </div>
                    }
                  >
                    <Show
                      when={list().length > 0}
                      fallback={
                        <div class="px-2.5 py-6 text-center text-[11px] text-v2-text-text-faint">
                          {language.t("goal.empty")}
                        </div>
                      }
                    >
                      <For each={list()}>
                        {(item) => (
                          <button
                            type="button"
                            class="flex min-h-9 w-full min-w-0 items-center gap-2 px-2.5 py-1 text-left transition-colors hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
                            onClick={() => void focus(item.id)}
                          >
                            <GoalStatusGlyph status={item.status} />
                            <div class="min-w-0 flex-1">
                              <div class={`truncate ${BODY}`}>{item.title}</div>
                              <div class="truncate text-[9px] leading-[13px] text-v2-text-text-faint">
                                {item.objective}
                              </div>
                            </div>
                            <GoalStatusChip status={item.status} />
                          </button>
                        )}
                      </For>
                    </Show>
                  </Show>
                </div>
              }
            >
              <div
                data-goal-create-surface=""
                class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-v2-background-bg-base"
              >
                <div
                  data-goal-create-scroll=""
                  class="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden bg-v2-background-bg-base no-scrollbar"
                >
                  <GoalInlineField
                    label={language.t("goal.field.objective")}
                    value={objective()}
                    onInput={setObjective}
                    rows={3}
                    autofocus
                    placeholder={language.t("goal.field.objectivePlaceholder")}
                  />
                  <GoalInlineField
                    label={language.t("goal.field.criteria")}
                    value={criteria()}
                    onInput={setCriteria}
                    rows={2}
                    placeholder={language.t("goal.field.criteriaPlaceholder")}
                    description={language.t("goal.field.criteriaDescription")}
                  />
                  <div class="flex h-7 min-w-0 items-center justify-end px-2">{refine.trigger()}</div>
                  {refine.questions()}
                </div>

                <div class="flex h-9 shrink-0 items-center justify-between gap-2 border-t border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2">
                  <span class="min-w-0 truncate px-0.5 text-[9px] leading-[13px] text-v2-text-text-faint">
                    {lines(criteria()).length
                      ? language.t("goal.autoContinueHint")
                      : language.t("goal.startRequiresCriterion")}
                  </span>
                  <div class="flex shrink-0 items-center gap-1">
                    <ButtonV2
                      size="small"
                      variant="ghost-muted"
                      class="shrink-0 whitespace-nowrap"
                      disabled={submitting() || !objective().trim()}
                      onClick={() => void create(false)}
                    >
                      {language.t("goal.saveDraft")}
                    </ButtonV2>
                    <ButtonV2
                      size="small"
                      variant="contrast"
                      class="shrink-0 whitespace-nowrap"
                      disabled={submitting() || !objective().trim() || lines(criteria()).length === 0}
                      onClick={() => void create(true)}
                    >
                      {language.t("goal.create")}
                    </ButtonV2>
                  </div>
                </div>
              </div>
            </Show>
          </div>
        </Popover>
      </div>
    </Show>
  )
}

/**
 * Borderless field row: a dense label bar over an edge-to-edge control, so
 * stacked fields read as one continuous sheet instead of a stack of cards.
 */
function GoalInlineField(props: {
  label: string
  value: string
  onInput: (value: string) => void
  placeholder?: string
  description?: string
  rows?: number
  autofocus?: boolean
  singleLine?: boolean
  disabled?: boolean
}) {
  let textarea: HTMLTextAreaElement | undefined
  let textareaArea: HTMLDivElement | undefined

  // Grow to the content instead of trusting a fixed row count: a `rows`-sized
  // box either wastes half the popover or hides trailing lines behind a
  // suppressed scrollbar. The CSS max-height still caps it and takes over.
  const fit = () => {
    if (!textarea) return
    textarea.style.height = "auto"
    textarea.style.height = `${Math.max(textarea.scrollHeight, 34)}px`
  }
  createEffect(() => {
    const value = props.value
    if (textarea && textarea.value !== value) textarea.value = value
    fit()
  })

  return (
    <label class="block min-w-0 border-b border-v2-border-border-muted last:border-b-0">
      <span class="flex h-6 min-w-0 items-center justify-between gap-2 px-2.5">
        <span class={`shrink-0 ${LABEL}`}>{props.label}</span>
        <Show when={props.description}>
          {(description) => (
            <span class="min-w-0 truncate text-right text-[9px] font-[440] leading-[14px] text-v2-text-text-faint">
              {description()}
            </span>
          )}
        </Show>
      </span>
      <Show
        when={props.singleLine}
        fallback={
          <div ref={(element) => (textareaArea = element)} class="relative min-w-0 bg-v2-background-bg-base">
            <textarea
              ref={(element) => (textarea = element)}
              value={props.value}
              placeholder={props.placeholder}
              rows={props.rows ?? 2}
              autofocus={props.autofocus}
              disabled={props.disabled}
              class="box-border block max-h-[min(200px,30vh)] min-h-[34px] w-full min-w-0 resize-none overflow-y-auto overscroll-contain border-0 bg-v2-background-bg-base pb-1.5 pe-4 ps-2.5 pt-0 text-[11px] leading-[15px] text-v2-text-text-base outline-none no-scrollbar placeholder:text-v2-text-text-faint disabled:opacity-60 [&::placeholder]:opacity-[0.38]"
              onInput={(event) => {
                props.onInput(event.currentTarget.value)
                fit()
              }}
            />
            <ScrollViewOverlayScrollbar viewport={() => textarea} hoverTarget={() => textareaArea} />
          </div>
        }
      >
        <input
          value={props.value}
          placeholder={props.placeholder}
          autofocus={props.autofocus}
          disabled={props.disabled}
          class="box-border block h-6 w-full min-w-0 border-0 bg-v2-background-bg-base pb-1.5 pe-2.5 ps-2.5 pt-0 text-[11px] leading-[15px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint disabled:opacity-60 [&::placeholder]:opacity-[0.38]"
          onInput={(event) => props.onInput(event.currentTarget.value)}
        />
      </Show>
    </label>
  )
}
