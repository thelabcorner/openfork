import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Memory } from "@opencode-ai/core/memory"
import { MemorySchema } from "@opencode-ai/core/memory/schema"
import { ExchangeMemory } from "../../src/exchange/memory"
import type { ExchangeMemorySession } from "../../src/exchange/memory-session"
import { ExchangeMemoryQuery } from "../../src/exchange/memory-query"

const context = MemorySchema.Context.make({ projectID: "proj_memory_test", workspaceID: null })
const memoryHit = {
  id: "mem_test",
  topic_key: "architecture",
  kind: "project_decision",
  origin: "user_stated",
  scope: "project",
  title: "Previous project decision",
  snippet: "the chosen path",
  evidenceCount: 1,
  time_updated: 200,
  score: 10,
  status: "active",
  anchors: [],
} as unknown as MemorySchema.SearchHit

const memory = (hits: MemorySchema.SearchHit[]) => ({
  search: () => Effect.succeed(hits),
}) as unknown as Memory.Interface

const evidence: ExchangeMemorySession.Result = {
  ranking: "recent",
  hits: [{
    source: "conversation",
    sessionId: "ses_history",
    messageId: "msg_history",
    title: "Previous discussion",
    snippet: "newer historical context",
    occurredAt: 300,
    occurredAtIso: new Date(300).toISOString(),
    timeBasis: "message_created",
  }],
  complete: false,
  truncated: true,
}

