import type { GoalDetail, GoalInfo } from "@opencode-ai/sdk/v2/client"
import { Popover } from "@opencode-ai/ui/popover"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { ScrollViewOverlayScrollbar } from "@opencode-ai/ui/scroll-view"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { For, Show, createEffect, createMemo, createSignal, type JSX } from "solid-js"
import { ModelSelectorPopoverV2 } from "./dialog-select-model"
import { useGoals } from "@/context/goals"
import { useLanguage } from "@/context/language"
import { useLocal } from "@/context/local"
import { useSync } from "@/context/sync"
import { useNow } from "@/hooks/use-now"
import { stripUnlimitedSuffix } from "@/utils/model-badges"
import { showToast } from "@/utils/toast"
import { formatGoalElapsed, goalLifecycleAction, goalProgress, isGoalTerminal } from "./goal-composer-shelf-model"

type Props = { sessionID: string }
type LauncherProps = { sessionID?: string; armKey: string }
type GoalModelRef = { providerID: string; modelID: string }

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

function titleFromObjective(objective: string) {
  const line = objective.split(/\r?\n/, 1)[0]?.trim() ?? ""
  if (!line) return "Goal"
  return line.length <= 72 ? line : `${line.slice(0, 69).trimEnd()}…`
}

function lifecycleLabel(language: ReturnType<typeof useLanguage>, status: string) {
  if (status === "draft") return language.t("goal.start")
  if (status === "active") return language.t("goal.pause")
  return language.t("goal.resume")
}

export function GoalComposerShelf(props: Props) {
  const goals = useGoals()
  const language = useLanguage()
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

  return (
    <Show when={current()}>
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
            ownedPortalSelector='[data-component="menu-v2-content"]'
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
          <TooltipV2
            value={
              goal()!.status === "draft" && detail()!.criteria.length === 0
                ? language.t("goal.startRequiresCriterion")
                : lifecycleLabel(language, goal()!.status)
            }
          >
            <IconButtonV2
              type="button"
              size="small"
              variant="ghost-muted"
              disabled={busy() || (goal()!.status === "draft" && detail()!.criteria.length === 0)}
              aria-label={lifecycleLabel(language, goal()!.status)}
              icon={<Icon name={goal()!.status === "active" ? "pause" : "play"} size="small" />}
              onClick={toggleLifecycle}
            />
          </TooltipV2>
        </Show>
      </div>
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
        name={
          props.status === "completed"
            ? "check"
            : props.status === "verifying"
              ? "hourglass"
              : props.status === "blocked"
                ? "warning"
                : "star"
        }
        size="small"
        class="size-3"
      />
    </span>
  )
}

