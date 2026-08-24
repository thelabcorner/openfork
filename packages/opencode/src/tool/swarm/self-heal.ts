import { Effect } from "effect"

export type SwarmStatus = "active" | "archived" | "frozen" | "paused"
export type MemberStatus = "working" | "idle" | "interrupted" | "stopped" | "reviewing"

export interface ModelRef {
  providerID: string
  modelID: string
}

export interface SwarmTarget {
  id: string
  name: string
  status: SwarmStatus
}

export interface MemberLike {
  name: string
  status: MemberStatus
}

export interface MemberInput {
  name: string
  role?: string
  prompt?: string
  model?: ModelRef | string
  capability?: string
  taskId?: string
}

export interface ModelCatalogEntry {
  providerID: string
  modelID: string
  label?: string
  aliases?: string[]
}

export interface CoordinatorContext {
  model: ModelRef
}

export interface SwarmStore {
  getByNameOrId(ref: string): Effect.Effect<SwarmTarget | undefined>
  create(name: string, opts: unknown): Effect.Effect<SwarmTarget>
  revive(
    swarm: SwarmTarget,
    opts: { strategy?: "keep" | "fresh"; includeStopped?: boolean },
  ): Effect.Effect<SwarmTarget>
  listMembers(swarm: SwarmTarget): Effect.Effect<MemberLike[]>
  removeMember(swarm: SwarmTarget, name: string): Effect.Effect<void>
  spawnOne(swarm: SwarmTarget, member: MemberInput): Effect.Effect<void>
  wakeOne?(swarm: SwarmTarget, name: string): Effect.Effect<void>
  reviveMember?(swarm: SwarmTarget, name: string): Effect.Effect<void>
  replyPermission?(
    swarm: SwarmTarget,
    permissionId: string,
    response: "once" | "always" | "reject",
  ): Effect.Effect<"answered" | "expired" | "gone">
  allowRule?(swarm: SwarmTarget, pattern: string, response: "once" | "always" | "reject"): Effect.Effect<void>
}

export const MEMBER_LIMIT = 10
export const SELF_MODEL_SENTINELS = ["self", "current", "@me", "same", "dots3"]
export const DEAD_MEMBER_STATUSES: MemberStatus[] = ["interrupted", "stopped"]

export class SwarmNotFoundError extends Error {
  constructor(public ref: string) {
    super(`No swarm matches '${ref}'.`)
    this.name = "SwarmNotFoundError"
  }
}

export class MemberNotFoundError extends Error {
  constructor(public swarm: string, public member: string) {
    super(`member '${member}' not found in swarm '${swarm}'.`)
    this.name = "MemberNotFoundError"
  }
}

function isArchived(s: SwarmTarget): boolean {
  return s.status === "archived"
}

function archivedError(ref: string): Error {
  return new Error(
    `swarm '${ref}' is not active (archived). It has been auto-revived; if you still see this, retry the call. ` +
      `Manual fix: swarm_revive action=revive strategy=keep includeStopped=true.`,
  )
}

export function normalizeSwarmId(input: Record<string, unknown>): Record<string, unknown> {
  if (input.swarmId === undefined && typeof input.armId === "string") {
    return { ...input, swarmId: input.armId }
  }
  return input
}

export function resolveSwarmTarget(
  store: SwarmStore,
  ref: string,
  opts: { coordinator: CoordinatorContext; createIfMissing?: boolean; autoRevive?: boolean },
): Effect.Effect<SwarmTarget, Error, never> {
  return Effect.gen(function* () {
    const existing = (yield* store.getByNameOrId(ref) as Effect.Effect<SwarmTarget | undefined, never, never>)
    if (!existing) {
      if (opts.createIfMissing) return yield* store.create(ref, {}) as Effect.Effect<SwarmTarget, never, never>
      return yield* Effect.fail(new SwarmNotFoundError(ref))
    }
    if (isArchived(existing) && (opts.autoRevive ?? true)) {
      const revived = yield* (store
        .revive(existing, { strategy: "keep", includeStopped: true }) as Effect.Effect<SwarmTarget, never, never>).pipe(
        Effect.catch(() => Effect.fail(archivedError(ref))),
      )
      return revived
    }
    if (isArchived(existing)) {
      return yield* Effect.fail(archivedError(ref))
    }
    return existing
  })
}

