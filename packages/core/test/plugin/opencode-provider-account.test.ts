import { describe, expect, test } from "bun:test"
import { Credential } from "@opencode-ai/core/credential"
import {
  canonicalServer,
  deriveAccountID,
  projectCredential,
} from "@opencode-ai/core/plugin/provider/opencode-provider-account"
import { Integration } from "@opencode-ai/schema/integration"

const opencode = Integration.ID.make("opencode")
const other = Integration.ID.make("other")
const methodID = Integration.MethodID.make("device")

const oauth = (
  access: string,
  metadata: Record<string, unknown>,
) =>
  Credential.OAuth.make({
    type: "oauth",
    methodID,
    access,
    refresh: `refresh-${access}`,
    expires: 4_000_000_000_000,
    metadata,
  })

const key = (value: string, metadata: Record<string, unknown>) =>
  Credential.Key.make({ type: "key", key: value, metadata })

const info = (input: {
  id: string
  label?: string
  active?: boolean
  integrationID?: Integration.ID
  value: Credential.Value
}) =>
  new Credential.Info({
    id: Credential.ID.make(input.id),
    integrationID: input.integrationID ?? opencode,
    label: input.label ?? "Console",
    value: input.value,
    ...(input.active ? { active: true } : {}),
    revision: 1,
  })

const stableMetadata = {
  server: "https://opencode.ai",
  accountID: "usr_123",
  email: "user@example.test",
  orgID: "org_abc",
  orgName: "Research Lab",
}

describe("OpenCode ProviderAccount projection", () => {
  test("is stable across token rotation, label rename, and local credential-row replacement", () => {
    const first = projectCredential(
      info({
        id: "cred_first",
        label: "Original",
        active: true,
        value: oauth("access-one", stableMetadata),
      }),
    )
    const rotated = projectCredential(
      info({
        id: "cred_first",
        label: "Renamed",
        active: true,
        value: oauth("completely-different-token", stableMetadata),
      }),
    )
    const replaced = projectCredential(
      info({
        id: "cred_replacement",
        label: "Imported",
        value: oauth("third-token", stableMetadata),
      }),
    )

    expect(first).toBeDefined()
    expect(rotated).toBeDefined()
    expect(replaced).toBeDefined()
    expect(first?.accountID).toBe(rotated?.accountID)
    expect(first?.accountID).toBe(replaced?.accountID)
    expect(first?.credentialID).toBe(Credential.ID.make("cred_first"))
    expect(replaced?.credentialID).toBe(Credential.ID.make("cred_replacement"))
    expect(first?.label).toBe("Original")
    expect(rotated?.label).toBe("Renamed")
  })

  test("separates organization, remote user, and server realm in durable account identity", () => {
    const base = projectCredential(
      info({ id: "cred_base", value: oauth("a", stableMetadata) }),
    )!
    const org = projectCredential(
      info({
        id: "cred_org",
        value: oauth("b", { ...stableMetadata, orgID: "org_other" }),
      }),
    )!
    const user = projectCredential(
      info({
        id: "cred_user",
        value: oauth("c", { ...stableMetadata, accountID: "usr_other" }),
      }),
    )!
    const server = projectCredential(
      info({
        id: "cred_server",
        value: oauth("d", {
          ...stableMetadata,
          server: "https://enterprise.example.test/console",
        }),
      }),
    )!

    expect(base.accountID).not.toBe(org.accountID)
    expect(base.accountID).not.toBe(user.accountID)
    expect(base.accountID).not.toBe(server.accountID)
  })

  test("normalizes harmless server spelling without changing identity", () => {
    const plain = projectCredential(
      info({
        id: "cred_plain",
        value: oauth("a", {
          ...stableMetadata,
          server: "https://OPENCODE.AI/",
        }),
      }),
    )!
    const canonical = projectCredential(
      info({
        id: "cred_canonical",
        value: oauth("b", stableMetadata),
      }),
    )!

    expect(canonicalServer("https://OPENCODE.AI/")).toBe("https://opencode.ai")
    expect(plain.accountID).toBe(canonical.accountID)
  })

  test("email is safe metadata but never identity authority", () => {
    const first = projectCredential(
      info({
        id: "cred_email_a",
        value: oauth("a", stableMetadata),
      }),
    )!
    const renamedEmail = projectCredential(
      info({
        id: "cred_email_b",
        value: oauth("b", {
          ...stableMetadata,
          email: "new-address@example.test",
        }),
      }),
    )!

    expect(first.accountID).toBe(renamedEmail.accountID)
    expect(first.metadata?.email).toBe("user@example.test")
    expect(renamedEmail.metadata?.email).toBe("new-address@example.test")
  })

  test("fails closed instead of fabricating account identity from local id, label, or email", () => {
    const missingRemote = projectCredential(
      info({
        id: "cred_local_only",
        label: "Looks stable",
        value: oauth("secret", {
          server: "https://opencode.ai",
          email: "only-email@example.test",
          orgID: "org_abc",
        }),
      }),
    )
    const malformedServer = projectCredential(
      info({
        id: "cred_bad_server",
        value: oauth("secret", {
          ...stableMetadata,
          server: "file:///tmp/not-a-console-realm",
        }),
      }),
    )
    const wrongIntegration = projectCredential(
      info({
        id: "cred_other",
        integrationID: other,
        value: oauth("secret", stableMetadata),
      }),
    )

    expect(missingRemote).toBeUndefined()
    expect(malformedServer).toBeUndefined()
    expect(wrongIntegration).toBeUndefined()
  })

  test("only trusted Console OAuth metadata may mint durable account identity today", () => {
    const oauthAccount = projectCredential(
      info({ id: "cred_oauth", value: oauth("oauth-secret", stableMetadata) }),
    )!
    const keyWithClaimedIdentity = projectCredential(
      info({ id: "cred_key", value: key("key-secret", stableMetadata) }),
    )
    const unverifiedKey = projectCredential(
      info({
        id: "cred_unverified_key",
        value: key("unverified-secret", { server: "https://opencode.ai" }),
      }),
    )

    expect(oauthAccount.authType).toBe("oauth")
    expect(keyWithClaimedIdentity).toBeUndefined()
    expect(unverifiedKey).toBeUndefined()
  })

  test("uses a full SHA-256-derived opaque id that contains no remote identity or secret text", () => {
    const projected = projectCredential(
      info({
        id: "cred_secret_audit",
        value: oauth("highly-sensitive-access", stableMetadata),
      }),
    )!
    const serialized = JSON.stringify(projected)

    expect(projected.accountID).toMatch(/^opencode-account:[0-9a-f]{64}$/)
    expect(projected.accountID).not.toContain("usr_123")
    expect(projected.accountID).not.toContain("org_abc")
    expect(serialized).not.toContain("highly-sensitive-access")
    expect(serialized).not.toContain("refresh-highly-sensitive-access")
  })

  test("derivation is deterministic and explicit about the no-org identity", () => {
    const withOrg = deriveAccountID({
      server: "https://opencode.ai",
      remoteUserID: "usr_123",
      orgID: "org_abc",
    })
    const withOrgAgain = deriveAccountID({
      server: "https://opencode.ai",
      remoteUserID: "usr_123",
      orgID: "org_abc",
    })
    const noOrg = deriveAccountID({
      server: "https://opencode.ai",
      remoteUserID: "usr_123",
    })

    expect(withOrg).toBe(withOrgAgain)
    expect(withOrg).not.toBe(noOrg)
  })
})
