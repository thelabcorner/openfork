/**
 * Deterministic, fully synthetic retrieval-quality evaluation. No private
 * transcripts, external API calls, embedding models or production DB access.
 *
 * Report and assert recall/precision separately from speed. The expect()s are
 * regression gates on tiny fixtures, not claims of population-level quality.
 */
import { describe, expect } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Memory } from "@opencode-ai/core/memory"
import { MemorySchema } from "@opencode-ai/core/memory/schema"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { searchText } from "@opencode-ai/core/session/search-text"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ExchangeMemory } from "@/exchange/memory"
import { ExchangeMemoryQuery } from "@/exchange/memory-query"
import { ExchangeMemorySession } from "@/exchange/memory-session"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(
  LayerNode.group([Database.node, Memory.node]),
  [[Database.node, Database.layerFromPath(":memory:")]],
))
const encode = Schema.encodeSync(SessionMessage.Message)
const ctx = MemorySchema.Context.make({ projectID: "fidelity_a", workspaceID: null })

type Metrics = {
  precisionAt5: number
  precisionReturned: number
  recallAt5: number
  leaked: number
}
function metrics(ids: readonly string[], relevant: ReadonlySet<string>, forbidden = new Set<string>()): Metrics {
  const top = ids.slice(0, 5)
  const good = top.filter((id) => relevant.has(id)).length
  return {
    // P@5 uses a denominator of five, not the number returned. The latter
    // is useful but is a different statistic (precision over retrieved hits).
    precisionAt5: good / 5,
    precisionReturned: top.length === 0 ? 0 : good / top.length,
    recallAt5: relevant.size === 0 ? Number(top.length === 0) : good / relevant.size,
    leaked: top.filter((id) => forbidden.has(id)).length,
  }
}

