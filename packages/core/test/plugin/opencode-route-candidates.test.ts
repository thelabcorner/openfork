import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  HttpClient,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { Credential } from "@opencode-ai/core/credential"
import * as CredentialResolver from "@opencode-ai/core/credential/resolver"
import {
  make as makeCandidates,
  type Options,
} from "@opencode-ai/core/plugin/provider/opencode-route-candidates"
import { Integration } from "@opencode-ai/schema/integration"

const integrationID = Integration.ID.make("opencode")
const methodID = Integration.MethodID.make("device")
const providerID = "console-test"
const modelID = "alpha"

const oauth = (input: {
  access: string
  server: string
  remoteUserID: string
  orgID: string
  expires?: number
}) =>
  Credential.OAuth.make({
    type: "oauth",
    methodID,
    access: input.access,
    refresh: `refresh-${input.access}`,
    expires: input.expires ?? Date.now() + 60 * 60_000,
    metadata: {
      server: input.server,
      accountID: input.remoteUserID,
      email: `${input.remoteUserID}@example.test`,
      orgID: input.orgID,
      orgName: input.orgID,
    },
  })

const info = (input: {
  id: string
  value: Credential.Value
  revision?: number
  label?: string
}) =>
  new Credential.Info({
    id: Credential.ID.make(input.id),
    integrationID,
    label: input.label ?? input.id,
    value: input.value,
    revision: input.revision ?? 1,
  })

const configBody = (input: {
  endpoint: string
  wireModelID?: string
  models?: Record<string, unknown>
}) => ({
  config: {
    provider: {
      [providerID]: {
        name: providerID,
        api: input.endpoint,
        npm: "@ai-sdk/openai-compatible",
        models:
          input.models ??
          {
            [modelID]: {
              id: input.wireModelID ?? modelID,
              name: input.wireModelID ?? modelID,
              cost: { input: 1, output: 2 },
              limit: { context: 32_000, output: 4_096 },
            },
          },
      },
    },
  },
})

const json = (
  request: HttpClientRequest.HttpClientRequest,
  body: unknown,
  status = 200,
) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )

function credentialStore(initial: readonly Credential.Info[]) {
  const records = new Map(initial.map((item) => [String(item.id), item]))
  let reverse = false
  return {
    service: {
      list: () => {
        reverse = !reverse
        const values = [...records.values()]
        return Effect.succeed(reverse ? values : values.toReversed())
      },
      get: (id: Credential.ID) => Effect.succeed(records.get(String(id))),
    } as unknown as Credential.Interface,
    records,
  }
}

function passthroughResolver(
  records: Map<string, Credential.Info>,
): CredentialResolver.Interface {
  return {
    resolve: (id: Credential.ID) => {
      const item = records.get(String(id))
      return Effect.succeed(
        item
          ? { value: item.value, revision: item.revision }
          : undefined,
      )
    },
  } as CredentialResolver.Interface
}

