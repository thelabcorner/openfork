import { beforeEach, describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import {
  CODE_RUN_TRACE_MAX_ID_CHARS,
  CODE_RUN_TRACE_MAX_REF_CHARS,
  CODE_RUN_TRACE_MAX_TITLE_CHARS,
  SessionV1,
} from "@opencode-ai/core/v1/session"
import type { Permission } from "@/permission"
import type { Plugin } from "@/plugin"
import type { Snapshot } from "@/snapshot"
import type { ToolInterrupt } from "@/tool/interrupt"
import type { Tool } from "@/tool/tool"
import { MessageID, PartID, SessionID } from "@/session/schema"
import * as CodeService from "@/code/service"
import { PreparedProgramCache } from "@/code/prepared"
import * as Revision from "@/code/revision"

const services: CodeService.Services = {
  permission: {
    releaseExecution: () => Effect.void,
  } as unknown as Permission.Interface,
  plugin: {} as Plugin.Interface,
  snapshot: {} as Snapshot.Interface,
  interrupt: {} as ToolInterrupt.Interface,
}

function context(partID: string): Tool.Context {
  return {
    sessionID: SessionID.make("ses_code_service_cache"),
    messageID: MessageID.make("msg_code_service_cache"),
    partID: PartID.make(partID),
    callID: `call_${partID}`,
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    permissionRuleset: [],
    ask: () => Effect.void,
    metadata: () => Effect.void,
  }
}

const inventory = { generation: "empty", entries: [] } as const

beforeEach(() => CodeService.resetPreparedCacheForTest())

describe("CodeService prepared-program cache", () => {
  test("reuses valid source across fresh root runs without re-preparing", async () => {
    const source = "return { doubled: input.value * 2 }"

    const first = await Effect.runPromise(
      CodeService.runInline({
        code: source,
        value: { value: 4 },
        ctx: context("prt_code_cache_a"),
        inventory,
        services,
      }),
    )
    const second = await Effect.runPromise(
      CodeService.runInline({
        code: source,
        value: { value: 9 },
        ctx: context("prt_code_cache_b"),
        inventory,
        services,
      }),
    )

    expect(first.envelope.ok && first.envelope.value).toEqual({ doubled: 8 })
    expect(second.envelope.ok && second.envelope.value).toEqual({ doubled: 18 })
    expect(CodeService.preparedCacheStats()).toMatchObject({
      entries: 1,
      hits: 1,
      misses: 1,
    })
  })

  test("preserves normalized parse diagnostics and does not cache invalid source", async () => {
    const source = "const broken ="

    const result = await Effect.runPromise(
      CodeService.runInline({
        code: source,
        value: {},
        ctx: context("prt_code_cache_invalid"),
        inventory,
        services,
      }),
    )

    expect(result.envelope.ok).toBe(false)
    if (!result.envelope.ok) expect(result.envelope.error.kind).toBe("ParseError")
    expect(CodeService.preparedCacheStats()).toEqual({
      entries: 0,
      sourceBytes: 0,
      hits: 0,
      misses: 1,
      prepares: 1,
    })
  })

  test("returns static dependency analysis from the prepared source", async () => {
    const result = await Effect.runPromise(
      CodeService.runInline({
        code: 'if (input.use) return await call("native:read", {}); return null',
        value: { use: false },
        ctx: context("prt_code_cache_deps"),
        inventory,
        services,
      }),
    )

    expect(result.dependencies).toEqual({
      literalRefs: ["native:read"],
      dynamicCallTarget: false,
    })
  })

  test("evicts the least-recently-used prepared program at the entry bound", () => {
    const sources = Array.from({ length: 129 }, (_, index) => `return ${index}`)

    for (const source of sources.slice(0, 128)) {
      PreparedProgramCache.get(source, Revision.sha256(source))
    }
    expect(PreparedProgramCache.stats()).toMatchObject({
      entries: 128,
      hits: 0,
      misses: 128,
    })

    // Refresh source[0], then push one new entry. source[1] must be the LRU victim.
    PreparedProgramCache.get(sources[0]!, Revision.sha256(sources[0]!))
    PreparedProgramCache.get(sources[128]!, Revision.sha256(sources[128]!))
    expect(PreparedProgramCache.stats()).toMatchObject({
      entries: 128,
      hits: 1,
      misses: 129,
    })

    PreparedProgramCache.get(sources[1]!, Revision.sha256(sources[1]!))
    expect(PreparedProgramCache.stats()).toMatchObject({
      entries: 128,
      hits: 1,
      misses: 130,
    })
  })

  test("bounds retained prepared-source bytes independently of entry count", () => {
    const payloadBytes = 2_200_000
    const first = `/*${"a".repeat(payloadBytes)}*/ return 1`
    const second = `/*${"b".repeat(payloadBytes)}*/ return 2`

    PreparedProgramCache.get(first, Revision.sha256(first))
    PreparedProgramCache.get(second, Revision.sha256(second))

    const bounded = PreparedProgramCache.stats()
    expect(bounded.entries).toBe(1)
    expect(bounded.sourceBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(bounded).toMatchObject({ hits: 0, misses: 2 })

    // The first entry was evicted by the byte budget, so loading it again is cold.
    PreparedProgramCache.get(first, Revision.sha256(first))
    expect(PreparedProgramCache.stats()).toMatchObject({
      entries: 1,
      hits: 0,
      misses: 3,
    })
  })

  test("projects gateway traces into the bounded schema-owned durable wire contract", () => {
    const trace = CodeService.projectTrace(
      {
        totalCalls: 3,
        failedCalls: 2,
        activeCalls: 1,
        truncated: true,
        frames: [
          {
            frameID: "code#1",
            ref: "native:read",
            kind: "native",
            depth: 0,
            startedAt: 10,
            finishedAt: 15,
            durationMs: 5,
            status: "failed",
            title: "read",
            metadata: { secret: "must-not-persist" },
            attachmentCount: 1,
          },
        ],
      },
      "code:prt_trace",
    )

    expect(Schema.is(SessionV1.CodeRunTrace)(trace)).toBe(true)
    expect(trace).toMatchObject({
      version: 1,
      rootFrameID: "code:prt_trace",
      counters: { calls: 3, failed: 2, active: 1 },
      truncated: { frames: 2 },
    })
    expect(JSON.stringify(trace)).not.toContain("must-not-persist")
    expect(trace.frames[0]).not.toHaveProperty("metadata")
  })

  test("bounds oversized producer trace strings", () => {
    const trace = CodeService.projectTrace(
      {
        totalCalls: 1,
        failedCalls: 0,
        activeCalls: 0,
        truncated: false,
        frames: [
          {
            frameID: "frame:" + "a".repeat(CODE_RUN_TRACE_MAX_ID_CHARS * 2),
            parentFrameID: "parent:" + "b".repeat(CODE_RUN_TRACE_MAX_ID_CHARS * 2),
            ref: "native:" + "c".repeat(CODE_RUN_TRACE_MAX_REF_CHARS * 2),
            kind: "native",
            depth: 1,
            startedAt: 1,
            status: "succeeded",
            title: "d".repeat(CODE_RUN_TRACE_MAX_TITLE_CHARS * 2),
          },
        ],
      },
      "root:" + "e".repeat(CODE_RUN_TRACE_MAX_ID_CHARS * 2),
    )

    expect(Schema.is(SessionV1.CodeRunTrace)(trace)).toBe(true)
    expect(trace.rootFrameID.length).toBeLessThanOrEqual(CODE_RUN_TRACE_MAX_ID_CHARS)
    expect(trace.frames[0]!.frameID.length).toBeLessThanOrEqual(CODE_RUN_TRACE_MAX_ID_CHARS)
    expect(trace.frames[0]!.parentFrameID!.length).toBeLessThanOrEqual(CODE_RUN_TRACE_MAX_ID_CHARS)
    expect(trace.frames[0]!.ref.length).toBeLessThanOrEqual(CODE_RUN_TRACE_MAX_REF_CHARS)
    expect(trace.frames[0]!.title!.length).toBeLessThanOrEqual(CODE_RUN_TRACE_MAX_TITLE_CHARS)
    expect(trace.rootFrameID).toContain("sha256:")
    expect(trace.frames[0]!.frameID).toContain("sha256:")
  })
})

describe("CodeService canonical descriptor", () => {
  test("describe items project onto the shared discovery envelope", () => {
    const canonical = CodeService.toCanonicalDescriptor({
      kind: "capability",
      ref: "native:read",
      capabilityKind: "native",
      description: "Read a file",
      callable: true,
      signature: "declare function call(ref: \"native:read\", input: { path: string }): Promise<unknown>;",
      example: "const result = await call(\"native:read\", /* input */)",
      inputSchema: { type: "object" },
    })
    expect(canonical).toEqual({
      protocol: "capability-descriptor-v1",
      ref: "native:read",
      kind: "native",
      description: "Read a file",
      inputSchema: { type: "object" },
      invocation: {
        tool: "code",
        action: "run",
        argsField: "code",
        hint: "const result = await call(\"native:read\", /* input */)",
      },
    })
  })
})