export function resolveModelRef(
  raw: ModelRef | string | undefined,
  ctx: CoordinatorContext,
  catalog: ModelCatalogEntry[],
): ModelRef {
  if (raw === undefined) return ctx.model
  if (typeof raw === "object" && raw !== null && "modelID" in raw) return raw as ModelRef
  const q = String(raw).trim().toLowerCase()
  if (SELF_MODEL_SENTINELS.includes(q)) return ctx.model
  const hit = catalog.find(
    (m) =>
      m.modelID.toLowerCase() === q ||
      `${m.providerID}/${m.modelID}`.toLowerCase() === q ||
      m.label?.toLowerCase().includes(q) ||
      m.aliases?.some((a) => a.toLowerCase() === q || a.toLowerCase().includes(q)),
  )
  if (hit) return { providerID: hit.providerID, modelID: hit.modelID }
  const aliasHint = catalog
    .filter((m) => m.aliases?.some((a) => a.toLowerCase().includes(q)))
    .map((m) => `${m.providerID}/${m.modelID}`)
    .slice(0, 3)
  const suffix = aliasHint.length
    ? ` Did you mean: ${aliasHint.join(", ")}?`
    : ` Available aliases include 'self' (your own ${ctx.model.providerID}/${ctx.model.modelID}).`
  throw new Error(`Could not resolve model '${raw}'.${suffix} Call swarm_models to list exact refs.`)
}

export function rankModelsForCoordinator(
  catalog: ModelCatalogEntry[],
  ctx: CoordinatorContext,
  query?: string,
): ModelCatalogEntry[] {
  const q = query?.trim().toLowerCase()
  const scored = catalog.map((m) => {
    let score = 0
    const hay = `${m.providerID}/${m.modelID} ${m.label ?? ""} ${(m.aliases ?? []).join(" ")}`.toLowerCase()
    if (m.providerID === ctx.model.providerID && m.modelID === ctx.model.modelID) score += 100
    if (q) {
      if (hay.includes(q)) score += 10
      if (m.modelID.toLowerCase() === q) score += 50
      if (m.label?.toLowerCase().includes(q)) score += 20
    }
    return { m, score }
  })
  return scored
    .filter((s) => (q ? s.score > 0 : true))
    .sort((a, b) => b.score - a.score)
    .map((s) => s.m)
}

export function evictDeadToFit(
  store: SwarmStore,
  swarm: SwarmTarget,
  needed: number,
  limit = MEMBER_LIMIT,
): Effect.Effect<{ evicted: string[]; free: number }> {
  return Effect.gen(function* () {
    const members = yield* store.listMembers(swarm)
    const dead = members.filter((m) => DEAD_MEMBER_STATUSES.includes(m.status))
    const evicted: string[] = []
    let free = limit - members.length
    for (const m of dead) {
      if (free >= needed) break
      yield* store.removeMember(swarm, m.name)
      evicted.push(m.name)
      free++
    }
    return { evicted, free }
  })
}

export function recoverInterruptedMembers(
  store: SwarmStore,
  swarm: SwarmTarget,
): Effect.Effect<{ recovered: string[] }> {
  return Effect.gen(function* () {
    if (!store.reviveMember) return { recovered: [] }
    const members = yield* store.listMembers(swarm)
    const interrupted = members.filter((m) => m.status === "interrupted")
    const recovered: string[] = []
    for (const m of interrupted) {
      yield* store.reviveMember(swarm, m.name)
      recovered.push(m.name)
    }
    return { recovered }
  })
}

