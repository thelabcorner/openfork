import { describe, expect, test } from "bun:test"
import { activeCredentialAccount, credentialAccounts } from "./provider-accounts"

describe("provider settings credential accounts", () => {
  test("keeps credential accounts and excludes environment connections", () => {
    const connections = [
      { type: "credential" as const, id: "cred_work", label: "Work", active: false },
      { type: "env" as const, name: "OPENROUTER_API_KEY" },
      { type: "credential" as const, id: "cred_personal", label: "Personal", active: true },
    ]

    expect(credentialAccounts(connections).map((account) => account.id)).toEqual(["cred_work", "cred_personal"])
  })

  test("prefers the explicit active credential", () => {
    const connections = [
      { type: "credential" as const, id: "cred_first", label: "First", active: false },
      { type: "credential" as const, id: "cred_active", label: "Active", active: true },
    ]

    expect(activeCredentialAccount(connections)?.id).toBe("cred_active")
  })

  test("falls back to server ordering when active metadata is absent", () => {
    const connections = [
      { type: "credential" as const, id: "cred_first", label: "First" },
      { type: "credential" as const, id: "cred_backup", label: "Backup" },
    ]

    expect(activeCredentialAccount(connections)?.id).toBe("cred_first")
  })
})
