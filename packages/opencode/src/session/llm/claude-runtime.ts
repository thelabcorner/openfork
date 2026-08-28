// Claude Agent SDK runtime adapter.
//
// Selected by src/session/llm.ts when model.providerID === "claude" and
// the rollback gate allows. One adapter call runs one full Agent SDK turn
// through ClaudeAgentRuntime (SDK stays lazy via the default loader), converts
// transport events into canonical @opencode-ai/llm LLMEvents for the session
// processor (durable OpenCode messages need no processor changes), routes every
// tool_use through BridgeStore + Permission.Service, feeds tool results back to
// the SDK via its streaming-input channel, and persists/validates session
// bindings so later turns resume the same external Claude session.
//
// The Agent SDK is never imported here: it is loaded lazily inside
// ClaudeAgentRuntime through availability.defaultSdkLoader. Fixtures inject a
// fake loader/runtime/store/bindings for deterministic tests.

import type { ModelMessage, Tool } from "ai"
import * as Stream from "effect/Stream"
import { Effect } from "effect"
import { LLMEvent, ToolResultValue } from "@opencode-ai/llm"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionID } from "@/session/schema"
import { shouldEnableClaudeFirstParty } from "@/plugin/shared"
import { ClaudeAgentRuntime, type RuntimeTimeouts, type TurnOutcome } from "@/claude/runtime"
import { defaultSdkLoader } from "@/claude/availability"
import type { AssistantEvent, ContentBlock, RuntimeEvent } from "@/claude/events"
import { BridgeStore, completeEffect, parkEffect, validateScope, type BridgeRequest, type Scope } from "@/claude/bridge"
import {
  boundHistory,
  createBinding,
  hashSettings,
  invalidate,
  makeMemoryStorage,
  modelFamilyOf,
  resolveResumeEffect,
  saveBinding,
  type BindingStorage,
  type ResumeDecision,
} from "@/claude/sessions"

// ── Gate ──

export type Status = { readonly type: "supported" } | { readonly type: "unsupported"; readonly reason: string }

/**
 * Rollback-gated runtime selection. `enabled` defaults to the migration lane's
 * shouldEnableClaudeFirstParty(); callers may narrow it further (RuntimeFlags).
 */
export function status(input: { readonly providerID: string; readonly enabled?: () => boolean }): Status {
  if (input.providerID !== "claude") return { type: "unsupported", reason: "provider is not claude" }
  const enabled = input.enabled ?? shouldEnableClaudeFirstParty
  if (!enabled())
    return {
      type: "unsupported",
      reason: "first-party Claude support disabled by OPENCODE_DISABLE_CLAUDE_FIRST_PARTY",
    }
  return { type: "supported" }
}

// ── Push channel: one producer, one async consumer ──

class PushChannel<T> {
  private queue: T[] = []
  private resolvers: Array<(result: IteratorResult<T>) => void> = []
  private ended = false

  push(value: T): void {
    const resolver = this.resolvers.shift()
    if (resolver) resolver({ done: false, value })
    else this.queue.push(value)
  }

  end(): void {
    this.ended = true
    for (const resolver of this.resolvers.splice(0)) resolver({ done: true, value: undefined as T })
  }

  get iterable(): AsyncIterable<T> {
    const self = this
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<T>>((resolve) => {
              const entry = self.queue.shift()
              if (entry !== undefined) return resolve({ done: false, value: entry })
              if (self.ended) return resolve({ done: true, value: undefined as T })
              self.resolvers.push(resolve)
            }),
        }
      },
    }
  }
}

// ── Shared per-process state (injected in tests) ──

let sharedStore: BridgeStore | undefined
let sharedBindings: BindingStorage | undefined

function defaultStore(): BridgeStore {
  if (!sharedStore) sharedStore = new BridgeStore()
  return sharedStore
}

function defaultBindings(): BindingStorage {
  if (!sharedBindings) sharedBindings = makeMemoryStorage()
  return sharedBindings
}

