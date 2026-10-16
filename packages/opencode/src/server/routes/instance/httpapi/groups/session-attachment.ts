import { SessionAttachment } from "@opencode-ai/schema/session-attachment"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { SessionID } from "@/session/schema"
import { Authorization } from "../middleware/authorization"
import { described } from "./metadata"
import { ApiNotFoundError } from "../errors"

const root = "/session/:sessionID/attachment"

export const SessionAttachmentPaths = {
  index: root,
} as const

const IndexQuery = Schema.Struct({
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
})

const RecipientStatuses = Schema.Struct({
  sessionID: SessionID,
  statuses: Schema.Array(SessionAttachment.RecipientStatus),
})

/**
 * Tier 1 durable session-attachment index. Reads the durable upload index only:
 * it never hydrates message/part history and never materializes a workspace
 * execution Instance. The returned page is O(k) in the requested page size and
 * is independent of transcript length.
 *
 * `status` is a compact per-recipient projection that reports selection,
 * authorization, resolution, and provider inclusion as separate facts. It
 * deliberately does not claim model comprehension.
 */
export const SessionAttachmentApi = HttpApi.make("session-attachment").add(
  HttpApiGroup.make("sessionAttachment")
    .add(
      HttpApiEndpoint.get("index", SessionAttachmentPaths.index, {
        params: { sessionID: SessionID },
        query: IndexQuery,
        success: described(SessionAttachment.IndexPage, "Paginated eligible session uploads"),
        error: [HttpApiError.BadRequest, ApiNotFoundError],
      }),
      HttpApiEndpoint.get("status", `${root}/status`, {
        params: { sessionID: SessionID },
        success: described(RecipientStatuses, "Per-recipient attachment handoff status for a child session"),
        error: [HttpApiError.BadRequest, ApiNotFoundError],
      }),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "sessionAttachment",
        description: "Bootstrap-free paginated session attachment index and recipient status.",
      }),
    )
    .middleware(Authorization),
)
