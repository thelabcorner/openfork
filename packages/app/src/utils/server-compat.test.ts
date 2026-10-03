import { describe, expect, test } from "bun:test"
import { createApiForServer, createSdkForServer } from "./server"
import {
  createCompatibleApi,
  LegacyPromptRevisorProtocolError,
  type CompatibleRevisionDraftArtifact,
} from "./server-compat"

function setup(
  protocol: "v1" | "v2" | Promise<"v1" | "v2">,
  responses?: {
    vcs?: { branch: string; default_branch: string }
    reviseError?: Response
    reviseResult?: unknown
    revisionDraft?: unknown
    abortAccepted?: boolean
  },
) {
  const requests: Request[] = []
  const fetcher = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(request)
      if (request.method === "PATCH") {
        return Response.json({
          id: "ses_1",
          slug: "ses_1",
          projectID: "project",
          directory: "/repo",
          title: "Session",
          version: "1",
          time: { created: 1, updated: 1 },
        })
      }
      if (request.method === "POST" && request.url.endsWith("/prompt_async"))
        return new Response(undefined, { status: 204 })
      if (request.method === "POST" && request.url.endsWith("/abort"))
        return Response.json(responses?.abortAccepted ?? true)
      if (request.method === "POST" && request.url.endsWith("/prompt")) {
        return Response.json({
          admittedSeq: 1,
          id: "msg_1",
          sessionID: "ses_1",
          timeCreated: 1,
          type: "user",
          data: { text: "hello" },
          delivery: "steer",
        })
      }
      if (request.method === "POST" && new URL(request.url).pathname === "/prompt/revise") {
        if (responses?.reviseError) return responses.reviseError
        if (responses && "reviseResult" in responses) return Response.json(responses.reviseResult)
        return Response.json({
          type: "revision",
          prompt: "Revised prompt",
          references: [],
          tools: ["question", "revised_prompt"],
          rounds: 1,
        })
      }
      if (request.method === "POST" && new URL(request.url).pathname === "/revision-draft/recover")
        return Response.json(responses?.revisionDraft ?? null)
      if (request.method === "POST" && new URL(request.url).pathname === "/revision-draft/consume")
        return new Response(undefined, { status: 204 })
      if (request.method === "GET" && new URL(request.url).pathname === "/vcs")
        return Response.json(responses?.vcs ?? {})
      if (request.method === "GET") return Response.json([])
      return new Response(undefined, { status: 204 })
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  const server = { url: "http://localhost:4096" }
  const api = createCompatibleApi({
    protocol: typeof protocol === "string" ? Promise.resolve(protocol) : protocol,
    current: createApiForServer({ server, fetch: fetcher }),
    legacy: (directory) => createSdkForServer({ server, fetch: fetcher, directory, throwOnError: true }),
    server,
    fetch: fetcher,
    directory: "/repo",
  })
  return { api, requests }
}