/** Test hook: drop shared bridge/binding state. */
export function resetSharedState(): void {
  sharedStore?.dispose()
  sharedStore = undefined
  sharedBindings = undefined
}

// ── Input shape ──

export interface StreamInput {
  readonly sessionID: string
  readonly system: readonly string[]
  readonly messages: readonly ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly modelID: string
  readonly providerID: string
  /** OpenCode effort variant (`low`…`max`); maps to Agent SDK `--effort`. */
  readonly effort?: string
  readonly abort: AbortSignal
  /** Permission.Service (ask); deny/reject surfaces as a denied tool result. */
  readonly permission: { ask: (input: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error> }
  /** Merged agent + request permission ruleset evaluated by Permission.Service. */
  readonly ruleset?: PermissionV1.Ruleset
  readonly bindings?: BindingStorage
  readonly store?: BridgeStore
  readonly runtime?: ClaudeAgentRuntime
  readonly timeouts?: RuntimeTimeouts
  /** Instance scope; defaults keep scope validation self-consistent per process. */
  readonly context?: { readonly projectID: string; readonly worktree: string; readonly directory: string }
}

const DEFAULT_CONTEXT = { projectID: "claude", worktree: process.cwd(), directory: process.cwd() }

// ── Prompt assembly ──
// Match @openchamber/opencode-claude SdkUserPrompt: the Agent SDK CLI rejects
// streaming-input items whose inner message.role is missing
// ("Expected message role 'user', got 'undefined'").

export type SdkUserPrompt = {
  readonly type: "user"
  readonly message: { readonly role: "user"; readonly content: string | readonly unknown[] }
  readonly parent_tool_use_id: null
}

export function sdkUserPrompt(content: string | readonly unknown[]): SdkUserPrompt {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  }
}

function messageText(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return ""
  return message.content
    .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
    .filter(Boolean)
    .join("\n")
}

// ── Attachment conversion (ported/adapted from plugin prompt.ts for 1:1) ──

type AnthropicBlock = { type: string; [k: string]: unknown }

function isDataUrl(s: string): boolean {
  return /^data:/i.test(s)
}

function parseDataUrl(s: string): { mediaType: string; data: string } | null {
  const m = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/i.exec(s)
  if (!m) return null
  return { mediaType: m[1]!, data: m[2]! }
}

function pushTextBlock(blocks: AnthropicBlock[], text: string): void {
  const t = text.trim()
  if (t) blocks.push({ type: "text", text: t })
}

function mediaLooksLikePdf(mediaType: string, name = ""): boolean {
  const m = (mediaType || "").toLowerCase()
  if (m.includes("pdf")) return true
  return (name || "").toLowerCase().endsWith(".pdf")
}

function mediaLooksLikeImage(mediaType: string): boolean {
  return (mediaType || "").toLowerCase().startsWith("image/")
}

