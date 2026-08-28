import type {
  PermissionV2Reply,
  PermissionV2Request,
  Provider,
  QuestionV2Request,
  Session,
  SnapshotFileDiff,
} from "@opencode-ai/sdk/v2/client"
import { For, Index, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { MessageBundle } from "../api"
import type { KillShellFn } from "../components/tools/registry"
import { AgentActivitySheet, type AgentEntry } from "../components/AgentActivitySheet"
import { Composer } from "../components/Composer"
import { DiffViewer } from "../components/DiffViewer"
import { GenerationStatus } from "../components/GenerationStatus"
import { MessageGroup } from "../components/MessageBlock"
import { ModelPicker } from "../components/ModelPicker"
import { PermissionPrompt } from "../components/PermissionPrompt"
import { ProviderBadge } from "../components/ProviderBadge"
import { QuestionPrompt } from "../components/QuestionPrompt"
import type { RuntimeStatus } from "../components/SessionStatus"
import { SessionStatusDot } from "../components/SessionStatus"
import { Sheet } from "../components/Sheet"
import { TelemetrySheet } from "../components/TelemetrySheet"
import { formatCost, formatTokens, shortModel } from "../format"
import {
    IconArrowDown,
    IconBarChart,
    IconChevronLeft,
  IconCpu,
  IconFileEdit,
  IconGitBranch,
  IconMore,
  IconSliders,
} from "../icons"

type ChatSheet = "model" | "telemetry" | "agents" | "diff" | "permission" | "question" | "overflow" | null

export function ChatView(props: {
  session: Session
  messages: MessageBundle[]
  runtimeStatus: RuntimeStatus
  busySince?: number
  contextTotal: number
  providers: Provider[]
  draft: string
  onDraftInput: (v: string) => void
  onSend: () => void
  onStop: () => void
  killShell?: KillShellFn
  onBack: () => void
  permissions: PermissionV2Request[]
  questions: QuestionV2Request[]
  onPermissionReply: (requestID: string, reply: PermissionV2Reply) => void
  onQuestionSubmit: (requestID: string, answers: string[][]) => void
  permissionReplyError?: string
  questionReplyError?: string
  onModelSelect: (providerID: string, modelID: string, variant?: string) => Promise<boolean>
  onOpenLimits: () => void
  autoAccept: boolean
  onToggleAutoAccept: () => void
}) {
  const [sheet, setSheet] = createSignal<ChatSheet>(null)
  const [showScrollDown, setShowScrollDown] = createSignal(false)
  // Close the permission/question sheets only once the underlying list has
  // actually drained (i.e. the reply succeeded server-side and refreshed).
  // A failed reply never shrinks the list, so the sheet — and its inline
  // error — correctly stays open for the user to retry.
  createEffect(() => {
    if (sheet() === "permission" && props.permissions.length === 0) setSheet(null)
  })
  createEffect(() => {
    if (sheet() === "question" && props.questions.length === 0) setSheet(null)
  })
  const [pinnedToBottom, setPinnedToBottom] = createSignal(true)
  const [expandedParts, setExpandedParts] = createSignal<ReadonlySet<string>>(new Set())
  let scrollRef: HTMLDivElement | undefined
  let contentRef: HTMLDivElement | undefined
  let forcePin = false
  let pinFrame = 0
  let roFrame = 0

  const scrollToBottom = (smooth = true) => {
    if (!scrollRef) return
    setPinnedToBottom(true)
    setShowScrollDown(false)
    forcePin = smooth
    scrollRef.scrollTo({ top: scrollRef.scrollHeight, behavior: smooth ? "smooth" : "auto" })
    if (smooth) window.setTimeout(() => { forcePin = false }, 450)
  }

  const followStream = () => {
    if (!scrollRef || !pinnedToBottom()) return
    if (pinFrame) cancelAnimationFrame(pinFrame)
    pinFrame = requestAnimationFrame(() => {
      pinFrame = 0
      if (scrollRef && pinnedToBottom()) scrollRef.scrollTop = scrollRef.scrollHeight
    })
  }

  const togglePart = (id: string) => {
    setExpandedParts((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  onMount(() => {
    scrollToBottom(false)
    // Keep pinned bottom when streamed markdown grows after the text-length
    // fingerprint already fired (async highlight/layout). This is rAF-throttled
    // so expanding a tool/reasoning block off-screen doesn't force a jump.
    let lastH = 0
    const ro = new ResizeObserver(() => {
      if (!scrollRef || !contentRef || !pinnedToBottom()) return
      const h = contentRef.scrollHeight
      if (h === lastH) return
      const growing = h > lastH
      lastH = h
      if (!growing) return
      if (roFrame) cancelAnimationFrame(roFrame)
      roFrame = requestAnimationFrame(() => {
        roFrame = 0
        if (scrollRef && pinnedToBottom()) scrollRef.scrollTop = scrollRef.scrollHeight
      })
    })
    if (contentRef) {
      ro.observe(contentRef)
      lastH = contentRef.scrollHeight
    }
    onCleanup(() => {
      ro.disconnect()
      if (pinFrame) cancelAnimationFrame(pinFrame)
      if (roFrame) cancelAnimationFrame(roFrame)
    })
  })

  // Follow only real message data growth while pinned. Using an effect that
  // touches message identity + last-part lengths keeps disclosure toggles,
  // syntax-highlight reflows, and other DOM mutations from forcing a scroll.
  createEffect(() => {
    const generating = props.runtimeStatus === "generating"
    const len = props.messages.length
    const last = len ? props.messages[len - 1] : undefined
    const fingerprint = last
      ? last.parts
          .map((part) => {
            if (part.type === "text" || part.type === "reasoning") return `${part.type}:${part.text.length}`
            if (part.type === "tool") return `tool:${part.id}:${part.state.status}`
            return part.type
          })
          .join("|")
      : ""
    // touch reactive deps
    len
    fingerprint
    generating
    if (!generating) return
    if (!pinnedToBottom()) return
    followStream()
  })

  const handleScroll = () => {
    if (!scrollRef) return
    const distance = scrollRef.scrollHeight - scrollRef.scrollTop - scrollRef.clientHeight
    if (!forcePin) setPinnedToBottom(distance <= 72)
    setShowScrollDown(distance > 140)
  }

  const tokens = createMemo(() => props.session.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
  const contextUsed = createMemo(() => {
    const t = tokens()
    return t.input + t.output + t.reasoning + t.cache.read + t.cache.write
  })
  const contextPct = createMemo(() =>
    props.contextTotal > 0 ? Math.min(100, Math.round((contextUsed() / props.contextTotal) * 100)) : 0,
  )
  const contextTier = createMemo(() => {
    const p = contextPct()
    if (p >= 85) return "critical"
    if (p >= 65) return "warn"
    if (p >= 40) return "mid"
    return "low"
  })

  const toolCallCount = createMemo(() =>
    props.messages.reduce((n, m) => n + m.parts.filter((p) => p.type === "tool").length, 0),
  )

  const agents = createMemo<AgentEntry[]>(() => {
    const list: AgentEntry[] = []
    props.messages.forEach((bundle, bi) => {
      bundle.parts.forEach((part) => {
        if (part.type !== "subtask") return
        const isLastBundle = bi === props.messages.length - 1
        const running = isLastBundle && props.runtimeStatus === "generating"
        list.push({ part, running })
      })
    })
    return list
  })

  const diffs = createMemo<SnapshotFileDiff[]>(() => props.session.summary?.diffs ?? [])



  const isEmpty = createMemo(() => props.messages.length === 0)
  const isGenerating = createMemo(() => props.runtimeStatus === "generating")
  const hasPendingActions = createMemo(() => props.permissions.length > 0 || props.questions.length > 0)

  const modelLabel = createMemo(() => (props.session.model ? shortModel(props.session.model.id) : "model"))
  const variants = createMemo(() => {
    const model = props.session.model
    if (!model) return []
    const provider = props.providers.find((p) => p.id === model.providerID)
    const found = provider?.models[model.id]
    return found?.variants ? Object.keys(found.variants) : []
  })
  const cycleVariant = () => {
    const list = ["default", ...variants()]
    const current = props.session.model?.variant ?? "default"
    const next = list[(list.indexOf(current) + 1) % list.length]
    props.onModelSelect(props.session.model!.providerID, props.session.model!.id, next === "default" ? undefined : next)
  }

  return (
    <div class="chat-view">
      <div class="chat-header">
        <button class="chat-back-btn" onClick={props.onBack}>
          <IconChevronLeft size={16} />
        </button>
        <div class="chat-identity">
          <div class="chat-title-row">
            <SessionStatusDot status={props.runtimeStatus} />
            <span class="chat-title">{props.session.title || "Untitled session"}</span>
          </div>
          <div class="chat-path">
            <IconGitBranch size={8} />
            <span>{props.session.directory}</span>
          </div>
        </div>
        <div class="chat-right">
          <button class="chat-ctx-btn" onClick={() => setSheet("telemetry")}>
            <div class="mini-bar-track ctx-track">
              <div class={`mini-bar-fill ctx-fill-${contextTier()}`} style={{ width: `${Math.max(contextPct(), 2)}%` }} />
            </div>
            <span class={`ctx-pct tnum ctx-${contextTier()}`}>{contextPct()}%</span>
          </button>
          <button class="chat-model-btn" onClick={() => setSheet("model")}>
            <Show when={props.session.model}><ProviderBadge providerID={props.session.model!.providerID} /></Show>
            <span>{modelLabel()}</span>
          </button>
          <Show when={agents().length > 0}>
            <button class="chat-agents-btn" onClick={() => setSheet("agents")}>
              <IconCpu size={11} />
              {agents().length}
            </button>
          </Show>
          <button class="chat-more-btn" onClick={() => setSheet("overflow")}>
            <IconMore size={14} />
          </button>
        </div>
      </div>

      <div class="chat-meta-bar">
        <button onClick={() => setSheet("telemetry")}>
          <IconBarChart size={9} />
          <span class="meta-val tnum">{formatCost(props.session.cost ?? 0)}</span>
        </button>
        <span class="meta-sep">·</span>
        <span class="meta-val tnum">{props.messages.length} msg</span>
        <span class="meta-sep">·</span>
        <span class="meta-val tnum">{toolCallCount()} tools</span>
        <Show when={contextUsed() > 0}>
          <span class="meta-sep">·</span>
          <span class="meta-val tnum">{formatTokens(contextUsed())} tok</span>
        </Show>
        <span class="spacer" />
        <Show when={diffs().length > 0}>
          <button onClick={() => setSheet("diff")}>
            <IconFileEdit size={9} />
            <span class="meta-val tnum">{diffs().length} changed</span>
          </button>
        </Show>
      </div>

      <Show when={hasPendingActions()}>
        <div class="pending-bar">
          <Show when={props.permissions.length > 0}>
            <button class="pending-item amber" onClick={() => setSheet("permission")}>
              <span class="status-dot amber pulse" />
              {props.permissions.length} permission{props.permissions.length > 1 ? "s" : ""}
            </button>
          </Show>
          <Show when={props.questions.length > 0}>
            <button class="pending-item blue" onClick={() => setSheet("question")}>
              <span class="status-dot blue pulse" />
              {props.questions.length} question{props.questions.length > 1 ? "s" : ""}
            </button>
          </Show>
        </div>
      </Show>

      <div class="chat-messages" ref={scrollRef} onScroll={handleScroll}>
        <div ref={contentRef} style={{ "min-height": "100%" }}>
          <Show
            when={!isEmpty()}
            fallback={
              <div class="chat-empty">
                <div class="chat-empty-logo">OC</div>
                <h2>New session</h2>
                <div class="chat-empty-path">
                  <span>{props.session.directory}</span>
                </div>
              </div>
            }
          >
            <Index each={props.messages}>
              {(bundle, i) => (
                <MessageGroup
                  info={bundle().info}
                  parts={bundle().parts}
                  isLast={i === props.messages.length - 1}
                  expandedParts={expandedParts()}
                  onTogglePart={togglePart}
                  killShell={props.killShell}
                />
              )}
            </Index>
          </Show>
        </div>
      </div>

      <Show when={showScrollDown() && !isEmpty()}>
        <button class="scroll-down-btn" onClick={() => scrollToBottom(true)}>
          <IconArrowDown size={12} />
        </button>
      </Show>

      <Show when={isGenerating()}>
        <GenerationStatus activity="Generating" startedAt={props.busySince ?? Date.now()} onStop={props.onStop} />
      </Show>

      <Composer
        value={props.draft}
        onInput={props.onDraftInput}
        onSend={props.onSend}
        onStop={props.onStop}
        isGenerating={isGenerating()}
        modelLabel={modelLabel()}
        providerID={props.session.model?.providerID}
        onModelClick={() => setSheet("model")}
        variantLabel={variants().length > 0 ? (props.session.model?.variant ?? "default") : undefined}
        onVariantClick={cycleVariant}
        autoAccept={props.autoAccept}
        onToggleAutoAccept={props.onToggleAutoAccept}
        onOpenLimits={props.onOpenLimits}
        pendingPermissions={props.permissions.length}
        pendingQuestions={props.questions.length}
        onPermissionClick={() => setSheet("permission")}
        onQuestionClick={() => setSheet("question")}
      />

      <ModelPicker
        open={sheet() === "model"}
        onClose={() => setSheet(null)}
        providers={props.providers}
        current={props.session.model ? { providerID: props.session.model.providerID, modelID: props.session.model.id } : undefined}
        onSelect={async (providerID, modelID) => {
          if (await props.onModelSelect(providerID, modelID)) setSheet(null)
        }}
      />
      <TelemetrySheet
        open={sheet() === "telemetry"}
        onClose={() => setSheet(null)}
        session={props.session}
        contextTotal={props.contextTotal}
        messageCount={props.messages.length}
        toolCallCount={toolCallCount()}
      />
      <AgentActivitySheet open={sheet() === "agents"} onClose={() => setSheet(null)} agents={agents()} />
      <DiffViewer open={sheet() === "diff"} onClose={() => setSheet(null)} diffs={diffs()} />
      <Show when={props.permissions[0]} keyed>
        {(req) => (
          <PermissionPrompt
            open={sheet() === "permission"}
            onClose={() => setSheet(null)}
            request={req}
            error={props.permissionReplyError}
            onReply={(reply) => props.onPermissionReply(req.id, reply)}
          />
        )}
      </Show>
      <Show when={props.questions[0]} keyed>
        {(req) => (
          <QuestionPrompt
            open={sheet() === "question"}
            onClose={() => setSheet(null)}
            request={req}
            error={props.questionReplyError}
            onSubmit={(answers) => props.onQuestionSubmit(req.id, answers)}
          />
        )}
      </Show>
      <Sheet open={sheet() === "overflow"} onClose={() => setSheet(null)} title="Session">
        <button
          class="settings-row"
          onClick={() => {
            setSheet("diff")
          }}
        >
          <IconFileEdit size={13} />
          <span class="label">Changed files</span>
          <span class="value">{diffs().length}</span>
        </button>
        <button class="settings-row" onClick={() => setSheet("agents")}>
          <IconCpu size={13} />
          <span class="label">Agent activity</span>
          <span class="value">{agents().length}</span>
        </button>
        <button class="settings-row" onClick={() => setSheet("telemetry")}>
          <IconBarChart size={13} />
          <span class="label">Session telemetry</span>
        </button>
        <button
          class="settings-row"
          onClick={() => {
            setSheet(null)
            props.onOpenLimits()
          }}
        >
          <IconSliders size={13} />
          <span class="label">Provider limits</span>
        </button>
      </Sheet>
    </div>
  )
}
