import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { MAX_SOURCE_BYTES } from "@/code/input-admission"
import { ExternalCode } from "@/exchange/code"
import { rankCapabilities } from "@/exchange/capability-search"

const catalog: readonly ExternalCode.Summary[] = [
  { ref: "read", description: "Read a file." },
  { ref: "reader", description: "Read another file." },
  { ref: "find", description: "Find project files." },
]

function host(options?: {
  calls?: string[]
  generationFlip?: boolean
  items?: readonly ExternalCode.Summary[]
  rank?: ExternalCode.Host["rank"]
  rankVersion?: string
}): ExternalCode.Host {
  return {
    list: () => Effect.succeed(options?.items ?? catalog),
    ...(options?.rank ? { rank: options.rank } : {}),
    ...(options?.rankVersion ? { rankVersion: options.rankVersion } : {}),
    describe: (ref) =>
      ref === "read"
        ? Effect.succeed({
            ref,
            description: "Read a file.",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string", description: "File path." } },
              required: ["path"],
            },
            outputSchema: { type: "string" },
          })
        : Effect.fail(new Error("missing")),
    call: (ref, input) =>
      Effect.sync(() => {
        options?.calls?.push(ref)
        return {
          value: { ref, input },
          attachments: [{ kind: "file" as const, handle: "artifact://one", mediaType: "text/plain" }],
        }
      }),
  }
}

