import { describe, expect, test } from "bun:test"
import { createApiForServer, createSdkForServer } from "./server"
import { normalizeSessionInfo } from "./session"
import { sessionTitleErrorMessage } from "../components/session-title-error"
import {
  createCompatibleApi,
  LegacyPromptRevisorProtocolError,
  type CompatibleRevisionDraftArtifact,
  type CompatibleRevisionRunStatus,
} from "./server-compat"

function setup(
  protocol: "v1" | "v2" | Promise<"v1" | "v2">,
  responses?: {
    vcs?: { branch: string; default_branch: string }
    reviseError?: Response
    titleError?: Response
    reviseResult?: unknown
    revisionDraft?: unknown
    revisionProgress?: unknown
    revisionRunStatus?: unknown
    cancelResult?: unknown
    abortAccepted?: boolean
    session?: unknown
  },
  scheduleControl?: <T>(kind: string, run: () => Promise<T>) => Promise<T>,
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
      if (request.method === "POST" && new URL(request.url).pathname.endsWith("/title/regenerate"))
        return responses?.titleError ?? new Response(undefined, { status: 204 })
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
      if (request.method === "GET" && new URL(request.url).pathname === "/prompt/revise/progress") {
        if (responses && "revisionProgress" in responses) return Response.json(responses.revisionProgress)
        return new Response(undefined, { status: 404 })
      }
      if (request.method === "GET" && new URL(request.url).pathname === "/prompt/revise/run") {
        if (responses && "revisionRunStatus" in responses) return Response.json(responses.revisionRunStatus)
        return new Response(undefined, { status: 404 })
      }
      if (request.method === "POST" && new URL(request.url).pathname === "/prompt/revise/cancel") {
        if (responses && "cancelResult" in responses) return Response.json(responses.cancelResult)
        return new Response(undefined, { status: 404 })
      }
      if (request.method === "GET" && new URL(request.url).pathname === "/vcs")
        return Response.json(responses?.vcs ?? {})
      if (request.method === "GET" && responses?.session) return Response.json(responses.session)
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
    scheduleControl,
  })
  return { api, requests }
}

