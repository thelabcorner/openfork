import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionID, MessageID } from "@/session/schema"
import type { MCP } from "@/mcp"
import * as McpResourceTools from "@/mcp/resource-capabilities"
import type { Tool } from "@/tool/tool"

function service() {
  return {
    clients: () =>
      Effect.succeed({
        alpha: {
          getServerCapabilities: () => ({ resources: {} }),
        },
        beta: {
          getServerCapabilities: () => ({ resources: {} }),
        },
      } as any),
    resources: (server?: string) =>
      Effect.succeed({
        one: {
          name: "one",
          uri: "res://one",
          description: "first",
          client: server ?? "alpha",
        },
      } as any),
    resourceTemplates: (server?: string) =>
      Effect.succeed({
        one: {
          name: "template",
          uriTemplate: "res://{id}",
          client: server ?? "alpha",
        },
      } as any),
    readResource: (_server: string, uri: string) =>
      Effect.succeed({
        contents: [
          { uri, mimeType: "text/plain", text: "hello" },
          { uri: uri + "/image", mimeType: "image/png", blob: "aGVsbG8=" },
        ],
      } as any),
  } as Pick<MCP.Interface, "clients" | "resources" | "resourceTemplates" | "readResource">
}

function context(asks: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">>): Tool.Context {
  return {
    sessionID: SessionID.make("ses_resource_capability"),
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: (request) =>
      Effect.sync(() => {
        asks.push(request)
      }),
  }
}

describe("McpResourceTools", () => {
  test("list uses server-scoped read permission and returns structured data", async () => {
    const asks: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
    const result = await Effect.runPromise(
      McpResourceTools.invoke(service(), McpResourceTools.IDs.list, { server: "alpha" }, context(asks)),
    )

    expect(asks).toEqual([
      {
        permission: "read",
        metadata: { server: "alpha" },
        patterns: ["mcp:alpha:*"],
        always: ["mcp:alpha:*"],
      },
    ])
    expect(result.data).toEqual({
      resources: [
        {
          name: "one",
          uri: "res://one",
          description: "first",
          server: "alpha",
        },
      ],
    })
  })

  test("read preserves text plus supported binary attachments without provider IDs", async () => {
    const asks: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
    const result = await Effect.runPromise(
      McpResourceTools.invoke(
        service(),
        McpResourceTools.IDs.read,
        { server: "alpha", uri: "res://one" },
        context(asks),
      ),
    )

    expect(asks[0]?.patterns).toEqual(["mcp:alpha:res://one"])
    expect(result.output).toContain("hello")
    expect(result.attachments).toEqual([
      {
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,aGVsbG8=",
        filename: "res://one/image",
      },
    ])
  })

  test("authorization fails closed on an explicit server-scoped deny", async () => {
    const exit = await Effect.runPromiseExit(
      McpResourceTools.authorize(
        service(),
        McpResourceTools.IDs.read,
        { server: "alpha", uri: "res://one" },
        [{ permission: "read", pattern: "mcp:alpha:*", action: "deny" }],
      ),
    )
    expect(exit._tag).toBe("Failure")
  })
})
