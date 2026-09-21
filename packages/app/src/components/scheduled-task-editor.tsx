import type {
  ModelRef,
  ScheduledTaskInfo,
  ScheduledTaskPolicy,
  ScheduledTaskPreview,
  ScheduledTaskScheduleInput,
  ScheduledTaskSessionCandidate,
  ScheduledTaskSessionPolicy,
  ScheduledTaskTarget,
} from "@opencode-ai/sdk/v2/client"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode-ai/ui/v2/dialog-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useQuery } from "@tanstack/solid-query"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { ModelSelectorPopoverV2, type ModelSelectorModelState } from "@/components/dialog-select-model"
import { useDirectoryPicker } from "@/components/directory-picker"
import { useLanguage } from "@/context/language"
import { ModelsProvider, useModels } from "@/context/models"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useSettings } from "@/context/settings"
import { useScheduledTasks, type ScheduledTaskDraft } from "@/context/scheduled-tasks"
import { providerModelID, splitModelIDForProvider } from "@/utils/model-account-identity"
import { pathKey } from "@/utils/path-key"
import {
  revisionCanApplyNow,
  revisionRecoveryDecision,
  revisionSourceFingerprint,
  scheduledTaskRevisionTargetKey,
  type RevisionDraftTarget,
} from "@/utils/revision-draft"
import { showToast } from "@/utils/toast"
import {
  scheduledTaskModelRef,
  scheduledTaskPromptRevisionPatch,
  scheduledTaskRevisionFingerprint,
  scheduledTaskScheduleFromDraft,
  type ScheduledTaskInputMode,
  type ScheduledTaskRecurringMode,
  type ScheduledTaskRelativeUnit,
} from "./scheduled-task-editor-model"

type Isolation = "directory" | "worktree"
type SessionMode = ScheduledTaskSessionPolicy["kind"]
type Option<T extends string> = { value: T; label: string }

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const

function numberOrUndefined(value: string): number | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

function scheduleInputModeOf(task: ScheduledTaskInfo | undefined): ScheduledTaskInputMode {
  return task?.schedule.kind === "once" ? "timestamp" : "recurring"
}

function recurringModeOf(task: ScheduledTaskInfo | undefined): ScheduledTaskRecurringMode {
  const kind = task?.schedule.kind
  if (kind === "weekly" || kind === "cron") return kind
  return "daily"
}

function localDateTimeValue(epochMs: number | undefined): string {
  const date = new Date(typeof epochMs === "number" && Number.isFinite(epochMs) ? epochMs : Date.now() + 3_600_000)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

type AutomationIconName = "task" | "schedule" | "workspace" | "execution" | "safety" | "summary"

function AutomationIcon(props: { name: AutomationIconName; class?: string }) {
  const glyph = () => {
    switch (props.name) {
      case "task":
        return (
          <>
            <path d="m12 3 1.35 3.46a3 3 0 0 0 1.69 1.69L18.5 9.5l-3.46 1.35a3 3 0 0 0-1.69 1.69L12 16l-1.35-3.46a3 3 0 0 0-1.69-1.69L5.5 9.5l3.46-1.35a3 3 0 0 0 1.69-1.69L12 3Z" />
            <path d="M5 3v3M3.5 4.5h3M19 17v4M17 19h4" />
          </>
        )
      case "schedule":
        return (
          <>
            <path d="M7 2v3M17 2v3M3 8h13M5 4h12a2 2 0 0 1 2 2v5" />
            <path d="M14 20H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2" />
            <circle cx="17" cy="17" r="4" />
            <path d="M17 15v2l1.5 1" />
          </>
        )
      case "workspace":
        return (
          <>
            <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z" />
            <circle cx="9" cy="12" r="1.25" />
            <circle cx="15" cy="15" r="1.25" />
            <path d="M10.25 12H12a3 3 0 0 1 3 3" />
          </>
        )
      case "execution":
        return (
          <>
            <rect x="4" y="7" width="16" height="12" rx="2" />
            <path d="M9 12h.01M15 12h.01M9 16h6M12 7V4M10 4h4" />
          </>
        )
      case "safety":
        return (
          <>
            <path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3v8Z" />
            <path d="m8.5 12 2.1 2.1 4.9-5" />
          </>
        )
      case "summary":
        return (
          <>
            <path d="m3 6 2 2 4-4M3 16l2 2 4-4M13 6h8M13 12h8M13 18h8" />
          </>
        )
    }
  }

  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class ?? "size-4"}
    >
      {glyph()}
    </svg>
  )
}

function EditorSection(props: {
  icon: AutomationIconName
  title: JSX.Element
  description: JSX.Element
  children: JSX.Element
}) {
  return (
    <section class="overflow-hidden rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-01">
      <div class="flex items-start gap-2.5 border-b border-v2-border-border-muted px-3 py-2.5">
        <div class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-02 text-v2-icon-icon-muted">
          <AutomationIcon name={props.icon} class="size-3.5" />
        </div>
        <div class="min-w-0">
          <h3 class="text-[13px] font-[530] leading-4 tracking-[-0.04px] text-v2-text-text-base">{props.title}</h3>
          <p class="mt-0.5 text-[11px] leading-4 text-v2-text-text-muted">{props.description}</p>
        </div>
      </div>
      <div class="flex flex-col gap-3 p-3">{props.children}</div>
    </section>
  )
}

function EditorField(props: { label: JSX.Element; hint?: JSX.Element; children: JSX.Element }) {
  return (
    <div class="min-w-0">
      <div class="mb-1.5 flex min-w-0 items-baseline justify-between gap-2">
        <span class="min-w-0 truncate text-[11px] font-[530] leading-none text-v2-text-text-muted">{props.label}</span>
        <Show when={props.hint}>
          {(hint) => <span class="shrink-0 text-[10px] leading-none text-v2-text-text-faint">{hint()}</span>}
        </Show>
      </div>
      {props.children}
    </div>
  )
}

function ChoiceButton(props: {
  selected: boolean
  title: JSX.Element
  description?: JSX.Element
  compact?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={props.selected}
      disabled={props.disabled}
      class="group flex min-w-0 items-start gap-2 rounded-md border text-left transition-colors focus-visible:border-v2-border-border-strong focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
      classList={{
        "px-2.5 py-2": !props.compact,
        "px-2.5 py-1.5": props.compact,
        "border-v2-border-border-strong bg-v2-background-bg-layer-02": props.selected,
        "border-v2-border-border-muted bg-v2-background-bg-base hover:bg-v2-overlay-simple-overlay-hover": !props.selected,
      }}
      onClick={props.onClick}
    >
      <span
        class="mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border"
        classList={{
          "border-v2-border-border-strong bg-v2-background-bg-inverted text-v2-icon-icon-inverted": props.selected,
          "border-v2-border-border-muted text-transparent": !props.selected,
        }}
      >
        <Show when={props.selected}>
          <Icon name="check" size="small" class="size-2.5" />
        </Show>
      </span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-[12px] font-[530] leading-4 text-v2-text-text-base">{props.title}</span>
        <Show when={props.description}>
          {(description) => <span class="mt-0.5 block text-[10px] leading-4 text-v2-text-text-muted">{description()}</span>}
        </Show>
      </span>
    </button>
  )
}

function SummaryRow(props: { label: JSX.Element; value: JSX.Element; mono?: boolean }) {
  return (
    <div class="grid min-w-0 grid-cols-[86px_minmax(0,1fr)] gap-2 py-1.5">
      <span class="text-[10px] font-[530] leading-4 text-v2-text-text-faint">{props.label}</span>
      <span
        class="min-w-0 truncate text-right text-[11px] leading-4 text-v2-text-text-base"
        classList={{ "font-mono": props.mono }}
        title={typeof props.value === "string" ? props.value : undefined}
      >
        {props.value}
      </span>
    </div>
  )
}