describe("external Code projection", () => {
  test("shares operation-aware ranked discovery with OXP while preserving Code pagination", async () => {
    const items = [
      { ref: "openfork_worker", description: "Create durable workers." },
      { ref: "openfork_swarm", description: "Coordinate durable Swarms and assign members to tasks." },
      { ref: "json", description: "Analyze JSON documents and query schemas." },
      { ref: "patch", description: "Apply source-code patches." },
    ] as const
    const scopedRank: NonNullable<ExternalCode.Host["rank"]> = (entries, query) =>
      rankCapabilities(entries.map((item) => ({
        id: item.ref,
        description: item.description,
        focusActions: item.ref === "openfork_swarm" ? { "member.batch": {}, "task.batch": {} } : undefined,
        item,
      })), query).map((entry) => entry.item)
    const first = await Effect.runPromise(ExternalCode.execute(
      { action: "search", query: "batch workers", limit: 1 },
      host({ items, rank: scopedRank, rankVersion: "owner-v1" }),
    ))
    expect(first.action).toBe("search")
    if (first.action !== "search") return
    expect(first.items[0]?.ref).toBe("openfork_swarm")
    expect(first.items[0]).not.toHaveProperty("inputSchema")
    if (first.next) {
      const next = await Effect.runPromise(ExternalCode.execute(
        { action: "search", query: "batch workers", cursor: first.next, limit: 1 },
        host({ items, rank: scopedRank, rankVersion: "owner-v1" }),
      ))
      expect(next.action).toBe("search")
      if (next.action === "search") expect(next.items[0]?.ref).not.toBe(first.items[0]?.ref)
      await expect(Effect.runPromise(ExternalCode.execute(
        { action: "search", query: "batch workers", cursor: first.next, limit: 1 },
        host({ items, rank: scopedRank, rankVersion: "owner-v2" }),
      ))).rejects.toThrow("invalid or stale")
    }
    const json = await Effect.runPromise(ExternalCode.execute(
      { action: "search", query: "JSON patches" }, host({ items }),
    ))
    expect(json.action).toBe("search")
    if (json.action === "search") expect(json.items[0]?.ref).toBe("json")
    // A buggy transport ranker cannot forge an extra tool or a replacement
    // description. Source catalog summaries are always projected verbatim.
    const hostile = await Effect.runPromise(ExternalCode.execute(
      { action: "search", query: "worker" },
      host({ items, rank: () => [
        { ref: "nonexistent", description: "ungranted" },
        { ref: "openfork_worker", description: "attacker-controlled replacement" },
      ] }),
    ))
    expect(hostile.action).toBe("search")
    if (hostile.action === "search") {
      expect(hostile.items).toEqual([items[0]])
    }
  })
  test("search is compact, ranked, bounded, and cursor-safe", async () => {
    const first = await Effect.runPromise(
      ExternalCode.execute({ action: "search", query: "read", limit: 1 }, host()),
    )
    expect(first.action).toBe("search")
    if (first.action !== "search") throw new Error("unexpected action")
    expect(first.items).toEqual([{ ref: "read", description: "Read a file." }])
    expect(first.items[0]).not.toHaveProperty("inputSchema")

    const page = await Effect.runPromise(
      ExternalCode.execute({ action: "search", query: "read", limit: 1, cursor: first.next! }, host()),
    )
    expect(page.action).toBe("search")

    await expect(
      Effect.runPromise(
        ExternalCode.execute({ action: "search", query: "find", limit: 1, cursor: first.next! }, host()),
      ),
    ).rejects.toThrow("invalid or stale")

    await expect(
      Effect.runPromise(
        ExternalCode.execute({ action: "search", cursor: "not-a-cursor" }, host()),
      ),
    ).rejects.toThrow("invalid or stale")
  })

  test("describe returns an exact paste-ready typed call contract", async () => {
    const result = await Effect.runPromise(
      ExternalCode.execute({ action: "describe", ref: "read" }, host()),
    )
    expect(result.action).toBe("describe")
    if (result.action !== "describe") throw new Error("unexpected action")
    expect(result.item.signature).toContain('declare function call(ref: "read"')
    expect(result.item.signature).toContain("path: string")
    expect(result.item.example).toBe('const result = await call("read", /* input */)')
  })

  test("run composes host capabilities and projects attachments once", async () => {
    const calls: string[] = []
    const result = await Effect.runPromise(
      ExternalCode.execute(
        {
          action: "run",
          code: 'const a = await call("read", { path: input.path }); return a.ref',
          input: { path: "README.md" },
        },
        host({ calls }),
      ),
    )
    expect(result.action).toBe("run")
    if (result.action !== "run") throw new Error("unexpected action")
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unexpected failure")
    expect(result.value).toBe("read")
    expect(calls).toEqual(["read"])
    expect(result.attachments).toEqual([
      { kind: "file", handle: "artifact://one", mediaType: "text/plain" },
    ])
  })

  test("run keeps parser failures as structured diagnostics", async () => {
    const result = await Effect.runPromise(
      ExternalCode.execute({ action: "run", code: "return (" }, host()),
    )
    expect(result.action).toBe("run")
    if (result.action !== "run") throw new Error("unexpected action")
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unexpected success")
    expect(result.error.kind).toBe("ParseError")
  })

  test("run preserves bounded model-safe host failure detail", async () => {
    const result = await Effect.runPromise(
      ExternalCode.execute(
        { action: "run", code: 'return await call("read", { path: "secret.txt" })' },
        {
          ...host(),
          call: () => Effect.fail(new Error("AUTHORITY_DENIED: read authority is required")),
        },
      ),
    )
    expect(result.action).toBe("run")
    if (result.action !== "run") throw new Error("unexpected action")
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unexpected success")
    expect(result.error.kind).toBe("ToolFailure")
    expect(result.error.message).toContain("AUTHORITY_DENIED")
    expect(result.error.message).not.toBe("Tool execution failed")
  })

  test("rejects pathological discovery strings before ranking or cursor decode", async () => {
    await expect(
      Effect.runPromise(
        ExternalCode.execute({ action: "search", query: "x".repeat(4_097) }, host()),
      ),
    ).rejects.toThrow("4096-character limit")
    await expect(
      Effect.runPromise(
        ExternalCode.execute({ action: "describe", ref: "x".repeat(4_097) }, host()),
      ),
    ).rejects.toThrow("4096-character limit")
    await expect(
      Effect.runPromise(
        ExternalCode.execute({ action: "search", cursor: "x".repeat(8_193) }, host()),
      ),
    ).rejects.toThrow("8192-character limit")
  })

  test("reuses native Code admission limits and returns typed invalid requests", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        ExternalCode.execute(
          { action: "run", code: "x".repeat(MAX_SOURCE_BYTES + 1) },
          host(),
        ),
      ),
    )
    expect(failure).toBeInstanceOf(ExternalCode.InvalidRequest)
    if (!(failure instanceof ExternalCode.InvalidRequest)) throw new Error("unexpected failure")
    expect(failure.detail).toContain(`${MAX_SOURCE_BYTES}-byte source limit`)
    expect(failure.detail).not.toContain("durable")
  })
})