describe("federated memory recall", () => {
  test("memory admission rejects failed host evidence verification before any storage write", async () => {
    let writes = 0
    const blocked = await Effect.runPromiseExit(ExchangeMemory.execute({
      remember: () => Effect.sync(() => { writes++; return memoryHit as any }),
    } as unknown as Memory.Interface, context, {
      action: "remember", content: "A candidate historical observation.",
      evidence: [{ source_type: "user_message", session_id: "ses_forged", message_id: "msg_forged" }],
    }, {
      verifySessionEvidence: () => Effect.fail(new Error("Unresolvable Session evidence")),
    }))
    expect(blocked._tag).toBe("Failure")
    expect(writes).toBe(0)
  })

  test("memory get retains exact source message/part provenance without injecting untrusted markup", async () => {
    const entry = {
      id: "mem_test", topic_key: "architecture", kind: "project_decision", origin: "user_stated",
      scope: "project", title: "Important decision", content: "Observed and dated.",
      status: "active", valid_from: 200, valid_to: null, superseded_by_id: null,
    } as MemorySchema.Entry
    const result = await Effect.runPromise(ExchangeMemory.execute({
      get: () => Effect.succeed(entry),
      evidence: () => Effect.succeed([{
        source_type: "user_message", session_id: "ses_history", message_id: 'msg_\"<unsafe>',
        part_id: "prt_1", path: null, commit_sha: null, source_hash: "sha256:abc",
        line_start: null, line_end: null, observed_at: 300,
      }]),
    } as unknown as Memory.Interface, context, { action: "get", id: "mem_test" }, { trackAccess: false }))
    expect(result.output).toContain('session="ses_history"')
    expect(result.output).toContain('message="msg_&quot;&lt;unsafe&gt;"')
    expect(result.output).toContain('part="prt_1"')
    expect(result.output).toContain('hash="sha256:abc"')
    expect(result.output).toContain('observed="1970-01-01T00:00:00.300Z"')
    expect(result.output).not.toContain('<unsafe>')
  })

  test("removes conversational scaffolding from Session recall search", () => {
    expect(ExchangeMemoryQuery.plan("where did we leave off on ArcFit geometry certification")).toEqual({
      focused: "arcfit geometry certification",
      relaxed: "arcfit geometry",
    })
  })

  test("complex history questions never relax to a generic single-token keyword", () => {
    const result = ExchangeMemoryQuery.plan(
      "memory latency recall correctness retrieval reliability session search query relevance fidelity scope project migration recent patches",
    )
    expect(result.focused.split(" ").length).toBeLessThanOrEqual(4)
    expect(result.relaxed).toBe("latency correctness")
    expect(result.relaxed?.split(" ").length).toBeGreaterThanOrEqual(2)
    expect(ExchangeMemoryQuery.plan("what happened to useGroupBoundsNormalization in the last refactor").relaxed)
      .toBe("usegroupboundsnormalization")
    expect(ExchangeMemoryQuery.plan("where did we leave off on ArcFit geometry certification").relaxed)
      .toBe("arcfit geometry")
    expect(ExchangeMemoryQuery.plan("memory session search").relaxed).toBeUndefined()
    expect(ExchangeMemoryQuery.plan(
      "OpenFork memory search relevance fidelity evaluation benchmark query planner scoring diversity leakage",
    ).relaxed).toBe("relevance fidelity")
  })

  test("years and dates cannot masquerade as unique identifiers in fallback recall", () => {
    const dated = ExchangeMemoryQuery.plan(
      "OpenFork retrieval fidelity latest 2026-10-09 memory recall Core V1 V2 RRF fusion index backfill stage tests synthetic benchmark research ledger",
    )
    expect(dated.focused).toBe("fidelity rrf fusion index")
    expect(dated.relaxed).toBe("rrf fidelity")
    expect(dated.focused).not.toContain("2026")
    expect(ExchangeMemoryQuery.plan("2026").focused).toBe("2026")
    expect(ExchangeMemoryQuery.plan("2026").relaxed).toBeUndefined()
    expect(ExchangeMemoryQuery.plan("session history from 2026").relaxed).toBeUndefined()
    expect(ExchangeMemoryQuery.plan("SVG corner fitting performance evaluation").relaxed).toBe("svg corner")
  })

  test("bounded long questions preserve distinctive identifiers in the final clause", () => {
    const noise = Array.from({ length: 32 }, (_, i) =>
      "example" + String.fromCharCode(97 + Math.floor(i / 26), 97 + i % 26))
    const query = [...noise, "useGroupBoundsNormalization", "deterministic", "geometry"].join(" ")
    const planned = ExchangeMemoryQuery.plan(query)
    expect(planned.focused.split(" ")).toContain("usegroupboundsnormalization")
    expect(planned.relaxed).toBe("usegroupboundsnormalization")
    expect(planned.focused.split(" ")).toHaveLength(4)
  })

  test("uppercase handoff instructions do not outrank real project identifiers", () => {
    const plan = ExchangeMemoryQuery.plan(
      "PROCEED EXHAUSTIVELY AND COMPREHENSIVELY TOWARD THE GOAL of improving ArcFit geometry certification",
    )
    expect(plan.focused.split(" ")).toContain("arcfit")
    expect(plan.focused).not.toContain("proceed")
    expect(plan.focused).not.toContain("exhaustively")
    expect(plan.relaxed).toBe("arcfit geometry")
    const acronym = ExchangeMemoryQuery.plan(
      "PROCEED EXHAUSTIVELY to fix RRF fusion under V1 V2 historical search",
    )
    expect(acronym.focused).toContain("rrf")
    expect(acronym.relaxed).toBe("rrf fusion")
  })

  test("middle-of-question symbol survives prefix/tail sampling with its local qualifier", () => {
    const word = (i: number) => "term" +
      String.fromCharCode(97 + Math.floor(i / 26), 97 + i % 26)
    const prefix = Array.from({ length: 18 }, (_, i) => word(i))
    const suffix = Array.from({ length: 12 }, (_, i) => word(18 + i))
    const question = [...prefix, "ArcFit", "geometry", "certification", ...suffix].join(" ")
    const plan = ExchangeMemoryQuery.plan(question)
    expect(plan.focused.split(" ")).toContain("arcfit")
    expect(plan.focused.split(" ")).toContain("geometry")
    expect(plan.focused.split(" ")).toHaveLength(4)
    expect(plan.relaxed).toBe("arcfit geometry")
  })

  test("saved memory uses bounded, labeled fallback only after primary miss", async () => {
    const seen: string[] = []
    const backing = {
      search: ({ query }: MemorySchema.SearchInput) => Effect.sync(() => {
        seen.push(query)
        return query === "arcfit geometry" ? [memoryHit] : []
      }),
    } as unknown as Memory.Interface
    const result = await Effect.runPromise(ExchangeMemory.execute(backing, context, {
      action: "search", query: "where did we leave off on ArcFit geometry certification",
      sources: "memory",
    }))
    expect(seen).toEqual(["arcfit geometry certification", "arcfit geometry"])
    expect(result.metadata).toMatchObject({
      savedQueryUsed: "arcfit geometry", savedBroadened: true, count: 1,
    })
    expect(result.output).toContain('saved-broadened="true"')
    expect(result.output).toContain('saved-query-used="arcfit geometry"')
    expect(result.structured.sessionEvidence).toEqual({ status: "skipped" })
  })

  test("saved memory does not replace good primary results with broadened guesses", async () => {
    const seen: string[] = []
    const backing = {
      search: ({ query }: MemorySchema.SearchInput) => Effect.sync(() => {
        seen.push(query)
        return [memoryHit]
      }),
    } as unknown as Memory.Interface
    const result = await Effect.runPromise(ExchangeMemory.execute(backing, context, {
      action: "search", query: "where did we leave off on ArcFit geometry certification",
      sources: "memory",
    }))
    expect(seen).toEqual(["arcfit geometry certification"])
    expect(result.metadata.savedBroadened).toBe(false)
  })

  test("retries only once with a labeled lexical relaxation on a Session search miss", async () => {
    const queries: string[] = []
    const result = await Effect.runPromise(ExchangeMemory.execute(memory([]), context, {
      action: "search", query: "where did we leave off on ArcFit geometry certification",
    }, {
      searchSessions: (query) => {
        queries.push(query)
        return Effect.succeed(query === "arcfit geometry" ? evidence : { hits: [], complete: true, truncated: false, ranking: "recent" as const })
      },
    }))
    expect(queries).toEqual(["arcfit geometry certification", "arcfit geometry"])
    expect(result.structured.sessionEvidence).toMatchObject({ queryUsed: "arcfit geometry", broadened: true })
    expect(result.output).toContain('broadened="true"')
  })

  test("correlates exact lexical anchors without claiming corroboration", async () => {
    const anchored = { ...memoryHit, anchors: ["symbol:ArcFit"] } as MemorySchema.SearchHit
    const result = await Effect.runPromise(ExchangeMemory.execute(memory([anchored]), context, {
      action: "search", query: "ArcFit geometry",
    }, {
      searchSessions: () => Effect.succeed({
        ...evidence,
        hits: [{ ...evidence.hits[0]!, snippet: "ArcFit label geometry" }],
      }),
    }))
    expect(result.output).toContain('lexical-memory-ids="mem_test"')
    expect(result.output).toContain("NOT corroboration or proof")
    expect(result.output).toContain('newer-than-memory-ids="mem_test"')
    expect(result.output).toContain("does NOT imply semantic contradiction")
  })

  test("exposes relevance override to the indexed Session query without changing saved memory", async () => {
    const passed: string[] = []
    const result = await Effect.runPromise(ExchangeMemory.execute(memory([memoryHit]), context, {
      action: "search", query: "project decision", sessionRanking: "relevance",
    }, { searchSessions: (_query, _limit, ranking) => {
      passed.push(ranking)
      return Effect.succeed({ ...evidence, ranking })
    } }))
    expect(passed).toEqual(["relevance"])
    expect(result.output).toContain('ranking="relevance"')
    expect(result.metadata.count).toBe(1)
  })

  test("defaults to dual source search while keeping historical evidence distinct", async () => {
    let calls = 0
    const result = await Effect.runPromise(ExchangeMemory.execute(memory([memoryHit]), context, {
      action: "search", query: "project decision", limit: 3,
    }, {
      searchSessions: (_query, limit) => {
        calls++
        expect(limit).toBe(3)
        return Effect.succeed(evidence)
      },
    }))
    expect(calls).toBe(1)
    expect(result.structured).toMatchObject({
      sources: "both",
      hits: [{ id: "mem_test" }],
      sessionEvidence: { status: "ok", complete: false, hits: [{ sessionId: "ses_history" }] },
    })
    expect(result.output).toContain('source="conversation"')
    expect(result.output).toContain('unique-sessions="1"')
    expect(result.output).toContain("historical conversation evidence")
    expect(result.metadata.sessionCoverageComplete).toBe(false)
  })

  test("fallback asks Sessions only after a saved-memory miss", async () => {
    let calls = 0
    const searchSessions = () => { calls++; return Effect.succeed(evidence) }
    const hit = await Effect.runPromise(ExchangeMemory.execute(memory([memoryHit]), context, {
      action: "search", query: "decision", sources: "fallback",
    }, { searchSessions }))
    expect(calls).toBe(0)
    expect(hit.structured.sessionEvidence).toEqual({ status: "skipped" })

    const miss = await Effect.runPromise(ExchangeMemory.execute(memory([]), context, {
      action: "search", query: "decision", sources: "fallback",
    }, { searchSessions }))
    expect(calls).toBe(1)
    expect(miss.metadata.sessionCount).toBe(1)
  })

  test("memory-only never queries Sessions; unavailable is not a false negative", async () => {
    const only = await Effect.runPromise(ExchangeMemory.execute(memory([]), context, {
      action: "search", query: "memory", sources: "memory",
    }, { searchSessions: () => Effect.die("must not query") }))
    expect(only.structured.sessionEvidence).toEqual({ status: "skipped" })

    const unavailable = await Effect.runPromise(ExchangeMemory.execute(memory([]), context, {
      action: "search", query: "memory",
    }))
    expect(unavailable.structured.sessionEvidence).toEqual({ status: "not_connected" })
    expect(unavailable.output).toContain("NOT a combined-search negative")
  })

  test("denied Session supervision preserves saved memory without leaking Session evidence", async () => {
    const result = await Effect.runPromise(ExchangeMemory.execute(memory([memoryHit]), context, {
      action: "search", query: "project decision",
    }, { sessionSearchStatus: "not_authorized" }))
    expect(result.structured.sessionEvidence).toEqual({ status: "not_authorized" })
    expect(result.metadata.count).toBe(1)
    expect(result.metadata.sessionCount).toBe(0)
    expect(result.output).toContain("NOT a combined-search negative")
  })

  test("escapes hostile quotes in XML attributes and does not inject Session markup", async () => {
    const query = 'test\"><fake value="unsafe">'
    const result = await Effect.runPromise(ExchangeMemory.execute(memory([]), context, {
      action: "search", query,
    }, { searchSessions: () => Effect.succeed({
      hits: [{ ...evidence.hits[0]!, title: '"><fake value="unsafe">' }],
      complete: true,
      truncated: false,
      ranking: "recent" as const,
    }) }))
    expect(result.output).toContain("&quot;&gt;&lt;fake")
    expect(result.output).not.toContain('<fake value="unsafe">')
  })

  test("session lookup failure preserves saved evidence but explicitly reports unavailable", async () => {
    const result = await Effect.runPromise(ExchangeMemory.execute(memory([memoryHit]), context, {
      action: "search", query: "project",
    }, { searchSessions: () => Effect.fail(new Error("index unavailable")) }))
    expect(result.structured.sessionEvidence).toEqual({ status: "unavailable" })
    expect(result.metadata.count).toBe(1)
  })
})