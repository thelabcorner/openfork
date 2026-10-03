import { describe, expect, test } from "bun:test"
import { reconcilePendingBySession } from "./pending-response-snapshot"

describe("reconcilePendingBySession", () => {
  test("clears stale rows and groups the authoritative active snapshot by session", () => {
    const result = reconcilePendingBySession(
      { ses_old: [{ sessionID: "ses_old", id: "old" }], ses_live: [{ sessionID: "ses_live", id: "stale" }] },
      [
        { sessionID: "ses_live", id: "new-a" },
        { sessionID: "ses_live", id: "new-b" },
        { sessionID: "ses_new", id: "new-c" },
      ],
    )
    expect(result).toEqual({
      ses_old: [],
      ses_live: [
        { sessionID: "ses_live", id: "new-a" },
        { sessionID: "ses_live", id: "new-b" },
      ],
      ses_new: [{ sessionID: "ses_new", id: "new-c" }],
    })
  })
})
