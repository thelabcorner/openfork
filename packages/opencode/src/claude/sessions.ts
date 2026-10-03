import { Effect, Schema } from "effect"
import { createHash } from "crypto"
import { constants as fsConstants } from "node:fs"
import { access, open, readdir } from "node:fs/promises"
import path from "node:path"
import { claudeConfigDir, homeDir, type ChildEnv } from "./env"
import { SessionBindingError } from "./errors"

// ── Binding schema (OpenCode-owned, NOT Claude-owned) ──

export const TurnBoundary = Schema.Struct({
  count: Schema.Finite,
  hash: Schema.String,
  leafUuid: Schema.optional(Schema.String),
})
export type TurnBoundary = Schema.Schema.Type<typeof TurnBoundary>

export const Binding = Schema.Struct({
  openCodeSessionID: Schema.String,
  claudeSessionID: Schema.String,
  projectID: Schema.String,
  worktree: Schema.String,
  directory: Schema.String,
  cwd: Schema.String,
  modelFamily: Schema.String,
  settingsDigest: Schema.String,
  /** Last main-chain Claude transcript entry observed by this OpenFork session. */
  leafUuid: Schema.optional(Schema.String),
  /**
   * User-history boundaries, oldest first. These let a revert/edit resume from
   * the Claude leaf that matched the surviving OpenFork history instead of
   * following a newer foreign transcript branch.
   */
  turns: Schema.optional(Schema.Array(TurnBoundary)),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
  invalidationReason: Schema.optional(Schema.String),
  lastErrorCategory: Schema.optional(Schema.String),
})
export type Binding = Schema.Schema.Type<typeof Binding>

export const MAX_HISTORY_TRANSFER_MESSAGES = 50
export const MAX_HISTORY_TRANSFER_CHARS = 200_000
export const MAX_TURN_BOUNDARIES = 100
export const BINDING_KEY_PREFIX = "claude/binding"
/**
 * Hard cap on the number of Claude-owned project directories the fallback
 * transcript scan will examine. A lookup for an explicit cwd resolves in O(1)
 * via `claudeProjectDirName`; this cap only bounds the case where the cwd is
 * unknown or its encoding does not match.
 */
export const MAX_PROJECT_DIRS_SCANNED = 500

/**
 * Claude Code names a session's project directory by encoding its working
 * directory. We only need this as a fast-path hint: a mismatch merely skips
 * the O(1) candidate and falls through to the bounded scan.
 */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-")
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

/** Locate a Claude-owned transcript without reading or mutating its contents. */
export async function findTranscript(
  claudeSessionID: string,
  options?: { cwd?: string; env?: ChildEnv },
): Promise<string | undefined> {
  const env = options?.env ?? process.env
  const id = claudeSessionID.trim()
  if (!id) return undefined
  const configDir = claudeConfigDir(env) ?? (homeDir(env) ? path.join(homeDir(env)!, ".claude") : undefined)
  if (!configDir) return undefined
  const projectsDir = path.join(configDir, "projects")
  const fileName = `${id}.jsonl`

  // O(1) fast path: an explicit cwd maps to exactly one project directory.
  const cwd = options?.cwd?.trim()
  if (cwd) {
    const derived = path.join(projectsDir, claudeProjectDirName(cwd), fileName)
    if (await fileExists(derived)) return derived
  }

  // Bounded fallback for an unknown cwd or unexpected encoding. Non-blocking
  // and capped so a large history cannot turn one resume check into an
  // unbounded synchronous directory walk.
  let projectDirs: string[]
  try {
    projectDirs = await readdir(projectsDir)
  } catch {
    return undefined
  }
  const limit = Math.min(projectDirs.length, MAX_PROJECT_DIRS_SCANNED)
  for (let i = 0; i < limit; i++) {
    const candidate = path.join(projectsDir, projectDirs[i], fileName)
    if (await fileExists(candidate)) return candidate
  }
  return undefined
}

export async function transcriptExists(
  claudeSessionID: string,
  options?: { cwd?: string; env?: ChildEnv },
): Promise<boolean> {
  return (await findTranscript(claudeSessionID, options)) !== undefined
}

/**
 * Verify that a known Claude transcript entry still exists without reading a
 * potentially multi-megabyte JSONL file into memory. Resume leaves are almost
 * always near the tail, so scan backwards in bounded chunks.
 */