function ScheduledTaskModelField(props: {
  directory: string
  providerID: string
  modelID: string
  variant: string
  onModel: (value: { providerID: string; modelID: string } | undefined) => void
  onVariant: (value: string) => void
}) {
  const serverSync = useServerSync()
  const [open, setOpen] = createSignal(false)
  const directory = createMemo(() => props.directory.trim())
  const catalogQuery = useQuery(() => {
    const target = pathKey(directory())
    return {
      ...serverSync().queryOptions.providers(target),
      // Scheduled is a global/Tier-0 workspace. Pay Tier-2 catalog cost only
      // for an explicit task target and only while the canonical picker is open.
      enabled: open() && !!target,
    }
  })
  const catalog = () => (catalogQuery.isPending ? undefined : catalogQuery.data)

  return (
    <ModelsProvider catalog={catalog} warmUsage={false}>
      <ScheduledTaskModelFieldInner
        directory={directory()}
        providerID={props.providerID}
        modelID={props.modelID}
        variant={props.variant}
        onOpenChange={setOpen}
        onModel={props.onModel}
        onVariant={props.onVariant}
      />
    </ModelsProvider>
  )
}

function ScheduledTaskModelFieldInner(props: {
  directory: string
  providerID: string
  modelID: string
  variant: string
  onOpenChange: (open: boolean) => void
  onModel: (value: { providerID: string; modelID: string } | undefined) => void
  onVariant: (value: string) => void
}) {
  const language = useLanguage()
  const models = useModels()
  const selectedCatalogModel = createMemo(() => {
    if (!props.providerID || !props.modelID) return undefined
    const exact = models.list().find((item) => item.provider.id === props.providerID && item.id === props.modelID)
    if (exact) return exact
    const base = splitModelIDForProvider(props.modelID, props.providerID).baseModelID
    return models.list().find((item) => {
      if (item.provider.id !== props.providerID) return false
      return splitModelIDForProvider(item.id, item.provider.id).baseModelID === base
    })
  })
  const recent = createMemo(() =>
    models.recent.list().flatMap((key) => {
      const item = models.find(key)
      return item ? [item] : []
    }),
  )
  const model = {
    current: selectedCatalogModel,
    recent,
    list: models.list,
    set(value, options) {
      if (!value) {
        props.onModel(undefined)
        return
      }
      const key = { providerID: value.providerID, modelID: value.modelID }
      props.onModel(key)
      models.setVisibility(key, true)
      if (options?.recent) models.recent.push(key)
    },
    visible: models.visible,
    favorite: models.favorite,
    subProvider: models.subProvider,
    order: models.order,
  } satisfies ModelSelectorModelState
  const variantOptions = createMemo<Option<string>[]>(() => {
    const current = props.variant.trim()
    const values = Object.keys(selectedCatalogModel()?.variants ?? {})
    if (current && !values.includes(current)) values.push(current)
    return [
      { value: "", label: language.t("scheduledTasks.model.variantDefault") },
      ...values.map((value) => ({ value, label: value })),
    ]
  })

  return (
    <div class="flex min-w-0 flex-col gap-1.5">
      <span class="text-[11px] font-[530] leading-none text-v2-text-text-muted">
        {language.t("scheduledTasks.field.model")}
      </span>
      <div class="flex min-w-0 items-center gap-1">
        <ModelSelectorPopoverV2
          model={model}
          directory={props.directory}
          placement="bottom-end"
          commitSelectionBeforeClose
          lightweight
          onOpenChange={props.onOpenChange}
          trigger={(triggerProps) => (
            <button
              {...triggerProps}
              type="button"
              data-action="scheduled-task-model"
              disabled={!props.directory}
              class="inline-flex h-8 min-w-0 flex-1 items-center justify-between gap-2 rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-2.5 text-left text-[12px] leading-none text-v2-text-text-base transition-colors hover:bg-v2-overlay-simple-overlay-hover focus-visible:border-v2-border-border-strong focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span class="min-w-0 truncate">
                {selectedCatalogModel()?.name ??
                  (props.providerID && props.modelID
                    ? `${props.providerID}/${props.modelID}`
                    : language.t("scheduledTasks.model.inherit"))}
              </span>
              <Icon name="chevron-down" size="small" class="size-3 shrink-0 text-v2-icon-icon-muted" />
            </button>
          )}
        />
        <Show when={props.providerID && props.modelID}>
          <ButtonV2
            type="button"
            size="small"
            variant="ghost-muted"
            aria-label={language.t("common.clear")}
            onClick={() => props.onModel(undefined)}
            icon="xmark-small"
          />
        </Show>
      </div>
      <Show when={props.providerID && props.modelID && variantOptions().length > 1}>
        <SelectV2
          appearance="base"
          options={variantOptions()}
          value={(option) => option.value}
          label={(option) => option.label}
          current={variantOptions().find((option) => option.value === props.variant)}
          onSelect={(option) => option && props.onVariant(option.value)}
          placeholder={language.t("scheduledTasks.model.variant")}
          aria-label={language.t("scheduledTasks.model.variant")}
        />
      </Show>
    </div>
  )
}

