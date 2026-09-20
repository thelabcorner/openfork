export * as SessionTurnProvenance from "./session-turn-provenance"

/**
 * Shared semantic vocabulary for durable conversational turns.
 *
 * Runtime schemas keep their own message-id brands, but first-party source
 * meaning is defined exactly once here so V1 and current/V2 cannot drift on
 * ownership, worker-root eligibility, durable user-action authorization, or causal lineage.
 */
export const Source = {
  Prompt: "prompt",
  Command: "command",
  Shell: "shell",
  PlanApproval: "plan.approval",
  GoalStart: "goal.start",
  GoalUpdate: "goal.update",
  HostPrompt: "host.prompt",
  ScheduledTaskRun: "scheduled-task.run",
  TaskSummary: "task.summary",
  BackgroundShellSummary: "background.shell.summary",
  GoalSpecification: "goal.spec",
  GoalProgress: "goal.progress",
  GoalContinuation: "goal.continuation",
  RecoveryContinuation: "recovery.continuation",
  UnknownFinishContinuation: "provider.unknown-finish.continuation",
  Compaction: "compaction",
  CompactionReplay: "compaction.replay",
  CompactionContinue: "compaction.continue",
  PromptRevisor: "special-agent.prompt-revisor",
  GoalRevisor: "special-agent.goal-revisor",
  SessionTitle: "special-agent.session-title",
  GoalAuditor: "special-agent.goal-auditor",
  SpadAuditor: "special-agent.spad-auditor",
  ProjectCopyName: "host-helper.project-copy-name",
  OxpSupervisor: "oxp.supervisor",
  OxpDelegation: "oxp.delegation",
  SwarmAssignment: "swarm.assignment",
  SwarmPeer: "swarm.peer",
  SwarmContinuation: "swarm.continuation",
  SwarmRecovery: "swarm.recovery",
  SwarmNotice: "swarm.notice",
} as const

export type Source = (typeof Source)[keyof typeof Source]
export type Owner = "user" | "host"
export type SemanticKind = "user" | "synthetic" | "shell" | "compaction"
export type Lineage = "root" | "derived" | "state"
export type Lifetime = "historical"

/**
 * Minimal browser-safe message metadata needed to interpret provenance. Runtime
 * packages may use branded ids and richer message shapes; presentation clients
 * intentionally do not need those brands merely to classify ownership/kind.
 */
export type ProvenanceLike =
  | { readonly owner: "user"; readonly source: string; readonly lifetime?: Lifetime }
  | {
      readonly owner: "host"
      readonly source: string
      readonly sourceMessageID?: string
      readonly ref?: string
      readonly lifetime?: Lifetime
    }

export type InfoLike = {
  readonly role?: string
  readonly provenance?: ProvenanceLike
}

export type Policy = {
  readonly owner: Owner
  readonly kind: SemanticKind
  readonly lineage: Lineage
  readonly workerPrompt?: true
  /**
   * A live user-authored root whose text may authorize creation of durable
   * user-owned domain state. Domain-specific policy must still prove *what*
   * the user authorized; this bit proves only *who* may authorize it.
   */
  readonly durableUserActionAuthorization?: true
  /** Producer must supply a durable O(1) correlation identity in provenance.ref. */
  readonly correlation?: "required"
}

/**
 * Exhaustive first-party provenance policy. Adding a source without defining
 * its semantics is a compile-time error instead of a permissive runtime fallthrough.
 */