function contentToAnthropicBlocks(content: ModelMessage["content"]): AnthropicBlock[] {
  if (typeof content === "string") {
    const t = content.trim()
    return t ? [{ type: "text", text: t }] : []
  }
  if (!Array.isArray(content)) return []
  const blocks: AnthropicBlock[] = []
  for (const part of content) {
    if (!part || typeof part !== "object") continue
    const p = part as Record<string, unknown>
    const type = typeof p.type === "string" ? p.type : ""
    if (type === "text" && typeof p.text === "string") {
      pushTextBlock(blocks, p.text)
      continue
    }
    if (type === "image") {
      let raw: string | undefined
      const img = p.image
      if (typeof img === "string") raw = img
      else if (img instanceof URL) raw = img.toString()
      const mediaType =
        (typeof p.mimeType === "string" ? p.mimeType : undefined) ||
        (typeof p.mediaType === "string" ? p.mediaType : undefined) ||
        (typeof raw === "string" ? raw.split(";")[0]?.replace("data:", "") : undefined) ||
        "image/png"
      if (raw) {
        if (isDataUrl(raw)) {
          const parsed = parseDataUrl(raw)
          if (parsed) {
            blocks.push({ type: "image", source: { type: "base64", media_type: parsed.mediaType, data: parsed.data } })
            continue
          }
        }
        if (/^https?:\/\//i.test(raw)) {
          blocks.push({ type: "image", source: { type: "url", url: raw } })
          continue
        }
        blocks.push({ type: "image", source: { type: "base64", media_type: mediaType, data: raw } })
      }
      continue
    }
    if (type === "file") {
      const data = typeof p.data === "string" ? p.data : undefined
      const mediaType =
        (typeof p.mediaType === "string" ? p.mediaType : undefined) ||
        (typeof p.mimeType === "string" ? p.mimeType : undefined) ||
        "application/octet-stream"
      const filename = (typeof p.filename === "string" ? p.filename : "") || ""
      if (data) {
        if (isDataUrl(data)) {
          const parsed = parseDataUrl(data)
          if (parsed) {
            const isPdf = mediaLooksLikePdf(parsed.mediaType, filename) || mediaLooksLikePdf(mediaType, filename)
            blocks.push({
              type: isPdf ? "document" : "image",
              source: { type: "base64", media_type: isPdf ? "application/pdf" : parsed.mediaType, data: parsed.data },
            })
            continue
          }
        }
        const isPdf = mediaLooksLikePdf(mediaType, filename)
        const btype = isPdf || !mediaLooksLikeImage(mediaType) ? "document" : "image"
        blocks.push({
          type: btype,
          source: { type: "base64", media_type: isPdf ? "application/pdf" : mediaType, data },
        })
      }
      continue
    }
  }
  return blocks
}

function messageHasAttachments(content: ModelMessage["content"]): boolean {
  if (typeof content === "string" || !Array.isArray(content)) return false
  return content.some((part: any) => part && (part.type === "image" || part.type === "file"))
}

// ── Failure classification (slim port of plugin failure.ts for better errors) ──

const RATE_LIMIT_PATTERNS = [
  /rate.?limit/i,
  /session limit/i,
  /usage limit/i,
  /resets? \d/i,
  /too many requests/i,
  /\b429\b/,
]

const AUTH_PATTERNS = [
  /invalid_grant/i,
  /refresh token/i,
  /invalid.*api.*key/i,
  /authentication/i,
  /unauthorized/i,
  /not logged in/i,
  /not authenticated/i,
  /please.*login/i,
  /oauth.*(expired|invalid|revoked)/i,
  /credentials.*(expired|invalid)/i,
  /\b401\b/i,
]

function classifyClaudeError(message: string): "rate_limit" | "auth" | "unknown" {
  if (!message) return "unknown"
  if (RATE_LIMIT_PATTERNS.some((re) => re.test(message))) return "rate_limit"
  if (AUTH_PATTERNS.some((re) => re.test(message))) return "auth"
  return "unknown"
}

function hintFor(kind: "rate_limit" | "auth" | "unknown"): string {
  if (kind === "rate_limit") return " Claude subscription limit active; wait for reset."
  if (kind === "auth") return " Claude Code credentials invalid/expired. Run `claude auth login --claudeai`."
  return ""
}