export function ScheduledTaskEditor(props: { task?: ScheduledTaskInfo }) {
  const store = useScheduledTasks()
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()
  const serverSDK = useServerSDK()
  const settings = useSettings()
  const server = useServer()
  const pickDirectory = useDirectoryPicker()

  const existing = props.task
  const inputMode = scheduleInputModeOf(existing)
  const recurringMode = recurringModeOf(existing)
  const existingWeekly = existing?.schedule.kind === "weekly" ? existing.schedule : undefined
  const existingTimes =
    existing?.schedule.kind === "daily" || existing?.schedule.kind === "weekly"
      ? existing.schedule.times
      : [{ hour: 9, minute: 0 }]

  const [form, setForm] = createStore({
    name: existing?.name ?? "",
    targetDirectory: existing?.targetDirectory ?? "",
    isolation: (existing?.target.kind ?? "worktree") as Isolation,
    worktreeReuse: existing?.target.kind === "worktree" ? existing.target.reuse : true,
    sessionMode: (existing?.sessionPolicy.kind ?? "new") as SessionMode,
    existingSessionID: existing?.sessionPolicy.kind === "existing" ? existing.sessionPolicy.sessionID : "",
    inputMode,
    recurringMode,
    relativeValue: "1",
    relativeUnit: "hours" as ScheduledTaskRelativeUnit,
    times: existingTimes.map((time) => ({ hour: time.hour, minute: time.minute })),
    weekdays: existingWeekly ? [...existingWeekly.weekdays] : [1, 2, 3, 4, 5],
    cron: existing?.schedule.kind === "cron" ? existing.schedule.expression : "0 9 * * 1-5",
    onceAt: localDateTimeValue(existing?.schedule.kind === "once" ? Number(existing.schedule.at) : undefined),
    timezone: existing?.timezone?.trim() || browserTimezone(),
    prompt: existing?.action.prompt ?? "",
    agent: existing?.action.agent ?? "",
    modelProvider: existing?.action.model?.providerID ?? "",
    modelID: existing?.action.model
      ? providerModelID(existing.action.model.id, existing.action.model.providerID, existing.action.model.accountID)
      : "",
    modelVariant: existing?.action.model?.variant ?? "",
    runAsGoal: !!existing?.action.goal,
    goalTitle: existing?.action.goal?.title ?? "",
    goalObjective: existing?.action.goal?.objective ?? "",
    goalCriteria: existing?.action.goal?.criteria?.join("\n") ?? "",
    permission: existing?.policy.permission ?? "deny",
    catchUp: existing?.policy.catchUp ?? "skip",
    catchUpMaxAgeMs: existing?.policy.catchUpMaxAgeMs !== undefined ? String(existing.policy.catchUpMaxAgeMs) : "",
    overrun: existing?.policy.overrun ?? "skip",
    jitterMs: existing?.policy.jitterMs !== undefined ? String(existing.policy.jitterMs) : "",
    maxAttempts: existing?.policy.maxAttempts !== undefined ? String(existing.policy.maxAttempts) : "",
    maxDurationMs: existing?.policy.maxDurationMs !== undefined ? String(existing.policy.maxDurationMs) : "",
    retentionRuns: existing?.policy.retentionRuns !== undefined ? String(existing.policy.retentionRuns) : "",
    notify: existing?.policy.notify ?? "failure",
  })

  const [preview, setPreview] = createSignal<ScheduledTaskPreview | undefined>(undefined)
  const [previewError, setPreviewError] = createSignal(false)
  const [previewPending, setPreviewPending] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [saving, setSaving] = createSignal(false)
  const [sessionCandidates, setSessionCandidates] = createSignal<ScheduledTaskSessionCandidate[]>([])
  const [binding, setBinding] = createSignal(existing ? store.binding(existing.id) : undefined)
  const [revisionBusy, setRevisionBusy] = createSignal(false)
  const [revisionGuidance, setRevisionGuidance] = createSignal("")
  const [revisionRestore, setRevisionRestore] = createSignal<{ before: string; after: string }>()
  let revisionRequest = 0
  let revisionAbort: AbortController | undefined
  const revisionTargetKey = () =>
    scheduledTaskRevisionTargetKey({
      taskID: existing?.id,
      directory: form.targetDirectory.trim(),
      windowID: platform.windowID,
    })

  onCleanup(() => {
    revisionRequest += 1
    revisionAbort?.abort()
  })

  const schedule = (): ScheduledTaskScheduleInput | undefined => {
    return scheduledTaskScheduleFromDraft({
      inputMode: form.inputMode,
      recurringMode: form.recurringMode,
      relativeValue: form.relativeValue,
      relativeUnit: form.relativeUnit,
      times: form.times,
      weekdays: form.weekdays,
      cron: form.cron,
      onceAt: form.onceAt,
    })
  }

  // Rule 4: never parse a schedule locally. Ask the server what "next" means.
  createEffect(() => {
    const current = schedule()
    const timezone = form.inputMode === "recurring" ? form.timezone.trim() : ""
    if (!current) {
      setPreview(undefined)
      return
    }
    const timer = setTimeout(() => {
      setPreviewPending(true)
      void store
        .preview(current, timezone, 5)
        .then((value) => {
          setPreview(value)
          setPreviewError(false)
        })
        .catch(() => setPreviewError(true))
        .finally(() => setPreviewPending(false))
    }, 250)
    onCleanup(() => clearTimeout(timer))
  })

  const target = (): ScheduledTaskTarget =>
    form.isolation === "worktree" ? { kind: "worktree", reuse: form.worktreeReuse } : { kind: "directory" }

  const sessionPolicy = (): ScheduledTaskSessionPolicy =>
    form.sessionMode === "existing"
      ? { kind: "existing", sessionID: form.existingSessionID }
      : { kind: form.sessionMode }

  const modelRef = (): ModelRef | undefined => {
    return scheduledTaskModelRef(form.modelProvider, form.modelID, form.modelVariant)
  }

  const configuredRevisorModel = (): ModelRef | undefined => {
    const configured = settings.general.promptRevision()?.model
    if (!configured) return undefined
    const split = splitModelIDForProvider(configured.modelID, configured.providerID)
    return {
      providerID: configured.providerID,
      id: split.baseModelID,
      ...(split.accountID ? { accountID: split.accountID } : {}),
    }
  }

  createEffect(() => {
    if (!existing || (form.sessionMode !== "reuse" && form.sessionMode !== "auto")) {
      setBinding(undefined)
      return
    }
    void store.getBinding(existing.id).then(setBinding)
  })

  createEffect(() => {
    if (form.sessionMode !== "existing" || !form.targetDirectory.trim()) {
      setSessionCandidates([])
      return
    }
    void store.sessionCandidates(form.targetDirectory.trim()).then(setSessionCandidates)
  })

  const policy = (): ScheduledTaskPolicy => {
    const value: ScheduledTaskPolicy = {
      catchUp: form.catchUp,
      overrun: form.overrun,
      permission: form.permission,
      notify: form.notify,
    }
    const catchUpMaxAgeMs = numberOrUndefined(form.catchUpMaxAgeMs)
    const jitterMs = numberOrUndefined(form.jitterMs)
    const maxAttempts = numberOrUndefined(form.maxAttempts)
    const maxDurationMs = numberOrUndefined(form.maxDurationMs)
    const retentionRuns = numberOrUndefined(form.retentionRuns)
    if (catchUpMaxAgeMs !== undefined) value.catchUpMaxAgeMs = catchUpMaxAgeMs
    if (jitterMs !== undefined) value.jitterMs = jitterMs
    if (maxAttempts !== undefined) value.maxAttempts = maxAttempts
    if (maxDurationMs !== undefined) value.maxDurationMs = maxDurationMs
    if (retentionRuns !== undefined) value.retentionRuns = retentionRuns
    return value
  }

  const revisionFingerprint = () =>
    scheduledTaskRevisionFingerprint({
      name: form.name,
      targetDirectory: form.targetDirectory,
      isolation: form.isolation,
      worktreeReuse: form.worktreeReuse,
      sessionMode: form.sessionMode,
      existingSessionID: form.existingSessionID,
      inputMode: form.inputMode,
      recurringMode: form.recurringMode,
      relativeValue: form.relativeValue,
      relativeUnit: form.relativeUnit,
      times: form.times.map((time) => ({ hour: time.hour, minute: time.minute })),
      weekdays: [...form.weekdays],
      cron: form.cron,
      onceAt: form.onceAt,
      timezone: form.timezone,
      prompt: form.prompt,
      agent: form.agent,
      model: modelRef(),
      runAsGoal: form.runAsGoal,
      goalTitle: form.goalTitle,
      goalObjective: form.goalObjective,
      goalCriteria: form.goalCriteria,
      policy: policy(),
    })

  let pendingRevisionArtifactID: string | undefined
  const consumeRevisionArtifact = async (id: string | undefined) => {
    if (!id) return false
    try {
      await serverSDK().api.revisionDraft.consume({ id })
      if (pendingRevisionArtifactID === id) pendingRevisionArtifactID = undefined
      return true
    } catch {
      return false
    }
  }
  const rememberRevisionArtifact = (id: string | undefined) => {
    if (id) pendingRevisionArtifactID = id
  }
  const commitRevisionArtifact = () => consumeRevisionArtifact(pendingRevisionArtifactID)

  let recoveredRevisionKey: string | undefined
  createEffect(() => {
    const key = revisionTargetKey()
    if (key === recoveredRevisionKey) return
    recoveredRevisionKey = key
    void (async () => {
      const artifact = await serverSDK().api.revisionDraft.recover({ kind: "scheduled_task", key }).catch(() => null)
      if (!artifact || artifact.kind !== "scheduled_task" || artifact.key !== key || revisionTargetKey() !== key) return

      const revisedPrompt = scheduledTaskPromptRevisionPatch(artifact.prompt).prompt
      if (existing?.action.prompt === revisedPrompt) {
        await consumeRevisionArtifact(artifact.id)
        return
      }
      const currentFingerprint = await revisionSourceFingerprint(revisionFingerprint())
      if (revisionTargetKey() !== key) return
      const decision = revisionRecoveryDecision({
        sourceFingerprint: artifact.sourceFingerprint,
        currentFingerprint,
        currentText: form.prompt,
        revisedText: revisedPrompt,
        consumeIfEqual: false,
        requireExplicitApply: !existing,
      })
      if (decision === "consume") {
        await consumeRevisionArtifact(artifact.id)
        return
      }

      const applyRecovered = async (expectedFingerprint: string) => {
        if (revisionTargetKey() !== key) {
          showToast({
            title: language.t("prompt.revision.error.title"),
            description: language.t("prompt.revision.changedDuringRequest"),
          })
          return
        }
        const currentFingerprint = await revisionSourceFingerprint(revisionFingerprint())
        if (revisionTargetKey() !== key) {
          showToast({
            title: language.t("prompt.revision.error.title"),
            description: language.t("prompt.revision.changedDuringRequest"),
          })
          return
        }
        if (
          !revisionCanApplyNow({
            expectedFingerprint,
            currentFingerprint,
          })
        ) {
          showToast({
            title: language.t("prompt.revision.error.title"),
            description: language.t("prompt.revision.changedDuringRequest"),
          })
          return
        }
        const before = form.prompt
        if (!existing && !form.targetDirectory.trim()) setForm("targetDirectory", artifact.directory)
        setForm("prompt", revisedPrompt)
        setRevisionRestore({ before, after: revisedPrompt })
        rememberRevisionArtifact(artifact.id)
        showToast({ variant: "success", title: language.t("prompt.revision.recovery.restored") })
      }
      if (decision === "apply") {
        void applyRecovered(artifact.sourceFingerprint)
        return
      }
      showToast({
        title: language.t("prompt.revision.recovery.title"),
        description: language.t("prompt.revision.recovery.description"),
        actions: [
          {
            label: language.t("prompt.revision.recovery.apply"),
            onClick: () => void applyRecovered(currentFingerprint),
          },
          { label: language.t("common.dismiss"), onClick: () => void consumeRevisionArtifact(artifact.id) },
        ],
      })
    })()
  })

  createEffect(() => {
    const restore = revisionRestore()
    if (!restore || revisionBusy()) return
    if (form.prompt === restore.after) return
    setRevisionRestore(undefined)
  })

  const restoreRevision = () => {
    const restore = revisionRestore()
    if (!restore || revisionBusy() || form.prompt !== restore.after) return
    setForm("prompt", restore.before)
    setRevisionRestore(undefined)
    void consumeRevisionArtifact(pendingRevisionArtifactID)
  }

  const revisePrompt = async () => {
    const prompt = form.prompt.trim()
    const directory = form.targetDirectory.trim()
    if (!prompt || !directory || revisionBusy()) return

    const token = ++revisionRequest
    const fingerprint = revisionFingerprint()
    const key = revisionTargetKey()
    const sourceFingerprint = await revisionSourceFingerprint(fingerprint)
    if (token !== revisionRequest || revisionTargetKey() !== key || revisionFingerprint() !== fingerprint) return
    const original = form.prompt
    const revisionTarget: RevisionDraftTarget = {
      kind: "scheduled_task",
      key,
      sourceFingerprint,
    }
    const controller = new AbortController()
    revisionAbort?.abort()
    revisionAbort = controller
    setRevisionBusy(true)
    try {
      const result = await serverSDK().api.promptRevisor.revise({
        prompt: original,
        purpose: "scheduled_task",
        target: revisionTarget,
        includeSessionContext: false,
        guidance: revisionGuidance().trim() || undefined,
        model: configuredRevisorModel(),
        fallbackModel: modelRef(),
        location: { directory },
        signal: controller.signal,
      })
      if (token !== revisionRequest) return
      if (revisionTargetKey() !== revisionTarget.key || revisionFingerprint() !== fingerprint) {
        showToast({
          title: language.t("prompt.revision.error.title"),
          description: language.t("prompt.revision.changedDuringRequest"),
        })
        return
      }
      if (result.type === "cancelled") return
      const patch = scheduledTaskPromptRevisionPatch(result.prompt)
      setForm("prompt", patch.prompt)
      setRevisionGuidance("")
      setRevisionRestore({ before: original, after: result.prompt })
      rememberRevisionArtifact(result.artifactID)
      showToast({
        variant: "success",
        title: language.t("prompt.revision.success.title"),
        description: language.t("scheduledTasks.prompt.revisionApplied"),
        actions: [{ label: language.t("prompt.revision.restore"), onClick: restoreRevision }],
      })
    } catch (cause) {
      if (token !== revisionRequest) return
      if (controller.signal.aborted || (cause instanceof DOMException && cause.name === "AbortError")) return
      showToast({
        variant: "error",
        title: language.t("prompt.revision.error.title"),
        description: cause instanceof Error ? cause.message : String(cause),
      })
    } finally {
      if (revisionAbort === controller) revisionAbort = undefined
      if (token === revisionRequest) setRevisionBusy(false)
    }
  }

  const validation = createMemo(() => {
    if (!form.name.trim()) return language.t("scheduledTasks.validation.name")
    if (!form.targetDirectory.trim()) return language.t("scheduledTasks.validation.targetDirectory")
    if (!form.prompt.trim()) return language.t("scheduledTasks.validation.prompt")
    if (form.sessionMode === "existing" && !form.existingSessionID)
      return language.t("scheduledTasks.validation.existingSession")
    if (
      (form.sessionMode === "reuse" || form.sessionMode === "auto") &&
      form.isolation === "worktree" &&
      !form.worktreeReuse
    )
      return language.t("scheduledTasks.validation.stableConversationTarget")
    if (form.inputMode === "relative" && !schedule()) return language.t("scheduledTasks.validation.relative")
    if (form.inputMode === "timestamp" && !Number.isFinite(Date.parse(form.onceAt)))
      return language.t("scheduledTasks.validation.onceAt")
    if (form.inputMode === "recurring" && form.recurringMode === "weekly" && form.weekdays.length === 0)
      return language.t("scheduledTasks.validation.weeklyDays")
    if (form.inputMode === "recurring" && form.recurringMode === "cron" && !form.cron.trim())
      return language.t("scheduledTasks.validation.cron")
    return undefined
  })

  const submit = async (event: Event) => {
    event.preventDefault()
    const current = schedule()
    const problem = validation()
    if (problem || !current) {
      setError(problem ?? language.t("scheduledTasks.validation.cron"))
      return
    }
    const goalExpanded = form.runAsGoal && form.goalObjective.trim()
    const draft: ScheduledTaskDraft = {
      name: form.name.trim(),
      targetDirectory: form.targetDirectory.trim(),
      target: target(),
      sessionPolicy: sessionPolicy(),
      schedule: current,
      timezone: form.inputMode === "recurring" ? form.timezone.trim() || browserTimezone() : "",
      action: {
        prompt: form.prompt,
        agent: form.agent.trim() || undefined,
        model: modelRef(),
        goal: goalExpanded
          ? {
              title: form.goalTitle.trim() || form.name.trim(),
              objective: form.goalObjective.trim(),
              criteria: form.goalCriteria
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean),
            }
          : undefined,
      },
      policy: policy(),
    }
    setSaving(true)
    setError(undefined)
    try {
      if (existing) await store.update(existing.id, Number(existing.revision), draft)
      else await store.create(draft)
      await commitRevisionArtifact()
      dialog.close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const chooseDirectory = () => {
    const current = server.current
    if (!current) return
    pickDirectory({
      server: current,
      title: language.t("scheduledTasks.field.targetDirectory"),
      onSelect: (result) => {
        const value = Array.isArray(result) ? result[0] : result
        if (value) setForm("targetDirectory", value)
      },
    })
  }

  const inputModes: Option<ScheduledTaskInputMode>[] = [
    { value: "relative", label: language.t("scheduledTasks.inputMode.relative") },
    { value: "timestamp", label: language.t("scheduledTasks.inputMode.timestamp") },
    { value: "recurring", label: language.t("scheduledTasks.inputMode.recurring") },
  ]
  const recurringModes: Option<ScheduledTaskRecurringMode>[] = [
    { value: "daily", label: language.t("scheduledTasks.scheduleMode.daily") },
    { value: "weekly", label: language.t("scheduledTasks.scheduleMode.weekly") },
    { value: "cron", label: language.t("scheduledTasks.scheduleMode.cron") },
  ]
  const relativeUnits: Option<ScheduledTaskRelativeUnit>[] = [
    { value: "seconds", label: language.t("scheduledTasks.relativeUnit.seconds") },
    { value: "minutes", label: language.t("scheduledTasks.relativeUnit.minutes") },
    { value: "hours", label: language.t("scheduledTasks.relativeUnit.hours") },
    { value: "days", label: language.t("scheduledTasks.relativeUnit.days") },
    { value: "weeks", label: language.t("scheduledTasks.relativeUnit.weeks") },
  ]
  const isolationOptions: Option<Isolation>[] = [
    { value: "worktree", label: language.t("scheduledTasks.isolation.worktree") },
    { value: "directory", label: language.t("scheduledTasks.isolation.directory") },
  ]
  const sessionOptions: Option<SessionMode>[] = [
    { value: "new", label: language.t("scheduledTasks.session.new") },
    { value: "reuse", label: language.t("scheduledTasks.session.reuse") },
    { value: "auto", label: language.t("scheduledTasks.session.auto") },
    { value: "existing", label: language.t("scheduledTasks.session.existing") },
  ]
  const permissionOptions: Option<ScheduledTaskPolicy["permission"] & string>[] = [
    { value: "deny", label: language.t("scheduledTasks.permission.deny") },
    { value: "pause", label: language.t("scheduledTasks.permission.pause") },
    { value: "inherit", label: language.t("scheduledTasks.permission.inherit") },
  ]
  const catchUpOptions: Option<"skip" | "run_once" | "run_all">[] = [
    { value: "skip", label: language.t("scheduledTasks.catchUp.skip") },
    { value: "run_once", label: language.t("scheduledTasks.catchUp.run_once") },
    { value: "run_all", label: language.t("scheduledTasks.catchUp.run_all") },
  ]
  const overrunOptions: Option<"skip" | "queue" | "cancel_prior">[] = [
    { value: "skip", label: language.t("scheduledTasks.overrun.skip") },
    { value: "queue", label: language.t("scheduledTasks.overrun.queue") },
    { value: "cancel_prior", label: language.t("scheduledTasks.overrun.cancel_prior") },
  ]
  const notifyOptions: Option<"failure" | "always" | "never">[] = [
    { value: "failure", label: language.t("scheduledTasks.notify.failure") },
    { value: "always", label: language.t("scheduledTasks.notify.always") },
    { value: "never", label: language.t("scheduledTasks.notify.never") },
  ]

  const optionLabel = <T extends string>(option: Option<T>) => option.label
  const optionValue = <T extends string>(option: Option<T>) => option.value

  const scheduleSummary = createMemo(() => {
    if (form.inputMode === "relative") {
      const unit = relativeUnits.find((option) => option.value === form.relativeUnit)?.label ?? form.relativeUnit
      return `${language.t("scheduledTasks.inputMode.relative")} · ${form.relativeValue || "—"} ${unit}`
    }
    if (form.inputMode === "timestamp") {
      const value = Date.parse(form.onceAt)
      return Number.isFinite(value)
        ? new Date(value).toLocaleString()
        : language.t("scheduledTasks.summary.previewUnavailable")
    }
    if (form.recurringMode === "cron") {
      return `${language.t("scheduledTasks.scheduleMode.cron")} · ${form.cron.trim() || "—"}`
    }
    const times = form.times
      .map((time) =>
        new Date(2000, 0, 1, time.hour, time.minute).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
      )
      .join(", ")
    if (form.recurringMode === "weekly") {
      const days = form.weekdays.map((day) => language.t(`scheduledTasks.weekday.${day}` as const)).join(", ")
      return `${days || "—"} · ${times || "—"}`
    }
    return `${language.t("scheduledTasks.scheduleMode.daily")} · ${times || "—"}`
  })

  const workspaceSummary = createMemo(
    () => form.targetDirectory.trim() || language.t("scheduledTasks.summary.notSelected"),
  )
  const isolationSummary = createMemo(() =>
    form.isolation === "directory"
      ? language.t("scheduledTasks.isolation.directory")
      : form.worktreeReuse
        ? language.t("scheduledTasks.summary.reusableWorktree")
        : language.t("scheduledTasks.summary.freshWorktree"),
  )
  const runtimeSummary = createMemo(() => {
    const agent = form.agent.trim() || language.t("scheduledTasks.summary.defaultAgent")
    const model =
      form.modelProvider && form.modelID
        ? `${form.modelProvider}/${form.modelID}${form.modelVariant ? ` · ${form.modelVariant}` : ""}`
        : language.t("scheduledTasks.model.inherit")
    return `${agent} · ${model}`
  })
  const permissionSummary = createMemo(
    () => permissionOptions.find((option) => option.value === form.permission)?.label ?? form.permission,
  )
  const notifySummary = createMemo(
    () => notifyOptions.find((option) => option.value === form.notify)?.label ?? form.notify,
  )
  const sessionSummary = createMemo(
    () => sessionOptions.find((option) => option.value === form.sessionMode)?.label ?? form.sessionMode,
  )
  const nextRuns = createMemo(() => preview()?.next?.slice(0, 3) ?? [])

  return (
    <Dialog
      size="x-large"
      containerClass="!h-[min(calc(100vh-40px),760px)] !w-[min(calc(100vw-24px),1080px)]"
      class="[font-family:var(--v2-font-family-sans)] !overflow-hidden"
    >
      <DialogHeader closeLabel={language.t("common.close")}>
        <div class="flex min-w-0 flex-1 items-start gap-3">
          <div class="flex size-8 shrink-0 items-center justify-center rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-02 text-v2-icon-icon-base">
            <AutomationIcon name="task" class="size-4" />
          </div>
          <DialogTitleGroup
            title={language.t(existing ? "scheduledTasks.editor.editTitle" : "scheduledTasks.editor.title")}
            description={language.t(
              existing ? "scheduledTasks.editor.editDescription" : "scheduledTasks.editor.description",
            )}
          />
        </div>
      </DialogHeader>

      <form class="flex min-h-0 w-full flex-1 flex-col" onSubmit={submit}>
        <DialogBody class="min-h-0 flex-1 border-y border-v2-border-border-muted bg-v2-background-bg-base">
          <ScrollView class="min-h-0 flex-1 [&_.scroll-view__viewport]:overscroll-contain">
            <div class="grid min-w-0 grid-cols-1 gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_292px] lg:items-start">
              <main class="flex min-w-0 flex-col gap-3">
                <EditorSection
                  icon="task"
                  title={language.t("scheduledTasks.section.task")}
                  description={language.t("scheduledTasks.section.task.description")}
                >
                  <div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px]">
                    <EditorField
                      label={language.t("scheduledTasks.field.name")}
                      hint={language.t("scheduledTasks.editor.required")}
                    >
                      <TextInputV2
                        autofocus
                        appearance="large"
                        value={form.name}
                        placeholder={language.t("scheduledTasks.field.namePlaceholder")}
                        invalid={!form.name.trim()}
                        onInput={(event) => setForm("name", event.currentTarget.value)}
                      />
                    </EditorField>
                    <EditorField
                      label={language.t("scheduledTasks.field.agent")}
                      hint={language.t("scheduledTasks.editor.optional")}
                    >
                      <TextInputV2
                        appearance="large"
                        value={form.agent}
                        placeholder={language.t("scheduledTasks.field.agentPlaceholder")}
                        onInput={(event) => setForm("agent", event.currentTarget.value)}
                      />
                    </EditorField>
                  </div>

                  <div class="min-w-0">
                    <div class="mb-1.5 flex min-w-0 items-center justify-between gap-2">
                      <span class="text-[11px] font-[530] leading-none text-v2-text-text-muted">
                        {language.t("scheduledTasks.field.prompt")}
                      </span>
                      <div class="flex shrink-0 items-center gap-1">
                        <Show when={revisionRestore()}>
                          <ButtonV2
                            type="button"
                            size="small"
                            variant="ghost-muted"
                            disabled={revisionBusy()}
                            icon="reset"
                            onClick={restoreRevision}
                          >
                            {language.t("prompt.revision.restore")}
                          </ButtonV2>
                        </Show>
                        <ButtonV2
                          type="button"
                          size="small"
                          variant={revisionBusy() ? "loading" : "ghost-muted"}
                          disabled={revisionBusy() || !form.prompt.trim() || !form.targetDirectory.trim()}
                          icon="pencil-sparkles"
                          onClick={() => void revisePrompt()}
                        >
                          {language.t(revisionBusy() ? "scheduledTasks.prompt.revising" : "scheduledTasks.prompt.revise")}
                        </ButtonV2>
                      </div>
                    </div>
                    <TextareaV2
                      rows={6}
                      class="w-full [&_[data-slot=textarea-v2-textarea]]:min-h-[132px] [&_[data-slot=textarea-v2-textarea]]:resize-y"
                      value={form.prompt}
                      placeholder={language.t("scheduledTasks.field.promptPlaceholder")}
                      invalid={!form.prompt.trim()}
                      onInput={(event) => setForm("prompt", event.currentTarget.value)}
                    />
                  </div>

                  <EditorField
                    label={language.t("scheduledTasks.prompt.guidance")}
                    hint={language.t("scheduledTasks.editor.optional")}
                  >
                    <TextInputV2
                      value={revisionGuidance()}
                      placeholder={language.t("scheduledTasks.prompt.guidancePlaceholder")}
                      leadingIcon={<Icon name="pencil-sparkles" size="small" />}
                      onInput={(event) => setRevisionGuidance(event.currentTarget.value)}
                    />
                  </EditorField>
                </EditorSection>

                <EditorSection
                  icon="schedule"
                  title={language.t("scheduledTasks.section.schedule")}
                  description={language.t("scheduledTasks.section.schedule.description")}
                >
                  <div class="grid grid-cols-3 gap-1.5">
                    <For each={inputModes}>
                      {(option) => (
                        <ChoiceButton
                          compact
                          selected={form.inputMode === option.value}
                          title={option.label}
                          onClick={() => setForm("inputMode", option.value)}
                        />
                      )}
                    </For>
                  </div>

                  <Show when={form.inputMode === "relative"}>
                    <div class="grid grid-cols-[minmax(0,1fr)_150px] gap-2">
                      <EditorField label={language.t("scheduledTasks.relativeValue")}>
                        <TextInputV2
                          type="number"
                          numeric
                          value={form.relativeValue}
                          min="1"
                          onInput={(event) => setForm("relativeValue", event.currentTarget.value)}
                        />
                      </EditorField>
                      <EditorField label={language.t("scheduledTasks.editor.unit")}>
                        <SelectV2
                          options={relativeUnits}
                          value={optionValue}
                          label={optionLabel}
                          current={relativeUnits.find((option) => option.value === form.relativeUnit)}
                          onSelect={(option) => option && setForm("relativeUnit", option.value)}
                          aria-label={language.t("scheduledTasks.editor.unit")}
                        />
                      </EditorField>
                    </div>
                  </Show>

                  <Show when={form.inputMode === "timestamp"}>
                    <EditorField label={language.t("scheduledTasks.onceAt")}>
                      <TextInputV2
                        type="datetime-local"
                        value={form.onceAt}
                        onInput={(event) => setForm("onceAt", event.currentTarget.value)}
                      />
                    </EditorField>
                  </Show>

                  <Show when={form.inputMode === "recurring"}>
                    <div class="grid grid-cols-3 gap-1.5">
                      <For each={recurringModes}>
                        {(option) => (
                          <ChoiceButton
                            compact
                            selected={form.recurringMode === option.value}
                            title={option.label}
                            onClick={() => setForm("recurringMode", option.value)}
                          />
                        )}
                      </For>
                    </div>

                    <EditorField
                      label={language.t("scheduledTasks.field.timezone")}
                      hint={language.t("scheduledTasks.field.timezoneHint")}
                    >
                      <TextInputV2
                        value={form.timezone}
                        leadingIcon={<Icon name="clock" size="small" />}
                        onInput={(event) => setForm("timezone", event.currentTarget.value)}
                      />
                    </EditorField>
                  </Show>

                  <Show
                    when={
                      form.inputMode === "recurring" &&
                      (form.recurringMode === "daily" || form.recurringMode === "weekly")
                    }
                  >
                    <div class="flex flex-col gap-1.5">
                      <span class="text-[11px] font-[530] leading-none text-v2-text-text-muted">
                        {language.t("scheduledTasks.time")}
                      </span>
                      <For each={form.times}>
                        {(time, index) => (
                          <div class="flex min-w-0 items-center gap-1.5">
                            <TextInputV2
                              class="min-w-0 flex-1"
                              type="time"
                              value={`${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`}
                              aria-label={`${language.t("scheduledTasks.time")} ${index() + 1}`}
                              onInput={(event) => {
                                const [hour, minute] = event.currentTarget.value.split(":")
                                setForm("times", index(), { hour: Number(hour) || 0, minute: Number(minute) || 0 })
                              }}
                            />
                            <Show when={form.times.length > 1}>
                              <ButtonV2
                                type="button"
                                size="small"
                                variant="ghost-muted"
                                icon="trash"
                                aria-label={language.t("common.remove")}
                                onClick={() => setForm("times", (times) => times.filter((_, i) => i !== index()))}
                              />
                            </Show>
                          </div>
                        )}
                      </For>
                      <ButtonV2
                        type="button"
                        size="small"
                        variant="ghost-muted"
                        class="self-start"
                        icon="plus"
                        onClick={() => setForm("times", (times) => [...times, { hour: 9, minute: 0 }])}
                      >
                        {language.t("scheduledTasks.addTime")}
                      </ButtonV2>
                    </div>
                  </Show>

                  <Show when={form.inputMode === "recurring" && form.recurringMode === "weekly"}>
                    <div class="grid grid-cols-7 gap-1">
                      <For each={WEEKDAYS}>
                        {(day) => {
                          const selected = () => form.weekdays.includes(day)
                          return (
                            <button
                              type="button"
                              aria-pressed={selected()}
                              class="h-7 rounded-md border text-[10px] font-[530] transition-colors focus-visible:border-v2-border-border-strong focus-visible:outline-none"
                              classList={{
                                "border-v2-border-border-strong bg-v2-background-bg-layer-02 text-v2-text-text-base":
                                  selected(),
                                "border-v2-border-border-muted bg-v2-background-bg-base text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover":
                                  !selected(),
                              }}
                              onClick={() =>
                                setForm("weekdays", (days) =>
                                  days.includes(day) ? days.filter((value) => value !== day) : [...days, day],
                                )
                              }
                            >
                              {language.t(`scheduledTasks.weekday.${day}` as const)}
                            </button>
                          )
                        }}
                      </For>
                    </div>
                  </Show>

                  <Show when={form.inputMode === "recurring" && form.recurringMode === "cron"}>
                    <EditorField label={language.t("scheduledTasks.cron")}>
                      <TextInputV2
                        class="[&_[data-slot=text-input-v2-input]]:font-mono"
                        value={form.cron}
                        placeholder="0 9 * * 1-5"
                        onInput={(event) => setForm("cron", event.currentTarget.value)}
                      />
                    </EditorField>
                  </Show>

                  <Show when={preview()?.next?.length || previewError() || previewPending()}>
                    <div class="rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-02 px-2.5 py-2">
                      <div class="flex items-center gap-1.5 text-[10px] font-[530] text-v2-text-text-muted">
                        <Icon name="clock" size="small" class="size-3" />
                        <Show
                          when={!previewPending() || !!preview()}
                          fallback={<span>{language.t("scheduledTasks.preview.loading")}</span>}
                        >
                          <span>{previewError() ? language.t("scheduledTasks.preview.failed") : scheduleSummary()}</span>
                        </Show>
                      </div>
                    </div>
                  </Show>
                </EditorSection>

                <EditorSection
                  icon="workspace"
                  title={language.t("scheduledTasks.section.context")}
                  description={language.t("scheduledTasks.section.context.description")}
                >
                  <div class="flex min-w-0 items-end gap-2">
                    <div class="min-w-0 flex-1">
                      <EditorField
                        label={language.t("scheduledTasks.field.targetDirectory")}
                        hint={language.t("scheduledTasks.editor.required")}
                      >
                        <TextInputV2
                          value={form.targetDirectory}
                          placeholder={language.t("scheduledTasks.field.targetDirectoryPlaceholder")}
                          leadingIcon={<Icon name="folder" size="small" />}
                          invalid={!form.targetDirectory.trim()}
                          onInput={(event) => setForm("targetDirectory", event.currentTarget.value)}
                        />
                      </EditorField>
                    </div>
                    <ButtonV2 type="button" variant="outline" icon="folder-add-left" onClick={chooseDirectory}>
                      {language.t("scheduledTasks.field.choose")}
                    </ButtonV2>
                  </div>

                  <div class="grid grid-cols-2 gap-1.5">
                    <For each={isolationOptions}>
                      {(option) => (
                        <ChoiceButton
                          compact
                          selected={form.isolation === option.value}
                          title={option.label}
                          onClick={() => setForm("isolation", option.value)}
                        />
                      )}
                    </For>
                  </div>

                  <Show when={form.isolation === "worktree"}>
                    <div class="flex min-w-0 items-center justify-between gap-3 rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-02 px-2.5 py-2">
                      <div class="min-w-0">
                        <div class="text-[11px] font-[530] leading-4 text-v2-text-text-base">
                          {language.t("scheduledTasks.isolation.reuse")}
                        </div>
                        <div class="text-[10px] leading-4 text-v2-text-text-muted">
                          {language.t("scheduledTasks.isolation.reuse.description")}
                        </div>
                      </div>
                      <Switch checked={form.worktreeReuse} onChange={(checked) => setForm("worktreeReuse", checked)} hideLabel>
                        {language.t("scheduledTasks.isolation.reuse")}
                      </Switch>
                    </div>
                  </Show>

                  <div class="border-t border-v2-border-border-muted pt-3">
                    <div class="mb-2 text-[11px] font-[530] leading-none text-v2-text-text-muted">
                      {language.t("scheduledTasks.section.conversation")}
                    </div>
                    <div class="grid gap-1.5 sm:grid-cols-2">
                      <For each={sessionOptions}>
                        {(option) => (
                          <ChoiceButton
                            selected={form.sessionMode === option.value}
                            title={option.label}
                            description={language.t(`scheduledTasks.session.${option.value}.description` as const)}
                            onClick={() => setForm("sessionMode", option.value)}
                          />
                        )}
                      </For>
                    </div>
                  </div>

                  <Show when={form.sessionMode === "existing"}>
                    <EditorField label={language.t("scheduledTasks.session.chooseExisting")}>
                      <SelectV2
                        options={sessionCandidates()}
                        value={(candidate) => candidate.id}
                        label={(candidate) => candidate.title || candidate.id}
                        current={sessionCandidates().find((candidate) => candidate.id === form.existingSessionID)}
                        onSelect={(candidate) => candidate && setForm("existingSessionID", candidate.id)}
                        placeholder={language.t("scheduledTasks.session.chooseExisting")}
                      />
                    </EditorField>
                  </Show>

                  <Show when={existing && (form.sessionMode === "reuse" || form.sessionMode === "auto")}>
                    <div class="flex min-w-0 items-center justify-between gap-2 rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-02 px-2.5 py-2">
                      <span class="min-w-0 truncate text-[10px] text-v2-text-text-muted">
                        {binding()?.sessionID
                          ? language.t("scheduledTasks.session.currentAnchor", { sessionID: binding()!.sessionID })
                          : language.t("scheduledTasks.session.noAnchor")}
                      </span>
                      <ButtonV2
                        type="button"
                        size="small"
                        variant="ghost-muted"
                        icon="reset"
                        disabled={!binding()?.sessionID}
                        onClick={() => existing && void store.clearBinding(existing.id).then(() => setBinding(null))}
                      >
                        {language.t("scheduledTasks.session.startFresh")}
                      </ButtonV2>
                    </div>
                  </Show>
                </EditorSection>

                <EditorSection
                  icon="execution"
                  title={language.t("scheduledTasks.section.execution")}
                  description={language.t("scheduledTasks.section.execution.description")}
                >
                  <div class="grid gap-3 sm:grid-cols-2">
                    <ScheduledTaskModelField
                      directory={form.targetDirectory}
                      providerID={form.modelProvider}
                      modelID={form.modelID}
                      variant={form.modelVariant}
                      onModel={(value) => {
                        setForm("modelProvider", value?.providerID ?? "")
                        setForm("modelID", value?.modelID ?? "")
                        setForm("modelVariant", "")
                      }}
                      onVariant={(value) => setForm("modelVariant", value)}
                    />
                    <div class="flex min-w-0 items-center justify-between gap-3 rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-02 px-2.5 py-2">
                      <div class="min-w-0">
                        <div class="text-[11px] font-[530] leading-4 text-v2-text-text-base">
                          {language.t("scheduledTasks.field.runAsGoal")}
                        </div>
                        <div class="text-[10px] leading-4 text-v2-text-text-muted">
                          {language.t("scheduledTasks.field.runAsGoalDescription")}
                        </div>
                      </div>
                      <Switch checked={form.runAsGoal} onChange={(checked) => setForm("runAsGoal", checked)} hideLabel>
                        {language.t("scheduledTasks.field.runAsGoal")}
                      </Switch>
                    </div>
                  </div>

                  <Show when={form.runAsGoal}>
                    <div class="grid gap-2 rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-02 p-2.5">
                      <EditorField label={language.t("scheduledTasks.field.goalTitle")} hint={language.t("scheduledTasks.editor.optional")}>
                        <TextInputV2 value={form.goalTitle} onInput={(event) => setForm("goalTitle", event.currentTarget.value)} />
                      </EditorField>
                      <EditorField label={language.t("scheduledTasks.field.goalObjective")}>
                        <TextareaV2 rows={3} value={form.goalObjective} onInput={(event) => setForm("goalObjective", event.currentTarget.value)} />
                      </EditorField>
                      <EditorField label={language.t("scheduledTasks.field.goalCriteria")}>
                        <TextareaV2 rows={3} value={form.goalCriteria} onInput={(event) => setForm("goalCriteria", event.currentTarget.value)} />
                      </EditorField>
                    </div>
                  </Show>
                </EditorSection>

                <EditorSection
                  icon="safety"
                  title={language.t("scheduledTasks.section.safety")}
                  description={language.t("scheduledTasks.section.safety.description")}
                >
                  <div class="grid gap-1.5 sm:grid-cols-3">
                    <For each={permissionOptions}>
                      {(option) => (
                        <ChoiceButton
                          selected={form.permission === option.value}
                          title={option.label}
                          description={
                            {
                              deny: language.t("scheduledTasks.permission.deny.description"),
                              pause: language.t("scheduledTasks.permission.pause.description"),
                              inherit: language.t("scheduledTasks.permission.inherit.description"),
                            }[option.value]
                          }
                          onClick={() => setForm("permission", option.value)}
                        />
                      )}
                    </For>
                  </div>

                  <Collapsible defaultOpen={false}>
                    <Collapsible.Trigger class="flex w-full items-center gap-2 rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-02 px-2.5 py-2 text-left transition-colors hover:bg-v2-overlay-simple-overlay-hover">
                      <Icon name="outline-sliders" size="small" class="size-3.5 shrink-0 text-v2-icon-icon-muted" />
                      <span class="min-w-0 flex-1">
                        <span class="block text-[11px] font-[530] leading-4 text-v2-text-text-base">
                          {language.t("scheduledTasks.field.advanced")}
                        </span>
                        <span class="block truncate text-[10px] leading-4 text-v2-text-text-muted">
                          {language.t("scheduledTasks.advanced.summary", {
                            catchUp: catchUpOptions.find((option) => option.value === form.catchUp)?.label ?? form.catchUp,
                            overrun: overrunOptions.find((option) => option.value === form.overrun)?.label ?? form.overrun,
                            notify: notifySummary(),
                          })}
                        </span>
                      </span>
                      <Collapsible.Arrow />
                    </Collapsible.Trigger>
                    <Collapsible.Content class="pt-2">
                      <div class="grid gap-2 rounded-md border border-v2-border-border-muted bg-v2-background-bg-base p-2.5 sm:grid-cols-2">
                        <EditorField label={language.t("scheduledTasks.field.catchUp")}>
                          <SelectV2
                            options={catchUpOptions}
                            value={optionValue}
                            label={optionLabel}
                            current={catchUpOptions.find((option) => option.value === form.catchUp)}
                            onSelect={(option) => option && setForm("catchUp", option.value)}
                          />
                        </EditorField>
                        <EditorField label={language.t("scheduledTasks.field.catchUpMaxAge")}>
                          <TextInputV2
                            type="number"
                            numeric
                            value={form.catchUpMaxAgeMs}
                            onInput={(event) => setForm("catchUpMaxAgeMs", event.currentTarget.value)}
                          />
                        </EditorField>
                        <EditorField label={language.t("scheduledTasks.field.overrun")}>
                          <SelectV2
                            options={overrunOptions}
                            value={optionValue}
                            label={optionLabel}
                            current={overrunOptions.find((option) => option.value === form.overrun)}
                            onSelect={(option) => option && setForm("overrun", option.value)}
                          />
                        </EditorField>
                        <EditorField label={language.t("scheduledTasks.field.jitter")}>
                          <TextInputV2
                            type="number"
                            numeric
                            value={form.jitterMs}
                            onInput={(event) => setForm("jitterMs", event.currentTarget.value)}
                          />
                        </EditorField>
                        <EditorField label={language.t("scheduledTasks.field.maxAttempts")}>
                          <TextInputV2
                            type="number"
                            numeric
                            value={form.maxAttempts}
                            onInput={(event) => setForm("maxAttempts", event.currentTarget.value)}
                          />
                        </EditorField>
                        <EditorField label={language.t("scheduledTasks.field.maxDuration")}>
                          <TextInputV2
                            type="number"
                            numeric
                            value={form.maxDurationMs}
                            onInput={(event) => setForm("maxDurationMs", event.currentTarget.value)}
                          />
                        </EditorField>
                        <EditorField label={language.t("scheduledTasks.field.retention")}>
                          <TextInputV2
                            type="number"
                            numeric
                            value={form.retentionRuns}
                            onInput={(event) => setForm("retentionRuns", event.currentTarget.value)}
                          />
                        </EditorField>
                        <EditorField label={language.t("scheduledTasks.field.notify")}>
                          <SelectV2
                            options={notifyOptions}
                            value={optionValue}
                            label={optionLabel}
                            current={notifyOptions.find((option) => option.value === form.notify)}
                            onSelect={(option) => option && setForm("notify", option.value)}
                          />
                        </EditorField>
                      </div>
                    </Collapsible.Content>
                  </Collapsible>
                </EditorSection>
              </main>

              <aside class="min-w-0 lg:sticky lg:top-3">
                <div class="overflow-hidden rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-01">
                  <div class="border-b border-v2-border-border-muted p-3">
                    <div class="flex items-start gap-2.5">
                      <div class="flex size-7 shrink-0 items-center justify-center rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-02 text-v2-icon-icon-muted">
                        <AutomationIcon name="summary" class="size-3.5" />
                      </div>
                      <div class="min-w-0 flex-1">
                        <div class="text-[12px] font-[530] leading-4 text-v2-text-text-base">
                          {language.t("scheduledTasks.summary.title")}
                        </div>
                        <div class="mt-0.5 text-[10px] leading-4 text-v2-text-text-muted">
                          {language.t("scheduledTasks.summary.description")}
                        </div>
                      </div>
                    </div>
                    <div
                      class="mt-2.5 flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-[10px] font-[530]"
                      classList={{
                        "border-v2-border-border-muted bg-v2-background-bg-layer-02 text-v2-text-text-base": !validation(),
                        "border-v2-border-border-muted bg-v2-background-bg-base text-v2-text-text-muted": !!validation(),
                      }}
                    >
                      <Icon name={validation() ? "warning" : "check"} size="small" class="size-3 shrink-0" />
                      <span class="min-w-0 truncate">
                        {validation()
                          ? language.t("scheduledTasks.summary.incomplete")
                          : language.t("scheduledTasks.summary.ready")}
                      </span>
                    </div>
                  </div>

                  <div class="divide-y divide-v2-border-border-muted px-3">
                    <SummaryRow label={language.t("scheduledTasks.summary.schedule")} value={scheduleSummary()} />
                    <SummaryRow
                      label={language.t("scheduledTasks.summary.workspace")}
                      value={workspaceSummary()}
                      mono={!!form.targetDirectory.trim()}
                    />
                    <SummaryRow label={language.t("scheduledTasks.isolation.label")} value={isolationSummary()} />
                    <SummaryRow label={language.t("scheduledTasks.section.conversation")} value={sessionSummary()} />
                    <SummaryRow label={language.t("scheduledTasks.summary.runtime")} value={runtimeSummary()} />
                    <SummaryRow label={language.t("scheduledTasks.summary.permissions")} value={permissionSummary()} />
                    <SummaryRow label={language.t("scheduledTasks.summary.notifications")} value={notifySummary()} />
                  </div>

                  <div class="border-t border-v2-border-border-muted p-3">
                    <div class="mb-2 flex items-center justify-between gap-2">
                      <span class="text-[10px] font-[530] uppercase tracking-[0.06em] text-v2-text-text-faint">
                        {language.t("scheduledTasks.summary.nextRuns")}
                      </span>
                      <Show when={previewPending()}>
                        <span class="text-[10px] text-v2-text-text-faint">
                          {language.t("scheduledTasks.preview.loading")}
                        </span>
                      </Show>
                    </div>

                    <Show
                      when={!previewError() && nextRuns().length > 0}
                      fallback={
                        <div class="rounded-md border border-dashed border-v2-border-border-muted px-2.5 py-2 text-[10px] leading-4 text-v2-text-text-muted">
                          {previewError()
                            ? language.t("scheduledTasks.preview.failed")
                            : language.t("scheduledTasks.summary.previewUnavailable")}
                        </div>
                      }
                    >
                      <div class="flex flex-col gap-1">
                        <For each={nextRuns()}>
                          {(instant, index) => (
                            <div class="flex items-center gap-2 rounded-md bg-v2-background-bg-layer-02 px-2 py-1.5">
                              <span class="flex size-5 shrink-0 items-center justify-center rounded border border-v2-border-border-muted text-v2-icon-icon-muted">
                                <Icon name="clock" size="small" class="size-3" />
                              </span>
                              <div class="min-w-0 flex-1">
                                <div class="truncate text-[10px] font-[530] leading-4 text-v2-text-text-base">
                                  {new Date(Number(instant)).toLocaleString()}
                                </div>
                                <div class="text-[9px] leading-3 text-v2-text-text-faint">
                                  {language.t("scheduledTasks.summary.runNumber", { count: index() + 1 })}
                                </div>
                              </div>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>

                    <Show when={preview()?.warnings?.length}>
                      <div class="mt-2 flex flex-col gap-1">
                        <For each={preview()?.warnings ?? []}>
                          {(warning) => (
                            <div class="flex items-start gap-1.5 text-[10px] leading-4 text-v2-text-text-muted">
                              <Icon name="warning" size="small" class="mt-0.5 size-3 shrink-0" />
                              <span>{warning}</span>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                </div>
              </aside>
            </div>
          </ScrollView>
        </DialogBody>

        <DialogFooter>
          <div class="mr-auto flex min-w-0 flex-1 items-center gap-2">
            <Show
              when={error()}
              fallback={
                <Show when={validation()}>
                  {(problem) => (
                    <>
                      <Icon name="warning" size="small" class="size-3.5 shrink-0 text-v2-icon-icon-muted" />
                      <span class="min-w-0 truncate text-[11px] text-v2-text-text-muted">{problem()}</span>
                    </>
                  )}
                </Show>
              }
            >
              {(message) => (
                <>
                  <Icon name="warning" size="small" class="size-3.5 shrink-0 text-v2-icon-icon-muted" />
                  <span class="min-w-0 truncate text-[11px] text-v2-text-text-base" role="alert">
                    {message()}
                  </span>
                </>
              )}
            </Show>
          </div>
          <ButtonV2 type="button" variant="neutral" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2
            type="submit"
            variant={saving() ? "loading" : "contrast"}
            disabled={!!validation() || saving()}
          >
            {existing ? language.t("common.save") : language.t("scheduledTasks.create")}
          </ButtonV2>
        </DialogFooter>
      </form>
    </Dialog>
  )
}