function GoalPopover(props: {
  sessionID: string
  busy: boolean
  onRun: (action: () => Promise<unknown>) => Promise<void>
}) {
  const goals = useGoals()
  const language = useLanguage()
  const current = createMemo(() => goals.focused(props.sessionID))
  const detail = createMemo(() => current()!.detail)
  const goal = createMemo(() => detail().goal)
  const expanded = createMemo(() => goals.expanded(goal().id))
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
  const verificationReady = createMemo(() => {
    if (detail().criteria.length === 0 || detail().criteria.some((item) => item.status !== "passed")) return false
    const evidenced = new Set(
      (expanded()?.evidence ?? []).flatMap((item) => (item.criterionID ? [item.criterionID] : [])),
    )
    return detail().criteria.every((item) => evidenced.has(item.id))
  })

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
        <Show
          when={goal().status === "draft"}
          fallback={
            <>
              <Section title={language.t("goal.criteria")} count={detail().criteria.length}>
                <For each={detail().criteria}>
                  {(item) => (
                    <div class="flex min-h-7 items-start gap-2 rounded-md px-2 py-1.5 hover:bg-v2-overlay-simple-overlay-hover">
                      <CriterionIcon status={item.status} />
                      <span class="min-w-0 flex-1 text-[11px] leading-4 text-v2-text-text-base">
                        {item.description}
                      </span>
                    </div>
                  )}
                </For>
              </Section>

              <Show when={detail().steps.length > 0}>
                <Section title={language.t("goal.steps")} count={detail().steps.length}>
                  <For each={detail().steps}>
                    {(item) => (
                      <div class="flex min-h-7 items-start gap-2 rounded-md px-2 py-1.5 hover:bg-v2-overlay-simple-overlay-hover">
                        <CriterionIcon
                          status={
                            item.status === "completed" ? "passed" : item.status === "blocked" ? "failed" : "pending"
                          }
                        />
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
            </>
          }
        >
          <GoalDraftSetup sessionID={props.sessionID} detail={detail} busy={props.busy} onRun={props.onRun} />
        </Show>

        <Show when={goal().status !== "draft"}>
          <Section title={language.t("goal.automation")}>
            <div class="grid grid-cols-3 gap-0.5 rounded-md bg-v2-overlay-simple-overlay-hover/50 p-0.5">
              <For each={["manual", "auto_continue", "unattended"] as const}>
                {(mode) => (
                  <button
                    type="button"
                    class="h-6 rounded-[5px] px-2 text-[10px] font-[540] transition-colors hover:bg-v2-overlay-simple-overlay-hover disabled:opacity-50"
                    classList={{
                      "bg-v2-background-bg-base text-v2-text-text-base shadow-sm":
                        goal().continuationPolicy.mode === mode,
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
        </Show>

        <Show when={goal().status !== "draft"}>
          <Section title={language.t("goal.auditor")}>
            <GoalAuditorModelPicker
              value={auditorModel()}
              action="goal-auditor-model"
              disabled={props.busy || goal().status === "verifying" || isGoalTerminal(goal().status)}
              onChange={(model) => void props.onRun(() => goals.setAuditorModel(props.sessionID, model))}
            />
            <Show when={latestAuditDecision()}>
              {(decision) => (
                <div class="mx-2 mb-1 rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2 py-1.5">
                  <div class="flex items-center gap-1.5">
                    <span class="text-[9px] font-[620] uppercase tracking-[0.04em] text-v2-text-text-faint">
                      {language.t("goal.auditor.latest")}
                    </span>
                    <span
                      class="rounded-sm px-1 py-0.5 text-[9px] font-[620] uppercase tracking-[0.03em]"
                      classList={{
                        "text-v2-state-fg-success": decision() === "complete",
                        "text-v2-state-fg-warning": decision() === "blocked",
                        "text-v2-text-text-muted": decision() === "continue",
                      }}
                    >
                      {decision()}
                    </span>
                  </div>
                  <Show when={latestAuditRationale()}>
                    {(rationale) => <div class="mt-1 text-[10px] leading-4 text-v2-text-text-muted">{rationale()}</div>}
                  </Show>
                  <Show when={latestAuditContinuation()}>
                    {(continuation) => (
                      <div class="mt-1.5 border-t border-v2-border-border-muted pt-1.5">
                        <div class="text-[8px] font-[620] uppercase tracking-[0.05em] text-v2-text-text-faint">
                          {language.t("goal.auditor.nextCycle")}
                        </div>
                        <div class="mt-0.5 max-h-24 overflow-y-auto whitespace-pre-wrap pr-1 text-[10px] leading-4 text-v2-text-text-base no-scrollbar">
                          {continuation()}
                        </div>
                      </div>
                    )}
                  </Show>
                </div>
              )}
            </Show>
          </Section>
        </Show>

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
                    <Show when={item.verdict}>
                      <span>· {item.verdict}</span>
                    </Show>
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

      <div class="flex items-center justify-between gap-1.5 border-t border-v2-border-border-muted p-2">
        <ButtonV2
          size="small"
          variant="ghost-muted"
          class="shrink-0 whitespace-nowrap"
          disabled={props.busy}
          onClick={() => props.onRun(() => goals.unfocus(props.sessionID))}
        >
          {language.t("goal.unfocus")}
        </ButtonV2>
        <div class="flex shrink-0 items-center gap-1">
          <Show when={goal().status === "draft"}>
            <TooltipV2
              placement="top"
              value={
                detail().criteria.length > 0 ? language.t("goal.start") : language.t("goal.startRequiresCriterion")
              }
            >
              <ButtonV2
                size="small"
                variant="neutral"
                class="shrink-0 whitespace-nowrap"
                disabled={props.busy || detail().criteria.length === 0}
                onClick={() => props.onRun(() => goals.transition(props.sessionID, "start"))}
              >
                {language.t("goal.start")}
              </ButtonV2>
            </TooltipV2>
          </Show>
          <Show when={goal().status === "active"}>
            <ButtonV2
              class="shrink-0 whitespace-nowrap"
              size="small"
              variant="ghost-muted"
              disabled={props.busy}
              onClick={() => props.onRun(() => goals.transition(props.sessionID, "pause"))}
            >
              {language.t("goal.pause")}
            </ButtonV2>
            <ButtonV2
              class="shrink-0 whitespace-nowrap"
              size="small"
              variant="neutral"
              disabled={props.busy}
              onClick={() => props.onRun(() => goals.transition(props.sessionID, "request_verification"))}
            >
              {language.t("goal.verify")}
            </ButtonV2>
          </Show>
          <Show when={goal().status === "paused" || goal().status === "blocked"}>
            <ButtonV2
              class="shrink-0 whitespace-nowrap"
              size="small"
              variant="neutral"
              disabled={props.busy}
              onClick={() => props.onRun(() => goals.transition(props.sessionID, "resume"))}
            >
              {language.t("goal.resume")}
            </ButtonV2>
          </Show>
          <Show when={goal().status === "verifying"}>
            <ButtonV2
              class="shrink-0 whitespace-nowrap"
              size="small"
              variant="ghost-muted"
              disabled={props.busy}
              onClick={() => props.onRun(() => goals.transition(props.sessionID, "verification_fail"))}
            >
              {language.t("goal.resumeWork")}
            </ButtonV2>
            <TooltipV2
              placement="top"
              value={
                verificationReady()
                  ? language.t("goal.complete")
                  : "Pass every criterion and attach supporting evidence before completion."
              }
            >
              <ButtonV2
                size="small"
                variant="neutral"
                class="shrink-0 whitespace-nowrap"
                disabled={props.busy || !verificationReady()}
                onClick={() => props.onRun(() => goals.transition(props.sessionID, "verification_pass"))}
              >
                {language.t("goal.complete")}
              </ButtonV2>
            </TooltipV2>
          </Show>
          <Show when={!isGoalTerminal(goal().status)}>
            <ButtonV2
              class="shrink-0 whitespace-nowrap"
              size="small"
              variant="danger"
              disabled={props.busy}
              onClick={() => props.onRun(() => goals.transition(props.sessionID, "cancel"))}
            >
              {language.t("goal.cancel")}
            </ButtonV2>
          </Show>
        </div>
      </div>
    </div>
  )
}

function GoalDraftSetup(props: {
  sessionID: string
  detail: () => GoalDetail
  busy: boolean
  onRun: (action: () => Promise<unknown>) => Promise<void>
}) {
  const goals = useGoals()
  const language = useLanguage()
  const [title, setTitle] = createSignal("")
  const [objective, setObjective] = createSignal("")
  const [criteria, setCriteria] = createSignal("")
  const [auditorModel, setAuditorModel] = createSignal<GoalModelRef | undefined>()

  createEffect(() => {
    const current = props.detail()
    setTitle(current.goal.title)
    setObjective(current.goal.objective)
    setCriteria(current.criteria.map((item) => item.description).join("\n"))
    const model = current.goal.auditorPolicy.model
    setAuditorModel(model ? { providerID: model.providerID, modelID: model.id } : undefined)
  })

  const save = () =>
    props.onRun(() =>
      goals.updateDraft(props.sessionID, {
        title: title().trim(),
        objective: objective().trim(),
        criteria: lines(criteria()),
        auditorPolicy: {
          ...props.detail().goal.auditorPolicy,
          model: auditorModel() ? { providerID: auditorModel()!.providerID, id: auditorModel()!.modelID } : undefined,
        },
      }),
    )

  return (
    <section class="mb-1 overflow-hidden rounded-[8px] border border-v2-border-border-muted bg-v2-background-bg-layer-01/35">
      <div class="flex items-start gap-2.5 border-b border-v2-border-border-muted px-2.5 py-2">
        <span class="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-v2-overlay-simple-overlay-hover text-v2-icon-icon-muted">
          <Icon name="star" size="small" class="size-3.5" />
        </span>
        <div class="min-w-0 flex-1">
          <div class="text-[11px] font-[600] leading-4 text-v2-text-text-base">{language.t("goal.setup")}</div>
          <div class="text-[9px] leading-3.5 text-v2-text-text-faint">{language.t("goal.setupDescription")}</div>
        </div>
      </div>

      <div class="grid gap-2 p-2.5">
        <GoalField
          label={language.t("goal.field.title")}
          value={title()}
          onInput={setTitle}
          placeholder={language.t("goal.field.titlePlaceholder")}
        />
        <GoalField
          label={language.t("goal.field.objective")}
          value={objective()}
          onInput={setObjective}
          multiline
          rows={2}
          placeholder={language.t("goal.field.objectivePlaceholder")}
        />
        <GoalField
          label={language.t("goal.field.criteria")}
          value={criteria()}
          onInput={setCriteria}
          multiline
          rows={2}
          placeholder={language.t("goal.field.criteriaPlaceholder")}
        />
        <GoalAuditorModelPicker
          value={auditorModel()}
          action="goal-draft-auditor-model"
          disabled={props.busy}
          onChange={setAuditorModel}
        />
      </div>

      <div class="flex min-h-9 items-center justify-between gap-2 border-t border-v2-border-border-muted px-2.5 py-1.5">
        <span class="text-[9px] leading-3 text-v2-text-text-faint">
          {lines(criteria()).length ? language.t("goal.readyToStart") : language.t("goal.startRequiresCriterion")}
        </span>
        <ButtonV2
          size="small"
          variant="contrast"
          class="shrink-0"
          disabled={props.busy || !title().trim() || !objective().trim()}
          onClick={save}
        >
          {language.t("goal.saveSetup")}
        </ButtonV2>
      </div>
    </section>
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
      <Show when={props.status === "passed"}>
        <Icon name="check" size="small" class="size-2.5" />
      </Show>
      <Show when={props.status === "failed"}>
        <Icon name="xmark-small" size="small" class="size-2.5" />
      </Show>
    </span>
  )
}

function Section(props: { title: string; count?: number; children: JSX.Element }) {
  return (
    <section class="mb-1 last:mb-0">
      <div class="flex h-6 items-center gap-1.5 px-2 text-[9px] font-[620] uppercase tracking-[0.04em] text-v2-text-text-faint">
        <span>{props.title}</span>
        <Show when={props.count !== undefined}>
          <span class="font-[440]">{props.count}</span>
        </Show>
      </div>
      <div>{props.children}</div>
    </section>
  )
}

function GoalAuditorModelPicker(props: {
  value: GoalModelRef | undefined
  action: string
  disabled?: boolean
  compact?: boolean
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

  const selector = () => (
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
          class={
            props.compact
              ? "group inline-flex h-6 min-w-0 max-w-[150px] shrink items-center gap-1 overflow-hidden rounded-[5px] px-1.5 text-[10px] font-[540] text-v2-text-text-base outline-none transition-colors hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover disabled:pointer-events-none disabled:opacity-50"
              : "group inline-flex h-7 min-w-0 max-w-[45%] shrink items-center gap-1.5 overflow-hidden rounded-md px-1.5 text-[10.5px] font-[540] text-v2-text-text-base outline-none transition-colors hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover disabled:pointer-events-none disabled:opacity-50"
          }
        >
          <Show when={selected()?.provider.id ?? props.value?.providerID}>
            {(providerID) => <ProviderIcon id={providerID()} class="size-3.5 shrink-0 opacity-70" />}
          </Show>
          <span class="min-w-0 truncate" dir="auto">
            {label()}
          </span>
          <Icon name="chevron-down" size="small" class="size-3 shrink-0 text-v2-icon-icon-muted" />
        </button>
      )}
    />
  )

  if (props.compact) return selector()

  return (
    <div class="flex min-h-10 min-w-0 w-full max-w-full items-center gap-2 overflow-hidden rounded-[7px] border border-v2-border-border-muted bg-v2-background-bg-layer-01/45 px-2 py-1.5">
      <span class="grid size-6 shrink-0 place-items-center rounded-md bg-v2-overlay-simple-overlay-hover text-v2-icon-icon-muted">
        <Icon name="check" size="small" class="size-3" />
      </span>
      <div class="min-w-0 flex-1">
        <div class="text-[10px] font-[570] leading-3.5 text-v2-text-text-base">{language.t("goal.auditor.model")}</div>
        <div class="truncate text-[8.5px] leading-3 text-v2-text-text-faint">
          {language.t("goal.auditor.modelDescription")}
        </div>
      </div>
      {selector()}
      <Show when={props.value}>
        <TooltipV2 placement="top" gutter={4} value={language.t("goal.auditor.inherit")}>
          <IconButtonV2
            type="button"
            size="small"
            variant="ghost-muted"
            disabled={props.disabled}
            aria-label={language.t("common.clear")}
            icon={<Icon name="close" size="small" />}
            onClick={() => props.onChange(undefined)}
          />
        </TooltipV2>
      </Show>
    </div>
  )
}

export function GoalComposerLauncher(props: LauncherProps) {
  const goals = useGoals()
  const sync = useSync()
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
      await goals.createAndFocus(sessionID, {
        projectID: current.projectID,
        workspaceID: current.workspaceID,
        title: titleFromObjective(objective()),
        objective: objective().trim(),
        criteria: acceptance,
        continuationPolicy: { mode: "auto_continue" },
        auditorPolicy: auditorModel()
          ? { model: { providerID: auditorModel()!.providerID, id: auditorModel()!.modelID } }
          : undefined,
        start,
      })
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
                <span class="truncate text-[11px] font-[600] text-v2-text-text-base">
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
                  <span class="shrink-0 text-[8px] font-[600] uppercase tracking-[0.05em] text-v2-text-text-faint">
                    {language.t("goal.auditor")}
                  </span>
                  <GoalAuditorModelPicker
                    compact
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
                <div class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-v2-background-bg-base p-1.5 no-scrollbar">
                  <Show
                    when={!listLoading()}
                    fallback={
                      <div class="px-2 py-6 text-center text-[11px] text-v2-text-text-faint">
                        {language.t("goal.loading")}
                      </div>
                    }
                  >
                    <Show
                      when={list().length > 0}
                      fallback={
                        <div class="px-2 py-6 text-center text-[11px] text-v2-text-text-faint">
                          {language.t("goal.empty")}
                        </div>
                      }
                    >
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
                </div>

                <div class="flex min-h-9 shrink-0 items-center justify-between gap-2 border-t border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2 py-1.5">
                  <div class="flex min-w-0 items-center gap-1.5 px-0.5 text-[9px] leading-3 text-v2-text-text-faint">
                    <span class="size-1.5 shrink-0 rounded-full bg-v2-icon-icon-muted" />
                    <span class="truncate">
                      {lines(criteria()).length
                        ? language.t("goal.autoContinueHint")
                        : language.t("goal.startRequiresCriterion")}
                    </span>
                  </div>
                  <div class="flex shrink-0 items-center gap-1">
                    <ButtonV2
                      size="small"
                      variant="ghost-muted"
                      disabled={submitting() || !objective().trim()}
                      onClick={() => void create(false)}
                    >
                      {language.t("goal.saveDraft")}
                    </ButtonV2>
                    <ButtonV2
                      size="small"
                      variant="contrast"
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

function GoalInlineField(props: {
  label: string
  value: string
  onInput: (value: string) => void
  placeholder?: string
  description?: string
  rows?: number
  autofocus?: boolean
}) {
  let textarea: HTMLTextAreaElement | undefined
  let textareaArea: HTMLDivElement | undefined

  return (
    <label class="block min-w-0 border-b border-v2-border-border-muted last:border-b-0">
      <span class="flex h-7 min-w-0 items-end justify-between gap-2 px-2.5 pb-1">
        <span class="shrink-0 text-[8.5px] font-[620] uppercase tracking-[0.05em] text-v2-text-text-faint">
          {props.label}
        </span>
        <Show when={props.description}>
          {(description) => (
            <span class="min-w-0 truncate text-right text-[8.5px] font-[440] text-v2-text-text-faint">
              {description()}
            </span>
          )}
        </Show>
      </span>
      <div ref={(element) => (textareaArea = element)} class="relative min-w-0 bg-v2-background-bg-base">
        <textarea
          ref={(element) => (textarea = element)}
          value={props.value}
          placeholder={props.placeholder}
          rows={props.rows ?? 2}
          autofocus={props.autofocus}
          class="box-border block min-h-[36px] max-h-[min(220px,32vh)] w-full min-w-0 resize-y overflow-y-auto overscroll-contain border-0 bg-v2-background-bg-base ps-2.5 pe-4 pb-2 pt-0.5 text-[11px] leading-[15px] text-v2-text-text-base outline-none no-scrollbar placeholder:text-v2-text-text-faint [&::placeholder]:opacity-[0.38]"
          onInput={(event) => props.onInput(event.currentTarget.value)}
        />
        <ScrollViewOverlayScrollbar viewport={() => textarea} hoverTarget={() => textareaArea} />
      </div>
    </label>
  )
}

function GoalField(props: {
  label: string
  value: string
  onInput: (value: string) => void
  multiline?: boolean
  placeholder?: string
  description?: string
  rows?: number
  autofocus?: boolean
}) {
  let textarea: HTMLTextAreaElement | undefined
  let textareaArea: HTMLDivElement | undefined

  return (
    <label class="flex min-w-0 w-full max-w-full flex-col gap-1.5 overflow-hidden">
      <span class="flex min-w-0 w-full max-w-full items-center justify-between gap-2 px-0.5 overflow-hidden">
        <span class="shrink-0 text-[9px] font-[620] uppercase tracking-[0.045em] text-v2-text-text-faint">
          {props.label}
        </span>
        <Show when={props.description}>
          {(description) => (
            <span class="min-w-0 max-w-[50%] flex-1 truncate text-right text-[8.5px] font-[440] normal-case tracking-normal text-v2-text-text-faint">
              {description()}
            </span>
          )}
        </Show>
      </span>
      <Show
        when={props.multiline}
        fallback={
          <input
            value={props.value}
            placeholder={props.placeholder}
            autofocus={props.autofocus}
            class="box-border h-8 w-full min-w-0 max-w-full rounded-[7px] border border-v2-border-border-muted bg-v2-background-bg-base px-2.5 text-[11.5px] text-v2-text-text-base outline-none transition-colors placeholder:text-v2-text-text-faint [&::placeholder]:opacity-[0.38] focus:border-v2-border-border-strong"
            onInput={(event) => props.onInput(event.currentTarget.value)}
          />
        }
      >
        <div ref={(element) => (textareaArea = element)} class="relative min-w-0 max-w-full">
          <textarea
            ref={(element) => (textarea = element)}
            value={props.value}
            placeholder={props.placeholder}
            rows={props.rows ?? 3}
            autofocus={props.autofocus}
            class="box-border min-h-[42px] max-h-[min(220px,32vh)] w-full min-w-0 max-w-full resize-y overflow-y-auto overscroll-contain rounded-[7px] border border-v2-border-border-muted bg-v2-background-bg-base ps-2.5 pe-4 py-2 text-[11px] leading-[15px] text-v2-text-text-base outline-none transition-colors no-scrollbar placeholder:text-v2-text-text-faint [&::placeholder]:opacity-[0.38] focus:border-v2-border-border-strong"
            onInput={(event) => props.onInput(event.currentTarget.value)}
          />
          <ScrollViewOverlayScrollbar viewport={() => textarea} hoverTarget={() => textareaArea} />
        </div>
      </Show>
    </label>
  )
}
