import { describe, expect, test } from "bun:test"
import { LLM, LLMEvent, Message, Model, type LLMRequest } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTurnProvenance } from "@opencode-ai/core/session/turn-provenance"
import { providerRequestHeaders } from "@opencode-ai/core/session/runner/provider-request-headers"
import { OpenCodeHostedUserAgent } from "@opencode-ai/core/installation/version"
import { DateTime, Effect, Stream } from "effect"

/**
 * S2-D typed architectural exclusion, proven rather than asserted.
 *
 * Core compaction is NOT a maintenance agent and NOT a new paid request class.
 * It is a continuation of the same parent generation, dispatched inside the same
 * drain with the parent's already route-materialized model and the parent's
 * exact materialized hosted headers. C3's released contract attributes the
 * durable route for that generation to the parent turn.
 *
 * Therefore compaction must:
 *   - reuse the parent model object and the parent `http` identity verbatim, so
 *     no second route selection or identity source can exist; and
 *   - record NO separate settlement, because a second Usage record for one
 *     physical request would double-count it.
 *
 * These tests fail if compaction ever starts selecting its own model/identity or
 * ever begins writing its own maintenance settlement.
 */

const sessionID = SessionSchema.ID.make("ses_compaction_identity")
const rootID = SessionMessage.ID.make("msg_compaction_identity_root")

const parentModel = Model.make({
  id: "space-bunny-free",
  provider: "opencode",
  route: OpenAIChat.route.with({ limits: { context: 20_000, output: 1_000 } }),
})

const rootEntry = {
  seq: 1,
  message: SessionMessage.User.make({
    id: rootID,
    type: "user",
    text: "ROOT REQUEST " + "x".repeat(24_000),
    provenance: SessionTurnProvenance.user(SessionTurnProvenance.Source.Prompt),
    time: { created: DateTime.makeUnsafe(0) },
  }),
}

const run = () => {
  const requests: LLMRequest[] = []
  const published: Array<{ definition: unknown; payload: unknown }> = []
  const compaction = SessionCompaction.make({
    events: {
      publish: ((definition: unknown, payload: unknown) => {
        published.push({ definition, payload })
        return Effect.succeed({ durable: { seq: published.length } })
      }) as never,
    } as never,
    llm: {
      stream: (request) => {
        requests.push(request)
        return Stream.fromIterable([
          LLMEvent.textStart({ id: "summary" }),
          LLMEvent.textDelta({ id: "summary", text: "summary" }),
          LLMEvent.textEnd({ id: "summary" }),
          LLMEvent.finish({ reason: "stop" }),
        ])
      },
    },
    config: [
      new Config.Document({
        type: "document",
        info: new Config.Info({
          compaction: new ConfigCompaction.Info({
            keep: new ConfigCompaction.Keep({ tokens: 1 }),
          }),
        }),
      }),
    ],
  })
  return { compaction, requests, published }
}

describe("Core compaction inherits the parent generation identity", () => {
  test("reuses the parent model object and the parent hosted http identity verbatim", async () => {
    const { compaction, requests } = run()
    const identity = providerRequestHeaders({
      providerID: "opencode",
      projectID: "prj_compaction",
      sessionID,
      requestID: "msg_parent_worker_turn",
    })
    const request = LLM.request({
      model: parentModel,
      http: { headers: identity },
      system: [],
      messages: [Message.user("provider request")],
      tools: [],
    })

    expect(
      await Effect.runPromise(
        compaction.compactAfterOverflow({ sessionID, entries: [rootEntry], model: parentModel, request, sourceMessageID: rootID }),
      ),
    ).toBe(true)

    expect(requests).toHaveLength(1)
    const dispatched = requests[0]!

    // Same model object: no second route selection is even possible.
    expect(dispatched.model).toBe(parentModel)
    expect(dispatched.model.provider).toBe(parentModel.provider)

    // Same materialized hosted identity, byte-for-byte.
    expect(dispatched.http?.headers).toEqual(identity)
    expect(dispatched.http?.headers?.["User-Agent"]).toBe(OpenCodeHostedUserAgent())
    expect(dispatched.http?.headers?.["x-opencode-session"]).toBe(sessionID)
  })

  test("adds no identity of its own when the parent request carries none", async () => {
    const { compaction, requests } = run()
    const request = LLM.request({
      model: parentModel,
      system: [],
      messages: [Message.user("provider request")],
      tools: [],
    })

    expect(
      await Effect.runPromise(
        compaction.compactAfterOverflow({ sessionID, entries: [rootEntry], model: parentModel, request, sourceMessageID: rootID }),
      ),
    ).toBe(true)

    expect(requests).toHaveLength(1)
    // Compaction must not fabricate hosted identity the parent did not have.
    expect(requests[0]!.http).toBeUndefined()
  })

  test("records no separate settlement for the compaction provider turn", async () => {
    const { compaction, published } = run()
    const request = LLM.request({
      model: parentModel,
      http: {
        headers: providerRequestHeaders({
          providerID: "opencode",
          projectID: "prj_compaction",
          sessionID,
          requestID: "msg_parent_worker_turn",
        }),
      },
      system: [],
      messages: [Message.user("provider request")],
      tools: [],
    })

    await Effect.runPromise(
      compaction.compactAfterOverflow({ sessionID, entries: [rootEntry], model: parentModel, request, sourceMessageID: rootID }),
    )

    // Compaction is a continuation, not a maintenance agent: it publishes domain
    // events only. Any usage/maintenance settlement here would double-count one
    // physical request against the parent turn's own settlement.
    const payloads = JSON.stringify(published)
    expect(published.length).toBeGreaterThan(0)
    expect(payloads).not.toContain("maintenance_usage")
    expect(payloads).not.toContain("recordMaintenance")
  })
})
