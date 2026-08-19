export * as SessionGroupID from "./group-id"

import { SessionGroup } from "@opencode-ai/schema/session-group"

export const ID = SessionGroup.ID
export type ID = typeof ID.Type
