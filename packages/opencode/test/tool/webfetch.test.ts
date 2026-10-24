import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Effect, Exit, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { WebFetchTool } from "../../src/tool/webfetch"
import { classifyGitHubFetch, githubFetchGuidance } from "../../src/tool/github-fetch-guidance"
import { classify as classifyGithub } from "../../src/tool/github"
import { SessionID, MessageID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([httpClient, Truncate.node, Agent.node]), [
    [httpClient, FetchHttpClient.layer as Layer.Layer<HttpClient.HttpClient>],
  ]),
)

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_message"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const withFetch = <A, E, R>(
  fetch: (req: Request) => Response | Promise<Response>,
  fn: (url: URL) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => Bun.serve({ port: 0, fetch })),
    (server) => fn(server.url),
    (server) => Effect.sync(() => server.stop(true)),
  )

const exec = Effect.fn("WebFetchToolTest.exec")(function* (args: Tool.InferParameters<typeof WebFetchTool>) {
  const info = yield* WebFetchTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

describe("tool.webfetch", () => {
  it.instance("returns image responses as file attachments", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
      yield* withFetch(
        () => new Response(bytes, { status: 200, headers: { "content-type": "IMAGE/PNG; charset=binary" } }),
        (url) =>
          Effect.gen(function* () {
            const result = yield* exec({ url: new URL("/image.png", url).toString(), format: "markdown" })
            expect(result.output).toBe("Image fetched successfully")
            expect(result.attachments).toBeDefined()
            expect(result.attachments?.length).toBe(1)
            expect(result.attachments?.[0].type).toBe("file")
            expect(result.attachments?.[0].mime).toBe("image/png")
            expect(result.attachments?.[0].url.startsWith("data:image/png;base64,")).toBe(true)
            expect(result.attachments?.[0]).not.toHaveProperty("id")
            expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
            expect(result.attachments?.[0]).not.toHaveProperty("messageID")
          }),
      )
    }),
  )

  it.instance("keeps svg as text output", () =>
    withFetch(
      () =>
        new Response('<svg xmlns="http://www.w3.org/2000/svg"><text>hello</text></svg>', {
          status: 200,
          headers: { "content-type": "image/svg+xml; charset=UTF-8" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/image.svg", url).toString(), format: "html" })
          expect(result.output).toContain("<svg")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("keeps text responses as text output", () =>
    withFetch(
      () =>
        new Response("hello from webfetch", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/file.txt", url).toString(), format: "text" })
          expect(result.output).toBe("hello from webfetch")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("extracts text from html without scripts or styles", () =>
    withFetch(
      () =>
        new Response(
          "<html><head><style>.hidden{}</style><script>alert('x')</script></head><body>Hello <b>world</b></body></html>",
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        ),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/page.html", url).toString(), format: "text" })
          expect(result.output).toBe("Hello world")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("bounds chunked response bodies before buffering past the 5MB limit", () =>
    withFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(3 * 1024 * 1024))
              controller.enqueue(new Uint8Array(3 * 1024 * 1024))
              controller.close()
            },
          }),
          { headers: { "content-type": "text/plain" } },
        ),
      (url) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(exec({ url: new URL("/chunked.txt", url).toString(), format: "text" }))
          expect(Exit.isFailure(exit)).toBe(true)
        }),
    ),
  )
})

describe("tool.webfetch github AX routing", () => {
  const raw = "https://raw.githubusercontent.com/storytold/vectorcraft/main/crates/geom/src/lib.rs"

  test("gives concrete, non-fetched REST guidance for raw source RAG", () => {
    const result = githubFetchGuidance(raw, "markdown")!
    expect(result.metadata).toEqual({
      advisory: "github-preferred",
      contentFetched: false,
      recommendedTool: "github",
      kind: "file",
    })
    expect(result.output).toContain('"endpoint":"repos/storytold/vectorcraft/contents/crates/geom/src/lib.rs"')
    expect(result.output).toContain('"ref":"main"')
    expect(result.output).toContain('"Accept":"application/vnd.github.raw+json"')
    expect(result.output).toContain("not an error")
    expect(result.output).toContain("forceWeb:true")
    expect(result.output).toContain("403/rate-limit exhaustion")
    expect(result.output).toContain("private repository files")
    const route = classifyGitHubFetch(raw, "text")!
    const input = JSON.parse(route.example.slice("github(".length, -1))
    expect(classifyGithub(input).access).toBe("read")
  })

  test("recognizes repo, blob, directory, issue and pull source workflows", () => {
    const cases: [string, string, string][] = [
      ["https://github.com/storytold/vectorcraft", "repository", '"repo","view"'],
      ["https://github.com/storytold/vectorcraft/", "repository", '"repo","view"'],
      ["https://github.com/storytold/vectorcraft/blob/main/crates/geom/src/projective.rs", "file", '"endpoint":"repos/storytold/vectorcraft/contents/crates/geom/src/projective.rs"'],
      ["https://github.com/storytold/vectorcraft/tree/main/crates/geom", "directory", '"endpoint":"repos/storytold/vectorcraft/contents/crates/geom"'],
      ["https://github.com/storytold/vectorcraft/issues/17", "issue", '"issue","view","17"'],
      ["https://github.com/storytold/vectorcraft/pull/29", "pull", '"pr","view","29"'],
      ["https://github.com/storytold/vectorcraft/pull/29.diff", "pull", '"pr","diff","29"'],
      ["https://api.github.com/repos/storytold/vectorcraft/issues/17", "api", '"repos/storytold/vectorcraft/issues/17"'],
    ]
    for (const [url, kind, command] of cases) {
      const result = githubFetchGuidance(url, "text")
      expect(String(result?.metadata.kind)).toBe(kind)
      expect(result?.output).toContain(command)
      const example = classifyGitHubFetch(url, "text")!.example
      const input = JSON.parse(example.slice("github(".length, -1))
      expect(classifyGithub(input).access).toBe("read")
    }
  })

  test("abstains from ambiguous or non-repository web traffic", () => {
    for (const url of [
      "https://example.com/page",
      "https://github.com.evil.example/storytold/vectorcraft/blob/main/file.rs",
      "https://gist.github.com/user/abc",
      "https://github.example.com/owner/repo",
      "https://codeload.github.com/storytold/vectorcraft/zip/main",
      "https://patch-diff.githubusercontent.com/raw/storytold/vectorcraft/pull/123.diff",
      "https://github.com/marketplace",
      "http://raw.githubusercontent.com/storytold/vectorcraft/main/file.rs",
      "https://github.com/owner/repo/blob/main/file.rs?plain=1",
      "https://raw.githubusercontent.com/owner/repo/main/file.rs?token=private",
      "https://raw.githubusercontent.com/owner/repo/main/dir%2ffile.rs",
      "not a url",
      "",
    ]) {
      expect(githubFetchGuidance(url, "markdown")).toBeUndefined()
    }
    expect(githubFetchGuidance(raw, "html")).toBeUndefined()
    expect(classifyGitHubFetch("https://github.com/owner/repo/blob/main/file.rs#L18", "text")?.kind).toBe("file")
  })

  test("ambiguous slash-bearing refs receive discovery guidance, not a guessed contents path", () => {
    const result = githubFetchGuidance("https://raw.githubusercontent.com/o/r/feature/big-change/src/mod.rs", "text")!
    expect(result.output).toContain("ref/path boundary")
    expect(result.output).toContain('action":"catalog"')
    expect(result.output).not.toContain('"endpoint":"repos/o/r/contents/')
  })

  it.instance("returns successful guidance without permission or outbound fetch", () =>
    Effect.gen(function* () {
      const info = yield* WebFetchTool
      const tool = yield* info.init()
      let asked = 0
      const result = yield* tool.execute({ url: raw, format: "text" }, {
        ...ctx,
        ask: () => Effect.sync(() => { asked++ }),
      })
      expect(asked).toBe(0)
      expect("contentFetched" in result.metadata && result.metadata.contentFetched).toBe(false)
      expect(result.output).toContain("Recommended github arguments:")
      expect(result.attachments).toBeUndefined()
    }),
  )

  it.instance("forceWeb bypasses the advisory and reaches the ordinary webfetch permission gate", () =>
    Effect.gen(function* () {
      const info = yield* WebFetchTool
      const tool = yield* info.init()
      let asked = 0
      const exit = yield* Effect.exit(tool.execute({ url: raw, format: "text", forceWeb: true }, {
        ...ctx,
        ask: () => Effect.gen(function* () {
          asked++
          return yield* Effect.die(new Error("test: permission gate reached"))
        }),
      }))
      expect(asked).toBe(1)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})