export const policies = {
  [Source.Prompt]: {
    owner: "user",
    kind: "user",
    lineage: "root",
    workerPrompt: true,
    durableUserActionAuthorization: true,
  },
  [Source.Command]: {
    owner: "user",
    kind: "user",
    lineage: "root",
    workerPrompt: true,
    durableUserActionAuthorization: true,
  },
  [Source.Shell]: { owner: "user", kind: "shell", lineage: "root" },
  [Source.PlanApproval]: { owner: "user", kind: "synthetic", lineage: "root" },
  [Source.GoalStart]: { owner: "user", kind: "user", lineage: "root", workerPrompt: true },
  [Source.GoalUpdate]: { owner: "user", kind: "user", lineage: "root", workerPrompt: true },
  [Source.HostPrompt]: { owner: "host", kind: "synthetic", lineage: "root", workerPrompt: true },
  [Source.ScheduledTaskRun]: {
    owner: "host",
    kind: "synthetic",
    lineage: "root",
    workerPrompt: true,
    correlation: "required",
  },
  [Source.TaskSummary]: { owner: "host", kind: "synthetic", lineage: "derived" },
  [Source.BackgroundShellSummary]: {
    owner: "host",
    kind: "synthetic",
    lineage: "derived",
    correlation: "required",
  },
  [Source.GoalSpecification]: { owner: "host", kind: "synthetic", lineage: "state" },
  [Source.GoalProgress]: { owner: "host", kind: "synthetic", lineage: "state" },
  [Source.GoalContinuation]: { owner: "host", kind: "synthetic", lineage: "derived" },
  [Source.RecoveryContinuation]: { owner: "host", kind: "synthetic", lineage: "derived" },
  [Source.UnknownFinishContinuation]: { owner: "host", kind: "synthetic", lineage: "derived" },
  [Source.Compaction]: { owner: "host", kind: "compaction", lineage: "derived" },
  [Source.CompactionReplay]: { owner: "host", kind: "synthetic", lineage: "derived" },
  [Source.CompactionContinue]: { owner: "host", kind: "synthetic", lineage: "derived" },
  [Source.PromptRevisor]: { owner: "host", kind: "synthetic", lineage: "root" },
  [Source.GoalRevisor]: { owner: "host", kind: "synthetic", lineage: "root" },
  [Source.SessionTitle]: { owner: "host", kind: "synthetic", lineage: "root" },
  [Source.GoalAuditor]: { owner: "host", kind: "synthetic", lineage: "root" },
  [Source.SpadAuditor]: { owner: "host", kind: "synthetic", lineage: "root" },
  [Source.ProjectCopyName]: { owner: "host", kind: "synthetic", lineage: "root" },
  [Source.OxpSupervisor]: {
    owner: "host",
    kind: "synthetic",
    lineage: "root",
    workerPrompt: true,
    correlation: "required",
  },
  [Source.OxpDelegation]: {
    owner: "host",
    kind: "synthetic",
    lineage: "root",
    workerPrompt: true,
    correlation: "required",
  },
  [Source.SwarmAssignment]: {
    owner: "host",
    kind: "synthetic",
    lineage: "root",
    workerPrompt: true,
    correlation: "required",
  },
  [Source.SwarmPeer]: {
    owner: "host",
    kind: "synthetic",
    lineage: "root",
    workerPrompt: true,
    correlation: "required",
  },
  [Source.SwarmContinuation]: {
    owner: "host",
    kind: "synthetic",
    lineage: "derived",
    correlation: "required",
  },
  [Source.SwarmRecovery]: {
    owner: "host",
    kind: "synthetic",
    lineage: "root",
    workerPrompt: true,
    correlation: "required",
  },
  [Source.SwarmNotice]: {
    owner: "host",
    kind: "synthetic",
    lineage: "root",
    workerPrompt: true,
    correlation: "required",
  },
} satisfies Record<Source, Policy>

/** Canonical first-party host producers accepted by trusted admission seams. */
export type CanonicalHostSource = {
  [K in Source]: (typeof policies)[K]["owner"] extends "host" ? K : never
}[Source]

/** Canonical first-party user producers accepted by trusted user-action seams. */
export type CanonicalUserSource = {
  [K in Source]: (typeof policies)[K]["owner"] extends "user" ? K : never
}[Source]

export function policy(source: string): Policy | undefined {
  return Object.hasOwn(policies, source) ? policies[source as Source] : undefined
}

export function assertCanonicalOwner(source: string, owner: Owner) {
  const expected = policy(source)?.owner
  if (expected && expected !== owner) throw new Error(`Turn source ${source} is owned by ${expected}, not ${owner}`)
}

export function requiresCausalRoot(source: string) {
  return policy(source)?.lineage === "derived"
}

export function requiresCorrelation(source: string) {
  return policy(source)?.correlation === "required"
}

/** Semantic STATE-shaped source, independent of whether the record is live or historical. */
export function isStateKind(source: string) {
  return policy(source)?.lineage === "state"
}

/** @deprecated Prefer isStateKind when asking about source semantics. */
export function isStateProjection(source: string) {
  return isStateKind(source)
}

/** Historical/imported turns preserve authorship and presentation, never live authority. */
export function isHistorical(provenance: ProvenanceLike | undefined) {
  return provenance?.lifetime === "historical"
}

/**
 * Info-only semantic classification for clients that do not hydrate V1 parts.
 * Explicit provenance is authoritative. An unstamped role=user row retains the
 * historical user interpretation as the intentionally quarantined compatibility
 * fallback; part-based legacy inference remains a runtime/V1 responsibility.
 */
export function semanticKindInfo(info: InfoLike): SemanticKind | undefined {
  if (info.role !== "user") return undefined
  const provenance = info.provenance
  if (!provenance) return "user"
  const source = policy(provenance.source)
  return source?.owner === provenance.owner ? source.kind : provenance.owner === "user" ? "user" : "synthetic"
}

export function isSemanticUserInfo(info: InfoLike) {
  return semanticKindInfo(info) === "user"
}

export function isWorkerPromptInfo(info: InfoLike) {
  if (info.role !== "user") return false
  const provenance = info.provenance
  if (!provenance) return true
  if (isHistorical(provenance)) return false
  const source = policy(provenance.source)
  return source?.workerPrompt === true && source.owner === provenance.owner
}

export function isHostPromptInfo(info: InfoLike) {
  const provenance = info.provenance
  return (
    info.role === "user" &&
    provenance?.owner === "host" &&
    !isHistorical(provenance) &&
    provenance.source === Source.HostPrompt
  )
}

export function isStateProjectionInfo(info: InfoLike) {
  const provenance = info.provenance
  return (
    info.role === "user" &&
    provenance?.owner === "host" &&
    !isHistorical(provenance) &&
    isStateKind(provenance.source)
  )
}
