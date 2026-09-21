import { SessionTurnProvenance } from "@opencode-ai/schema/session-turn-provenance"

export type MessageProvenancePresentation = {
  readonly badgeKey: string
  readonly badgeDefault: string
  readonly previewKey: string
  readonly previewDefault: string
  readonly expandKey: string
  readonly expandDefault: string
  readonly collapseKey: string
  readonly collapseDefault: string
}

type MessageLike = {
  readonly role?: string
  readonly provenance?: SessionTurnProvenance.ProvenanceLike
}

const generic = (source: string): MessageProvenancePresentation => ({
  badgeKey: "ui.message.automation",
  badgeDefault: "Automation",
  previewKey: "ui.message.automation.source",
  previewDefault: source,
  expandKey: "ui.message.automation.expand",
  expandDefault: "Show automation context",
  collapseKey: "ui.message.automation.collapse",
  collapseDefault: "Hide automation context",
})

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
})

/**
 * Presentation-only classification for provider-user rows whose durable
 * provenance says the turn is host-owned. Human/user-owned prompts deliberately
 * return undefined so they continue through the normal UserMessageDisplay path.
 *
 * This consumes message-level provenance only; it never scans parts or history.
 */
export function messageProvenancePresentation(message: MessageLike): MessageProvenancePresentation | undefined {
  if (message.role !== "user" || message.provenance?.owner !== "host") return
  switch (message.provenance.source) {
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
      return generic(message.provenance.source)
  }
}
