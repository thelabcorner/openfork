import { Effect, Schema } from "effect"
import type { Tool } from "@/tool/tool"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import {
  BridgeStore,
  type BridgeRequest,
  type BridgeResult,
  type PendingEntry,
  type Scope,
  parkEffect,
  completeEffect,
  isSafeToolName,
  validateScope,
} from "./bridge"
import { BridgeError } from "./errors"

// In-process BridgeStore registry keyed by directory. Uses a plain Map
// for typecheck-safe per-instance isolation; InstanceState.directory can
// be used externally to select the correct store, but the map itself
// remains testable without Scope/InstanceState.make.
const storeByDirectory = new Map<string, BridgeStore>()

export function getOrCreateStore(directory: string): BridgeStore {
  let s = storeByDirectory.get(directory)
  if (!s) {
    s = new BridgeStore()
    storeByDirectory.set(directory, s)
  }
  return s
}

export function clearAllStores(): void {
  for (const s of storeByDirectory.values()) s.dispose()
  storeByDirectory.clear()
}

export interface BridgeExecuteInput {
  readonly tool: string
  readonly input: unknown
  readonly callID: string
  readonly sessionID: string
  readonly scope: Scope
  readonly messageID?: string
  readonly agent?: string
  readonly timeoutMs?: number
}

export interface BridgeExecuteResult {
  readonly bridgeResult: BridgeResult
  readonly toolOutput: string
}

export function ownerScope(directory: string, worktree: string, projectID: string): Scope {
  return { projectID, worktree, directory, cwd: directory }
}

function permissionPatternsFor(input: unknown): string[] {
  try {
    const raw = JSON.stringify(input ?? {})
    if (!raw || raw === "{}" || raw === "null") return ["*"]
    return [raw.slice(0, 1024)]
  } catch {
    return ["*"]
  }
}

// Core execute: validates allowlist + scope, parks exact-once, asks
// Permission.Service, executes the ToolRegistry tool, completes exact-once.
// Caller supplies the store, permission service, registry, and owner scope
// so this remains pure and typecheck-safe without InstanceState plumbing.
export function executeBridgeTool(input: {
  store: BridgeStore
  permission: { ask: (req: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error> }
  tools: Tool.Def[]
  ownerScope: Scope
  request: BridgeExecuteInput
}): Effect.Effect<BridgeExecuteResult, any, any> {
  return Effect.gen(function* () {
    const { store, permission, tools, ownerScope, request } = input
    const messageID = request.messageID ?? `claude-msg-${request.callID}`

    // Fence by registry membership + safe name only; no BUILTIN_DENYLIST here so real OpenCode tools (bash/read/edit)
    // are not blocked when they are in the registry. Live runtime uses same fence.
    const allowed = new Set(tools.map((t) => t.id))
    if (!isSafeToolName(request.tool) || !allowed.has(request.tool)) {
      return yield* new BridgeError({ code: "invalid_tool", message: `tool not allowed: ${request.tool}`, callID: request.callID })
    }

    const req: BridgeRequest = {
      callID: request.callID,
      tool: request.tool,
      input: request.input,
      sessionID: request.sessionID,
      scope: request.scope,
    }

    yield* parkEffect(store, req, ownerScope, { timeoutMs: request.timeoutMs })

    yield* Effect.try({
      try: () => store.markExecuting(request.callID),
      catch: (e) => (e instanceof BridgeError ? e : new BridgeError({ code: "invalid_tool", message: String(e), callID: request.callID })),
    })

    const askOk = yield* permission
      .ask({
        sessionID: request.sessionID as any,
        permission: request.tool,
        patterns: permissionPatternsFor(request.input),
        always: permissionPatternsFor(request.input),
        metadata: { source: "claude-bridge", tool: request.tool },
        tool: { messageID: messageID as any, callID: request.callID },
        ruleset: [],
      }).pipe(
        Effect.as(true as const),
        Effect.catch(() => Effect.succeed(false as const)),
      )

    if (!askOk) {
      yield* Effect.try({ try: () => store.deny(request.callID), catch: () => {} })
      return yield* new BridgeError({ code: "denied", message: `tool denied: ${request.tool}`, callID: request.callID })
    }

    if (!validateScope(request.scope, ownerScope)) {
      yield* Effect.try({ try: () => store.cancelSession(request.sessionID), catch: () => {} })
      return yield* new BridgeError({ code: "scope_mismatch", message: "scope mismatch after permission", callID: request.callID })
    }

    const toolDef = tools.find((t) => t.id === request.tool)
    if (!toolDef) {
      yield* Effect.try({ try: () => store.deny(request.callID), catch: () => {} })
      return yield* new BridgeError({ code: "invalid_tool", message: `tool not found: ${request.tool}`, callID: request.callID })
    }

    const toolResult = yield* executeToolDef(toolDef, request, messageID).pipe(
      Effect.catch((cause) =>
        Effect.succeed({
          title: request.tool,
          metadata: { error: String(cause) },
          output: `tool execution failed: ${String((cause as any)?.message ?? cause)}`,
        }),
      ),
    )

    const bridgeResult = yield* completeEffect(store, request.callID, {
      callID: request.callID,
      status: "success",
      output: toolResult.output,
    })

    return { bridgeResult, toolOutput: toolResult.output }
  })
}

function executeToolDef(toolDef: Tool.Def, request: BridgeExecuteInput, messageID: string) {
  return Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(toolDef.parameters)(request.input).pipe(
      Effect.catch(() => Effect.succeed(request.input as any)),
    )
    const ctx: Tool.Context = {
      sessionID: request.sessionID as any,
      messageID: messageID as any,
      agent: request.agent ?? "claude",
      abort: new AbortController().signal,
      callID: request.callID,
      extra: { claudeBridge: true },
      messages: [],
      metadata: () => Effect.void,
      ask: () => Effect.void,
    }
    return yield* (toolDef.execute as any)(decoded, ctx)
  })
}

// Convenience helpers for cancellation/disposal/list
export function cancelBridgeSession(store: BridgeStore, sessionID: string): PendingEntry[] {
  return store.cancelSession(sessionID)
}
export function disposeBridgeStore(store: BridgeStore): PendingEntry[] {
  return store.dispose()
}
export function listBridgeEntries(store: BridgeStore, sessionID?: string): PendingEntry[] {
  return store.list(sessionID)
}

export const ClaudeToolBridge = {
  getOrCreateStore,
  clearAllStores,
  executeBridgeTool,
  cancelBridgeSession,
  disposeBridgeStore,
  listBridgeEntries,
  ownerScope,
}

export * as ClaudeToolBridgeModule from "./tool-bridge"
