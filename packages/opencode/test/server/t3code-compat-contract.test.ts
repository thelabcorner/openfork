import { describe, expect, test } from "bun:test"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { Schema } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import { EventManifest } from "../../src/event-manifest"
import { t3CodeAccountModelID } from "../../src/compat/t3code"
import * as Question from "../../src/question"
import * as Session from "../../src/session/session"
import { OpenCodeHttpApi } from "../../src/server/routes/instance/httpapi/api"
import {
  CommandPayload,
  ForkPayload,
  PromptPayload,
  SummarizePayload,
  UpdatePayload,
} from "../../src/server/routes/instance/httpapi/groups/session"

type Method = "get" | "post" | "patch"
type Parameter = {
  readonly name?: string
  readonly in?: string
}
type Operation = {
  readonly parameters?: ReadonlyArray<Parameter>
}
type Spec = {
  readonly paths: Record<string, Partial<Record<Method, Operation>>>
}

const sdkOperations = [
  ["app.agents", "get", "/agent"],
  ["app.skills", "get", "/skill"],
  ["command.list", "get", "/command"],
  ["event.subscribe", "get", "/event"],
  ["global.health", "get", "/global/health"],
  ["mcp.add", "post", "/mcp"],
  ["permission.list", "get", "/permission"],
  ["permission.reply", "post", "/permission/{requestID}/reply"],
  ["provider.list", "get", "/provider"],
  ["question.list", "get", "/question"],
  ["question.reply", "post", "/question/{requestID}/reply"],
  ["session.abort", "post", "/session/{sessionID}/abort"],
  ["session.children", "get", "/session/{sessionID}/children"],
  ["session.command", "post", "/session/{sessionID}/command"],
  ["session.create", "post", "/session"],
  ["session.fork", "post", "/session/{sessionID}/fork"],
  ["session.get", "get", "/session/{sessionID}"],
  ["session.message", "get", "/session/{sessionID}/message/{messageID}"],
  ["session.messages", "get", "/session/{sessionID}/message"],
  ["session.promptAsync", "post", "/session/{sessionID}/prompt_async"],
  ["session.status", "get", "/session/status"],
  ["session.summarize", "post", "/session/{sessionID}/summarize"],
  ["session.update", "patch", "/session/{sessionID}"],
] as const satisfies ReadonlyArray<readonly [string, Method, string]>

const consumedEvents = [
  "server.connected",
  "session.created",
  "session.updated",
  "session.deleted",
  "session.error",
  "session.compacted",
  "session.status",
  "message.updated",
  "message.removed",
  "message.part.updated",
  "message.part.delta",
  "message.part.removed",
  "todo.updated",
  "permission.asked",
  "permission.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
] as const

describe("T3 Code OpenCode 1.15.13 consumer contract", () => {
  test("retains every SDK operation used by T3 Code", () => {
    const spec = OpenApi.fromApi(OpenCodeHttpApi) as Spec

    for (const [operation, method, path] of sdkOperations) {
      expect(spec.paths[path]?.[method], `${operation} must remain available at ${method.toUpperCase()} ${path}`).toBeDefined()
    }
  })

  test("retains T3 Code directory routing and bootstrap-free status semantics", () => {
    const spec = OpenApi.fromApi(OpenCodeHttpApi) as Spec
    const fork = spec.paths["/session/{sessionID}/fork"]?.post
    const status = spec.paths["/session/status"]?.get

    expect(fork?.parameters?.some((parameter) => parameter.in === "query" && parameter.name === "directory")).toBe(true)
    expect(status?.parameters?.some((parameter) => parameter.name === "directory")).toBe(false)
  })

  test("retains every event type consumed by the T3 Code adapter", () => {
    for (const event of consumedEvents) {
      expect(EventManifest.Latest.has(event), `${event} must remain in the legacy event manifest`).toBe(true)
    }
  })

  test("retains the status variants T3 Code recognizes", () => {
    expect(Schema.is(SessionStatusEvent.Info)({ type: "idle" })).toBe(true)
    expect(Schema.is(SessionStatusEvent.Info)({ type: "busy" })).toBe(true)
    expect(
      Schema.is(SessionStatusEvent.Info)({
        type: "retry",
        attempt: 1,
        message: "retry",
        next: 0,
      }),
    ).toBe(true)
  })

  test("accepts the request payload shapes T3 Code emits", () => {
    const accountAlias = t3CodeAccountModelID(
      "claude-test",
      "opencode-account:t3-test",
    )
    const fullAccessPermissions = [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
    ] as const

    expect(
      Schema.is(ConfigMCPV1.Info)({
        type: "remote",
        url: "http://127.0.0.1:43123",
        headers: { Authorization: "Bearer t3-test" },
        oauth: false,
      }),
    ).toBe(true)

    expect(
      Schema.is(Session.CreateInput)({
        title: "T3 Code thread",
        permission: fullAccessPermissions,
      }),
    ).toBe(true)

    expect(
      Schema.is(ForkPayload)({
        messageID: "msg_t3_rewind",
      }),
    ).toBe(true)

    expect(
      Schema.is(PromptPayload)({
        messageID: "msg_t3_test",
        model: {
          providerID: "anthropic",
          modelID: accountAlias,
        },
        system: "T3 Code runtime addendum",
        parts: [
          { type: "text", text: "hello" },
          {
            type: "file",
            mime: "text/plain",
            filename: "notes.txt",
            url: "file:///tmp/notes.txt",
          },
        ],
      }),
    ).toBe(true)

    expect(
      Schema.is(CommandPayload)({
        messageID: "msg_t3_command",
        command: "test",
        arguments: "",
        model: `anthropic/${accountAlias}`,
        agent: "build",
        variant: "high",
        parts: [],
      }),
    ).toBe(true)

    expect(
      Schema.is(SummarizePayload)({
        providerID: "anthropic",
        modelID: accountAlias,
        auto: false,
      }),
    ).toBe(true)

    expect(
      Schema.is(UpdatePayload)({
        permission: fullAccessPermissions,
      }),
    ).toBe(true)

    for (const reply of ["once", "always", "reject"] as const) {
      expect(Schema.is(PermissionV1.Reply)(reply)).toBe(true)
    }

    expect(Schema.is(Schema.Array(Question.Answer))([["first"], ["second", "third"], []])).toBe(true)
  })
})