export interface SpawnResult {
  spawned: string[]
  skipped: string[]
  evicted: string[]
  recovered: string[]
}

export interface SpawnOptions {
  replace?: boolean
}

export function spawnMembersAtomic(
  store: SwarmStore,
  swarm: SwarmTarget,
  members: MemberInput[],
  limit = MEMBER_LIMIT,
  opts: SpawnOptions = {},
): Effect.Effect<SpawnResult, Error> {
  if (!members || members.length === 0) {
    return Effect.fail(
      new Error(
        `swarm_spawn received no members. Provide a 'members' array, or call swarm_wake to recover existing interrupted members instead of re-spawning.`,
      ),
    )
  }
  return Effect.gen(function* () {
    const recovered = yield* recoverInterruptedMembers(store, swarm)
    const existing = yield* store.listMembers(swarm)
    const existingNames = new Set(existing.map((m) => m.name))

    if (opts.replace) {
      for (const m of members) {
        if (existingNames.has(m.name)) {
          yield* store.removeMember(swarm, m.name)
        }
      }
    }

    const liveAfterReplace = yield* store.listMembers(swarm)
    const stillExisting = new Set(liveAfterReplace.map((m) => m.name))
    const toCreate = members.filter((m) => !stillExisting.has(m.name))
    const skipped = members.filter((m) => stillExisting.has(m.name)).map((m) => m.name)
    let free = limit - liveAfterReplace.length
    let evicted: string[] = []
    if (toCreate.length > free) {
      const ev = yield* evictDeadToFit(store, swarm, toCreate.length - free, limit)
      evicted = ev.evicted
      free = ev.free
    }
    if (toCreate.length > free) {
      return yield* Effect.fail(
        new Error(
          `Cannot add ${toCreate.length} new member(s) to '${swarm.name}': only ${free} roster slot(s) free ` +
            `after auto-evicting ${evicted.length} dead member(s). Remove live members explicitly with swarm_remove, ` +
            `or raise the swarm member limit (currently ${limit}).`,
        ),
      )
    }
    const spawned: string[] = []
    for (const m of toCreate) {
      yield* store.spawnOne(swarm, m)
      spawned.push(m.name)
    }
    return { spawned, skipped, evicted, recovered: recovered.recovered }
  })
}

export function wakeMemberSelfHeal(
  store: SwarmStore,
  swarm: SwarmTarget,
  name: string,
): Effect.Effect<{ before: MemberStatus | undefined; status: string; recovered: boolean }, MemberNotFoundError, never> {
  return Effect.gen(function* () {
    const members = yield* store.listMembers(swarm)
    const m = members.find((x) => x.name === name)
    if (!m) return yield* Effect.fail(new MemberNotFoundError(swarm.name, name))
    if (m.status === "interrupted" || m.status === "stopped") {
      if (store.reviveMember) {
        yield* store.reviveMember(swarm, name)
        return { before: m.status, status: "working", recovered: true }
      }
      return { before: m.status, status: m.status, recovered: false }
    }
    if (store.wakeOne) yield* store.wakeOne(swarm, name)
    return { before: m.status, status: m.status, recovered: false }
  })
}

export function batchRemove(
  store: SwarmStore,
  swarm: SwarmTarget,
  members: string[],
): Effect.Effect<{ removed: string[]; missing: string[] }> {
  return Effect.gen(function* () {
    const current = yield* store.listMembers(swarm)
    const currentNames = new Set(current.map((m) => m.name))
    const removed: string[] = []
    const missing: string[] = []
    for (const forEachName of members) {
      const name = forEachName
      if (!currentNames.has(name)) {
        missing.push(name)
        continue
      }
      yield* store.removeMember(swarm, name)
      removed.push(name)
    }
    return { removed, missing }
  })
}

export const __SWARM_SELF_HEAL_OK = true
