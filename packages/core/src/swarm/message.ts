import type { Swarm } from "@opencode-ai/schema/swarm"

export type MessageTarget =
  | { readonly type: "member"; readonly memberID: Swarm.MemberID }
  | { readonly type: "broadcast" }

export type TargetExpansion =
  | { readonly ok: true; readonly recipients: readonly Swarm.MemberID[] }
  | { readonly ok: false; readonly reason: "sender_missing" | "recipient_missing" | "self_send" | "recipient_stopped" }

const ACTION_REQUIRING = new Set<Swarm.MessageKind>(["request", "blocker", "review"])

export function canSuppressReply(kind: Swarm.MessageKind) {
  return !ACTION_REQUIRING.has(kind)
}

export function validMessageBody(body: string) {
  return body.trim().length > 0
}

/**
 * Expand direct/broadcast addressing once. The message body remains singular;
 * callers persist one delivery receipt per returned member.
 */
export function expandRecipients(
  members: readonly Pick<Swarm.Member, "id" | "lifecycle">[],
  senderMemberID: Swarm.MemberID,
  target: MessageTarget,
): TargetExpansion {
  const byID = new Map(members.map((member) => [member.id, member] as const))
  if (!byID.has(senderMemberID)) return { ok: false, reason: "sender_missing" }

  if (target.type === "member") {
    if (target.memberID === senderMemberID) return { ok: false, reason: "self_send" }
    const recipient = byID.get(target.memberID)
    if (!recipient) return { ok: false, reason: "recipient_missing" }
    if (recipient.lifecycle === "stopped" || recipient.lifecycle === "stopping")
      return { ok: false, reason: "recipient_stopped" }
    return { ok: true, recipients: [recipient.id] }
  }

  return {
    ok: true,
    recipients: members
      .filter(
        (member) =>
          member.id !== senderMemberID && member.lifecycle !== "stopped" && member.lifecycle !== "stopping",
      )
      .map((member) => member.id)
      .sort(),
  }
}
