import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
} from "solid-js"
import { createStore } from "solid-js/store"
import { Schema } from "effect"
import type {
  SwarmBlackboardEntry,
  SwarmClaim,
  SwarmDeliverable,
  SwarmHttpApiMessageHistoryEntry,
  SwarmMember,
  SwarmMemberExecutionProfile,
  SwarmStatus,
  SwarmTask,
  SwarmTaskRun,
  SwarmWorkspacePolicy,
} from "@opencode-ai/sdk/v2/client"
import { Swarm as SwarmSchema } from "@opencode-ai/schema/swarm"
import type { Phase as SessionTelemetryPhase } from "@opencode-ai/schema/session-telemetry"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import {
  loadSwarmPanelCore,
  loadSwarmPanelHistory,
  loadSwarmPanelMemory,
  loadSwarmPanelBlackboardPage,
  loadSwarmPanelClaimPage,
  loadSwarmPanelDeliverablePage,
  loadSwarmPanelMessagePage,
  loadSwarmPanelRunPage,
  indexSwarmPanelDetail,
} from "./swarm-panel-data"
import {
  swarmPanelEventInvalidations,
  type SwarmPanelInvalidation,
} from "./swarm-panel-events"

type PanelSection = "overview" | "tasks" | "memory" | "history"

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message
  return undefined
}

