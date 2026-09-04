import { Effect, Schema } from "effect"
import { createHash } from "crypto"
import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import { claudeConfigDir, homeDir, type ChildEnv } from "./env"
import { SessionBindingError } from "./errors"

// ── Binding schema (OpenCode-owned, NOT Claude-owned) ──

export const Binding = Schema.Struct({
  openCodeSessionID: Schema.String,
  claudeSessionID: Schema.String,
  projectID: Schema.String,
  worktree: Schema.String,
  directory: Schema.String,
  cwd: Schema.String,
  modelFamily: Schema.String,
  settingsDigest: Schema.String,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
  invalidationReason: Schema.optional(Schema.String),
  lastErrorCategory: Schema.optional(Schema.String),
})
export type Binding = Schema.Schema.Type<typeof Binding>

export const MAX_HISTORY_TRANSFER_MESSAGES = 50
export const MAX_HISTORY_TRANSFER_CHARS = 200_000
export const BINDING_KEY_PREFIX = "claude/binding"

/** Locate a Claude-owned transcript without reading or mutating its contents. */
export function findTranscript(claudeSessionID: string, env: ChildEnv = process.env): string | undefined {
  const id = claudeSessionID.trim()
  if (!id) return undefined
  const configDir = claudeConfigDir(env) ?? (homeDir(env) ? path.join(homeDir(env)!, ".claude") : undefined)
  if (!configDir) return undefined
  const projectsDir = path.join(configDir, "projects")
  let projectDirs: string[]
  try {
    projectDirs = readdirSync(projectsDir)
  } catch {
    return undefined
  }
  for (const projectDir of projectDirs) {
    const candidate = path.join(projectsDir, projectDir, `${id}.jsonl`)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

export function transcriptExists(claudeSessionID: string, env: ChildEnv = process.env): boolean {
  return findTranscript(claudeSessionID, env) !== undefined
}

export type ValidationContext = {
  projectID: string
  worktree: string
  directory: string
  cwd: string
  modelFamily: string
  settingsDigest: string
  transcriptExists: boolean
}

export type ValidationResult =
  | { readonly valid: true; readonly binding: Binding }
  | { readonly valid: false; readonly reason: SessionBindingError["code"]; readonly message: string }

export type ResumeStrategy = "resume" | "fresh" | "historyTransfer"

export type ResumeDecision = {
  readonly strategy: ResumeStrategy
  readonly binding?: Binding
  readonly reason?: string
  // bounded history-transfer payload (never includes Claude-owned files)
  readonly historyTransfer?: {
    readonly messages: ReadonlyArray<{ role: string; content: string }>
    readonly truncated: boolean
  }
}

// ── Pure helpers (no I/O, fully testable) ──

export function hashSettings(settings: unknown): string {
  const normalized =
    JSON.stringify(
      settings ?? {},
      Object.keys(settings as any).sort?.() ? Object.keys(settings as any).sort() : undefined,
    ) ?? "{}"
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16)
}

export function modelFamilyOf(modelID: string): string {
  // e.g. claude-sonnet-4-5-20250514 -> claude-sonnet-4 (family without patch/date)
  const m = modelID.toLowerCase().match(/^(claude-[a-z]+-\d+)/)
  if (m) return m[1]!
  return modelID.split(/[-/]/).slice(0, 3).join("-").toLowerCase()
}

export function bindingKey(projectID: string, openCodeSessionID: string): string[] {
  return [BINDING_KEY_PREFIX, projectID, openCodeSessionID]
}

export function validateBinding(binding: Binding, ctx: ValidationContext): ValidationResult {
  if (binding.projectID !== ctx.projectID) {
    return {
      valid: false,
      reason: "project_mismatch",
      message: `project mismatch: binding ${binding.projectID} vs context ${ctx.projectID}`,
    }
  }
  if (binding.worktree !== ctx.worktree) {
    return { valid: false, reason: "worktree_mismatch", message: `worktree mismatch` }
  }
  // cwd must be within worktree/directory boundary; exact match required for resume
  if (binding.cwd !== ctx.cwd) {
    return { valid: false, reason: "cwd_mismatch", message: `cwd mismatch` }
  }
  if (binding.modelFamily !== ctx.modelFamily) {
    return {
      valid: false,
      reason: "model_mismatch",
      message: `model family mismatch: ${binding.modelFamily} vs ${ctx.modelFamily}`,
    }
  }
  if (binding.settingsDigest !== ctx.settingsDigest) {
    return { valid: false, reason: "digest_mismatch", message: `settings digest mismatch` }
  }
  if (!ctx.transcriptExists) {
    return { valid: false, reason: "transcript_missing", message: `external transcript missing` }
  }
  return { valid: true, binding }
}

export function invalidate(binding: Binding, reason: SessionBindingError["code"], message?: string): Binding {
  return {
    ...binding,
    invalidationReason: reason,
    lastErrorCategory: reason,
    updatedAt: Date.now(),
  }
}

export function createBinding(input: {
  openCodeSessionID: string
  claudeSessionID: string
  projectID: string
  worktree: string
  directory: string
  cwd: string
  modelID: string
  settings: unknown
}): Binding {
  const now = Date.now()
  return {
    openCodeSessionID: input.openCodeSessionID,
    claudeSessionID: input.claudeSessionID,
    projectID: input.projectID,
    worktree: input.worktree,
    directory: input.directory,
    cwd: input.cwd,
    modelFamily: modelFamilyOf(input.modelID),
    settingsDigest: hashSettings(input.settings),
    createdAt: now,
    updatedAt: now,
  }
}

export function decideResume(input: {
  binding: Binding | undefined
  ctx: ValidationContext
  historyMessages?: ReadonlyArray<{ role: string; content: string }>
}): ResumeDecision {
  if (!input.binding) {
    return { strategy: "fresh", reason: "no binding" }
  }
  const validated = validateBinding(input.binding, input.ctx)
  if (!validated.valid) {
    // Missing transcript or mismatched binding never resumes silently; use history-transfer or fresh
    const canTransfer = (input.historyMessages?.length ?? 0) > 0
    if (validated.reason === "transcript_missing" && canTransfer) {
      const bounded = boundHistory(input.historyMessages!)
      return {
        strategy: "historyTransfer",
        binding: invalidate(input.binding, validated.reason),
        reason: validated.message,
        historyTransfer: bounded,
      }
    }
    if (validated.reason === "transcript_missing") {
      return { strategy: "fresh", binding: invalidate(input.binding, validated.reason), reason: validated.message }
    }
    // For other stales, still allow bounded history transfer if available, else fresh
    if (canTransfer) {
      const bounded = boundHistory(input.historyMessages!)
      return {
        strategy: "historyTransfer",
        binding: invalidate(input.binding, validated.reason),
        reason: validated.message,
        historyTransfer: bounded,
      }
    }
    return { strategy: "fresh", binding: invalidate(input.binding, validated.reason), reason: validated.message }
  }
  return { strategy: "resume", binding: validated.binding }
}

export function boundHistory(messages: ReadonlyArray<{ role: string; content: string }>): {
  messages: ReadonlyArray<{ role: string; content: string }>
  truncated: boolean
} {
  const sliced = messages.slice(-MAX_HISTORY_TRANSFER_MESSAGES)
  let chars = 0
  const result: Array<{ role: string; content: string }> = []
  let truncated = sliced.length < messages.length
  for (const m of sliced) {
    const len = m.content.length
    if (chars + len > MAX_HISTORY_TRANSFER_CHARS) {
      truncated = true
      const remaining = MAX_HISTORY_TRANSFER_CHARS - chars
      if (remaining > 0) result.push({ role: m.role, content: m.content.slice(0, remaining) + " …truncated" })
      break
    }
    result.push(m)
    chars += len
  }
  return { messages: result, truncated }
}

// ── Storage abstraction (OpenCode-owned binding store) ──
// Never deletes Claude-owned files; only our binding JSON under storage/.

export interface BindingStorage {
  readonly read: (key: string[]) => Effect.Effect<Binding, SessionBindingError>
  readonly write: (key: string[], binding: Binding) => Effect.Effect<void, never>
  readonly remove: (key: string[]) => Effect.Effect<void, never>
  readonly list: (prefix: string[]) => Effect.Effect<string[][], never>
}

// In-memory implementation for tests / pure runtime
export function makeMemoryStorage(): BindingStorage & { map: Map<string, Binding> } {
  const map = new Map<string, Binding>()
  const keyOf = (k: string[]) => k.join("/")
  return {
    map,
    read: (key) => {
      const v = map.get(keyOf(key))
      if (!v)
        return Effect.fail(new SessionBindingError({ code: "not_found", message: `binding not found: ${keyOf(key)}` }))
      return Effect.succeed(v)
    },
    write: (key, binding) =>
      Effect.sync(() => {
        map.set(keyOf(key), binding)
      }),
    remove: (key) =>
      Effect.sync(() => {
        map.delete(keyOf(key))
      }),
    list: (prefix) =>
      Effect.sync(() => {
        const p = prefix.join("/")
        return [...map.keys()].filter((k) => k.startsWith(p)).map((k) => k.split("/"))
      }),
  }
}

// Effect helpers that compose validation + persistence

export const loadBinding = (storage: BindingStorage, projectID: string, openCodeSessionID: string) =>
  storage.read(bindingKey(projectID, openCodeSessionID))

export const saveBinding = (storage: BindingStorage, binding: Binding) =>
  storage.write(bindingKey(binding.projectID, binding.openCodeSessionID), binding)

export const removeBinding = (storage: BindingStorage, projectID: string, openCodeSessionID: string) =>
  storage.remove(bindingKey(projectID, openCodeSessionID))

export const resolveResumeEffect = (input: {
  storage: BindingStorage
  projectID: string
  openCodeSessionID: string
  ctx: ValidationContext
  historyMessages?: ReadonlyArray<{ role: string; content: string }>
  transcriptExists?: (binding: Binding) => Effect.Effect<boolean>
}) =>
  Effect.gen(function* () {
    const binding = yield* input.storage.read(bindingKey(input.projectID, input.openCodeSessionID)).pipe(
      Effect.catchIf(
        (e) => e instanceof SessionBindingError && e.code === "not_found",
        () => Effect.succeed(undefined as unknown as Binding),
      ),
    ) as Effect.Effect<Binding | undefined>
    const ctx =
      binding && input.transcriptExists
        ? { ...input.ctx, transcriptExists: yield* input.transcriptExists(binding) }
        : input.ctx
    const decision = decideResume({ binding, ctx, historyMessages: input.historyMessages })
    if (decision.binding?.invalidationReason) {
      yield* input.storage.write(bindingKey(input.projectID, input.openCodeSessionID), decision.binding)
    }
    return decision
  })

export * as ClaudeSessions from "./sessions"
