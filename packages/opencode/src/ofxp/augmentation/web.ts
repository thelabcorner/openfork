export * as OfxpWebCapability from "./web"

import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { ExchangeError } from "@/exchange/error"
import type { RuntimeFlags } from "@/effect/runtime-flags"
import { Parameters as WebParameters } from "@/tool/web"
import { executeFetch } from "@/tool/webfetch"
import { callProvider, flagMap, providersOutput, selectWebSearchProvider, webSearchProviderLabel } from "@/tool/websearch"
import type { PeerCertificateIdentity } from "../certificate"

export const Parameters = WebParameters

export interface Dependencies {
  readonly peers: OfxpPeer.Interface
  readonly http: HttpClient.HttpClient
  readonly flags: RuntimeFlags.Info
}

export interface Result {
  readonly title: string
  readonly output: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly grantRevision: number
}

function actionOf(input: Schema.Schema.Type<typeof Parameters>): "fetch" | "search" | "providers" {
  if (input.action) return input.action
  if (input.url) return "fetch"
  if (input.query) return "search"
  return "fetch"
}

export const execute = Effect.fn("OfxpWebCapability.execute")(function* (
  deps: Dependencies,
  peer: PeerCertificateIdentity,
  call: Ofxp.CapabilityCall,
  signal?: AbortSignal,
) {
  if (signal?.aborted) return yield* new ExchangeError.Cancelled({ detail: "OFXP web request was cancelled" })
  const input = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(Parameters)(call.args, { onExcessProperty: "error" }),
    catch: () => new ExchangeError.InvalidArgument({ detail: "OFXP web arguments are invalid" }),
  })
  const admission = yield* deps.peers.authorize({ peerID: peer.peerID, capability: "integrations" })
  const action = actionOf(input)
  const flagsByProvider = flagMap(deps.flags)

  let result: Omit<Result, "grantRevision">
  if (action === "providers") {
    if (input.url || input.query) return yield* new ExchangeError.InvalidArgument({ detail: "web.providers does not accept url or query" })
    result = { title: "Web search providers", output: providersOutput(flagsByProvider), metadata: { action } }
  } else if (action === "fetch") {
    if (!input.url) return yield* new ExchangeError.InvalidArgument({ detail: "web.fetch requires url" })
    const fetched = yield* executeFetch(deps.http, {
      url: input.url,
      format: input.format ?? "markdown",
      ...(input.timeout === undefined ? {} : { timeout: input.timeout }),
    }).pipe(
      Effect.mapError((error) =>
        error.message.includes("URL must") || error.message.includes("too large")
          ? new ExchangeError.InvalidArgument({ detail: error.message })
          : new ExchangeError.DependencyUnavailable({ detail: `Web fetch failed: ${error.message}` }),
      ),
    )
    result = {
      title: fetched.title,
      output: fetched.output,
      metadata: { action, url: input.url, ...(fetched.attachments?.length ? { attachmentsOmitted: fetched.attachments.length } : {}) },
    }
  } else {
    if (!input.query) return yield* new ExchangeError.InvalidArgument({ detail: "web.search requires query" })
    const source = call.context.sourceSessionID ??
      (call.context.source?.kind === "session"
        ? call.context.source.sessionID
        : call.context.source?.kind === "external"
          ? call.context.source.principal
          : "unknown")
    const provider = selectWebSearchProvider(`${peer.peerID}:${source}`, flagsByProvider, input.provider)
    const output = yield* callProvider(
      deps.http,
      provider,
      {
        action: "search",
        query: input.query,
        ...(input.numResults === undefined ? {} : { numResults: input.numResults }),
        ...(input.livecrawl === undefined ? {} : { livecrawl: input.livecrawl }),
        ...(input.type === undefined ? {} : { type: input.type }),
        ...(input.contextMaxCharacters === undefined ? {} : { contextMaxCharacters: input.contextMaxCharacters }),
        ...(input.provider === undefined ? {} : { provider: input.provider }),
      },
      { sessionID: `${peer.peerID}:${source}` },
    ).pipe(
      Effect.mapError((error) => new ExchangeError.DependencyUnavailable({ detail: `Web search failed: ${String(error)}` })),
    )
    result = {
      title: `${webSearchProviderLabel(provider)} "${input.query}"`,
      output: output ?? "No search results found. Please try a different query.",
      metadata: { action, provider },
    }
  }

  if (signal?.aborted) return yield* new ExchangeError.Cancelled({ detail: "OFXP web request was cancelled" })
  const fresh = yield* deps.peers.authorize({
    peerID: peer.peerID,
    capability: "integrations",
    expectedGrantRevision: admission.grantRevision,
  })
  void fresh
  return { ...result, grantRevision: admission.grantRevision } satisfies Result
})