export async function transcriptHasEntry(
  claudeSessionID: string,
  uuid: string,
  options?: { cwd?: string; env?: ChildEnv; chunkBytes?: number },
): Promise<boolean> {
  const transcript = await findTranscript(claudeSessionID, options)
  const id = uuid.trim()
  if (!transcript || !id) return false
  const chunkBytes = Math.max(4_096, options?.chunkBytes ?? 256 * 1024)
  const needle = Buffer.from(`"uuid":"${id}"`, "utf8")
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(transcript, "r")
    let end = (await handle.stat()).size
    let carry = Buffer.alloc(0)
    while (end > 0) {
      const start = Math.max(0, end - chunkBytes)
      const chunk = Buffer.alloc(end - start)
      await handle.read(chunk, 0, chunk.length, start)
      const window = carry.length === 0 ? chunk : Buffer.concat([chunk, carry])
      if (window.includes(needle)) return true
      carry = window.subarray(0, Math.min(window.length, Math.max(0, needle.length - 1)))
      end = start
    }
    return false
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => {})
  }
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
  /** Pin the Agent SDK resume to this known main-chain transcript entry. */
  readonly resumeSessionAt?: string
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
  leafUuid?: string
  turnBoundary?: Omit<TurnBoundary, "leafUuid">
}): Binding {
  const now = Date.now()
  const turns = input.turnBoundary
    ? [{ ...input.turnBoundary, ...(input.leafUuid ? { leafUuid: input.leafUuid } : {}) }]
    : undefined
  return {
    openCodeSessionID: input.openCodeSessionID,
    claudeSessionID: input.claudeSessionID,
    projectID: input.projectID,
    worktree: input.worktree,
    directory: input.directory,
    cwd: input.cwd,
    modelFamily: modelFamilyOf(input.modelID),
    settingsDigest: hashSettings(input.settings),
    ...(input.leafUuid ? { leafUuid: input.leafUuid } : {}),
    ...(turns ? { turns } : {}),
    createdAt: now,
    updatedAt: now,
  }
}

function sameBoundary(
  a: Pick<TurnBoundary, "count" | "hash"> | undefined,
  b: Pick<TurnBoundary, "count" | "hash">,
): boolean {
  return !!a && a.count === b.count && a.hash === b.hash
}

export function historyBoundary(fingerprints: readonly string[]): Omit<TurnBoundary, "leafUuid"> | undefined {
  const hash = fingerprints.at(-1)
  return hash ? { count: fingerprints.length, hash } : undefined
}

/**
 * Record the user-history shape at the start of a turn. The new boundary
 * initially points at the current leaf (the place the turn starts from); on
 * settlement advanceBindingLeaf() moves it to the new main-chain leaf.
 */
export function recordTurnStart(
  binding: Binding,
  boundary: Omit<TurnBoundary, "leafUuid">,
  before?: Omit<TurnBoundary, "leafUuid">,
): Binding {
  const turns = [...(binding.turns ?? [])]
  if (turns.length === 0 && before && before.count > 0 && !sameBoundary(before, boundary)) {
    turns.push({ ...before, ...(binding.leafUuid ? { leafUuid: binding.leafUuid } : {}) })
  }
  if (!sameBoundary(turns.at(-1), boundary)) {
    turns.push({ ...boundary, ...(binding.leafUuid ? { leafUuid: binding.leafUuid } : {}) })
  }
  const bounded = turns.slice(-MAX_TURN_BOUNDARIES)
  if (JSON.stringify(bounded) === JSON.stringify(binding.turns ?? [])) return binding
  return { ...binding, turns: bounded, updatedAt: Date.now() }
}

export type TurnHistoryMatch =
  | { readonly kind: "untracked" }
  | { readonly kind: "latest" }
  | { readonly kind: "rewind"; readonly index: number; readonly leafUuid?: string }
  | { readonly kind: "diverged" }

/**
 * Compare OpenFork's surviving user history with the boundaries recorded for
 * the Claude transcript. Assistant serialization is deliberately ignored.
 */
export function matchTurnHistory(turns: readonly TurnBoundary[], fingerprints: readonly string[]): TurnHistoryMatch {
  const latest = turns.at(-1)
  if (!latest) return { kind: "untracked" }
  const count = fingerprints.length
  if (count >= latest.count && fingerprints[latest.count - 1] === latest.hash) return { kind: "latest" }
  for (let i = turns.length - 2; i >= 0; i--) {
    const turn = turns[i]!
    if (turn.count === count && fingerprints[count - 1] === turn.hash) {
      return { kind: "rewind", index: i, ...(turn.leafUuid ? { leafUuid: turn.leafUuid } : {}) }
    }
  }
  return { kind: "diverged" }
}

export function rewindBinding(binding: Binding, index: number): Binding {
  const target = binding.turns?.[index]
  if (!target) return binding
  return {
    ...binding,
    ...(target.leafUuid ? { leafUuid: target.leafUuid } : { leafUuid: undefined }),
    turns: binding.turns!.slice(0, index + 1),
    updatedAt: Date.now(),
  }
}

export function advanceBindingLeaf(binding: Binding, leafUuid: string | undefined): Binding {
  if (!leafUuid) return binding
  const turns = [...(binding.turns ?? [])]
  if (turns.length > 0) turns[turns.length - 1] = { ...turns.at(-1)!, leafUuid }
  const sameLeaf = binding.leafUuid === leafUuid
  const sameTurns = JSON.stringify(turns) === JSON.stringify(binding.turns ?? [])
  if (sameLeaf && sameTurns && !binding.invalidationReason && !binding.lastErrorCategory) return binding
  return {
    ...binding,
    leafUuid,
    ...(turns.length > 0 ? { turns } : {}),
    updatedAt: Date.now(),
    invalidationReason: undefined,
    lastErrorCategory: undefined,
  }
}

