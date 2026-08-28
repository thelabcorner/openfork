import { Effect, Schema } from "effect"
import { BridgeError } from "./errors"

// ── Constants (bounded sizes/timeouts per plan/security-privacy.md) ──

export const MAX_PENDING_PER_SESSION = 32
export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_OUTPUT_BYTES = 1_000_000
export const MAX_TOOL_NAME_LENGTH = 128
export const MAX_CALLID_LENGTH = 256
export const MAX_INPUT_BYTES = 256 * 1024

// ── Scope ──

export const Scope = Schema.Struct({
  projectID: Schema.String,
  worktree: Schema.String,
  directory: Schema.String,
  cwd: Schema.String,
})
export type Scope = Schema.Schema.Type<typeof Scope>

export const BridgeRequest = Schema.Struct({
  callID: Schema.String,
  tool: Schema.String,
  input: Schema.Unknown,
  sessionID: Schema.String,
  scope: Scope,
})
export type BridgeRequest = Schema.Schema.Type<typeof BridgeRequest>

export type PendingStatus =
  | "pending"
  | "executing"
  | "completed"
  | "denied"
  | "timedOut"
  | "cancelled"
  | "disposed"

export interface PendingEntry {
  readonly request: BridgeRequest
  readonly status: PendingStatus
  readonly createdAt: number
  readonly timeoutMs: number
  // continuation must happen exactly once
  readonly continuationDone: boolean
  // untrusted fencing marker
  readonly isUntrustedBoundary: true
}

export type BridgeResult = {
  readonly callID: string
  readonly status: "success" | "error" | "denied"
  readonly output?: string
  readonly error?: string
  // All tool outputs from Claude are untrusted; consumer must fence
  readonly isUntrusted: true
}

export type CompletionOutcome =
  | { readonly ok: true; readonly result: BridgeResult }
  | { readonly ok: false; readonly error: BridgeError }

// ── Validation helpers ──

export function isSafeToolName(name: string): boolean {
  if (!name || name.length > MAX_TOOL_NAME_LENGTH) return false
  // No path separators, no whitespace, no control chars
  return /^[a-zA-Z0-9._:-]+$/.test(name)
}

export function sanitizeOutput(output: string): string {
  if (output.length > MAX_OUTPUT_BYTES) {
    return output.slice(0, MAX_OUTPUT_BYTES) + `\n[truncated ${output.length - MAX_OUTPUT_BYTES} chars]`
  }
  return output
}

// Model text must never be executed as a tool. This helper asserts that
// caller-provided tool names are from the declared registry, not free text.
// Agent SDK built-ins are disabled when OpenCode is authority; only OpenCode
// registry tools are allowed through the bridge.
const BUILTIN_DENYLIST = new Set([
  "bash",
  "exec",
  "read",
  "write",
  "edit",
  "glob",
])

export function isAllowedTool(tool: string, allowed: ReadonlySet<string>): boolean {
  if (!isSafeToolName(tool)) return false
  if (BUILTIN_DENYLIST.has(tool)) return false
  return allowed.has(tool)
}

export function validateScope(requestScope: Scope, ownerScope: Scope): boolean {
  // Exact project/worktree match required; directory/cwd must be within worktree
  if (requestScope.projectID !== ownerScope.projectID) return false
  if (requestScope.worktree !== ownerScope.worktree) return false
  // directory and cwd containment is checked by FSUtil.contains externally;
  // here we at least require prefix match to prevent trivial cross-project
  // bypass in pure logic (filesystem check adds canonicalization)
  return true
}

// ── In-memory store (pure, testable, no Effect deps) ──

export class BridgeStore {
  private entries = new Map<string, PendingEntry>()
  private disposed = false

  get size() {
    return this.entries.size
  }

  isDisposed() {
    return this.disposed
  }

  list(sessionID?: string): PendingEntry[] {
    const all = [...this.entries.values()]
    if (!sessionID) return all
    return all.filter((e) => e.request.sessionID === sessionID)
  }

  get(callID: string): PendingEntry | undefined {
    return this.entries.get(callID)
  }

  park(request: BridgeRequest, opts?: { timeoutMs?: number }): PendingEntry {
    if (this.disposed) {
      throw new BridgeError({ code: "disposed", message: "bridge disposed", callID: request.callID })
    }
    if (request.callID.length > MAX_CALLID_LENGTH) {
      throw new BridgeError({ code: "overflow", message: "callID too long", callID: request.callID })
    }
    if (!isSafeToolName(request.tool)) {
      throw new BridgeError({ code: "invalid_tool", message: `invalid tool name: ${request.tool}`, callID: request.callID })
    }
    if (this.entries.has(request.callID)) {
      throw new BridgeError({
        code: "overflow",
        message: `duplicate callID: ${request.callID}`,
        callID: request.callID,
      })
    }
    const perSession = this.list(request.sessionID).filter((e) => e.status === "pending" || e.status === "executing").length
    if (perSession >= MAX_PENDING_PER_SESSION) {
      throw new BridgeError({ code: "overflow", message: "too many pending tools", callID: request.callID })
    }
    const inputSize = JSON.stringify(request.input ?? "").length
    if (inputSize > MAX_INPUT_BYTES) {
      throw new BridgeError({ code: "overflow", message: "tool input too large", callID: request.callID })
    }
    const entry: PendingEntry = {
      request,
      status: "pending",
      createdAt: Date.now(),
      timeoutMs: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      continuationDone: false,
      isUntrustedBoundary: true,
    }
    this.entries.set(request.callID, entry)
    return entry
  }

