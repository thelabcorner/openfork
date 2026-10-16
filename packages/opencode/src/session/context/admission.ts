/**
 * Authoritative context-operation admission. Executed through EventV2's
 * pre-projector admit hook on the SAME writer transaction as the durable event
 * and its overlay projection. Never call with a separate WAL read snapshot.
 *
 * No Context mutation may be committed after its targeted message is deleted,
 * becomes a protected host STATE, acquires signed reasoning, or changes the
 * requested part's type/status. All failures abort the event and its projector.
 */
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionMetadataOwnership } from "@opencode-ai/core/session/metadata-ownership"
import type { Database } from "@opencode-ai/core/database/database"
import type { SessionContext } from "@opencode-ai/schema/session-context"
import { MessageV2 } from "@/session/message-v2"
import { EffectiveContextCompiler } from "./compiler"

export class ContextMutationAdmissionError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = "ContextMutationAdmissionError"
  }
}

export const validate = Effect.fn("ContextMutationAdmission.validate")(function* (
  input: { sessionID: string; operations: readonly SessionContext.ContextOperation[] },
  db: Pick<Database.DatabaseShape, "select">,
) {
  // Session existence and protected owner classification must be rechecked in
  // the same writer transaction. An earlier HTTP read is NOT authoritative.
  const session = yield* db.select({ metadata: SessionTable.metadata })
    .from(SessionTable)
    .where(eq(SessionTable.id, input.sessionID as any))
    .get().pipe(Effect.orDie)
  const reject = (why: string) => Effect.die(new ContextMutationAdmissionError(why))
  if (!session) return yield* reject("Session was removed")
  if (SessionMetadataOwnership.isSpecialAgent(session.metadata ?? undefined))
    return yield* reject("Protected special-agent transcript")

  const targets = yield* MessageV2.probeContextTargetsFrom({
    sessionID: input.sessionID as any,
    messageIDs: input.operations.map((op) => op.messageID as any),
    signatureMessageIDs: input.operations
      .filter((op) => op.type === "message.exclude" || op.type === "text.replace")
      .map((op) => op.messageID as any),
    partIDs: input.operations
      .flatMap((op) => ("partID" in op && op.partID ? [op.partID as any] : [])),
  }, db)
  for (const op of input.operations) {
    const msg = targets.messages.get(op.messageID as any)
    if (!msg) return yield* reject("Missing or foreign-session message")
    if (msg.opaqueParts && (op.type === "message.exclude" || op.type === "text.replace"))
      return yield* reject("Opaque signed-reasoning status")
    const partID = "partID" in op ? op.partID as string | undefined : undefined
    if (partID && targets.partOwners.get(partID as any) !== op.messageID)
      return yield* reject("Part does not belong to targeted message")
    const check = EffectiveContextCompiler.canApplyContextOperationFacts(
      msg.info, msg.signedReasoning, op.type,
    )
    if (!check.allowed) return yield* reject(check.reason ?? "Protected transcript mutation")
    const target = EffectiveContextCompiler.canApplyContextOperationTargetFacts(
      op.type, partID, msg.hasEditablePart,
      partID ? targets.partFacts.get(partID as any) : undefined,
    )
    if (!target.allowed) return yield* reject(target.reason ?? "Invalid mutation target")
  }
})
