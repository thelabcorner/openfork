import { describe, expect, test } from "bun:test"
import type { PromptInputV2Prompt } from "@opencode-ai/session-ui/v2/prompt-input/types"
import {
  pollRevisionProgress,
  pollRevisionRun,
  cancelRevisionRun,
  resumeRevisionRun,
  promptRevisionDraftContext,
  promptRevisionFingerprint,
  promptRevisionArtifactIsApplied,
  promptRevisionPrefix,
  promptRevisionRevealBoundaries,
  promptRevisionText,
  promptRevisionUsablePath,
  revisedPromptParts,
} from "./prompt-revision"

describe("prompt revision helpers", () => {
  test("preserves structured mentions and image attachments after a rewrite", () => {
    const original: PromptInputV2Prompt = [
      { type: "text", content: "Fix ", start: 0, end: 4 },
      { type: "file", path: "src/a.ts", content: "@src/a.ts", start: 4, end: 13 },
      { type: "text", content: " please", start: 13, end: 20 },
      { type: "image", id: "img", filename: "shot.png", mime: "image/png", blob: { id: "blob", url: "blob:test" } },
    ]

    const revised = revisedPromptParts("Please inspect @src/a.ts and fix the bug.", original)

    expect(revised).toEqual([
      { type: "text", content: "Please inspect ", start: 0, end: 15 },
      { type: "file", path: "src/a.ts", content: "@src/a.ts", start: 15, end: 24 },
      { type: "text", content: " and fix the bug.", start: 24, end: 41 },
      original[3],
    ])
  })

  test("does not invent extra structured mentions when the model repeats a token", () => {
    const original: PromptInputV2Prompt = [{ type: "file", path: "src/a.ts", content: "@src/a.ts", start: 0, end: 9 }]

    const revised = revisedPromptParts("Compare @src/a.ts with @src/a.ts", original)
    expect(revised.filter((part) => part.type === "file")).toHaveLength(1)
    expect(
      revised
        .filter((part) => part.type === "text")
        .map((part) => part.content)
        .join(""),
    ).toContain("@src/a.ts")
  })

  test("preserves duplicate mention metadata in original occurrence order", () => {
    const original: PromptInputV2Prompt = [
      {
        type: "file",
        path: "src/a.ts",
        content: "@src/a.ts",
        start: 0,
        end: 9,
        selection: { startLine: 1, startChar: 1, endLine: 2, endChar: 1 },
      },
      { type: "text", content: " ", start: 9, end: 10 },
      {
        type: "file",
        path: "src/a.ts",
        content: "@src/a.ts",
        start: 10,
        end: 19,
        selection: { startLine: 20, startChar: 1, endLine: 21, endChar: 1 },
      },
    ]

    const revised = revisedPromptParts("First @src/a.ts then @src/a.ts", original)
    const files = revised.filter((part) => part.type === "file")
    expect(files).toHaveLength(2)
    expect(files[0]?.selection?.startLine).toBe(1)
    expect(files[1]?.selection?.startLine).toBe(20)
  })

  test("serializes rich composer semantics without leaking client-only attachment internals", () => {
    const parts: PromptInputV2Prompt = [
      { type: "text", content: "Use ", start: 0, end: 4 },
      {
        type: "file",
        path: "src/a.ts",
        content: "@src/a.ts",
        start: 4,
        end: 13,
        selection: { startLine: 2, startChar: 1, endLine: 4, endChar: 8 },
      },
      { type: "agent", name: "explore", content: "@explore", start: 13, end: 21 },
      { type: "skill", name: "ui-review", content: "@ui-review", start: 21, end: 31 },
      {
        type: "file",
        path: "/references/design-system",
        content: "@design-system",
        start: 31,
        end: 45,
        mime: "application/x-directory",
        filename: "design-system",
      },
      {
        type: "file",
        path: "mcp://docs/component",
        content: "@Component docs",
        start: 45,
        end: 60,
        mime: "text/markdown",
        filename: "Component docs",
        url: "mcp://docs/component",
        source: {
          type: "resource",
          text: { value: "@Component docs", start: 45, end: 60 },
          clientName: "docs",
          uri: "mcp://docs/component",
        },
      },
      {
        type: "image",
        id: "img-1",
        filename: "screen.png",
        mime: "image/png",
        blob: { id: "opaque-blob", url: "blob:secret-client-url" },
      },
    ]

    expect(promptRevisionDraftContext(parts)).toEqual({
      mentions: [
        {
          id: "m1",
          type: "file",
          token: "@src/a.ts",
          path: "src/a.ts",
          selection: { startLine: 2, startChar: 1, endLine: 4, endChar: 8 },
        },
        { id: "m2", type: "agent", token: "@explore", name: "explore" },
        { id: "m3", type: "skill", token: "@ui-review", name: "ui-review" },
        {
          id: "m4",
          type: "reference",
          token: "@design-system",
          name: "design-system",
          path: "/references/design-system",
        },
        {
          id: "m5",
          type: "resource",
          token: "@Component docs",
          name: "Component docs",
          clientName: "docs",
          uri: "mcp://docs/component",
        },
      ],
      attachments: [{ id: "img-1", type: "image", filename: "screen.png", mime: "image/png" }],
    })
  })

  test("drops malformed null-like file/reference paths from the Revisor draft snapshot", () => {
    expect(promptRevisionUsablePath(null)).toBeUndefined()
    expect(promptRevisionUsablePath(undefined)).toBeUndefined()
    expect(promptRevisionUsablePath("null")).toBeUndefined()
    expect(promptRevisionUsablePath(" undefined ")).toBeUndefined()
    expect(promptRevisionUsablePath(" src/a.ts ")).toBe("src/a.ts")

    const malformed = [
      { type: "file", path: null, content: "@broken", start: 0, end: 7 },
      {
        type: "file",
        path: "null",
        content: "@broken-ref",
        start: 7,
        end: 18,
        mime: "application/x-directory",
        filename: "broken-ref",
      },
      { type: "text", content: "keep this", start: 18, end: 27 },
    ] as unknown as PromptInputV2Prompt

    expect(promptRevisionDraftContext(malformed)).toEqual({ mentions: [], attachments: [] })
  })

  test("materializes Revisor-declared references as native Prompt Input V2 parts", () => {
    const original: PromptInputV2Prompt = [
      { type: "text", content: "old", start: 0, end: 3 },
      { type: "image", id: "img", filename: "shot.png", mime: "image/png", blob: { id: "blob", url: "blob:test" } },
    ]
    const text = "Inspect @src/new.ts with @ui-review and @Design docs."
    const revised = revisedPromptParts(text, original, [
      { type: "file", content: "@src/new.ts", start: 8, end: 19, path: "src/new.ts" },
      { type: "skill", content: "@ui-review", start: 25, end: 35, name: "ui-review" },
      {
        type: "resource",
        content: "@Design docs",
        start: 40,
        end: 52,
        name: "Design docs",
        clientName: "design",
        uri: "mcp://design/docs",
        mimeType: "text/markdown",
      },
    ])

    expect(revised.filter((part) => part.type === "file")).toEqual([
      { type: "file", path: "src/new.ts", content: "@src/new.ts", start: 8, end: 19 },
      {
        type: "file",
        path: "mcp://design/docs",
        content: "@Design docs",
        start: 40,
        end: 52,
        mime: "text/markdown",
        filename: "Design docs",
        url: "mcp://design/docs",
        source: {
          type: "resource",
          text: { value: "@Design docs", start: 40, end: 52 },
          clientName: "design",
          uri: "mcp://design/docs",
        },
      },
    ])
    expect(revised.find((part) => part.type === "skill")).toEqual({
      type: "skill",
      name: "ui-review",
      content: "@ui-review",
      start: 25,
      end: 35,
    })
    expect(revised.at(-1)).toBe(original[1])
  })

  test("does not treat equal visible text as an applied revision when structured references are missing", () => {
    const text = "Review @src/parser.ts"
    const current = [{ type: "text" as const, content: text, start: 0, end: text.length }]
    const start = text.indexOf("@src/parser.ts")
    const references = [
      {
        type: "file" as const,
        path: "src/parser.ts",
        content: "@src/parser.ts",
        start,
        end: start + "@src/parser.ts".length,
      },
    ]

    expect(promptRevisionArtifactIsApplied(current, text, references)).toBe(false)
    const applied = revisedPromptParts(text, current, references)
    expect(promptRevisionArtifactIsApplied(applied, text, references)).toBe(true)
  })

  test("preserves tool mentions locally without widening the Revisor reference protocol", () => {
    const original: PromptInputV2Prompt = [
      { type: "text", content: "Use ", start: 0, end: 4 },
      {
        type: "tool",
        name: "read",
        content: "@read",
        start: 4,
        end: 9,
        exposure: "default",
        source: "registry",
      },
      { type: "text", content: " for this", start: 9, end: 18 },
    ]

    expect(promptRevisionDraftContext(original)).toEqual({ mentions: [], attachments: [] })

    const revised = revisedPromptParts("Please use @read for this", original)
    expect(revised.find((part) => part.type === "tool")).toEqual({
      type: "tool",
      name: "read",
      content: "@read",
      start: 11,
      end: 16,
      exposure: "default",
      source: "registry",
    })
  })

  test("fingerprint changes when prompt structure changes even if visible text does not", () => {
    const text: PromptInputV2Prompt = [{ type: "text", content: "@src/a.ts", start: 0, end: 9 }]
    const mention: PromptInputV2Prompt = [{ type: "file", path: "src/a.ts", content: "@src/a.ts", start: 0, end: 9 }]
    expect(promptRevisionFingerprint(text)).not.toBe(promptRevisionFingerprint(mention))
  })

  test("streams structured mentions atomically while preserving image attachments", () => {
    const image = {
      type: "image" as const,
      id: "img",
      filename: "shot.png",
      mime: "image/png",
      blob: { id: "blob", url: "blob:test" },
    }
    const parts: PromptInputV2Prompt = [
      { type: "text", content: "Inspect ", start: 0, end: 8 },
      { type: "file", path: "src/a.ts", content: "@src/a.ts", start: 8, end: 17 },
      { type: "text", content: " carefully", start: 17, end: 27 },
      image,
    ]

    const insideMention = promptRevisionPrefix(parts, 12)
    expect(promptRevisionText(insideMention)).toBe("Inspect ")
    expect(insideMention.at(-1)).toBe(image)

    const completeMention = promptRevisionPrefix(parts, 17)
    expect(promptRevisionText(completeMention)).toBe("Inspect @src/a.ts")
    expect(completeMention.find((part) => part.type === "file")).toMatchObject({
      type: "file",
      path: "src/a.ts",
      content: "@src/a.ts",
      start: 8,
      end: 17,
    })
    expect(completeMention.at(-1)).toBe(image)
  })

  test("word reveal boundaries never split structured mentions and cap long animations", () => {
    const parts: PromptInputV2Prompt = [
      { type: "text", content: "Inspect ", start: 0, end: 8 },
      { type: "file", path: "folder/my file.ts", content: "@folder/my file.ts", start: 8, end: 26 },
      { type: "text", content: " then continue", start: 26, end: 40 },
    ]
    const boundaries = promptRevisionRevealBoundaries(parts)
    expect(boundaries.some((boundary) => boundary > 8 && boundary < 26)).toBe(false)
    expect(boundaries.at(-1)).toBe(40)

    const long: PromptInputV2Prompt = [
      {
        type: "text",
        content: Array.from({ length: 300 }, (_, index) => `word${index}`).join(" "),
        start: 0,
        end: Array.from({ length: 300 }, (_, index) => `word${index}`).join(" ").length,
      },
    ]
    expect(promptRevisionRevealBoundaries(long, 40).length).toBeLessThanOrEqual(41)
  })

  test("polls revision progress at a bounded cadence and applies only current snapshots", async () => {
    const controller = new AbortController()
    const waits: number[] = []
    const seen: number[] = []
    let reads = 0

    await pollRevisionProgress({
      operationID: "op",
      intervalMs: 5,
      wait: (ms) => {
        waits.push(ms)
        return Promise.resolve()
      },
      read: () => {
        reads += 1
        if (reads === 1) return Promise.resolve(null)
        if (reads === 2) return Promise.resolve({ operationID: "op", percent: 40, updatedAt: 1 })
        controller.abort()
        return Promise.resolve({ operationID: "op", percent: 90, updatedAt: 2 })
      },
      isCurrent: () => true,
      onUpdate: (next) => seen.push(next.percent),
      signal: controller.signal,
    })

    expect(waits).toEqual([5, 5, 5])
    expect(reads).toBe(3)
    // A snapshot that arrives after the operation settled is discarded.
    expect(seen).toEqual([40])
  })

  test("stops applying revision progress once the flow is superseded", async () => {
    const controller = new AbortController()
    const seen: number[] = []
    let current = true

    await pollRevisionProgress({
      operationID: "op",
      wait: () => Promise.resolve(),
      read: () => Promise.resolve({ operationID: "op", percent: 10, updatedAt: 1 }),
      isCurrent: () => current,
      onUpdate: (next) => {
        seen.push(next.percent)
        // A newer revision claims the composer; the stale flow must stop here.
        current = false
      },
      signal: controller.signal,
    })

    // The superseded flow never even reads again.
    const readsAfterSupersede = {
      count: 0,
    }
    await pollRevisionProgress({
      operationID: "op",
      wait: () => Promise.resolve(),
      read: () => {
        readsAfterSupersede.count += 1
        return Promise.resolve({ operationID: "op", percent: 20, updatedAt: 2 })
      },
      isCurrent: () => current,
      onUpdate: (next) => seen.push(next.percent),
      signal: controller.signal,
    })

    expect(seen).toEqual([10])
    expect(readsAfterSupersede.count).toBe(0)
  })

  test("keeps polling through read failures and aborts as soon as the flow settles", async () => {
    const controller = new AbortController()
    const seen: number[] = []
    let reads = 0

    await pollRevisionProgress({
      operationID: "op",
      wait: () => Promise.resolve(),
      read: () => {
        reads += 1
        if (reads === 1) return Promise.reject(new Error("flaky"))
        return Promise.resolve({ operationID: "op", percent: 30, updatedAt: 1 })
      },
      isCurrent: () => true,
      onUpdate: (next) => {
        seen.push(next.percent)
        controller.abort()
      },
      signal: controller.signal,
    })

    expect(reads).toBe(2)
    expect(seen).toEqual([30])
    expect(controller.signal.aborted).toBe(true)
  })
})