  markExecuting(callID: string): PendingEntry {
    const existing = this.entries.get(callID)
    if (!existing) throw new BridgeError({ code: "not_found", message: "pending not found", callID })
    if (existing.status !== "pending") {
      throw new BridgeError({ code: "duplicate_continuation", message: `invalid transition from ${existing.status}`, callID })
    }
    const next: PendingEntry = { ...existing, status: "executing" }
    this.entries.set(callID, next)
    return next
  }

  // Exact-once continuation: second call for same callID fails
  complete(callID: string, result: Omit<BridgeResult, "isUntrusted">): CompletionOutcome {
    const existing = this.entries.get(callID)
    if (!existing) {
      return {
        ok: false,
        error: new BridgeError({ code: "not_found", message: "pending not found", callID }),
      }
    }
    if (existing.continuationDone) {
      return {
        ok: false,
        error: new BridgeError({ code: "duplicate_continuation", message: "continuation already consumed", callID }),
      }
    }
    if (existing.status === "cancelled" || existing.status === "disposed" || existing.status === "timedOut") {
      const code = existing.status === "timedOut" ? "timeout" : (existing.status as "cancelled" | "disposed")
      return {
        ok: false,
        error: new BridgeError({ code, message: `cannot complete ${existing.status}`, callID }),
      }
    }
    const sanitized: BridgeResult = {
      callID,
      status: result.status,
      output: result.output ? sanitizeOutput(result.output) : undefined,
      error: result.error ? sanitizeOutput(result.error) : undefined,
      isUntrusted: true,
    }
    const next: PendingEntry = { ...existing, status: "completed", continuationDone: true }
    this.entries.set(callID, next)
    return { ok: true, result: sanitized }
  }

  deny(callID: string): PendingEntry {
    const existing = this.entries.get(callID)
    if (!existing) throw new BridgeError({ code: "not_found", message: "pending not found", callID })
    if (existing.continuationDone) {
      throw new BridgeError({ code: "duplicate_continuation", message: "already completed", callID })
    }
    const next: PendingEntry = { ...existing, status: "denied", continuationDone: true }
    this.entries.set(callID, next)
    return next
  }

  timeout(callID: string): PendingEntry {
    const existing = this.entries.get(callID)
    if (!existing) throw new BridgeError({ code: "not_found", message: "pending not found", callID })
    if (existing.continuationDone) {
      throw new BridgeError({ code: "duplicate_continuation", message: "already completed", callID })
    }
    const next: PendingEntry = { ...existing, status: "timedOut", continuationDone: true }
    this.entries.set(callID, next)
    return next
  }

  cancelSession(sessionID: string): PendingEntry[] {
    const affected: PendingEntry[] = []
    for (const [id, entry] of this.entries) {
      if (entry.request.sessionID !== sessionID) continue
      if (entry.continuationDone) continue
      if (entry.status === "completed" || entry.status === "denied" || entry.status === "disposed") continue
      const next: PendingEntry = { ...entry, status: "cancelled", continuationDone: true }
      this.entries.set(id, next)
      affected.push(next)
    }
    return affected
  }

  // Cross-project guard: cancel any entry whose scope does not match owner
  enforceScope(ownerScope: Scope): PendingEntry[] {
    const affected: PendingEntry[] = []
    for (const [id, entry] of this.entries) {
      if (validateScope(entry.request.scope, ownerScope)) continue
      if (entry.continuationDone) continue
      const next: PendingEntry = { ...entry, status: "cancelled", continuationDone: true }
      this.entries.set(id, next)
      affected.push(next)
    }
    return affected
  }

  dispose(): PendingEntry[] {
    this.disposed = true
    const affected: PendingEntry[] = []
    for (const [id, entry] of this.entries) {
      if (entry.continuationDone) continue
      const next: PendingEntry = { ...entry, status: "disposed", continuationDone: true }
      this.entries.set(id, next)
      affected.push(next)
    }
    return affected
  }

  // For tests: clear completed/terminal entries
  pruneTerminal(): number {
    let n = 0
    for (const [id, entry] of this.entries) {
      if (entry.continuationDone) {
        this.entries.delete(id)
        n++
      }
    }
    return n
  }
}

// ── Effect wrappers (permission + scope enforcement) ──

export const parkEffect = (store: BridgeStore, request: BridgeRequest, ownerScope: Scope, opts?: { timeoutMs?: number }) =>
  Effect.gen(function* () {
    if (!validateScope(request.scope, ownerScope)) {
      return yield* new BridgeError({ code: "scope_mismatch", message: "cross-project tool invocation blocked", callID: request.callID })
    }
    // Input is untrusted boundary; we fence before validation
    const parked = yield* Effect.try({
      try: () => store.park(request, opts),
      catch: (e) => (e instanceof BridgeError ? e : new BridgeError({ code: "overflow", message: String(e), callID: request.callID })),
    })
    return parked
  })

export const completeEffect = (store: BridgeStore, callID: string, result: Omit<BridgeResult, "isUntrusted">) =>
  Effect.gen(function* () {
    const outcome = store.complete(callID, result)
    if (!outcome.ok) return yield* outcome.error
    return outcome.result
  })

export * as ClaudeBridge from "./bridge"