export function buildPrompt(input: {
  readonly system: readonly string[]
  readonly messages: readonly ModelMessage[]
  readonly resume: boolean
  readonly historyTransfer?: ReadonlyArray<{ role: string; content: string }>
}): string | readonly unknown[] {
  const current = [...input.messages].reverse().find((message) => message.role === "user")
  const hasAttach = current ? messageHasAttachments(current.content) : false
  const userText = current ? messageText(current) : ""
  // Resuming continues the external transcript, so only the new user text (or blocks) goes
  // over the wire; fresh turns carry bounded context instead.
  if (input.resume) {
    return hasAttach && current ? contentToAnthropicBlocks(current.content) : userText
  }
  // Do not dump OpenCode system prompts into the Agent SDK user turn — the
  // Claude Code preset owns the agent system prompt (plugin prompt.ts).
  const history =
    input.historyTransfer ??
    boundHistory(
      input.messages
        .slice(0, -1)
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message) => ({ role: message.role, content: messageText(message) }))
        .filter((message) => message.content.length > 0),
    ).messages
  const transcript = history
    .map((message) => {
      if (message.role === "user") return `User:\n${message.content}`
      if (message.role === "assistant") return `Assistant:\n${message.content}`
      return null
    })
    .filter((line): line is string => Boolean(line))
    .join("\n\n")
  if (!transcript) {
    return hasAttach && current ? contentToAnthropicBlocks(current.content) : userText
  }
  if (!hasAttach) {
    return (
      "<conversation_history>\n" +
      "The earlier conversation of this chat is included below because the previous " +
      "Claude session could not be resumed. Treat it as established context — do not " +
      "re-do completed work — and respond to the user's latest message, which follows " +
      "the history.\n\n" +
      transcript +
      "\n</conversation_history>\n\nLatest user message:\n" +
      userText
    )
  }
  // Attachment case + history: send history as leading text block, then rich blocks for latest turn.
  // This preserves the non-attach string shape exactly, while enabling multimodal on current turn.
  const header =
    "<conversation_history>\n" +
    "The earlier conversation of this chat is included below because the previous " +
    "Claude session could not be resumed. Treat it as established context — do not " +
    "re-do completed work — and respond to the user's latest message (which may include attachments), which follows " +
    "the history.\n\n" +
    transcript +
    "\n</conversation_history>\n\nLatest user message follows (text + attachments):"
  const blocks = current ? contentToAnthropicBlocks(current.content) : []
  return [{ type: "text", text: header }, ...blocks]
}

// ── Transport → LLMEvent conversion ──

interface ResolvedToolUse {
  readonly id: string
  readonly name: string
  readonly input: unknown
}

function toolUseOf(block: ContentBlock): ResolvedToolUse | undefined {
  if (block.type !== "tool_use") return undefined
  const id = typeof block.id === "string" ? block.id : undefined
  const name = typeof block.name === "string" ? block.name : undefined
  if (!id || !name) return undefined
  return { id, name, input: (block as { input?: unknown }).input ?? {} }
}

function emitAssistantBlocks(out: PushChannel<LLMEvent>, blocks: readonly ContentBlock[], onToolUse: (block: ResolvedToolUse) => void): void {
  let index = 0
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      const id = `txt-${index++}`
      out.push(LLMEvent.textStart({ id }))
      out.push(LLMEvent.textDelta({ id, text: block.text }))
      out.push(LLMEvent.textEnd({ id }))
      continue
    }
    if (block.type === "thinking" && typeof block.thinking === "string") {
      const id = `thk-${index++}`
      out.push(LLMEvent.reasoningStart({ id }))
      out.push(LLMEvent.reasoningDelta({ id, text: block.thinking }))
      out.push(LLMEvent.reasoningEnd({ id }))
      continue
    }
    if (block.type === "tool_use") {
      const toolUse = toolUseOf(block)
      if (!toolUse) continue
      out.push(LLMEvent.toolInputStart({ id: toolUse.id, name: toolUse.name }))
      out.push(LLMEvent.toolCall({ id: toolUse.id, name: toolUse.name, input: toolUse.input }))
      onToolUse(toolUse)
    }
  }
}

// ── Turn driver ──

async function runPromise<A>(effect: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(effect)
}

export function stream(input: StreamInput): Stream.Stream<LLMEvent, unknown> {
  async function* generate(): AsyncGenerator<LLMEvent> {
    const out = new PushChannel<LLMEvent>()
    const driver = drive(input, out)
    yield* out.iterable
    await driver
  }
  return Stream.fromAsyncIterable(generate(), (error) => (error instanceof Error ? error : new Error(String(error))))
}