/** Rebind a live Claude transcript after Claude Code makes a session-scoped model fallback. */
export function rebindBindingModel(binding: Binding, modelID: string, settings: unknown): Binding {
  const modelFamily = modelFamilyOf(modelID)
  const settingsDigest = hashSettings(settings)
  if (
    binding.modelFamily === modelFamily &&
    binding.settingsDigest === settingsDigest &&
    !binding.invalidationReason &&
    !binding.lastErrorCategory
  )
    return binding
  return {
    ...binding,
    modelFamily,
    settingsDigest,
    updatedAt: Date.now(),
    invalidationReason: undefined,
    lastErrorCategory: undefined,
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
  /** User-message fingerprints for the whole request history, including the current turn. */
  historyFingerprints?: readonly string[]
  /** User-message fingerprints strictly before the current turn. */
  priorHistoryFingerprints?: readonly string[]
  transcriptExists?: (binding: Binding) => Effect.Effect<boolean>
  transcriptHasEntry?: (binding: Binding, uuid: string) => Effect.Effect<boolean>
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
    let decision = decideResume({ binding, ctx, historyMessages: input.historyMessages })

    if (decision.strategy === "resume" && decision.binding) {
      let active = decision.binding
      const prior = input.priorHistoryFingerprints
      // An adapter/test may intentionally provide only the current user turn.
      // With no prior history there is not enough evidence to call the binding
      // divergent, so preserve legacy plain-resume behavior.
      if (prior && prior.length > 0 && active.turns?.length) {
        const match = matchTurnHistory(active.turns, prior)
        if (match.kind === "rewind") {
          if (!match.leafUuid) {
            const stale = invalidate(active, "stale", "history rewind has no safe Claude resume leaf")
            decision =
              (input.historyMessages?.length ?? 0) > 0
                ? {
                    strategy: "historyTransfer",
                    binding: stale,
                    reason: "OpenFork history moved behind the tracked Claude transcript",
                    historyTransfer: boundHistory(input.historyMessages!),
                  }
                : { strategy: "fresh", binding: stale, reason: "OpenFork history moved behind the tracked Claude transcript" }
          } else {
            const exists = input.transcriptHasEntry ? yield* input.transcriptHasEntry(active, match.leafUuid) : false
            if (!exists) {
              const stale = invalidate(active, "stale", "tracked Claude resume leaf is missing")
              decision =
                (input.historyMessages?.length ?? 0) > 0
                  ? {
                      strategy: "historyTransfer",
                      binding: stale,
                      reason: "Tracked Claude rewind point is no longer present",
                      historyTransfer: boundHistory(input.historyMessages!),
                    }
                  : { strategy: "fresh", binding: stale, reason: "Tracked Claude rewind point is no longer present" }
            } else {
              active = rewindBinding(active, match.index)
              decision = { strategy: "resume", binding: active, resumeSessionAt: match.leafUuid }
            }
          }
        } else if (match.kind === "diverged") {
          const stale = invalidate(active, "stale", "OpenFork history diverged from tracked Claude boundaries")
          decision =
            (input.historyMessages?.length ?? 0) > 0
              ? {
                  strategy: "historyTransfer",
                  binding: stale,
                  reason: "OpenFork history no longer matches the Claude transcript",
                  historyTransfer: boundHistory(input.historyMessages!),
                }
              : { strategy: "fresh", binding: stale, reason: "OpenFork history no longer matches the Claude transcript" }
        }
      }

      if (decision.strategy === "resume" && decision.binding && !decision.resumeSessionAt && decision.binding.leafUuid) {
        const exists = input.transcriptHasEntry
          ? yield* input.transcriptHasEntry(decision.binding, decision.binding.leafUuid)
          : false
        if (exists) {
          decision = { ...decision, resumeSessionAt: decision.binding.leafUuid }
        } else if (input.transcriptHasEntry) {
          const stale = invalidate(decision.binding, "stale", "tracked Claude resume leaf is missing")
          decision =
            (input.historyMessages?.length ?? 0) > 0
              ? {
                  strategy: "historyTransfer",
                  binding: stale,
                  reason: "Tracked Claude resume point is no longer present",
                  historyTransfer: boundHistory(input.historyMessages!),
                }
              : { strategy: "fresh", binding: stale, reason: "Tracked Claude resume point is no longer present" }
        }
      }

      const current = historyBoundary(input.historyFingerprints ?? [])
      if (decision.strategy === "resume" && decision.binding && current) {
        const before = historyBoundary(input.priorHistoryFingerprints ?? [])
        const recorded = recordTurnStart(decision.binding, current, before)
        if (recorded !== decision.binding) {
          decision = { ...decision, binding: recorded }
        }
      }
    }

    if (
      decision.binding &&
      decision.binding !== binding &&
      (decision.binding.invalidationReason || decision.strategy === "resume")
    ) {
      yield* input.storage.write(bindingKey(input.projectID, input.openCodeSessionID), decision.binding)
    }
    return decision
  })

export * as ClaudeSessions from "./sessions"