describe("createCompatibleApi", () => {
  for (const protocol of ["v1", "v2"] as const) {
    test(`preserves safe title error detail through ${protocol} compatibility`, async () => {
      const { api } = setup(protocol, {
        titleError: Response.json(
          { _tag: "ServiceUnavailableError", service: "session-title", message: "The title model hit a usage limit." },
          { status: 503 },
        ),
      })
      const error = await api.session.regenerateTitle({ sessionID: "ses_1" }).catch((value: unknown) => value)
      expect(sessionTitleErrorMessage(error)).toBe("The title model hit a usage limit.")
    })

    test(`does not trust arbitrary title failure text through ${protocol} compatibility`, async () => {
      const { api } = setup(protocol, {
        titleError: new Response("upstream leaked provider secret", { status: 502 }),
      })
      const error = await api.session.regenerateTitle({ sessionID: "ses_1" }).catch((value: unknown) => value)
      expect(sessionTitleErrorMessage(error)).toBeUndefined()
    })
  }
  test("preserves server-owned worker interjection through V1 adaptation and normalization", async () => {
    const { api, requests } = setup("v1", {
      session: {
        id: "ses_worker",
        slug: "worker",
        parentID: "ses_parent",
        projectID: "project",
        directory: "/repo",
        title: "Worker",
        version: "1",
        humanInterjection: true,
        time: { created: 1, updated: 1 },
      },
    })
    const session = normalizeSessionInfo(await api.session.get({ sessionID: "ses_worker" }))
    expect(session.humanInterjection).toBe(true)
    expect(session.parentID).toBe("ses_parent")
    expect(requests).toHaveLength(1)
  })
  test("rejects a V1 interrupt when generation fencing supersedes the abort", async () => {
    const controlKinds: string[] = []
    const { api } = setup("v1", { abortAccepted: false }, (kind, run) => {
      controlKinds.push(kind)
      return run()
    })
    await expect(api.session.interrupt({ sessionID: "ses_1" })).rejects.toThrow("superseded by a newer execution")
    expect(controlKinds).toEqual(["session-interrupt"])
  })

  test("routes current-protocol interrupts through control admission", async () => {
    const controlKinds: string[] = []
    const { api, requests } = setup("v2", undefined, (kind, run) => {
      controlKinds.push(kind)
      return run()
    })
    await api.session.interrupt({ sessionID: "ses_1" })

    expect(controlKinds).toEqual(["session-interrupt"])
    expect(new URL(requests.at(-1)!.url).pathname).toContain("/interrupt")
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

  test("correlates live Prompt Revisor progress by the client-owned operation id", async () => {
    const snapshot = { operationID: "op-1", percent: 42, phase: "reading", updatedAt: 7 }
    const { api, requests } = setup("v2", { revisionProgress: snapshot })

    expect(await api.promptRevisor.progress({ operationID: "op-1" })).toEqual(snapshot)
    const request = requests.at(-1)!
    const url = new URL(request.url)
    expect(request.method).toBe("GET")
    expect(url.pathname).toBe("/prompt/revise/progress")
    expect(url.searchParams.get("operationID")).toBe("op-1")
  })

  test("sends the operation correlation id with the revise payload", async () => {
    const { api, requests } = setup("v2")
    await api.promptRevisor.revise({ prompt: "Improve this.", operationID: "op-7" })

    const body = await requests.at(-1)!.json()
    expect(body).toMatchObject({ prompt: "Improve this.", operationID: "op-7" })
  })

  test("treats a missing progress route or malformed body as no update", async () => {
    const missing = setup("v2")
    expect(await missing.api.promptRevisor.progress({ operationID: "op-1" })).toBeNull()

    const malformed = setup("v2", { revisionProgress: [] })
    expect(await malformed.api.promptRevisor.progress({ operationID: "op-1" })).toBeNull()

    const invalidPercent = setup("v2", {
      revisionProgress: { operationID: "op-1", percent: Number.NaN },
    })
    expect(await invalidPercent.api.promptRevisor.progress({ operationID: "op-1" })).toBeNull()
  })

  test("keeps progress reads available on the V1 protocol path too", async () => {
    const snapshot = { operationID: "op-2", percent: 15, updatedAt: 3 }
    const { api, requests } = setup("v1", { revisionProgress: snapshot })

    expect(await api.promptRevisor.progress({ operationID: "op-2" })).toEqual(snapshot)
    expect(new URL(requests.at(-1)!.url).pathname).toBe("/prompt/revise/progress")
  })

  test("reads detached revision run status by locator on both protocol paths", async () => {
    const status: CompatibleRevisionRunStatus = { state: "running", sourceFingerprint: "fp", operationID: "op-3", startedAt: 11 }
    for (const protocol of ["v1", "v2"] as const) {
      const { api, requests } = setup(protocol, { revisionRunStatus: status })
      expect(await api.promptRevisor.runStatus({ kind: "prompt", key: "session:ses_1" })).toEqual(status)
      const request = requests.at(-1)!
      const url = new URL(request.url)
      expect(request.method).toBe("GET")
      expect(url.pathname).toBe("/prompt/revise/run")
      expect(url.searchParams.get("kind")).toBe("prompt")
      expect(url.searchParams.get("key")).toBe("session:ses_1")
    }
  })

  test("treats a missing or malformed run status as no run info", async () => {
    const missing = setup("v2")
    expect(await missing.api.promptRevisor.runStatus({ kind: "prompt", key: "session:ses_1" })).toBeNull()

    const malformed = setup("v2", { revisionRunStatus: { state: "running" } })
    expect(await malformed.api.promptRevisor.runStatus({ kind: "prompt", key: "session:ses_1" })).toBeNull()

    const failed = setup("v2", {
      revisionRunStatus: { state: "failed", sourceFingerprint: "fp", message: "boom", at: 5 },
    })
    expect(await failed.api.promptRevisor.runStatus({ kind: "prompt", key: "session:ses_1" })).toEqual({
      state: "failed",
      sourceFingerprint: "fp",
      message: "boom",
      at: 5,
    })
  })

  test("cancels a detached run first-class and tolerates servers without the route", async () => {
    const { api, requests } = setup("v2", { cancelResult: true })
    expect(
      await api.promptRevisor.cancel({ kind: "prompt", key: "session:ses_1", operationID: "op-9" }),
    ).toBe(true)
    const request = requests.at(-1)!
    expect(request.method).toBe("POST")
    expect(new URL(request.url).pathname).toBe("/prompt/revise/cancel")
    expect(await request.json()).toEqual({ kind: "prompt", key: "session:ses_1", operationID: "op-9" })

    const legacy = setup("v1")
    expect(await legacy.api.promptRevisor.cancel({ kind: "prompt", key: "session:ses_1" })).toBe(false)
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