async function drive(input: StreamInput, out: PushChannel<LLMEvent>): Promise<void> {
  try {
    const context = input.context ?? DEFAULT_CONTEXT
    const ownerScope: Scope = {
      projectID: context.projectID,
      worktree: context.worktree,
      directory: context.directory,
      cwd: context.directory,
    }
    const store = input.store ?? defaultStore()
    const bindings = input.bindings ?? defaultBindings()
    const settings = { model: input.modelID, provider: input.providerID }

    // Resume decision through the OpenCode-owned binding store.
    const decision = await runPromise(
      resolveResumeEffect({
        storage: bindings,
        projectID: ownerScope.projectID,
        openCodeSessionID: input.sessionID,
        ctx: {
          projectID: ownerScope.projectID,
          worktree: ownerScope.worktree,
          directory: ownerScope.directory,
          cwd: ownerScope.cwd,
          modelFamily: modelFamilyOf(input.modelID),
          settingsDigest: hashSettings(settings),
          transcriptExists: true,
        },
        historyMessages: input.messages
          .filter((message) => message.role === "user" || message.role === "assistant")
          .map((message) => ({ role: message.role, content: messageText(message) }))
          .filter((message) => message.content.length > 0),
      }).pipe(Effect.orElseSucceed((): ResumeDecision => ({ strategy: "fresh" }))),
    )
    const resumeSessionID = decision.strategy === "resume" ? decision.binding?.claudeSessionID : undefined
    const prompt = buildPrompt({
      system: input.system,
      messages: input.messages,
      resume: resumeSessionID !== undefined,
      historyTransfer: decision.historyTransfer?.messages,
    })

    const sdkIn = new PushChannel<Record<string, unknown>>()
    const runtime =
      input.runtime ??
      new ClaudeAgentRuntime({
        loader: defaultSdkLoader,
        cwd: ownerScope.cwd,
        timeouts: input.timeouts,
      })

    out.push(LLMEvent.stepStart({ index: 0 }))

    // Tool bridging: park → Permission.ask → execute → complete exactly once,
    // then feed the tool_result back to the SDK so the turn continues.
    const pending = new Set<Promise<void>>()
    const executeToolUse = async (toolUse: ResolvedToolUse): Promise<void> => {
      const callID = toolUse.id
      const name = toolUse.name
      const callInput = toolUse.input
      const failTool = (message: string) => {
        out.push(LLMEvent.toolError({ id: callID, name, message }))
        sdkIn.push(sdkUserPrompt([{ type: "tool_result", tool_use_id: callID, is_error: true, content: message }]))
      }
      if (!callID || !name) return failTool("malformed tool_use block")
      // Fence: only names from THIS request's OpenCode registry projection pass.
      // BUILTIN_DENYLIST does not apply here — prepared.tools is already the
      // OpenCode-owned registry projection (no SDK built-ins are registered),
      // and its bash/read/edit entries would otherwise be unreachable.
      if (!Object.prototype.hasOwnProperty.call(input.tools, name) || !/^[a-zA-Z0-9._:-]+$/.test(name)) {
        return failTool(`tool not available: ${name}`)
      }
      const request: BridgeRequest = {
        callID,
        tool: name,
        input: callInput,
        sessionID: input.sessionID,
        scope: ownerScope,
      }
      try {
        await runPromise(parkEffect(store, request, ownerScope))
      } catch (error) {
        return failTool(error instanceof Error ? error.message : String(error))
      }
      store.markExecuting(callID)
      try {
        await runPromise(
          input.permission.ask({
            sessionID: SessionID.make(input.sessionID),
            permission: name,
            patterns: [name],
            always: [name],
            metadata: { source: "claude-first-party", tool: name },
            tool: { messageID: `claude-${callID}`, callID },
            ruleset: [...(input.ruleset ?? [])],
          }),
        )
      } catch {
        try {
          store.deny(callID)
        } catch {}
        return failTool(`tool denied: ${name}`)
      }
      if (!validateScope(request.scope, ownerScope)) {
        try {
          store.deny(callID)
        } catch {}
        return failTool("scope mismatch")
      }
      let outputText: string
      try {
        const tool = input.tools[name]
        if (!tool.execute) throw new Error(`tool has no execute handler: ${name}`)
        const raw = await tool.execute(callInput, {
          toolCallId: callID,
          messages: input.messages as ModelMessage[],
          abortSignal: input.abort,
        })
        outputText = typeof raw === "string" ? raw : JSON.stringify(raw ?? "")
        await runPromise(completeEffect(store, callID, { callID, status: "success", output: outputText }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        try {
          await runPromise(completeEffect(store, callID, { callID, status: "error", error: message }))
        } catch {}
        out.push(LLMEvent.toolError({ id: callID, name, message }))
        sdkIn.push(
          sdkUserPrompt([{ type: "tool_result", tool_use_id: callID, is_error: true, content: message }]),
        )
        return
      }
      out.push(
        LLMEvent.toolResult({
          id: callID,
          name,
          result: ToolResultValue.make(outputText, "text"),
          providerExecuted: false,
        }),
      )
      sdkIn.push(sdkUserPrompt([{ type: "tool_result", tool_use_id: callID, content: outputText }]))
    }

    const sink = (event: RuntimeEvent): void => {
      if (event.kind !== "transport") return
      const transport = event.event
      if (transport.type !== "assistant") return
      emitAssistantBlocks(out, (transport as AssistantEvent).message?.content ?? [], (toolUse) => {
        const task = executeToolUse(toolUse).catch(() => {})
        pending.add(task)
        void task.finally(() => pending.delete(task))
      })
    }

    // Streaming-input mode: the assembled prompt is the first user message;
    // tool_result feedback follows between assistant turns.
    sdkIn.push(sdkUserPrompt(prompt))

    const outcome: TurnOutcome = await runtime.run({
      prompt: sdkIn.iterable,
      model: input.modelID,
      effort: input.effort,
      resume: resumeSessionID,
      signal: input.abort,
      sink,
    })

    // Settle eager tool tasks before the terminal events.
    await Promise.allSettled([...pending])

    if (outcome.status === "completed") {
      const usage =
        outcome.usage && (outcome.usage.input_tokens !== undefined || outcome.usage.output_tokens !== undefined)
          ? { inputTokens: outcome.usage.input_tokens, outputTokens: outcome.usage.output_tokens }
          : undefined
      const reason = outcome.isError ? ("error" as const) : ("stop" as const)
      out.push(LLMEvent.stepFinish({ index: 0, reason, ...(usage ? { usage } : {}) }))
      out.push(LLMEvent.finish({ reason, ...(usage ? { usage } : {}) }))
      if (outcome.sessionID) {
        const existing = decision.strategy === "resume" ? decision.binding : undefined
        const binding =
          existing && existing.claudeSessionID === outcome.sessionID
            ? { ...existing, updatedAt: Date.now() }
            : createBinding({
                openCodeSessionID: input.sessionID,
                claudeSessionID: outcome.sessionID,
                projectID: ownerScope.projectID,
                worktree: ownerScope.worktree,
                directory: ownerScope.directory,
                cwd: ownerScope.cwd,
                modelID: input.modelID,
                settings,
              })
        await runPromise(saveBinding(bindings, binding))
      }
    } else {
      if (resumeSessionID && decision.binding) {
        await runPromise(
          saveBinding(bindings, invalidate(decision.binding, "stale", outcome.category ?? outcome.status)),
        )
      }
      // Cancellation ends the stream quietly, matching AI SDK abort semantics.
      if (outcome.status !== "cancelled") {
        const rawMsg = outcome.message ?? outcome.category ?? `claude turn ${outcome.status}`
        const kind = classifyClaudeError(rawMsg)
        const msg = rawMsg + hintFor(kind)
        out.push(LLMEvent.providerError({ message: msg }))
      }
    }
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error)
    const kind = classifyClaudeError(raw)
    out.push(LLMEvent.providerError({ message: raw + hintFor(kind) }))
  } finally {
    out.end()
  }
}

export * as ClaudeRuntimeAdapter from "./claude-runtime"
