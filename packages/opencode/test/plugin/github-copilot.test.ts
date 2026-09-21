import { expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { CopilotAuthPlugin } from "@/plugin/github-copilot/copilot"

type ChatHeaders = NonNullable<Hooks["chat.headers"]>

async function hook(options?: { parts?: unknown[]; parentID?: string }) {
  const hooks = await CopilotAuthPlugin({
    directory: "",
    project: {} as never,
    worktree: "",
    experimental_workspace: { register() {} },
    serverUrl: new URL("http://localhost"),
    $: {} as never,
    client: {
      session: {
        message: async () => ({ data: { parts: options?.parts ?? [] } }),
        get: async () => ({ data: options?.parentID ? { parentID: options.parentID } : {} }),
      },
    } as never,
  })
  return hooks["chat.headers"]!
}

function input(
  sessionID: string,
  providerID: string,
  npm: string,
  provenance?: { owner: "user" | "host"; source: string },
) {
  return {
    sessionID,
    agent: "build",
    model: { providerID, api: { npm } },
    message: { id: "msg_test", sessionID, role: "user", ...(provenance ? { provenance } : {}) },
  } as Parameters<ChatHeaders>[0]
}

test.each([
  ["github-copilot", "@ai-sdk/github-copilot"],
  ["github-copilot", "@ai-sdk/anthropic"],
  ["github-copilot-enterprise", "@ai-sdk/github-copilot"],
  ["github-copilot-enterprise", "@ai-sdk/anthropic"],
])("uses the session ID for %s interaction headers with %s", async (providerID, npm) => {
  const headers = await hook()
  for (const sessionID of ["ses_one", "ses_one", "ses_two"]) {
    const output = { headers: { "x-existing": "preserved" } }
    await headers(input(sessionID, providerID, npm), output)
    expect(output.headers).toMatchObject({
      "X-Interaction-Id": sessionID,
      "x-existing": "preserved",
    })
  }
})

test("does not add interaction headers to other providers", async () => {
  const headers = await hook()
  const output = { headers: { "x-existing": "preserved" } }
  await headers(input("ses_one", "openai", "@ai-sdk/openai"), output)
  expect(output.headers).toEqual({ "x-existing": "preserved" })
})

test("derives Copilot initiator from explicit turn ownership instead of provider user role", async () => {
  const headers = await hook()
  const host = { headers: {} as Record<string, string> }
  await headers(input("ses_host", "github-copilot", "@ai-sdk/github-copilot", { owner: "host", source: "goal.continuation" }), host)
  expect(host.headers["x-initiator"]).toBe("agent")

  const user = { headers: {} as Record<string, string> }
  await headers(input("ses_user", "github-copilot", "@ai-sdk/github-copilot", { owner: "user", source: "goal.start" }), user)
  expect(user.headers["x-initiator"]).toBe("user")
})

test("quarantines legacy part inference in the canonical V1 provenance resolver", async () => {
  const synthetic = await hook({
    parts: [
      {
        id: "prt_host",
        sessionID: "ses_legacy_host",
        messageID: "msg_test",
        type: "text",
        text: "Continue",
        synthetic: true,
      },
    ],
  })
  const host = { headers: {} as Record<string, string> }
  await synthetic(input("ses_legacy_host", "github-copilot", "@ai-sdk/github-copilot"), host)
  expect(host.headers["x-initiator"]).toBe("agent")

  const ordinary = await hook({
    parts: [
      {
        id: "prt_user",
        sessionID: "ses_legacy_user",
        messageID: "msg_test",
        type: "text",
        text: "Please help",
      },
    ],
  })
  const user = { headers: {} as Record<string, string> }
  await ordinary(input("ses_legacy_user", "github-copilot", "@ai-sdk/github-copilot"), user)
  expect(user.headers["x-initiator"]).toBe("user")
})

test("legacy child-session topology remains agent-initiated after canonical turn resolution", async () => {
  const headers = await hook({
    parentID: "ses_parent",
    parts: [
      {
        id: "prt_user",
        sessionID: "ses_child",
        messageID: "msg_test",
        type: "text",
        text: "Legacy child task",
      },
    ],
  })
  const output = { headers: {} as Record<string, string> }
  await headers(input("ses_child", "github-copilot", "@ai-sdk/github-copilot"), output)
  expect(output.headers["x-initiator"]).toBe("agent")
})
