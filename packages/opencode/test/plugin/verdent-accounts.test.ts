import { describe, expect, test } from "bun:test"
import { verdentProviderAccounts } from "@/plugin/verdent-accounts"

describe("verdentProviderAccounts", () => {
  test("publishes stable ids plus the same labels and exact aliases used by the provider UI", () => {
    const accounts = [
      {
        id: "vd-account-1111",
        uid: "123456",
        nickname: "123456",
        email: "person@example.com",
        credential: { email: "person@example.com" },
      },
      {
        id: "vd-account-2222",
        uid: "uid-b",
        nickname: "team",
        email: "team@example.com",
        credential: { email: "backup@example.com" },
      },
      {
        id: "vd-account-3333",
        uid: "uid-c",
        nickname: "team",
        email: "other@example.com",
        credential: { email: "other@example.com" },
      },
    ]

    expect(verdentProviderAccounts(accounts)).toEqual([
      {
        id: "vd-account-1111",
        label: "person@example.com",
        aliases: ["123456", "person@example.com"],
      },
      {
        id: "vd-account-2222",
        label: "team #2222",
        aliases: ["team", "team@example.com", "backup@example.com", "uid-b"],
      },
      {
        id: "vd-account-3333",
        label: "team #3333",
        aliases: ["team", "other@example.com", "uid-c"],
      },
    ])
  })
})
