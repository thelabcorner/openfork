import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ProviderAccount } from "../src/provider-account"

const decode = Schema.decodeUnknownSync(ProviderAccount.Info)

describe("ProviderAccount schema", () => {
  test("decodes the secret-free credential/account identity contract", () => {
    const result = decode({
      providerID: "opencode",
      credentialID: "cred_example",
      accountID: "opencode-account:abc123",
      label: "Research",
      active: true,
      authType: "oauth",
      source: "credential",
      metadata: {
        email: "user@example.test",
        remoteUserID: "usr_123",
        orgID: "org_456",
        orgName: "Lab",
        server: "https://opencode.ai",
      },
    })

    expect(String(result.providerID)).toBe("opencode")
    expect(String(result.credentialID)).toBe("cred_example")
    expect(result.accountID).toBe("opencode-account:abc123")
    expect(result.label).toBe("Research")
    expect(result.active).toBe(true)
    expect(result.authType).toBe("oauth")
    expect(result.source).toBe("credential")
    expect(result.metadata).toEqual({
      email: "user@example.test",
      remoteUserID: "usr_123",
      orgID: "org_456",
      orgName: "Lab",
      server: "https://opencode.ai",
    })
  })

  test("bounds stable account identity to the reusable safe-selector limit", () => {
    expect(() =>
      decode({
        providerID: "opencode",
        credentialID: "cred_example",
        accountID: "",
        label: "Account",
        active: false,
        authType: "oauth",
        source: "credential",
      }),
    ).toThrow()

    expect(() =>
      decode({
        providerID: "opencode",
        credentialID: "cred_example",
        accountID: "a".repeat(257),
        label: "Account",
        active: false,
        authType: "oauth",
        source: "credential",
      }),
    ).toThrow()
  })

  test("keeps auth/storage provenance explicit", () => {
    expect(
      decode({
        providerID: "opencode",
        credentialID: "cred_key",
        accountID: "acct-safe",
        label: "Key",
        active: false,
        authType: "key",
        source: "credential",
      }),
    ).toMatchObject({ authType: "key", source: "credential" })

    expect(() =>
      decode({
        providerID: "opencode",
        credentialID: "cred_bad",
        accountID: "acct-safe",
        label: "Bad",
        active: false,
        authType: "password",
        source: "credential",
      }),
    ).toThrow()
  })
})