describe("OpenCode route candidate source", () => {
  test("isolates two OAuth accounts across identity, config, model capability and wire auth", async () => {
    const accountA = info({
      id: "cred_a",
      revision: 3,
      value: oauth({
        access: "access-a",
        server: "https://console-a.example/console",
        remoteUserID: "user-a",
        orgID: "org-a",
      }),
    })
    const accountB = info({
      id: "cred_b",
      revision: 5,
      value: oauth({
        access: "access-b",
        server: "https://console-b.example/console",
        remoteUserID: "user-b",
        orgID: "org-b",
      }),
    })
    const claimedKey = new Credential.Info({
      id: Credential.ID.make("cred_key"),
      integrationID,
      label: "Unverified key",
      value: Credential.Key.make({
        type: "key",
        key: "key-secret",
        metadata: {
          server: "https://console-key.example/console",
          accountID: "claimed-user",
        },
      }),
      revision: 1,
    })
    const store = credentialStore([accountA, claimedKey, accountB])
    const seen: Array<{
      url: string
      authorization?: string
      orgID?: string
    }> = []
    const configHttp = HttpClient.make((request) => {
      seen.push({
        url: request.url,
        authorization: request.headers.authorization,
        orgID: request.headers["x-org-id"],
      })
      if (request.headers.authorization === "Bearer access-a") {
        return Effect.succeed(
          json(
            request,
            configBody({
              endpoint: "https://inference-a.example/v1",
              wireModelID: "wire-a",
            }),
          ),
        )
      }
      if (request.headers.authorization === "Bearer access-b") {
        return Effect.succeed(
          json(
            request,
            configBody({
              endpoint: "https://inference-b.example/v1",
              wireModelID: "wire-b",
            }),
          ),
        )
      }
      return Effect.succeed(json(request, {}, 401))
    })
    const rawHttp = HttpClient.make((request) =>
      Effect.die(`unexpected raw OAuth request: ${request.method} ${request.url}`),
    )
    const healthCalls: string[] = []
    const source = makeCandidates({
      realm: "realm-test",
      credentials: store.service,
      resolver: passthroughResolver(store.records),
      http: rawHttp,
      configHttp,
      assessHealth: (input) => {
        healthCalls.push(input.account.accountID)
        return Effect.succeed({
          admissible: true,
          healthRank:
            input.account.metadata?.remoteUserID === "user-a" ? 2 : 1,
          usedPercent: 20,
        })
      },
    })

    const first = await Effect.runPromise(source.list({ providerID, modelID }))
    const second = await Effect.runPromise(source.list({ providerID, modelID }))

    expect(first.issues).toEqual([])
    expect(first.candidates).toHaveLength(2)
    expect(second.candidates.map((item) => item.account.accountID)).toEqual(
      first.candidates.map((item) => item.account.accountID),
    )
    expect(seen).toHaveLength(2)
    expect(healthCalls).toHaveLength(4)

    const byHandle = new Map(
      first.candidates.map((item) => [
        String(item.account.credentialID),
        item,
      ]),
    )
    const a = byHandle.get("cred_a")!
    const b = byHandle.get("cred_b")!

    expect(a.credentialRevision).toBe(3)
    expect(b.credentialRevision).toBe(5)
    expect(a.configVersion).toBe(1)
    expect(b.configVersion).toBe(1)
    expect(a.providerConfigIdentity).toBeDefined()
    expect(b.providerConfigIdentity).toBeDefined()
    expect(a.providerConfigIdentity).not.toBe(b.providerConfigIdentity)
    expect(a.candidate).toMatchObject({
      providerID,
      accountID: a.account.accountID,
      credentialHandle: "cred_a",
      admissible: true,
      healthRank: 2,
    })
    expect(b.candidate).toMatchObject({
      providerID,
      accountID: b.account.accountID,
      credentialHandle: "cred_b",
      admissible: true,
      healthRank: 1,
    })

    expect(seen).toEqual(
      expect.arrayContaining([
        {
          url: "https://console-a.example/console/api/config",
          authorization: "Bearer access-a",
          orgID: "org-a",
        },
        {
          url: "https://console-b.example/console/api/config",
          authorization: "Bearer access-b",
          orgID: "org-b",
        },
      ]),
    )

    expect(
      await Effect.runPromise(
        source.resolveCredentialRevision({
          providerID,
          accountID: a.account.accountID,
          credentialHandle: "cred_a",
        }),
      ),
    ).toBe(3)
    expect(seen).toHaveLength(2)

    expect(
      await Effect.runPromise(
        source.resolveCredentialRevision({
          providerID,
          accountID: b.account.accountID,
          credentialHandle: "cred_a",
        }),
      ),
    ).toBeUndefined()
    expect(
      await Effect.runPromise(
        source.resolveCredentialRevision({
          providerID: "unrelated-provider",
          accountID: a.account.accountID,
          credentialHandle: "cred_a",
        }),
      ),
    ).toBeUndefined()
    expect(
      await Effect.runPromise(
        source.resolveCredentialRevision({
          providerID,
          accountID: a.account.accountID,
          credentialHandle: "cred_key",
        }),
      ),
    ).toBeUndefined()

    const execution = await Effect.runPromise(
      source.resolveExecution({
        providerID,
        modelID,
        accountID: a.account.accountID,
        credentialHandle: "cred_a",
        expectedCredentialRevision: 3,
      }),
    )
    expect(execution?.credentialRevision).toBe(3)
    expect(execution?.credential.type).toBe("oauth")
    if (execution?.credential.type !== "oauth") throw new Error("expected OAuth execution credential")
    expect(execution.credential.access).toBe("access-a")
    expect(execution.capabilities.providers[providerID]?.models[modelID]?.apiID).toBe("wire-a")
    // Final materialization reuses the same bounded account-config cache.
    expect(seen).toHaveLength(2)
    expect(
      await Effect.runPromise(
        source.resolveExecution({
          providerID,
          modelID,
          accountID: a.account.accountID,
          credentialHandle: "cred_a",
          expectedCredentialRevision: 2,
        }),
      ),
    ).toBeUndefined()
    expect(
      await Effect.runPromise(
        source.resolveExecution({
          providerID,
          modelID: "missing-model",
          accountID: a.account.accountID,
          credentialHandle: "cred_a",
          expectedCredentialRevision: 3,
        }),
      ),
    ).toBeUndefined()

    const serialized = JSON.stringify(first)
    expect(serialized).not.toContain("access-a")
    expect(serialized).not.toContain("access-b")
    expect(serialized).not.toContain("refresh-access-a")
    expect(serialized).not.toContain("key-secret")
    expect(serialized).not.toContain("Authorization")
  })

  test("marks unsupported model hard-ineligible without invoking health", async () => {
    const stored = info({
      id: "cred_unsupported",
      value: oauth({
        access: "access-unsupported",
        server: "https://unsupported.example/console",
        remoteUserID: "user-unsupported",
        orgID: "org-unsupported",
      }),
    })
    const store = credentialStore([stored])
    let healthCalls = 0
    const configHttp = HttpClient.make((request) =>
      Effect.succeed(
        json(
          request,
          configBody({
            endpoint: "https://unsupported.example/v1",
            models: {
              beta: {
                id: "wire-beta",
                cost: { input: 1, output: 1 },
                limit: { context: 8_000, output: 1_000 },
              },
            },
          }),
        ),
      ),
    )
    const source = makeCandidates({
      realm: "realm-unsupported",
      credentials: store.service,
      resolver: passthroughResolver(store.records),
      http: configHttp,
      configHttp,
      assessHealth: () => {
        healthCalls++
        return Effect.succeed({ admissible: true, healthRank: 0 })
      },
    })

    const result = await Effect.runPromise(source.list({ providerID, modelID }))

    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]!.candidate).toMatchObject({
      admissible: false,
      ineligibleReason: "model-unsupported",
    })
    expect(healthCalls).toBe(0)
  })

  test("consumes the shared OAuth refresh callback and routes config with the rotated P2 value/revision", async () => {
    const stored = info({
      id: "cred_refresh",
      revision: 6,
      value: oauth({
        access: "access-old",
        server: "https://refresh.example/console",
        remoteUserID: "user-refresh",
        orgID: "org-refresh",
        expires: 1,
      }),
    })
    const store = credentialStore([stored])
    let current = stored
    let refreshCalls = 0
    const rawHttp = HttpClient.make((request) => {
      refreshCalls++
      expect(request.method).toBe("POST")
      expect(request.url).toBe(
        "https://refresh.example/console/auth/device/token",
      )
      return Effect.succeed(
        json(request, {
          access_token: "access-rotated",
          refresh_token: "refresh-rotated",
          expires_in: 3600,
        }),
      )
    })
    const resolver = {
      resolve: (id: Credential.ID, options: CredentialResolver.ResolveOptions<unknown>) =>
        Effect.gen(function* () {
          if (String(id) !== String(current.id)) return undefined
          if (
            current.value.type === "oauth" &&
            options.shouldRefresh(
              current.value,
              current.integrationID,
              Date.now(),
            )
          ) {
            const refreshed = yield* options.refresh(
              current.value,
              current.integrationID,
            )
            if (refreshed) {
              current = new Credential.Info({
                ...current,
                value: refreshed,
                revision: current.revision + 1,
              })
            }
          }
          return { value: current.value, revision: current.revision }
        }),
    } as CredentialResolver.Interface
    const configSeen: string[] = []
    const configHttp = HttpClient.make((request) => {
      configSeen.push(request.headers.authorization ?? "")
      return Effect.succeed(
        json(
          request,
          configBody({
            endpoint: "https://refresh-inference.example/v1",
            wireModelID: "wire-refresh",
          }),
        ),
      )
    })
    const source = makeCandidates({
      realm: "realm-refresh",
      credentials: store.service,
      resolver,
      http: rawHttp,
      configHttp,
      assessHealth: () =>
        Effect.succeed({ admissible: true, healthRank: 0 }),
    })

    const result = await Effect.runPromise(source.list({ providerID, modelID }))
    const item = result.candidates[0]!

    expect(refreshCalls).toBe(1)
    expect(configSeen).toEqual(["Bearer access-rotated"])
    expect(item.credentialRevision).toBe(7)
    expect(item.account.accountID).toBeDefined()
    expect(
      await Effect.runPromise(
        source.resolveCredentialRevision({
          providerID,
          accountID: item.account.accountID,
          credentialHandle: "cred_refresh",
        }),
      ),
    ).toBe(7)
    expect(refreshCalls).toBe(1)
    expect(configSeen).toHaveLength(1)
  })

  test("isolates one account config failure instead of removing healthy peers", async () => {
    const bad = info({
      id: "cred_bad",
      value: oauth({
        access: "access-bad",
        server: "https://bad.example/console",
        remoteUserID: "user-bad",
        orgID: "org-bad",
      }),
    })
    const good = info({
      id: "cred_good",
      value: oauth({
        access: "access-good",
        server: "https://good.example/console",
        remoteUserID: "user-good",
        orgID: "org-good",
      }),
    })
    const store = credentialStore([bad, good])
    const configHttp = HttpClient.make((request) => {
      if (request.headers.authorization === "Bearer access-bad") {
        return Effect.succeed(json(request, { error: "temporary" }, 503))
      }
      return Effect.succeed(
        json(
          request,
          configBody({
            endpoint: "https://good-inference.example/v1",
          }),
        ),
      )
    })
    const source = makeCandidates({
      realm: "realm-isolation",
      credentials: store.service,
      resolver: passthroughResolver(store.records),
      http: configHttp,
      configHttp,
      assessHealth: () =>
        Effect.succeed({ admissible: true, healthRank: 0 }),
    })

    const result = await Effect.runPromise(source.list({ providerID, modelID }))

    expect(result.candidates).toHaveLength(1)
    expect(String(result.candidates[0]!.account.credentialID)).toBe("cred_good")
    expect(result.issues).toHaveLength(1)
    expect(String(result.issues[0]!.credentialHandle)).toBe("cred_bad")
    expect(result.issues[0]!.phase).toBe("account-config")
    expect(JSON.stringify(result.issues)).not.toContain("access-bad")
  })
})