describe("Memory fidelity / synthetic ground truth", () => {
  it.effect("a middle-of-prompt symbol beats introductory decoys and respects project scope", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const word = (i: number) => "term" +
        String.fromCharCode(97 + Math.floor(i / 26), 97 + i % 26)
      const prefix = Array.from({ length: 18 }, (_, i) => word(i))
      const suffix = Array.from({ length: 12 }, (_, i) => word(18 + i))
      const question = [...prefix, "ArcFit", "geometry", "certification", ...suffix].join(" ")
      const expected = yield* memory.remember({
        context: ctx, kind: "project_decision",
        content: "ArcFit geometry certification preserves width under nested clipping masks.",
        evidence: [{ source_type: "test_result" }],
      })
      const denied = yield* memory.remember({
        context: MemorySchema.Context.make({ projectID: "fidelity_b", workspaceID: null }),
        kind: "project_decision",
        content: "ArcFit geometry certification alternative proprietary geometry.",
        evidence: [{ source_type: "test_result" }],
      })
      const decoys: string[] = []
      for (let i = 0; i < 7; i++) {
        const row = yield* memory.remember({
          context: ctx, kind: "reference",
          content: prefix.slice(0, 4).join(" ") + " unrelated marketing option number " + i,
          evidence: [{ source_type: "test_result" }],
        })
        decoys.push(row.id)
      }
      const oldStyle = yield* memory.search({
        context: ctx, query: prefix.slice(0, 4).join(" "), limit: 5,
        trackAccess: false,
      })
      expect(oldStyle).toHaveLength(5)
      expect(oldStyle.every((item) => decoys.includes(item.id))).toBe(true)

      const planned = ExchangeMemoryQuery.plan(question)
      expect(planned.focused).toContain("arcfit geometry")
      expect(planned.relaxed).toBe("arcfit geometry")
      const result = yield* ExchangeMemory.execute(memory, ctx, {
        action: "search", sources: "memory", query: question, limit: 5,
      }, { trackAccess: false })
      const ids = ((result.structured.hits ?? []) as MemorySchema.SearchHit[]).map((item) => item.id)
      expect(ids).toEqual([expected.id])
      expect(ids).not.toContain(denied.id)
      expect(metrics(ids, new Set([expected.id]), new Set([denied.id, ...decoys])))
        .toMatchObject({ recallAt5: 1, precisionAt5: 0.2, precisionReturned: 1, leaked: 0 })
    }),
  )

  it.effect("broad brand fallback cannot turn unrelated marketing memories into geometry evidence", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      for (let i = 0; i < 7; i++) {
        yield* memory.remember({
          context: ctx, kind: "reference",
          content: "ArcFit annual pricing and licensing plan tier " + i + " for studios",
          evidence: [{ source_type: "test_result" }],
        })
      }
      // This reproduces the previous broad ArcFit-only fallback's five false
      // positives; there is intentionally NO relevant geometry information.
      const naive = yield* memory.search({
        context: ctx, query: "arcfit", limit: 5, trackAccess: false,
      })
      expect(naive).toHaveLength(5)
      const result = yield* ExchangeMemory.execute(memory, ctx, {
        action: "search", sources: "memory", limit: 5,
        query: "where did we leave off on ArcFit geometry certification",
      }, { trackAccess: false })
      expect(result.metadata.savedBroadened).toBe(true)
      expect(result.metadata.savedQueryUsed).toBe("arcfit geometry")
      expect((result.structured.hits ?? [])).toHaveLength(0)
    }),
  )

  it.effect("dated engineering recall returns the matching work, not nearby timestamped title sessions", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const memory = yield* Memory.Service
      const relevant = yield* memory.remember({
        context: ctx, kind: "project_decision",
        content: "RRF fusion index backfill fidelity preserves historical source ranking in memory search.",
        evidence: [{ source_type: "test_result" }],
      })
      const noise = yield* memory.remember({
        context: ctx, kind: "reference",
        content: "The OpenFork session title record was generated on 2026 10 09.",
        evidence: [{ source_type: "test_result" }],
      })
      yield* db.insert(ProjectTable).values({
        id: ProjectV2.ID.global, worktree: AbsolutePath.make("/approved"), sandboxes: [],
      }).run().pipe(Effect.orDie)
      for (const fixture of [
        { id: "ses_rank_fidelity", at: 100, dir: "/approved",
          title: "Historical retrieval fidelity", text: "RRF fusion index backfill fidelity preserves V1 V2 source relevance" },
        { id: "ses_title_year", at: 300, dir: "/approved",
          title: "Title · New session - 2026-10-09", text: "Title agent created the new session in 2026" },
        { id: "ses_rank_forbidden", at: 500, dir: "/forbidden",
          title: "Private historical retrieval", text: "RRF fusion index backfill fidelity private draft" },
      ]) {
        yield* db.insert(SessionTable).values({
          id: SessionSchema.ID.make(fixture.id), project_id: ProjectV2.ID.global,
          slug: fixture.id, directory: fixture.dir, title: fixture.title,
          version: "test", time_created: fixture.at, time_updated: fixture.at,
        }).run().pipe(Effect.orDie)
        const msg = SessionMessage.User.make({
          id: SessionMessage.ID.make("msg_" + fixture.id), type: "user",
          text: fixture.text, time: { created: DateTime.makeUnsafe(fixture.at) },
        })
        const { id, type, ...data } = encode(msg)
        yield* db.insert(SessionMessageTable).values({
          id: SessionMessage.ID.make(id), session_id: SessionSchema.ID.make(fixture.id),
          type, seq: 1, time_created: fixture.at, data, search_text: searchText(msg),
        }).run().pipe(Effect.orDie)
      }
      const query =
        "OpenFork retrieval fidelity latest 2026-10-09 memory recall Core V1 V2 RRF fusion index backfill stage tests synthetic benchmark research ledger"
      const plan = ExchangeMemoryQuery.plan(query)
      expect(plan.focused).not.toContain("2026")
      expect(plan.relaxed).not.toBe("2026")
      const saved = yield* ExchangeMemory.execute(memory, ctx, {
        action: "search", query, sources: "memory", limit: 5,
      }, { trackAccess: false })
      const savedIds = ((saved.structured.hits ?? []) as MemorySchema.SearchHit[]).map((x) => x.id)
      expect(savedIds).toContain(relevant.id)
      expect(savedIds).not.toContain(noise.id)
      const sessions = yield* ExchangeMemorySession.search(db, {
        query: plan.focused, limit: 5, directoryPrefixes: ["/approved"], ranking: "relevance",
      })
      expect(metrics(sessions.hits.map((x) => x.sessionId),
        new Set(["ses_rank_fidelity"]), new Set(["ses_rank_forbidden"])))
        .toMatchObject({ recallAt5: 1, precisionAt5: 0.2, precisionReturned: 1, leaked: 0 })
      expect(sessions.hits[0]?.messageId).toBe("msg_ses_rank_fidelity")
    }),
  )

  it.effect("saved memory: precise routing, superseded audit, unrelated decoys and project denial", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const entries = []
      entries.push(yield* memory.remember({
        context: ctx, stableKey: "arcfit", kind: "project_decision",
        content: "ArcFit geometry certification requires preserve-width warp of nested clipping masks.",
        evidence: [{ source_type: "test_result" }],
      }))
      const historical = yield* memory.remember({
        context: ctx, stableKey: "cache", kind: "project_decision",
        content: "Legacy widgetcache triangulation was accepted pending tests.",
        evidence: [{ source_type: "test_result" }],
      })
      yield* memory.remember({
        context: ctx, stableKey: "cache", kind: "project_decision",
        content: "Current widgetcache uses exact split-plan after benchmark.",
        evidence: [{ source_type: "test_result" }],
      })
      const forgotten = yield* memory.remember({
        context: ctx, kind: "reference",
        content: "Old unsafe amber-token index must be forgotten.",
        evidence: [{ source_type: "test_result" }],
      })
      yield* memory.forget({ context: ctx, id: forgotten.id })
      const forbidden = yield* memory.remember({
        context: MemorySchema.Context.make({ projectID: "fidelity_b", workspaceID: null }),
        kind: "project_decision",
        content: "ArcFit geometry certification is secret to fidelity_b",
        evidence: [{ source_type: "test_result" }],
      })
      for (let i = 0; i < 8; i++) {
        yield* memory.remember({
          context: ctx, kind: "reference",
          content: "ArcFit price and marketing strategy variant " + i + " with alternative pricing",
          evidence: [{ source_type: "test_result" }],
        })
      }
      const result = yield* ExchangeMemory.execute(memory, ctx, {
        action: "search", sources: "memory",
        query: "where did we leave off on ArcFit geometry certification",
        limit: 5,
      }, { trackAccess: false })
      const ids = ((result.structured.hits ?? []) as MemorySchema.SearchHit[]).map((h) => h.id)
      const score = metrics(ids, new Set([entries[0]!.id]), new Set([forbidden.id, forgotten.id]))
      expect(score.recallAt5).toBe(1)
      expect(score.leaked).toBe(0)
      expect(result.metadata.savedBroadened).toBe(false)

      const ordinary = yield* memory.search({ context: ctx, query: "widgetcache" })
      expect(ordinary.some((hit) => hit.id === historical.id)).toBe(false)
      const audit = yield* memory.search({ context: ctx, query: "widgetcache", includeHistory: true })
      expect(audit.some((hit) => hit.id === historical.id)).toBe(true)
      const deleted = yield* memory.search({ context: ctx, query: "amber-token", includeHistory: true })
      expect(deleted.some((hit) => hit.id === forgotten.id)).toBe(false)
      const negative = yield* ExchangeMemory.execute(memory, ctx, {
        action: "search", sources: "memory", query: "nonexistent_rare_fidelity_anchor_183",
      }, { trackAccess: false })
      expect(((negative.structured.hits ?? []) as MemorySchema.SearchHit[])).toHaveLength(0)
    }),
  )

  it.effect("Session recall: distinct relevant sessions, strongest evidence, scope and provenance", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db.insert(ProjectTable).values({
        id: ProjectV2.ID.global, worktree: AbsolutePath.make("/allowed"), sandboxes: [],
      }).run().pipe(Effect.orDie)
      const fixtures = [
        { sid: "ses_arcfit", dir: "/allowed/work", time: 200, title: "ArcFit geometry research", text: "ArcFit preserve width clipping mask vertices" },
        { sid: "ses_nacre", dir: "/allowed/work", time: 190, title: "Nacre corner reconstruction", text: "Nacre low resolution corner inference SDF" },
        { sid: "ses_arcfit_pricing", dir: "/allowed/work", time: 180, title: "ArcFit commercial tiers", text: "ArcFit pricing annual license budget" },
        { sid: "ses_forbidden", dir: "/forbidden/repo", time: 500, title: "ArcFit secret scope", text: "ArcFit preserve width clipping mask vertices private" },
      ]
      for (const item of fixtures) {
        yield* db.insert(SessionTable).values({
          id: SessionSchema.ID.make(item.sid), project_id: ProjectV2.ID.global,
          slug: item.sid, directory: item.dir, title: item.title,
          version: "test", time_created: item.time, time_updated: item.time,
        }).run().pipe(Effect.orDie)
        const msg = SessionMessage.User.make({
          id: SessionMessage.ID.make("msg_" + item.sid), type: "user",
          text: item.text, time: { created: DateTime.makeUnsafe(item.time) },
        })
        const { id, type, ...data } = encode(msg)
        yield* db.insert(SessionMessageTable).values({
          id: SessionMessage.ID.make(id), session_id: SessionSchema.ID.make(item.sid),
          type, seq: 1, time_created: item.time, data, search_text: searchText(msg),
        }).run().pipe(Effect.orDie)
      }
      const arcfit = yield* ExchangeMemorySession.search(db, {
        query: "arcfit preserve width clipping", limit: 5, directoryPrefixes: ["/allowed"],
      })
      const arcIds = arcfit.hits.map((x) => x.sessionId)
      const arcScore = metrics(arcIds, new Set(["ses_arcfit"]), new Set(["ses_forbidden"]))
      expect(arcScore).toMatchObject({ recallAt5: 1, precisionAt5: 0.2, precisionReturned: 1, leaked: 0 })
      expect(arcfit.hits[0]?.messageId).toBe("msg_ses_arcfit")
      expect(arcfit.hits[0]?.timeBasis).toBe("message_created")
      const nacre = yield* ExchangeMemorySession.search(db, {
        query: "nacre corner", limit: 5, directoryPrefixes: ["/allowed"],
      })
      expect(nacre.hits[0]?.sessionId).toBe("ses_nacre")
      expect(JSON.stringify(nacre)).not.toContain("ses_forbidden")
      // Read-only incomplete indexing remains explicit instead of claiming absence.
      expect(typeof arcfit.complete).toBe("boolean")
    }),
  )
})
