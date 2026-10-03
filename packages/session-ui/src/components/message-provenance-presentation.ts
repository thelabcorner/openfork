import { SessionTurnProvenance } from "@opencode-ai/schema/session-turn-provenance"
import type { InjectionTone, SystemInjectionKind } from "../v2/components/system-injection-content"

export type MessageProvenancePresentation = {
  readonly badgeKey: string
  readonly badgeDefault: string
  readonly previewKey: string
  readonly previewDefault: string
  readonly expandKey: string
  readonly expandDefault: string
  readonly collapseKey: string
  readonly collapseDefault: string
  /** Glyph family for the injection card. */
  readonly kind: SystemInjectionKind
  /**
   * Accent the producer is certain about regardless of payload. Left undefined
   * for sources whose outcome only the payload knows (a task summary is green
   * or red depending on how the task ended), so the card derives it instead.
   */
  readonly tone?: InjectionTone
}

type MessageLike = {
  readonly role?: string
  readonly provenance?: SessionTurnProvenance.ProvenanceLike
}

const automation = (
  kind: string,
  label: string,
  preview: string,
  visual?: { kind?: SystemInjectionKind; tone?: InjectionTone },
): MessageProvenancePresentation => ({
  badgeKey: "ui.message.automation." + kind,
  badgeDefault: label,
  previewKey: "ui.message.automation." + kind + ".preview",
  previewDefault: preview,
  expandKey: "ui.message.automation.expand",
  expandDefault: "Show automation context",
  collapseKey: "ui.message.automation.collapse",
  collapseDefault: "Hide automation context",
  kind: visual?.kind ?? "automation",
  ...(visual?.tone ? { tone: visual.tone } : {}),
})

const generic = (source: string): MessageProvenancePresentation =>
  automation("generic", "Automation", source)

const swarm = (
  kind: "assignment" | "peer" | "continuation" | "recovery" | "notice",
  label: string,
  preview: string,
): MessageProvenancePresentation => ({
  badgeKey: "ui.message.swarm." + kind,
  badgeDefault: label,
  previewKey: "ui.message.swarm." + kind + ".preview",
  previewDefault: preview,
  expandKey: "ui.message.swarm.expand",
  expandDefault: "Show Swarm context",
  collapseKey: "ui.message.swarm.collapse",
  collapseDefault: "Hide Swarm context",
  kind: "swarm",
})

/**
 * Presentation-only classification for provider-user rows whose durable
 * provenance gives them Synthetic semantics. Genuine human prompts deliberately
 * return undefined so they continue through the normal UserMessageDisplay path.
 *
 * This consumes message-level provenance only; it never scans parts or history.
 */
export function messageProvenancePresentation(message: MessageLike): MessageProvenancePresentation | undefined {
  if (message.role !== "user") return
  const provenance = message.provenance
  if (!provenance || SessionTurnProvenance.semanticKindInfo(message) !== "synthetic") return

  switch (provenance.source) {
    case SessionTurnProvenance.Source.PlanApproval:
      return automation("planApproval", "Plan approval", "Plan approval", { kind: "plan", tone: "success" })
    case SessionTurnProvenance.Source.HostPrompt:
      return automation("hostPrompt", "Agent prompt", "Agent prompt", { kind: "automation" })
    case SessionTurnProvenance.Source.ScheduledTaskRun:
      return automation("scheduledTask", "Scheduled task", "Scheduled task", { kind: "schedule" })
    case SessionTurnProvenance.Source.TaskSummary:
      return automation("taskSummary", "Task summary", "Task summary", { kind: "task" })
    case SessionTurnProvenance.Source.BackgroundShellSummary:
      return automation("backgroundShellSummary", "Shell summary", "Background shell summary", { kind: "shell" })
    case SessionTurnProvenance.Source.GoalSpecification:
      return automation("goalSpecification", "Goal", "Goal specification", { kind: "goal" })
    case SessionTurnProvenance.Source.GoalProgress:
      return automation("goalProgress", "Goal progress", "Goal progress", { kind: "goal" })
    case SessionTurnProvenance.Source.GoalContinuation:
      return automation("goalContinuation", "Goal continuation", "Goal continuation", { kind: "goal" })
    case SessionTurnProvenance.Source.RecoveryContinuation:
      return automation("recoveryContinuation", "Recovery", "Recovery continuation", { kind: "recovery", tone: "warning" })
    case SessionTurnProvenance.Source.UnknownFinishContinuation:
      return automation("providerContinuation", "Provider continuation", "Provider continuation", { kind: "recovery", tone: "warning" })
    case SessionTurnProvenance.Source.CompactionReplay:
      return automation("compactionReplay", "Compaction replay", "Compaction replay", { kind: "compaction" })
    case SessionTurnProvenance.Source.CompactionContinue:
      return automation("compactionContinuation", "Compaction continuation", "Compaction continuation", { kind: "compaction" })
    case SessionTurnProvenance.Source.PromptRevisor:
      return automation("promptRevisor", "Prompt revisor", "Prompt revision", { kind: "title" })
    case SessionTurnProvenance.Source.GoalRevisor:
      return automation("goalRevisor", "Goal revisor", "Goal revision", { kind: "goal" })
    case SessionTurnProvenance.Source.SessionTitle:
      return automation("sessionTitle", "Title agent", "Session title generation", { kind: "title" })
    case SessionTurnProvenance.Source.GoalAuditor:
      return automation("goalAuditor", "Goal auditor", "Goal audit", { kind: "audit" })
    case SessionTurnProvenance.Source.SpadAuditor:
      return automation("spadAuditor", "SPAD auditor", "Loop audit", { kind: "audit" })
    case SessionTurnProvenance.Source.ProjectCopyName:
      return automation("projectCopyName", "Project naming", "Project copy naming", { kind: "title" })
    case SessionTurnProvenance.Source.OxpSupervisor:
      return automation("oxpSupervisor", "OXP supervisor", "OXP supervision", { kind: "oxp" })
    case SessionTurnProvenance.Source.OxpDelegation:
      return automation("oxpDelegation", "OXP delegation", "Delegated task", { kind: "oxp" })
    case SessionTurnProvenance.Source.SwarmAssignment:
      return swarm("assignment", "Swarm assignment", "Task assignment")
    case SessionTurnProvenance.Source.SwarmPeer:
      return swarm("peer", "Swarm peer", "Peer message")
    case SessionTurnProvenance.Source.SwarmContinuation:
      return swarm("continuation", "Swarm continuation", "Task continuation")
    case SessionTurnProvenance.Source.SwarmRecovery:
      return swarm("recovery", "Swarm recovery", "Recovery instruction")
    case SessionTurnProvenance.Source.SwarmNotice:
      return swarm("notice", "Swarm notice", "Swarm notice")
    default:
      return generic(provenance.source)
  }
}
