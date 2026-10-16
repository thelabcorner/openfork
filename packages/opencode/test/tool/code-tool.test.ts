import { beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as CodeSchema from "@/code/schema"
import * as CodeService from "@/code/service"
import * as Capability from "@/tool/capability"
import { DESCRIPTION } from "@/tool/code"

const entry: Capability.Registration = {
  identity: Capability.nativeIdentity("orders.lookup"),
  kind: "native",
  description: "Look up an order by ID.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Order identifier." },
      verbose: { type: "boolean", description: "Include verbose details." },
    },
    required: ["id"],
  },
  outputSchema: {
    type: "object",
    properties: {
      status: { type: "string", description: "Current order status." },
    },
    required: ["status"],
  },
  permissionKey: "orders.lookup",
  invokeSemantic: () => Effect.succeed({ title: "orders.lookup", metadata: {}, output: "ok" }),
  authorize: () => Effect.void,
  authorityBinding: "native:orders.lookup",
  classifyWorkspaceMutation: () => false,
  codeCallable: true,
  lifetime: "inline",
}

const inventory: Capability.Inventory = {
  generation: "generation-1",
  entries: [entry],
}

beforeEach(() => CodeService.resetSearchCacheForTest())

describe("code provider discovery UX", () => {
  test("keeps broad search and exact describe semantically distinct", () => {
    expect(
      CodeSchema.validate({
        action: "search",
        query: "order",
      } as CodeSchema.Parameters),
    ).toEqual({ action: "search", query: "order" })

    expect(() =>
      CodeSchema.validate({
        action: "search",
        ref: entry.identity.ref,
      } as CodeSchema.Parameters),
    ).toThrow("Field 'ref' is not valid for code.search.")

    expect(
      CodeSchema.validate({
        action: "describe",
        ref: entry.identity.ref,
      } as CodeSchema.Parameters),
    ).toEqual({ action: "describe", ref: entry.identity.ref })

    expect(() => CodeSchema.validate({ action: "describe" } as CodeSchema.Parameters)).toThrow(
      "code.describe requires ref.",
    )
  })

  test("search keeps saved discovery distinct from ordinary host capabilities", () => {
    const saved: Capability.Registration = {
      ...entry,
      identity: Capability.savedIdentity(
        "project",
        "order_summary",
        "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      ),
      kind: "saved",
      description: "Summarize an order.",
      revision: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      authorityBinding: "saved:project:scope:order_summary",
    }
    const withSaved = { generation: "generation-2", entries: [entry, saved] }

    expect(CodeService.search(withSaved, { target: "saved" }).items.map((item) => item.ref)).toEqual([
      saved.identity.ref,
    ])
    expect(CodeService.search(withSaved, { target: "capabilities" }).items.map((item) => item.ref)).toEqual([
      entry.identity.ref,
    ])
    expect(CodeService.search(withSaved, { target: "callable" }).items.map((item) => item.ref).sort()).toEqual(
      [entry.identity.ref, saved.identity.ref].sort(),
    )
  })

  test("search stays compact while describe returns a paste-ready exact contract", () => {
    const search = CodeService.search(inventory, { query: "order" })
    expect(search.items).toEqual([
      {
        kind: "capability",
        ref: "native:orders.lookup",
        capabilityKind: "native",
        description: "Look up an order by ID.",
        callable: true,
      },
    ])
    expect("inputSchema" in search.items[0]!).toBe(false)

    const exact = CodeService.describe(inventory, "native:orders.lookup")
    expect(exact.item.inputSchema).toEqual(entry.inputSchema)
    expect(exact.item.outputSchema).toEqual(entry.outputSchema)
    expect(exact.item.signature).toContain('declare function call(ref: "native:orders.lookup"')
    expect(exact.item.signature).toContain("id: string")
    expect(exact.item.signature).toContain("verbose?: boolean")
    expect(exact.item.signature).toContain("Promise<")
    expect(exact.item.signature).toContain("status: string")
    expect(exact.item.example).toBe('const result = await call("native:orders.lookup", /* input */)')
    expect(exact.item.canonical.protocol).toBe("capability-descriptor-v1")
    expect(exact.item.canonical.ref).toBe("native:orders.lookup")
    expect(exact.item.canonical.inputSchema).toEqual(entry.inputSchema)
  })

  test("describe uses the precomputed exact-ref index rather than scanning broad entries", () => {
    const indexed: Capability.Inventory = {
      generation: "generation-indexed",
      entries: [],
      byRef: new Map([[entry.identity.ref, entry]]),
    }

    expect(CodeService.describe(indexed, entry.identity.ref).item.ref).toBe(entry.identity.ref)
  })

  test("reuses ranked search work across reconstructed inventories with the same search generation", () => {
    const first: Capability.Inventory = {
      generation: "cursor-generation-a",
      searchGeneration: "search-generation-shared",
      entries: [entry],
    }
    const second: Capability.Inventory = {
      generation: "cursor-generation-b",
      searchGeneration: "search-generation-shared",
      entries: [{ ...entry }],
    }

    expect(CodeService.search(first, { query: "order" }).items[0]?.ref).toBe(entry.identity.ref)
    expect(CodeService.searchCacheStats()).toEqual({
      hits: 0,
      misses: 1,
      generations: 1,
      queries: 1,
    })

    const reused = CodeService.search(second, { query: "order" })
    expect(reused.generation).toBe("cursor-generation-b")
    expect(reused.items[0]?.ref).toBe(entry.identity.ref)
    expect(CodeService.searchCacheStats()).toEqual({
      hits: 1,
      misses: 1,
      generations: 1,
      queries: 1,
    })
  })

  test("bounds retained search generations and queries", () => {
    const oneGeneration: Capability.Inventory = {
      generation: "cursor-generation",
      searchGeneration: "search-generation-query-cap",
      entries: [entry],
    }
    for (let index = 0; index < 20; index++) {
      CodeService.search(oneGeneration, { query: `query-${index}` })
    }
    expect(CodeService.searchCacheStats().queries).toBe(16)

    for (let index = 0; index < 10; index++) {
      CodeService.search(
        {
          generation: `cursor-${index}`,
          searchGeneration: `search-generation-${index}`,
          entries: [entry],
        },
        { query: "order" },
      )
    }
    const stats = CodeService.searchCacheStats()
    expect(stats.generations).toBe(8)
    expect(stats.queries).toBeLessThanOrEqual(8 * 16)
  })

  test("static tool prose teaches the intended discover-describe-run workflow", () => {
    expect(DESCRIPTION).toContain("code.search finds refs")
    expect(DESCRIPTION).toContain("target=saved")
    expect(DESCRIPTION).toContain("target=runs")
    expect(DESCRIPTION).toContain("code.describe returns the exact callable contract or safe replay descriptor")
    expect(DESCRIPTION).toContain("await call(ref, input)")
    expect(DESCRIPTION).toContain("Promise.all")
    expect(DESCRIPTION).toContain("error.recovery")
    expect(DESCRIPTION).toContain("no ambient filesystem, process, network, imports, credentials, or warm state")
  })
})