describe("createCompatibleApi", () => {
  test("rejects a V1 interrupt when generation fencing supersedes the abort", async () => {
    const { api } = setup("v1", { abortAccepted: false })
    await expect(api.session.interrupt({ sessionID: "ses_1" })).rejects.toThrow("superseded by a newer execution")
  })

  test("preserves structured question details on current protocol", async () => {
    const { api, requests } = setup("v2")
    await api.question.reply({
      sessionID: "ses_1",
      requestID: "que_1",
      answers: [["Build"]],
      details: ["Focus @packages/app"],
    })

    const request = requests.at(-1)!
    const url = new URL(request.url)
    expect(url.pathname).toBe("/question/que_1/reply")
    expect(url.searchParams.get("directory")).toBe("/repo")
    expect(await request.json()).toEqual({ answers: [["Build"]], details: ["Focus @packages/app"] })
  })

  test("flattens question details for V1 compatibility", async () => {
    const { api, requests } = setup("v1")
    await api.question.reply({
      sessionID: "ses_1",
      requestID: "que_1",
      answers: [["Build"]],
      details: ["Focus @packages/app"],
    })

    const request = requests.at(-1)!
    expect(new URL(request.url).pathname).toBe("/question/que_1/reply")
    expect(await request.json()).toEqual({ answers: [["Build", "Focus @packages/app"]] })
  })

  test("surfaces the server's own message instead of a raw tagged error body", async () => {
    const { api } = setup("v2", {
      reviseError: Response.json(
        {
          _tag: "ServiceUnavailableError",
          message: "The prompt revisor's response hit the model output limit before it could commit the revision.",
          service: "prompt-revisor",
        },
        { status: 503 },
      ),
    })

    const error = await api.promptRevisor.revise({ prompt: "Improve this." }).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(
      "The prompt revisor's response hit the model output limit before it could commit the revision.",
    )
  })

  test("falls back to the status line when a failure body is not a tagged error", async () => {
    const { api } = setup("v2", { reviseError: new Response("", { status: 502 }) })

    const error = await api.promptRevisor.revise({ prompt: "Improve this." }).catch((value: unknown) => value)
    expect((error as Error).message).toContain("502")
    expect((error as Error).message).toContain("/prompt/revise")
  })

  test("routes Prompt Revisor to the selected workspace without transporting clarification lifecycle state", async () => {
    const { api, requests } = setup("v2")
    const result = await api.promptRevisor.revise({
      prompt: "Improve this parser.",
      draft: {
        mentions: [{ id: "m1", type: "file", token: "@src/parser.ts", path: "src/parser.ts" }],
        attachments: [{ id: "img1", type: "image", filename: "bug.png", mime: "image/png" }],
      },
      location: { directory: "/other" },
    })

    const request = requests.at(-1)!
    const url = new URL(request.url)
    expect(url.pathname).toBe("/prompt/revise")
    expect(url.searchParams.get("directory")).toBe("/other")
    expect(await request.json()).toEqual({
      prompt: "Improve this parser.",
      draft: {
        mentions: [{ id: "m1", type: "file", token: "@src/parser.ts", path: "src/parser.ts" }],
        attachments: [{ id: "img1", type: "image", filename: "bug.png", mime: "image/png" }],
      },
    })
    expect(result).toEqual({
      type: "revision",
      prompt: "Revised prompt",
      references: [],
      tools: ["question", "revised_prompt"],
      rounds: 1,
    })
  })

  test("preserves the scheduled-task revision purpose and exact fallback model identity", async () => {
    const { api, requests } = setup("v2")
    await api.promptRevisor.revise({
      prompt: "Audit dependencies every night.",
      purpose: "scheduled_task",
      target: {
        kind: "scheduled_task",
        key: "task:task_1",
        sourceFingerprint: "sha256-source",
      },
      includeSessionContext: false,
      fallbackModel: {
        providerID: "provider",
        id: "model",
        accountID: "account-2",
        variant: "high",
      },
      location: { directory: "/scheduled" },
    })

    const request = requests.at(-1)!
    const url = new URL(request.url)
    expect(url.pathname).toBe("/prompt/revise")
    expect(url.searchParams.get("directory")).toBe("/scheduled")
    expect(await request.json()).toMatchObject({
      prompt: "Audit dependencies every night.",
      purpose: "scheduled_task",
      target: {
        kind: "scheduled_task",
        key: "task:task_1",
        sourceFingerprint: "sha256-source",
      },
      includeSessionContext: false,
      fallbackModel: {
        providerID: "provider",
        id: "model",
        accountID: "account-2",
        variant: "high",
      },
    })
  })

  test("round-trips durable revision mailbox recovery and immutable acknowledgement", async () => {
    const artifact: CompatibleRevisionDraftArtifact = {
      id: "revision-draft:artifact-1",
      directory: "/scheduled-target",
      kind: "scheduled_task",
      key: "new:/repo",
      purpose: "scheduled_task",
      sourceFingerprint: "source-fingerprint",
      prompt: "Recovered scheduled prompt",
      references: [],
      timeCreated: 42,
    }
    const { api, requests } = setup("v2", { revisionDraft: artifact })

    expect(await api.revisionDraft.recover({ kind: "scheduled_task", key: "new:/repo" })).toEqual(artifact)
    const recover = requests.at(-1)!
    expect(new URL(recover.url).pathname).toBe("/revision-draft/recover")
    expect(await recover.json()).toEqual({ kind: "scheduled_task", key: "new:/repo" })

    await api.revisionDraft.consume({ id: artifact.id })
    const consume = requests.at(-1)!
    expect(new URL(consume.url).pathname).toBe("/revision-draft/consume")
    expect(await consume.json()).toEqual({ id: artifact.id })
  })

  test("localizes the retired question-return protocol to an explicit compatibility error", async () => {
    const { api } = setup("v2", {
      reviseResult: {
        type: "question",
        questions: [],
        clarificationRound: 1,
        tools: ["question"],
        rounds: 1,
      },
    })

    const error = await api.promptRevisor.revise({ prompt: "Improve this." }).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(LegacyPromptRevisorProtocolError)
    expect((error as Error).message).toContain("retired Prompt Revisor clarification protocol")
  })

  /*
  test("routes V1 archive through the legacy session update", async () => {
    const { api, requests } = setup("v1")
    await api.session.archive({ sessionID: "ses_1", directory: "/repo" })

    const url = new URL(requests[0]!.url)
    expect(url.pathname).toBe("/session/ses_1")
    expect(requests[0]!.headers.get("x-opencode-directory")).toBe("%2Frepo")
    expect(requests[0]!.method).toBe("PATCH")
    expect(await requests[0]!.json()).toMatchObject({ time: { archived: expect.any(Number) } })
  })
  */

  test("converts current prompts to the V1 prompt contract", async () => {
    const { api, requests } = setup("v1")
    await api.session.prompt({
      sessionID: "ses_1",
      id: "msg_1",
      text: "hello @src/index.ts",
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
      files: [
        { uri: "file:///repo/src/index.ts", name: "index.ts", mention: { text: "@src/index.ts", start: 6, end: 19 } },
        { uri: "data:text/plain;base64,aGVsbG8=", name: "notes.txt" },
      ],
    })

    expect(new URL(requests[0]!.url).pathname).toBe("/session/ses_1/prompt_async")
    const body = await requests[0]!.json()
    expect(body).toMatchObject({
      messageID: "msg_1",
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
      parts: [
        { type: "text", text: "hello @src/index.ts" },
        {
          type: "file",
          mime: "text/plain",
          url: "file:///repo/src/index.ts",
          filename: "index.ts",
          source: {
            type: "file",
            text: { value: "@src/index.ts", start: 6, end: 19 },
            path: "file:///repo/src/index.ts",
          },
        },
        {
          type: "file",
          mime: "text/plain",
          url: "data:text/plain;base64,aGVsbG8=",
          filename: "notes.txt",
        },
      ],
    })
    expect(body.parts[2]).not.toHaveProperty("source")
  })

  test("preserves original parts for V1 optimistic reconciliation", async () => {
    const { api, requests } = setup("v1")
    await api.session.prompt({
      sessionID: "ses_1",
      id: "msg_1",
      text: "look",
      files: [{ uri: "data:image/png;base64,AAAA", name: "image.png" }],
      legacyParts: [
        { id: "prt_text", type: "text", text: "look" },
        { id: "prt_image", type: "file", mime: "image/png", url: "data:image/png;base64,AAAA", filename: "image.png" },
      ],
    })

    expect((await requests[0]!.json()).parts).toEqual([
      { id: "prt_text", type: "text", text: "look" },
      { id: "prt_image", type: "file", mime: "image/png", url: "data:image/png;base64,AAAA", filename: "image.png" },
    ])
  })

  test("resolves protocol detection once across implementation methods", async () => {
    let detections = 0
    const resolved = Promise.resolve<"v1" | "v2">("v2")
    const protocol = new Proxy(resolved, {
      get(target, property) {
        if (property !== "then") return Reflect.get(target, property, target)
        detections++
        return target.then.bind(target)
      },
    })
    const { api } = setup(protocol)

    await api.session.list()
    await api.session.list()

    expect(detections).toBe(1)
  })

  /*
  test("keeps V2 session actions on the current API", async () => {
    const { api, requests } = setup("v2")
    await api.session.archive({ sessionID: "ses_1" })

    expect(new URL(requests[0]!.url).pathname).toBe("/api/session/ses_1/archive")
    expect(requests[0]!.method).toBe("POST")
  })
  */

  test("uses the global V1 session search endpoint", async () => {
    const { api, requests } = setup("v1")
    await api.session.list({ parentID: null, search: "session", limit: 50 })

    expect(new URL(requests[0]!.url).pathname).toBe("/experimental/session")
  })

  test("routes V1 tab control actions through raw session endpoints", async () => {
    const { api, requests } = setup("v1")

    await api.session.pause({ sessionID: "ses_1" })
    await api.session.resume({ sessionID: "ses_1" })
    await api.session.regenerateTitle({
      sessionID: "ses_1",
      model: { providerID: "provider", id: "model" },
      prompt: "short title",
    })

    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["POST", "/session/ses_1/pause"],
      ["POST", "/session/ses_1/resume"],
      ["POST", "/session/ses_1/title/regenerate"],
    ])
    expect(await requests[2]!.json()).toEqual({
      model: { providerID: "provider", id: "model" },
      prompt: "short title",
    })
  })

  test("keeps tab control actions available on the current protocol shape", async () => {
    const { api, requests } = setup("v2")

    await api.session.pause({ sessionID: "ses_1" })

    expect(new URL(requests[0]!.url).pathname).toBe("/session/ses_1/pause")
  })

  /*
  test("projects the V1 default branch", async () => {
    const { api } = setup("v1", { vcs: { branch: "feature", default_branch: "dev" } })

    expect(await api.vcs.get({ location: { directory: "/repo" } })).toMatchObject({
      data: { branch: "feature", defaultBranch: "dev" },
    })
  })
  */

  test("translates current file searches to the V1 dirs parameter", async () => {
    const { api, requests } = setup("v1")
    await api.file.find({ location: { directory: "/repo" }, query: "src", type: "file", limit: 20 })

    const url = new URL(requests[0]!.url)
    expect(url.pathname).toBe("/find/file")
    expect(url.searchParams.get("dirs")).toBe("false")
    expect(url.searchParams.get("limit")).toBe("20")
  })

  test("synthesizes an authoritative mention-search base for older V1 servers", async () => {
    const { api, requests } = setup("v1")
    const result = await api.find.search({ location: { directory: "/repo" }, query: "sink_ab.mjs", limit: 50 })

    const url = new URL(requests[0]!.url)
    expect(url.pathname).toBe("/find/search")
    expect(result.data).toEqual({ base: "/repo", results: [], hasMore: false, total: 0 })
  })

  test("falls back to the compatibility client's directory when find.search omits location", async () => {
    const { api } = setup("v1")
    const result = await api.find.search({ query: "sink_ab.mjs", limit: 50 })

    expect(result.data.base).toBe("/repo")
    expect(result.location.directory).toBe("/repo")
  })

  test("routes V1 permission replies through the requested directory", async () => {
    const { api, requests } = setup("v1")
    await api.permission.reply({
      sessionID: "ses_1",
      requestID: "permission_1",
      reply: "once",
      location: { directory: "/other" },
    })

    expect(new URL(requests[0]!.url).pathname).toBe("/session/ses_1/permissions/permission_1")
    expect(new URL(requests[0]!.url).searchParams.get("directory")).toBe("/other")
  })

  test("disposes the V1 instance after connecting a provider", async () => {
    const { api, requests } = setup("v1")

    await api.integration.connect.key({
      integrationID: "openrouter",
      key: "secret",
      location: { directory: "/repo" },
    })

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/auth/openrouter",
      "/instance/dispose",
      "/instance/dispose",
    ])
    expect(requests[1]!.headers.get("x-opencode-directory")).toBe("%2Frepo")
    expect(requests[2]!.headers.get("x-opencode-directory")).toBeNull()
  })

  test("disposes the V1 instance after completing provider OAuth", async () => {
    const { api, requests } = setup("v1")

    await api.integration.oauth.complete({
      integrationID: "openrouter",
      attemptID: "openrouter:0",
      code: "code",
      location: { directory: "/repo" },
    })

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/provider/openrouter/oauth/callback",
      "/instance/dispose",
      "/instance/dispose",
    ])
    expect(requests[1]!.headers.get("x-opencode-directory")).toBe("%2Frepo")
    expect(requests[2]!.headers.get("x-opencode-directory")).toBeNull()
  })
})