export function SwarmPanel(props: { swarmID: string; onClose: () => void }) {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const [section, setSection] = createSignal<PanelSection>("overview")
  const [mutating, setMutating] = createSignal(false)
  const reportLoadError = (error: unknown) =>
    showToast({
      variant: "error",
      title: language.t("swarm.panel.loadFailed"),
      description: errorMessage(error),
    })

  const [core, { refetch: refetchCore }] = createResource(
    () => props.swarmID,
    (swarmID) => loadSwarmPanelCore(serverSDK().client.swarm, swarmID),
  )

  const detail = createMemo(() => core()?.detail)
  const summary = createMemo(() => core()?.summary)
  const index = createMemo(() => indexSwarmPanelDetail(detail()))
  const members = createMemo(() => index().memberByID)
  const tasks = createMemo(() => index().taskByID)

  createEffect(() => {
    const ids = new Set(
      (detail()?.members ?? []).flatMap((member) => (member.sessionID ? [member.sessionID] : [])),
    )
    if (ids.size > 0) serverSync().telemetry.ensure(ids)
  })

  const [memory, setMemory] = createStore({
    loaded: false,
    loading: false,
    blackboard: [] as SwarmBlackboardEntry[],
    blackboardCursor: undefined as string | undefined,
    blackboardMore: false,
    claims: [] as SwarmClaim[],
    claimsCursor: undefined as string | undefined,
    claimsMore: false,
    deliverables: [] as SwarmDeliverable[],
    deliverablesCursor: undefined as string | undefined,
    deliverablesMore: false,
  })

  const loadMemory = async (reset = true) => {
    if (memory.loading) return
    setMemory("loading", true)
    try {
      const pages = await loadSwarmPanelMemory(serverSDK().client.swarm, {
        swarmID: props.swarmID,
        ...(reset || !memory.blackboardCursor ? {} : { blackboardCursor: memory.blackboardCursor }),
        ...(reset || !memory.claimsCursor ? {} : { claimsCursor: memory.claimsCursor }),
        ...(reset || !memory.deliverablesCursor ? {} : { deliverablesCursor: memory.deliverablesCursor }),
      })
      const blackboardPage = pages.blackboard
      const claimPage = pages.claims
      const deliverablePage = pages.deliverables
      setMemory({
        loaded: true,
        loading: false,
        blackboard: reset ? (blackboardPage?.items ?? []) : [...memory.blackboard, ...(blackboardPage?.items ?? [])],
        blackboardCursor: blackboardPage?.nextCursor,
        blackboardMore: blackboardPage?.more ?? false,
        claims: reset ? (claimPage?.items ?? []) : [...memory.claims, ...(claimPage?.items ?? [])],
        claimsCursor: claimPage?.nextCursor,
        claimsMore: claimPage?.more ?? false,
        deliverables: reset
          ? (deliverablePage?.items ?? [])
          : [...memory.deliverables, ...(deliverablePage?.items ?? [])],
        deliverablesCursor: deliverablePage?.nextCursor,
        deliverablesMore: deliverablePage?.more ?? false,
      })
    } catch (error) {
      setMemory("loading", false)
      reportLoadError(error)
    }
  }

  const loadMoreBlackboard = async () => {
    if (!memory.blackboardMore || !memory.blackboardCursor || memory.loading) return
    setMemory("loading", true)
    try {
      const page = await loadSwarmPanelBlackboardPage(serverSDK().client.swarm, props.swarmID, memory.blackboardCursor)
      setMemory("blackboard", [...memory.blackboard, ...page.items])
      setMemory("blackboardCursor", page.nextCursor)
      setMemory("blackboardMore", page.more)
    } catch (error) {
      reportLoadError(error)
    } finally {
      setMemory("loading", false)
    }
  }
  const loadMoreClaims = async () => {
    if (!memory.claimsMore || !memory.claimsCursor || memory.loading) return
    setMemory("loading", true)
    try {
      const page = await loadSwarmPanelClaimPage(serverSDK().client.swarm, props.swarmID, memory.claimsCursor)
      setMemory("claims", [...memory.claims, ...page.items])
      setMemory("claimsCursor", page.nextCursor)
      setMemory("claimsMore", page.more)
    } catch (error) {
      reportLoadError(error)
    } finally {
      setMemory("loading", false)
    }
  }
  const loadMoreDeliverables = async () => {
    if (!memory.deliverablesMore || !memory.deliverablesCursor || memory.loading) return
    setMemory("loading", true)
    try {
      const page = await loadSwarmPanelDeliverablePage(
        serverSDK().client.swarm,
        props.swarmID,
        memory.deliverablesCursor,
      )
      setMemory("deliverables", [...memory.deliverables, ...page.items])
      setMemory("deliverablesCursor", page.nextCursor)
      setMemory("deliverablesMore", page.more)
    } catch (error) {
      reportLoadError(error)
    } finally {
      setMemory("loading", false)
    }
  }

  const [history, setHistory] = createStore({
    loaded: false,
    loading: false,
    messages: [] as SwarmHttpApiMessageHistoryEntry[],
    messageCursor: undefined as string | undefined,
    messageMore: false,
    runs: [] as SwarmTaskRun[],
    runCursor: undefined as string | undefined,
    runMore: false,
  })

  const loadHistory = async (reset = true) => {
    if (history.loading) return
    setHistory("loading", true)
    try {
      const pages = await loadSwarmPanelHistory(serverSDK().client.swarm, {
        swarmID: props.swarmID,
        ...(reset || !history.messageCursor ? {} : { messageCursor: history.messageCursor }),
        ...(reset || !history.runCursor ? {} : { runCursor: history.runCursor }),
      })
      const messagePage = pages.messages
      const runPage = pages.runs
      setHistory({
        loaded: true,
        loading: false,
        messages: reset ? (messagePage?.items ?? []) : [...history.messages, ...(messagePage?.items ?? [])],
        messageCursor: messagePage?.nextCursor,
        messageMore: messagePage?.more ?? false,
        runs: reset ? (runPage?.items ?? []) : [...history.runs, ...(runPage?.items ?? [])],
        runCursor: runPage?.nextCursor,
        runMore: runPage?.more ?? false,
      })
    } catch (error) {
      setHistory("loading", false)
      reportLoadError(error)
    }
  }

  const loadMoreMessages = async () => {
    if (!history.messageMore || !history.messageCursor || history.loading) return
    setHistory("loading", true)
    try {
      const page = await loadSwarmPanelMessagePage(serverSDK().client.swarm, props.swarmID, history.messageCursor)
      setHistory("messages", [...history.messages, ...page.items])
      setHistory("messageCursor", page.nextCursor)
      setHistory("messageMore", page.more)
    } catch (error) {
      reportLoadError(error)
    } finally {
      setHistory("loading", false)
    }
  }
  const loadMoreRuns = async () => {
    if (!history.runMore || !history.runCursor || history.loading) return
    setHistory("loading", true)
    try {
      const page = await loadSwarmPanelRunPage(serverSDK().client.swarm, props.swarmID, history.runCursor)
      setHistory("runs", [...history.runs, ...page.items])
      setHistory("runCursor", page.nextCursor)
      setHistory("runMore", page.more)
    } catch (error) {
      reportLoadError(error)
    } finally {
      setHistory("loading", false)
    }
  }

  createEffect(() => {
    if (section() === "memory" && !memory.loaded && !memory.loading) void loadMemory(true)
    if (section() === "history" && !history.loaded && !history.loading) void loadHistory(true)
  })

  // One event subscription while the panel is mounted. Core/detail events,
  // explicit history and shared-state pages each have their own coalesced
  // invalidation lane so a delivery burst cannot produce one request per event.
  createEffect(() => {
    const sdk = serverSDK()
    const queued = new Set<SwarmPanelInvalidation>()
    let scheduled = false
    const flush = () => {
      scheduled = false
      const work = [...queued]
      queued.clear()
      if (work.includes("core")) void refetchCore()
      if (work.includes("memory") && memory.loaded) void loadMemory(true)
      if (work.includes("history") && history.loaded) void loadHistory(true)
    }
    const unsubscribe = sdk.event.listen((envelope) => {
      const event = envelope.details
      const swarmID = (event.properties as { swarmID?: string } | undefined)?.swarmID
      if (swarmID !== props.swarmID) return
      for (const target of swarmPanelEventInvalidations(event.type)) queued.add(target)
      if (queued.size === 0 || scheduled) return
      scheduled = true
      queueMicrotask(flush)
    })
    onCleanup(unsubscribe)
  })

  const action = async (operation: () => Promise<unknown>, success?: string) => {
    if (mutating()) return
    setMutating(true)
    try {
      await operation()
      await refetchCore()
      if (success) showToast({ title: success })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("swarm.panel.actionFailed"),
        description: errorMessage(error),
      })
    } finally {
      setMutating(false)
    }
  }

  const setSwarmStatus = (status: "active" | "paused") => {
    const current = detail()?.swarm
    if (!current) return
    void action(() =>
      serverSDK().client.swarm.update(
        { swarmID: current.id, expectedRevision: current.revision, status },
        { throwOnError: true },
      ),
    )
  }

  const recoverMembers = () => {
    void action(async () => {
      const response = await serverSDK().client.swarm.recover({ swarmID: props.swarmID }, { throwOnError: true })
      showToast({
        title: response.data?.requested
          ? language.t("swarm.panel.recoveryRequested")
          : language.t("swarm.panel.recoveryDeferred"),
      })
    })
  }

  const setMemberLifecycle = (member: SwarmMember, lifecycle: "active" | "stopped") => {
    if (member.lifecycle !== "active" && member.lifecycle !== "stopped") return
    const expectedLifecycle = member.lifecycle
    void action(() =>
      serverSDK().client.swarm.memberLifecycle(
        {
          swarmID: props.swarmID,
          memberID: member.id,
          expectedLifecycle,
          lifecycle,
        },
        { throwOnError: true },
      ),
    )
  }

  const [configMemberID, setConfigMemberID] = createSignal<string>()
  const [config, setConfig] = createStore({
    agent: "",
    providerID: "",
    modelID: "",
    accountID: undefined as string | undefined,
    variant: "",
    workspaceMode: "shared-read" as "shared-read" | "shared-write" | "worktree",
    baseRef: "",
    tags: "",
    modelRequirements: "",
  })
  const configMember = createMemo(() => detail()?.members.find((member) => member.id === configMemberID()))
  const beginConfigure = (member: SwarmMember) => {
    const profile = member.desiredProfile
    if (!profile) return
    setConfig({
      agent: profile.agent,
      providerID: profile.model.providerID,
      modelID: profile.model.id,
      accountID: profile.model.accountID,
      variant: profile.model.variant ?? "",
      workspaceMode: member.workspacePolicy.mode,
      baseRef: member.workspacePolicy.mode === "worktree" ? (member.workspacePolicy.baseRef ?? "") : "",
      tags: member.capabilities?.tags.join(", ") ?? "",
      modelRequirements: profile.modelRequirements?.join(", ") ?? "",
    })
    setConfigMemberID(member.id)
  }

  const [modelCatalog] = createResource(
    () => (configMemberID() ? true : undefined),
    async () => (await serverSDK().client.providerSettings.models({ throwOnError: true })).data?.models ?? [],
  )

  const saveConfiguration = () => {
    const member = configMember()
    const previous = member?.desiredProfile
    if (!member || !previous) return
    const modelRequirements = config.modelRequirements.split(",").map((item) => item.trim()).filter(Boolean)
    const isModelRequirement = Schema.is(SwarmSchema.ModelRequirement)
    const invalidRequirements = modelRequirements.filter((item) => !isModelRequirement(item))
    if (invalidRequirements.length > 0) {
      showToast({
        variant: "error",
        title: language.t("swarm.panel.loadFailed"),
        description: `Unknown model requirements: ${invalidRequirements.join(", ")}`,
      })
      return
    }
    const workspacePolicy: SwarmWorkspacePolicy =
      config.workspaceMode === "worktree"
        ? { mode: "worktree", ...(config.baseRef.trim() ? { baseRef: config.baseRef.trim() } : {}) }
        : { mode: config.workspaceMode }
    const desiredProfile: SwarmMemberExecutionProfile = {
      agent: config.agent.trim(),
      model: {
        providerID: config.providerID.trim(),
        id: config.modelID.trim(),
        ...(config.accountID ? { accountID: config.accountID } : {}),
        ...(config.variant.trim() ? { variant: config.variant.trim() } : {}),
      },
      permissionBoundary: previous.permissionBoundary,
      ...(modelRequirements.length > 0
        ? { modelRequirements: modelRequirements.filter(isModelRequirement) }
        : {}),
    }
    void action(async () => {
      await serverSDK().client.swarm.memberConfigure(
        {
          swarmID: props.swarmID,
          memberID: member.id,
          expectedBindingGeneration: member.bindingGeneration,
          desiredProfile,
          workspacePolicy,
          capabilities: { tags: config.tags.split(",").map((item) => item.trim()).filter(Boolean) },
        },
        { throwOnError: true },
      )
      setConfigMemberID(undefined)
    })
  }

  const [addingMember, setAddingMember] = createSignal(false)
  const [newMember, setNewMember] = createStore({
    name: "",
    role: "",
    agent: "build",
    providerID: "",
    modelID: "",
    workspaceMode: "shared-read" as "shared-read" | "shared-write" | "worktree",
  })
  const addMember = () => {
    if (!newMember.name.trim() || !newMember.role.trim() || !newMember.providerID.trim() || !newMember.modelID.trim()) return
    void action(async () => {
      await serverSDK().client.swarm.memberAdd(
        {
          swarmID: props.swarmID,
          name: newMember.name.trim(),
          role: newMember.role.trim(),
          desiredProfile: {
            agent: newMember.agent.trim() || "build",
            model: { providerID: newMember.providerID.trim(), id: newMember.modelID.trim() },
            permissionBoundary: [],
          },
          workspacePolicy: { mode: newMember.workspaceMode },
        },
        { throwOnError: true },
      )
      setNewMember({ name: "", role: "", agent: "build", providerID: "", modelID: "", workspaceMode: "shared-read" })
      setAddingMember(false)
    })
  }

  const [creatingTask, setCreatingTask] = createSignal(false)
  const [newTask, setNewTask] = createStore({
    title: "",
    description: "",
    priority: "0",
    reservedMemberID: "",
  })
  const createTask = () => {
    if (!newTask.title.trim()) return
    void action(async () => {
      await serverSDK().client.swarm.taskCreate(
        {
          swarmID: props.swarmID,
          title: newTask.title.trim(),
          ...(newTask.description.trim() ? { description: newTask.description.trim() } : {}),
          priority: Number.isFinite(Number(newTask.priority)) ? Math.trunc(Number(newTask.priority)) : 0,
          ...(newTask.reservedMemberID ? { reservedMemberID: newTask.reservedMemberID } : {}),
          dependencies: [],
        },
        { throwOnError: true },
      )
      setNewTask({ title: "", description: "", priority: "0", reservedMemberID: "" })
      setCreatingTask(false)
    })
  }

  const statusLabel = (status: SwarmStatus) => {
    switch (status) {
      case "creating": return language.t("swarm.status.creating")
      case "active": return language.t("swarm.status.active")
      case "paused": return language.t("swarm.status.paused")
      case "stopping": return language.t("swarm.status.stopping")
      case "completed": return language.t("swarm.status.completed")
      case "failed": return language.t("swarm.status.failed")
      case "archived": return language.t("swarm.status.archived")
    }
  }
  const memberLifecycle = (value: SwarmMember["lifecycle"]) => {
    switch (value) {
      case "active": return language.t("swarm.member.lifecycle.active")
      case "held": return language.t("swarm.member.lifecycle.held")
      case "stopping": return language.t("swarm.member.lifecycle.stopping")
      case "stopped": return language.t("swarm.member.lifecycle.stopped")
    }
  }
  const memberKind = (value: SwarmMember["kind"]) => {
    switch (value) {
      case "coordinator": return language.t("swarm.member.kind.coordinator")
      case "managed_worker": return language.t("swarm.member.kind.managed_worker")
      case "external": return language.t("swarm.member.kind.external")
      case "guest": return language.t("swarm.member.kind.guest")
    }
  }
  const taskStatus = (value: SwarmTask["status"]) => {
    switch (value) {
      case "pending": return language.t("swarm.task.status.pending")
      case "blocked": return language.t("swarm.task.status.blocked")
      case "ready": return language.t("swarm.task.status.ready")
      case "working": return language.t("swarm.task.status.working")
      case "review_pending": return language.t("swarm.task.status.review_pending")
      case "changes_requested": return language.t("swarm.task.status.changes_requested")
      case "completed": return language.t("swarm.task.status.completed")
      case "failed": return language.t("swarm.task.status.failed")
      case "cancelled": return language.t("swarm.task.status.cancelled")
    }
  }
  const telemetryPhase = (value: SessionTelemetryPhase | undefined) => {
    switch (value) {
      case "idle": return language.t("swarm.telemetry.idle")
      case "requesting": return language.t("swarm.telemetry.requesting")
      case "reasoning": return language.t("swarm.telemetry.reasoning")
      case "generating": return language.t("swarm.telemetry.generating")
      case "tool": return language.t("swarm.telemetry.tool")
      case "retrying": return language.t("swarm.telemetry.retrying")
      default: return language.t("swarm.panel.unbound")
    }
  }

  const PanelButton = (button: { active: boolean; label: string; onClick: () => void }) => (
    <button
      type="button"
      class="h-7 rounded-md px-2 text-[10px] font-[560] uppercase tracking-[0.04em] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-v2-border-border-base"
      classList={{
        "bg-v2-background-bg-layer-03 text-v2-text-text-base": button.active,
        "text-v2-text-text-faint hover:bg-v2-background-bg-layer-01 hover:text-v2-text-text-muted": !button.active,
      }}
      onClick={button.onClick}
    >
      {button.label}
    </button>
  )

  return (
    <aside
      id="swarm-panel"
      class="flex h-full min-h-0 w-[390px] shrink-0 flex-col border-s border-v2-border-border-base bg-v2-background-bg-base"
      data-swarm-panel
    >
      <div class="flex h-10 shrink-0 items-center gap-2 border-b border-v2-border-border-base px-2.5">
        <div class="flex size-6 items-center justify-center rounded-md bg-v2-background-bg-layer-02 text-v2-icon-icon-muted">
          <IconV2 name="layers" size="small" />
        </div>
        <div class="min-w-0 flex-1">
          <div class="truncate text-[11px] font-[600] leading-tight text-v2-text-text-base">
            {detail()?.swarm.name ?? language.t("swarm.panel.title")}
          </div>
          <div class="text-[9px] font-[540] uppercase tracking-[0.06em] text-v2-text-text-faint">
            <Show when={detail()?.swarm}>{(swarm) => statusLabel(swarm().status)}</Show>
          </div>
        </div>
        <Show when={detail()?.swarm.status === "active"}>
          <button
            type="button"
            disabled={mutating()}
            class="h-6 rounded-md px-2 text-[10px] text-v2-text-text-muted hover:bg-v2-background-bg-layer-02 disabled:opacity-50"
            onClick={() => setSwarmStatus("paused")}
          >
            {language.t("swarm.panel.pause")}
          </button>
        </Show>
        <Show when={detail()?.swarm.status === "paused"}>
          <button
            type="button"
            disabled={mutating()}
            class="h-6 rounded-md px-2 text-[10px] text-v2-text-text-muted hover:bg-v2-background-bg-layer-02 disabled:opacity-50"
            onClick={() => setSwarmStatus("active")}
          >
            {language.t("swarm.panel.resume")}
          </button>
        </Show>
        <TooltipV2 value={language.t("swarm.panel.refresh")}>
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="small"
            aria-label={language.t("swarm.panel.refresh")}
            onClick={() => void refetchCore()}
            icon={<IconV2 name="refresh" />}
          />
        </TooltipV2>
        <TooltipV2 value={language.t("swarm.panel.close")}>
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="small"
            aria-label={language.t("swarm.panel.close")}
            onClick={props.onClose}
            icon={<IconV2 name="close" />}
          />
        </TooltipV2>
      </div>

      <Show
        when={core()}
        fallback={
          <div class="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-[11px] text-v2-text-text-muted">
            {core.error ? language.t("swarm.panel.loadFailed") : language.t("swarm.panel.loading")}
          </div>
        }
      >
        <div class="grid shrink-0 grid-cols-4 gap-px border-b border-v2-border-border-base bg-v2-border-border-base">
          <Stat label={language.t("swarm.panel.stat.members")} value={summary()?.memberCount ?? 0} />
          <Stat label={language.t("swarm.panel.stat.ready")} value={summary()?.readyTaskCount ?? 0} />
          <Stat label={language.t("swarm.panel.stat.working")} value={summary()?.workingTaskCount ?? 0} />
          <Stat label={language.t("swarm.panel.stat.delivery")} value={summary()?.pendingDeliveryCount ?? 0} />
        </div>

        <div class="flex h-9 shrink-0 items-center gap-1 border-b border-v2-border-border-base px-2">
          <PanelButton active={section() === "overview"} label={language.t("swarm.panel.overview")} onClick={() => setSection("overview")} />
          <PanelButton active={section() === "tasks"} label={language.t("swarm.panel.tasks")} onClick={() => setSection("tasks")} />
          <PanelButton active={section() === "memory"} label={language.t("swarm.panel.memory")} onClick={() => setSection("memory")} />
          <PanelButton active={section() === "history"} label={language.t("swarm.panel.history")} onClick={() => setSection("history")} />
        </div>

        <ScrollView class="min-h-0 flex-1">
          <div class="flex flex-col gap-3 p-2.5">
            <Show when={section() === "overview"}>
              <div class="flex items-center justify-between">
                <SectionTitle>{language.t("swarm.panel.members")}</SectionTitle>
                <div class="flex items-center gap-1">
                  <button type="button" class="panel-action" onClick={recoverMembers} disabled={mutating()}>
                    {language.t("swarm.panel.recover")}
                  </button>
                  <button type="button" class="panel-action" onClick={() => setAddingMember((value) => !value)}>
                    {language.t("swarm.panel.addMember")}
                  </button>
                </div>
              </div>

              <Show when={addingMember()}>
                <div class="rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-01 p-2">
                  <div class="grid grid-cols-2 gap-2">
                    <Field label={language.t("swarm.panel.memberName")} value={newMember.name} onInput={(value) => setNewMember("name", value)} />
                    <Field label={language.t("swarm.panel.memberRole")} value={newMember.role} onInput={(value) => setNewMember("role", value)} />
                    <Field label={language.t("swarm.panel.agent")} value={newMember.agent} onInput={(value) => setNewMember("agent", value)} />
                    <Field label={language.t("swarm.panel.provider")} value={newMember.providerID} onInput={(value) => setNewMember("providerID", value)} />
                    <Field label={language.t("swarm.panel.model")} value={newMember.modelID} onInput={(value) => setNewMember("modelID", value)} />
                    <label class="flex flex-col gap-1">
                      <span class="text-[9px] font-[550] uppercase tracking-[0.05em] text-v2-text-text-faint">{language.t("swarm.panel.workspace")}</span>
                      <select class="panel-input" value={newMember.workspaceMode} onChange={(event) => setNewMember("workspaceMode", event.currentTarget.value as typeof newMember.workspaceMode)}>
                        <option value="shared-read">{language.t("swarm.panel.workspace.sharedRead")}</option>
                        <option value="shared-write">{language.t("swarm.panel.workspace.sharedWrite")}</option>
                        <option value="worktree">{language.t("swarm.panel.workspace.worktree")}</option>
                      </select>
                    </label>
                  </div>
                  <div class="mt-2 flex justify-end gap-1">
                    <button type="button" class="panel-action" onClick={() => setAddingMember(false)}>{language.t("swarm.panel.cancel")}</button>
                    <button type="button" class="panel-action-primary" disabled={mutating()} onClick={addMember}>{language.t("swarm.panel.addMember")}</button>
                  </div>
                </div>
              </Show>

              <Show when={(detail()?.members.length ?? 0) > 0} fallback={<Empty>{language.t("swarm.panel.noMembers")}</Empty>}>
                <div class="flex flex-col gap-1.5">
                  <For each={detail()?.members ?? []}>
                    {(member) => {
                      const telemetry = () => member.sessionID ? serverSync().telemetry.get(member.sessionID) : undefined
                      const currentModel = () => telemetry()?.model ?? telemetry()?.context?.model
                      const permissionCount = () => member.sessionID ? (serverSync().session.data.permission[member.sessionID]?.length ?? 0) : 0
                      const questionCount = () => member.sessionID ? (serverSync().session.data.question[member.sessionID]?.length ?? 0) : 0
                      const configurable = () => member.kind === "managed_worker" && member.lifecycle === "stopped" && !member.sessionID
                      return (
                        <div class="rounded-lg border border-v2-border-border-base/70 bg-v2-background-bg-layer-01 p-2">
                          <div class="flex items-start gap-2">
                            <div class="mt-1 size-2 shrink-0 rounded-full bg-v2-icon-icon-muted" classList={{ "animate-pulse bg-v2-state-fg-success": telemetry()?.phase !== undefined && telemetry()?.phase !== "idle" }} />
                            <div class="min-w-0 flex-1">
                              <div class="flex items-center gap-1.5">
                                <span class="truncate text-[11px] font-[600] text-v2-text-text-base">{member.name}</span>
                                <span class="rounded bg-v2-background-bg-layer-03 px-1 py-0.5 text-[8px] font-[600] uppercase tracking-[0.04em] text-v2-text-text-faint">{memberKind(member.kind)}</span>
                              </div>
                              <div class="mt-0.5 truncate text-[10px] text-v2-text-text-muted">{member.role}</div>
                              <div class="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[9px] text-v2-text-text-faint">
                                <span>{memberLifecycle(member.lifecycle)}</span>
                                <span>{telemetryPhase(telemetry()?.phase)}</span>
                                <Show when={member.desiredProfile}><span>{language.t("swarm.panel.desiredModel")}: {member.desiredProfile!.model.providerID}/{member.desiredProfile!.model.id}</span></Show>
                                <Show when={currentModel()}>{(model) => <span>{language.t("swarm.panel.currentSessionModel")}: {model().providerID}/{model().modelID}</span>}</Show>
                                <Show when={permissionCount() > 0}><span>{language.t("swarm.panel.permissions")}: {permissionCount()}</span></Show>
                                <Show when={questionCount() > 0}><span>{language.t("swarm.panel.questions")}: {questionCount()}</span></Show>
                              </div>
                            </div>
                            <Show when={member.kind === "managed_worker"}>
                              <div class="flex shrink-0 items-center gap-1">
                                <Show when={member.lifecycle === "active"}>
                                  <button type="button" class="panel-action" disabled={mutating()} onClick={() => setMemberLifecycle(member, "stopped")}>{language.t("swarm.panel.stop")}</button>
                                </Show>
                                <Show when={member.lifecycle === "stopped"}>
                                  <button type="button" class="panel-action" disabled={mutating()} onClick={() => setMemberLifecycle(member, "active")}>{language.t("swarm.panel.resumeMember")}</button>
                                </Show>
                                <button type="button" class="panel-action" disabled={!configurable()} onClick={() => beginConfigure(member)}>{language.t("swarm.panel.configure")}</button>
                              </div>
                            </Show>
                          </div>

                          <Show when={configMemberID() === member.id && configMember()}>
                            <div class="mt-2 border-t border-v2-border-border-muted/50 pt-2">
                              <p class="mb-2 text-[9px] leading-relaxed text-v2-text-text-faint">{language.t("swarm.panel.profileStoppedHint")}</p>
                              <div class="grid grid-cols-2 gap-2">
                                <Field label={language.t("swarm.panel.agent")} value={config.agent} onInput={(value) => setConfig("agent", value)} />
                                <label class="flex flex-col gap-1">
                                  <span class="text-[9px] font-[550] uppercase tracking-[0.05em] text-v2-text-text-faint">{language.t("swarm.panel.model")}</span>
                                  <select
                                    class="panel-input"
                                    value={JSON.stringify([config.providerID, config.modelID])}
                                    onChange={(event) => {
                                      if (!event.currentTarget.value) return
                                      const [providerID, modelID] = JSON.parse(event.currentTarget.value) as [string, string]
                                      setConfig({ providerID, modelID })
                                    }}
                                  >
                                    <Show when={!modelCatalog()?.some((model) => model.providerID === config.providerID && model.modelID === config.modelID)}>
                                      <option value={JSON.stringify([config.providerID, config.modelID])}>{config.providerID}/{config.modelID}</option>
                                    </Show>
                                    <For each={modelCatalog() ?? []}>{(model) => <option value={JSON.stringify([model.providerID, model.modelID])}>{model.providerName} · {model.name}</option>}</For>
                                  </select>
                                </label>
                                <Field label={language.t("swarm.panel.variant")} value={config.variant} onInput={(value) => setConfig("variant", value)} />
                                <label class="flex flex-col gap-1">
                                  <span class="text-[9px] font-[550] uppercase tracking-[0.05em] text-v2-text-text-faint">{language.t("swarm.panel.workspace")}</span>
                                  <select class="panel-input" value={config.workspaceMode} onChange={(event) => setConfig("workspaceMode", event.currentTarget.value as typeof config.workspaceMode)}>
                                    <option value="shared-read">{language.t("swarm.panel.workspace.sharedRead")}</option>
                                    <option value="shared-write">{language.t("swarm.panel.workspace.sharedWrite")}</option>
                                    <option value="worktree">{language.t("swarm.panel.workspace.worktree")}</option>
                                  </select>
                                </label>
                                <Show when={config.workspaceMode === "worktree"}><Field label={language.t("swarm.panel.baseRef")} value={config.baseRef} onInput={(value) => setConfig("baseRef", value)} /></Show>
                                <Field label={language.t("swarm.panel.capabilities")} value={config.tags} onInput={(value) => setConfig("tags", value)} />
                                <Field label={language.t("swarm.panel.requestedCapabilities")} value={config.modelRequirements} onInput={(value) => setConfig("modelRequirements", value)} />
                              </div>
                              <div class="mt-2 flex justify-end gap-1">
                                <button type="button" class="panel-action" onClick={() => setConfigMemberID(undefined)}>{language.t("swarm.panel.cancel")}</button>
                                <button type="button" class="panel-action-primary" disabled={mutating()} onClick={saveConfiguration}>{language.t("swarm.panel.save")}</button>
                              </div>
                            </div>
                          </Show>
                        </div>
                      )
                    }}
                  </For>
                </div>
              </Show>
            </Show>

            <Show when={section() === "tasks"}>
              <div class="flex items-center justify-between">
                <SectionTitle>{language.t("swarm.panel.tasks")}</SectionTitle>
                <button type="button" class="panel-action" onClick={() => setCreatingTask((value) => !value)}>{language.t("swarm.panel.createTask")}</button>
              </div>
              <Show when={creatingTask()}>
                <div class="rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-01 p-2">
                  <div class="grid grid-cols-2 gap-2">
                    <Field label={language.t("swarm.panel.taskTitle")} value={newTask.title} onInput={(value) => setNewTask("title", value)} />
                    <Field label={language.t("swarm.panel.taskPriority")} value={newTask.priority} onInput={(value) => setNewTask("priority", value)} type="number" />
                    <div class="col-span-2"><Field label={language.t("swarm.panel.taskDescription")} value={newTask.description} onInput={(value) => setNewTask("description", value)} /></div>
                    <label class="col-span-2 flex flex-col gap-1">
                      <span class="text-[9px] font-[550] uppercase tracking-[0.05em] text-v2-text-text-faint">{language.t("swarm.panel.taskReservation")}</span>
                      <select class="panel-input" value={newTask.reservedMemberID} onChange={(event) => setNewTask("reservedMemberID", event.currentTarget.value)}>
                        <option value="">{language.t("swarm.panel.unreserved")}</option>
                        <For each={detail()?.members.filter((member) => member.kind === "managed_worker") ?? []}>{(member) => <option value={member.id}>{member.name}</option>}</For>
                      </select>
                    </label>
                  </div>
                  <div class="mt-2 flex justify-end gap-1">
                    <button type="button" class="panel-action" onClick={() => setCreatingTask(false)}>{language.t("swarm.panel.cancel")}</button>
                    <button type="button" class="panel-action-primary" disabled={mutating()} onClick={createTask}>{language.t("swarm.panel.createTask")}</button>
                  </div>
                </div>
              </Show>
              <Show when={(detail()?.tasks.length ?? 0) > 0} fallback={<Empty>{language.t("swarm.panel.noTasks")}</Empty>}>
                <div class="flex flex-col gap-1.5">
                  <For each={[...(detail()?.tasks ?? [])].sort((a, b) => b.priority - a.priority)}>
                    {(task) => {
                      const dependencies = () => index().dependenciesByTaskID.get(task.id) ?? []
                      return (
                        <div class="rounded-lg border border-v2-border-border-base/70 bg-v2-background-bg-layer-01 p-2">
                          <div class="flex items-start gap-2">
                            <div class="min-w-0 flex-1">
                              <div class="truncate text-[11px] font-[600] text-v2-text-text-base">{task.title}</div>
                              <Show when={task.description}><div class="mt-0.5 line-clamp-2 text-[10px] leading-snug text-v2-text-text-muted">{task.description}</div></Show>
                            </div>
                            <span class="shrink-0 rounded bg-v2-background-bg-layer-03 px-1.5 py-0.5 text-[8px] font-[600] uppercase tracking-[0.04em] text-v2-text-text-faint">{taskStatus(task.status)}</span>
                          </div>
                          <div class="mt-1.5 flex flex-wrap gap-x-2 gap-y-1 text-[9px] text-v2-text-text-faint">
                            <span>#{task.priority}</span>
                            <Show when={task.reservedMemberID}><span>{members().get(task.reservedMemberID!)?.name ?? task.reservedMemberID}</span></Show>
                            <Show when={task.semanticRetryCount > 0}><span>{task.semanticRetryCount}</span></Show>
                          </div>
                          <Show when={dependencies().length > 0}>
                            <div class="mt-2 border-t border-v2-border-border-muted/50 pt-1.5">
                              <div class="mb-1 text-[8px] font-[600] uppercase tracking-[0.05em] text-v2-text-text-faint">{language.t("swarm.panel.dependencies")}</div>
                              <For each={dependencies()}>{(edge) => <div class="truncate text-[9px] text-v2-text-text-muted">↳ {tasks().get(edge.dependsOnTaskID)?.title ?? edge.dependsOnTaskID} · {edge.requirement}</div>}</For>
                            </div>
                          </Show>
                        </div>
                      )
                    }}
                  </For>
                </div>
              </Show>
            </Show>

            <Show when={section() === "memory"}>
              <MemorySection title={language.t("swarm.panel.blackboard")} empty={language.t("swarm.panel.noBlackboard")} items={memory.blackboard} render={(entry) => <div><div class="font-[600] text-v2-text-text-base">{entry.key} <span class="font-normal text-v2-text-text-faint">v{entry.version}</span></div><div class="mt-0.5 line-clamp-2 break-all text-v2-text-text-muted">{JSON.stringify(entry.value)}</div></div>} />
              <Show when={memory.blackboardMore}><button type="button" class="panel-load-more" onClick={() => void loadMoreBlackboard()}>{language.t("swarm.panel.loadMore")}</button></Show>
              <MemorySection title={language.t("swarm.panel.claims")} empty={language.t("swarm.panel.noClaims")} items={memory.claims} render={(claim) => <div><div class="font-[600] text-v2-text-text-base">{claim.scope}</div><div class="mt-0.5 text-v2-text-text-faint">{members().get(claim.memberID)?.name ?? claim.memberID} · g{claim.generation}</div></div>} />
              <Show when={memory.claimsMore}><button type="button" class="panel-load-more" onClick={() => void loadMoreClaims()}>{language.t("swarm.panel.loadMore")}</button></Show>
              <MemorySection title={language.t("swarm.panel.deliverables")} empty={language.t("swarm.panel.noDeliverables")} items={memory.deliverables} render={(deliverable) => <div><div class="font-[600] text-v2-text-text-base">{deliverable.summary}</div><div class="mt-0.5 text-v2-text-text-faint">{members().get(deliverable.memberID)?.name ?? deliverable.memberID}<Show when={deliverable.verdict}> · {deliverable.verdict === "accepted" ? language.t("swarm.verdict.accepted") : language.t("swarm.verdict.rejected")}</Show></div></div>} />
              <Show when={memory.deliverablesMore}><button type="button" class="panel-load-more" onClick={() => void loadMoreDeliverables()}>{language.t("swarm.panel.loadMore")}</button></Show>
            </Show>

            <Show when={section() === "history"}>
              <SectionTitle>{language.t("swarm.panel.messages")}</SectionTitle>
              <Show when={history.messages.length > 0} fallback={<Empty>{language.t("swarm.panel.noMessages")}</Empty>}>
                <div class="flex flex-col gap-1.5">
                  <For each={history.messages}>
                    {(entry) => (
                      <div class="rounded-lg border border-v2-border-border-base/70 bg-v2-background-bg-layer-01 p-2 text-[10px]">
                        <div class="flex items-center gap-1.5">
                          <span class="font-[600] text-v2-text-text-base">{members().get(entry.message.senderMemberID)?.name ?? entry.message.senderMemberID}</span>
                          <span class="rounded bg-v2-background-bg-layer-03 px-1 py-0.5 text-[8px] uppercase text-v2-text-text-faint">{entry.message.kind}</span>
                          <span class="ms-auto text-[8px] text-v2-text-text-faint">{new Date(entry.message.createdAt).toLocaleString()}</span>
                        </div>
                        <div class="mt-1 whitespace-pre-wrap break-words leading-snug text-v2-text-text-muted">{entry.message.body}</div>
                        <div class="mt-1 text-[8px] text-v2-text-text-faint">{language.t("swarm.panel.delivery")}: {entry.deliveries.map((delivery) => delivery.state).join(", ")}</div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={history.messageMore}><button type="button" class="panel-load-more" onClick={() => void loadMoreMessages()}>{language.t("swarm.panel.loadMore")}</button></Show>

              <SectionTitle>{language.t("swarm.panel.runs")}</SectionTitle>
              <Show when={history.runs.length > 0} fallback={<Empty>{language.t("swarm.panel.noRuns")}</Empty>}>
                <div class="flex flex-col gap-1.5">
                  <For each={history.runs}>
                    {(run) => (
                      <div class="rounded-lg border border-v2-border-border-base/70 bg-v2-background-bg-layer-01 p-2 text-[10px]">
                        <div class="flex items-center gap-1.5">
                          <span class="min-w-0 flex-1 truncate font-[600] text-v2-text-text-base">{tasks().get(run.taskID)?.title ?? run.taskID}</span>
                          <span class="rounded bg-v2-background-bg-layer-03 px-1 py-0.5 text-[8px] uppercase text-v2-text-text-faint">{run.status}</span>
                        </div>
                        <div class="mt-1 text-[9px] text-v2-text-text-faint">{members().get(run.memberID)?.name ?? run.memberID} · {new Date(run.createdAt).toLocaleString()}</div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={history.runMore}><button type="button" class="panel-load-more" onClick={() => void loadMoreRuns()}>{language.t("swarm.panel.loadMore")}</button></Show>
            </Show>
          </div>
        </ScrollView>
      </Show>

      <style>{`
        #swarm-panel .panel-action {
          height: 24px;
          border-radius: 6px;
          padding: 0 7px;
          font-size: 9px;
          font-weight: 550;
          color: var(--v2-text-text-muted);
          background: var(--v2-background-bg-layer-02);
        }
        #swarm-panel .panel-action:hover { background: var(--v2-background-bg-layer-03); color: var(--v2-text-text-base); }
        #swarm-panel .panel-action:disabled { opacity: .45; cursor: default; }
        #swarm-panel .panel-action-primary {
          height: 24px;
          border-radius: 6px;
          padding: 0 8px;
          font-size: 9px;
          font-weight: 600;
          color: var(--v2-text-text-base);
          background: var(--v2-background-bg-layer-03);
        }
        #swarm-panel .panel-action-primary:disabled { opacity: .45; cursor: default; }
        #swarm-panel .panel-input {
          width: 100%;
          height: 27px;
          border: 1px solid var(--v2-border-border-base);
          border-radius: 6px;
          padding: 0 7px;
          background: var(--v2-background-bg-base);
          color: var(--v2-text-text-base);
          font-size: 10px;
          outline: none;
        }
        #swarm-panel .panel-input:focus { border-color: var(--v2-border-border-strong); }
        #swarm-panel .panel-load-more {
          height: 25px;
          border-radius: 6px;
          font-size: 9px;
          color: var(--v2-text-text-faint);
        }
        #swarm-panel .panel-load-more:hover { background: var(--v2-background-bg-layer-01); color: var(--v2-text-text-muted); }
      `}</style>
    </aside>
  )
}

function Stat(props: { label: string; value: number }) {
  return (
    <div class="flex h-12 flex-col items-center justify-center bg-v2-background-bg-base">
      <span class="text-[13px] font-[650] tabular-nums text-v2-text-text-base">{props.value}</span>
      <span class="mt-0.5 text-[8px] font-[560] uppercase tracking-[0.05em] text-v2-text-text-faint">{props.label}</span>
    </div>
  )
}

function SectionTitle(props: { children: unknown }) {
  return <div class="text-[9px] font-[650] uppercase tracking-[0.07em] text-v2-text-text-faint">{props.children as never}</div>
}

function Empty(props: { children: unknown }) {
  return <div class="rounded-lg border border-dashed border-v2-border-border-muted/70 px-3 py-5 text-center text-[10px] text-v2-text-text-faint">{props.children as never}</div>
}

function Field(props: {
  label: string
  value: string
  onInput: (value: string) => void
  type?: "text" | "number"
}) {
  return (
    <label class="flex min-w-0 flex-col gap-1">
      <span class="truncate text-[9px] font-[550] uppercase tracking-[0.05em] text-v2-text-text-faint">{props.label}</span>
      <input
        type={props.type ?? "text"}
        class="panel-input"
        value={props.value}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
    </label>
  )
}

function MemorySection<T>(props: {
  title: string
  empty: string
  items: readonly T[]
  render: (item: T) => unknown
}) {
  return (
    <>
      <SectionTitle>{props.title}</SectionTitle>
      <Show when={props.items.length > 0} fallback={<Empty>{props.empty}</Empty>}>
        <div class="flex flex-col gap-1.5">
          <For each={props.items}>
            {(item) => (
              <div class="rounded-lg border border-v2-border-border-base/70 bg-v2-background-bg-layer-01 p-2 text-[10px]">
                {props.render(item) as never}
              </div>
            )}
          </For>
        </div>
      </Show>
    </>
  )
}