describe("resumed revision run supervision", () => {
  const running = (operationID?: string) => ({
    state: "running" as const,
    sourceFingerprint: "fp",
    ...(operationID === undefined ? {} : { operationID }),
    startedAt: 1,
  })
  const failed = { state: "failed" as const, sourceFingerprint: "fp", message: "provider exploded", at: 9 }

  test("tracks a running run through progress and recovers the artifact once it settles", async () => {
    const controller = new AbortController()
    const statuses: Array<ReturnType<typeof running> | null> = [running("op-1"), running("op-1"), null]
    const waits: number[] = []
    const progress: number[] = []
    const runningSeen: string[] = []
    let recovered = 0

    await pollRevisionRun({
      readStatus: () => Promise.resolve(statuses.shift() ?? null),
      readProgress: (operationID) => Promise.resolve({ operationID, percent: 42, updatedAt: 1 }),
      recover: () => {
        recovered += 1
        return Promise.resolve(true)
      },
      onRunning: (status) => runningSeen.push(status.operationID ?? "none"),
      onProgress: (next) => progress.push(next.percent),
      onFailed: () => {
        throw new Error("unexpected failure")
      },
      isCurrent: () => true,
      signal: controller.signal,
      intervalMs: 5,
      wait: (ms) => {
        waits.push(ms)
        return Promise.resolve()
      },
    })

    expect(runningSeen).toEqual(["op-1", "op-1"])
    expect(progress).toEqual([42, 42])
    expect(recovered).toBe(1)
    expect(waits).toEqual([5, 5])
  })

  test("surfaces a retained failure and stops supervising", async () => {
    const controller = new AbortController()
    const statuses: unknown[] = [running("op-1"), failed]
    const failures: string[] = []
    let recovered = 0

    await pollRevisionRun({
      readStatus: () => Promise.resolve(statuses.shift() as never),
      recover: () => {
        recovered += 1
        return Promise.resolve(false)
      },
      onRunning: () => {},
      onFailed: (status) => failures.push(status.message),
      isCurrent: () => true,
      signal: controller.signal,
      wait: () => Promise.resolve(),
    })

    expect(failures).toEqual(["provider exploded"])
    expect(recovered).toBe(0)
  })

  test("checks the mailbox once when no run is tracked, and never loops", async () => {
    const controller = new AbortController()
    let statusReads = 0
    let recovered = 0

    await pollRevisionRun({
      readStatus: () => {
        statusReads += 1
        return Promise.resolve(null)
      },
      recover: () => {
        recovered += 1
        return Promise.resolve(false)
      },
      onRunning: () => {},
      onFailed: () => {},
      isCurrent: () => true,
      signal: controller.signal,
      wait: () => Promise.resolve(),
    })

    expect(statusReads).toBe(1)
    expect(recovered).toBe(1)
  })

  test("a transient status read failure does not settle a running run", async () => {
    const controller = new AbortController()
    const statuses: Array<unknown> = [new Error("flaky"), running("op-1"), null]
    let recovered = 0

    await pollRevisionRun({
      readStatus: () => {
        const next = statuses.shift()
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next as never)
      },
      recover: () => {
        recovered += 1
        return Promise.resolve(true)
      },
      onRunning: () => {},
      onFailed: () => {
        throw new Error("unexpected failure")
      },
      isCurrent: () => true,
      signal: controller.signal,
      wait: () => Promise.resolve(),
    })

    expect(recovered).toBe(1)
  })

  test("aborting a resumed run tears down only the local polls", async () => {
    let statusReads = 0
    const run = resumeRevisionRun({
      readStatus: () => {
        statusReads += 1
        return Promise.resolve(running("op-1"))
      },
      recover: () => Promise.resolve(false),
      onRunning: () => {},
      onFailed: () => {},
      isCurrent: () => true,
      wait: (_ms, signal) =>
        new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
    })
    await Promise.resolve()
    run.abort()
    await run.done
    const readsAtAbort = statusReads
    await Promise.resolve()
    await Promise.resolve()
    expect(statusReads).toBe(readsAtAbort)
  })

  test("explicit cancellation calls the server endpoint with the locator", async () => {
    const calls: Array<{ kind: string; key: string; operationID?: string }> = []
    const cancelled = await cancelRevisionRun({
      kind: "prompt",
      key: "session:ses_1",
      operationID: "op-1",
      cancel: (input) => {
        calls.push(input)
        return Promise.resolve(true)
      },
    })
    expect(cancelled).toBe(true)
    expect(calls).toEqual([{ kind: "prompt", key: "session:ses_1", operationID: "op-1" }])

    const tolerated = await cancelRevisionRun({
      kind: "prompt",
      key: "session:ses_1",
      cancel: () => Promise.reject(new Error("404")),
    })
    expect(tolerated).toBe(false)
  })
})
