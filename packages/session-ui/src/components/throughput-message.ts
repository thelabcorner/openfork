import type { Message } from "@opencode-ai/sdk/v2"
import { SessionTurnProvenance } from "@opencode-ai/schema/session-turn-provenance"
import type { SessionThroughput } from "@opencode-ai/core/session/throughput"

/**
 * Browser-safe adapter from SDK message compatibility shape to the pure
 * throughput calculator's structural roles.
 *
 * Current/V2 host STATE is intentionally normalized to SDK role=user so older
 * presentation code can consume it. That wire/presentation role must not turn
 * STATE semantics into a throughput turn boundary. Historical lifetime revokes
 * live authority but does not make an imported Goal STATE row a request.
 */
export function toThroughputMessage(message: Message): SessionThroughput.ThroughputMessage {
  if (message.role !== "assistant") {
    const provenance = message.role === "user" ? message.provenance : undefined
    const role =
      provenance?.owner === "host" && SessionTurnProvenance.isStateKind(provenance.source) ? "state" : message.role
    return { id: message.id, role }
  }

  const served = message.servedModel
  return {
    id: message.id,
    role: "assistant",
    modelKey: served
      ? `${served.providerID ?? message.providerID}:${served.modelID}`
      : `${message.providerID}:${message.modelID}`,
    output: message.tokens.output,
    reasoning: message.tokens.reasoning,
    requestSentAt: message.time.requestSentAt,
    firstTokenAt: message.time.firstTokenAt,
    streamedAt: message.time.streamedAt,
    failed: message.error !== undefined,
  }
}
