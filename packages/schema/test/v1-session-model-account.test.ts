import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionV1 } from "../src/session-v1"

const base = {
  id: "ses_account_model",
  slug: "account-model",
  projectID: "global",
  directory: "/project",
  title: "account model",
  version: "test",
  time: { created: 1, updated: 1 },
}

describe("V1 Session model account identity", () => {
  test("round-trips an explicit provider account", () => {
    const decoded = Schema.decodeUnknownSync(SessionV1.SessionInfo)({
      ...base,
      model: {
        id: "deepseek-v4.1-flash",
        providerID: "workbuddy",
        accountID: "wb-account-1",
        variant: "max",
      },
    })
    expect(decoded.model?.accountID).toBe("wb-account-1")
    expect(Schema.encodeSync(SessionV1.SessionInfo)(decoded).model).toEqual({
      id: "deepseek-v4.1-flash",
      providerID: "workbuddy",
      accountID: "wb-account-1",
      variant: "max",
    })
  })

  test("keeps account identity optional for legacy Session payloads", () => {
    const encoded = Schema.encodeSync(SessionV1.SessionInfo)(
      Schema.decodeUnknownSync(SessionV1.SessionInfo)({
        ...base,
        model: { id: "legacy-model", providerID: "legacy-provider" },
      }),
    )
    expect("accountID" in encoded.model!).toBe(false)
  })
})
