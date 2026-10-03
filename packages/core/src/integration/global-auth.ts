export * as GlobalIntegrationAuth from "./global-auth"

import { Context, Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Integration } from "@opencode-ai/schema/integration"
import { Credential } from "../credential"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { httpClient } from "../effect/app-node-platform"
import {
  type AuthorizationError,
  type CodeRequiredError,
  make as makeAuthKernel,
  type OAuthImplementation,
} from "./auth-kernel"
import { integrationID as opencodeID, keyMethod as opencodeKeyMethod, oauth as opencodeOAuth } from "../plugin/provider/opencode-auth"

export interface Interface {
  /** Lists bootstrap-free authentication methods registered for one provider/integration. */
  readonly methods: (integrationID: Integration.ID) => Effect.Effect<readonly Integration.Method[]>
  /** Starts an OAuth attempt without materializing a workspace runtime. */
  readonly oauth: (input: {
    readonly integrationID: Integration.ID
    readonly methodID: Integration.MethodID
    readonly inputs: Integration.Inputs
    readonly label?: string
  }) => Effect.Effect<Integration.Attempt, AuthorizationError>
  readonly attempt: {
    readonly status: (attemptID: Integration.AttemptID) => Effect.Effect<Integration.AttemptStatus>
    readonly complete: (input: {
      readonly attemptID: Integration.AttemptID
      readonly code?: string
    }) => Effect.Effect<void, CodeRequiredError | AuthorizationError>
    readonly cancel: (attemptID: Integration.AttemptID) => Effect.Effect<void>
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/GlobalIntegrationAuth") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const opencode = opencodeOAuth(http)
    const methods = new Map<Integration.ID, readonly Integration.Method[]>([
      [opencodeID, [opencode.method, opencodeKeyMethod]],
    ])
    const implementations = new Map<Integration.ID, ReadonlyMap<Integration.MethodID, OAuthImplementation>>([
      [opencodeID, new Map([[opencode.method.id, opencode]])],
    ])
    const auth = yield* makeAuthKernel((providerID, methodID) => implementations.get(providerID)?.get(methodID))

    return Service.of({
      methods: Effect.fn("GlobalIntegrationAuth.methods")((providerID: Integration.ID) =>
        Effect.succeed(methods.get(providerID) ?? []),
      ),
      oauth: auth.oauth,
      attempt: auth.attempt,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Credential.node, EventV2.node, httpClient],
})
