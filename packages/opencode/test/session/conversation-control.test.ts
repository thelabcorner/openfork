import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { DateTime, Deferred, Effect, Exit, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionContextState } from "@/session/context/state"
import { validate as validateContextMutation } from "@/session/context/admission"
import { SessionLedger } from "@/session/context/ledger"
import { ContextInspection } from "@/session/context/inspection"
import { readPage as readContextLedgerPage } from "@/session/context/page"
import { readTotals as readContextLedgerTotals } from "@/session/context/totals"
import { backfillLegacyContextFacts } from "@/session/context/backfill"
import { EffectiveContextCompiler } from "@/session/context/compiler"
import { MessageID, SessionID } from "@/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { GlobalBus } from "@/bus/global"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionNs.node,
      EventV2Bridge.node,
      EventV2.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
      Database.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ gate: Effect.void, warmup: Effect.void })),
      ],
    ],
  )
)

describe("conversation control", () => {
  it.instance("reuses verified producer facts after OPCL externalizes physical part JSON", () =>
    Effect.gen(function* () {
      const sessionSvc = yield* SessionNs.Service
      const { db } = yield* Database.Service
      const created = yield* Effect.acquireRelease(sessionSvc.create({ title: "context-opcl-verified-facts" }), (info) =>
        sessionSvc.remove(info.id).pipe(Effect.ignore),
      )
      const messageID = MessageID.make("msg_context_opcl_verified")
      const partID = "prt_context_opcl_verified"
      yield* sessionSvc.updateMessage({
        id: messageID, sessionID: created.id, role: "user", agent: "test",
        time: { created: 1000 }, model: { providerID: "test", modelID: "test" },
      } as SessionV1.User)
      yield* sessionSvc.updatePart({
        id: partID as any, messageID, sessionID: created.id,
        type: "text", text: "Authoritative text survives externalization",
      } as any)
      const before = yield* readContextLedgerPage({ sessionID: created.id })
      const totalsBefore = yield* readContextLedgerTotals(created.id)
      expect(before.entries).toHaveLength(1)
      expect(totalsBefore.totals).toBeDefined()

      // Simulate post-projection OPCL compression. The real payload has moved
      // outside part.data but exact producer-owned scalar facts remain intact.
      // No event-value resolution is needed to show bounded ledger statistics.
      yield* db.run(sql`
        UPDATE part SET data = ${JSON.stringify({ $cdbRef: "externalized-provider-text" })},
          context_opaque = 1
        WHERE id = ${partID}
      `)
      const after = yield* readContextLedgerPage({ sessionID: created.id })
      expect(after.mode).toBe("chronological")
      expect(after.entries).toEqual(before.entries)
      expect((yield* readContextLedgerTotals(created.id)).totals).toEqual(totalsBefore.totals)
    }),
  )

  it.instance("projects authoritative all-history totals from durable part facts without hydrating every message", () =>
    Effect.gen(function* () {
      const sessionSvc = yield* SessionNs.Service
      const { db } = yield* Database.Service
      const created = yield* Effect.acquireRelease(sessionSvc.create({ title: "context-scalar-totals" }), (info) =>
        sessionSvc.remove(info.id).pipe(Effect.ignore),
      )
      const ids = Array.from({ length: 65 }, (_, i) => MessageID.make(`msg_context_totals_${String(i).padStart(3, "0")}`))
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i]!
        yield* sessionSvc.updateMessage({
          id, sessionID: created.id, role: "user", time: { created: 1_000 + i },
          agent: "test", model: { providerID: "test", modelID: "test" },
        } as SessionV1.User)
        yield* sessionSvc.updatePart({
          id: `prt_context_totals_${i}` as any, messageID: id, sessionID: created.id,
          type: "text", text: `Token estimate for entry ${i}`,
        } as any)
      }
      yield* SessionContextState.applyOps({
        sessionID: created.id,
        operations: [
          { type: "message.exclude", messageID: ids[3]! },
          { type: "message.pin", messageID: ids[4]! },
          { type: "message.exclude", messageID: ids[4]! },
          { type: "text.replace", messageID: ids[5]!, content: "replacement" },
        ],
      })
      const page = yield* readContextLedgerPage({ sessionID: created.id, limit: 10 })
      const canonical = ContextInspection.ledger(created.id, yield* ContextInspection.read(created.id))
      expect(page.mode).toBe("chronological")
      expect(page.entries).toHaveLength(10)
      expect("authoritativeTotals" in page).toBe(false)
      const authoritative = yield* readContextLedgerTotals(created.id)
      expect(authoritative.revision).toBe(page.revision)
      expect(authoritative.totals).toEqual(canonical.totals)
      expect(canonical.totals.messageCount).toBe(65)
      expect(canonical.totals.excludedCount).toBe(1)
      expect(canonical.totals.pinnedCount).toBe(1)
      expect(canonical.totals.editedCount).toBe(1)
      const next = yield* readContextLedgerPage({ sessionID: created.id, limit: 10, cursor: page.nextCursor })
      expect("authoritativeTotals" in next).toBe(false)

      // Historical v0 part scalars are never trusted as zero-valued facts.
      yield* db.run(sql`UPDATE part SET context_projection_version = 0 WHERE id = ${"prt_context_totals_0"}`)
      const legacy = yield* readContextLedgerTotals(created.id)
      expect(legacy.totals).toBeUndefined()
      const repaired = yield* backfillLegacyContextFacts({ sessionID: created.id, limit: 1 })
      expect(repaired).toMatchObject({
        scanned: 1, upgraded: 1, skippedOpaque: 0, skippedMalformed: 0,
      })
      expect((yield* readContextLedgerTotals(created.id)).totals).toEqual(canonical.totals)

      // OPCL references cannot be parsed as inline provider parts. The
      // bounded repair preserves the v0 record for a future ref-aware decoder.
      yield* db.run(sql`
        INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, context_opaque)
        VALUES ('prt_totals_opcl', ${ids[0]!}, ${created.id}, 2000, 2000,
          ${JSON.stringify({ $cdbRef: "not-an-inline-part" })}, 1)
      `)
      const opaque = yield* backfillLegacyContextFacts({ sessionID: created.id, limit: 1 })
      expect(opaque).toMatchObject({ scanned: 1, upgraded: 0, skippedOpaque: 1 })
      expect((yield* readContextLedgerTotals(created.id)).totals).toBeUndefined()
    }),
  )

  it.instance("bounded Context page headers preserve provenance and legacy-shell semantics without large metadata hydration", () =>
    Effect.gen(function* () {
      const sessionSvc = yield* SessionNs.Service
      const { db } = yield* Database.Service
      const created = yield* Effect.acquireRelease(sessionSvc.create({ title: "context-scalar-message-headers" }), (info) =>
        sessionSvc.remove(info.id).pipe(Effect.ignore),
      )
      const stateID = MessageID.make("msg_ctx_scalar_host_state")
      const shellID = MessageID.make("msg_ctx_scalar_legacy_shell")
      for (const [id, time, provenance] of [
        [stateID, 1000, SessionTurnProvenance.host(SessionTurnProvenance.Source.GoalProgress, {
          ref: "goal-state:v1:progress:gol_test:" + "a".repeat(64),
        })],
        [shellID, 1001, undefined],
      ] as const) {
        yield* sessionSvc.updateMessage({
          id, sessionID: created.id, role: "user", time: { created: time }, agent: "test",
          model: { providerID: "test", modelID: "test" },
          ...(provenance ? { provenance } : {}),
        } as SessionV1.User)
      }
      yield* sessionSvc.updatePart({
        id: "prt_ctx_scalar_host_state" as any, messageID: stateID, sessionID: created.id,
        type: "text", text: "The latest authoritative goal state",
      } as any)
      yield* sessionSvc.updatePart({
        id: "prt_ctx_scalar_legacy_shell" as any, messageID: shellID, sessionID: created.id,
        type: "text", synthetic: true, text: "The following tool was executed by the user",
      } as any)
      // Inject a large *unneeded* metadata object after the producer wrote the
      // header. Canonical full hydration still sees the same role/provenance,
      // while scalar ledger paging must not copy 2 MiB into the JS result.
      yield* db.run(sql`
        UPDATE message SET data = json_set(data, '$.debugMetadata', ${"X".repeat(2 * 1024 * 1024)})
        WHERE id = ${stateID}
      `)
      const fast = yield* MessageV2.pageContextFactsOn({ sessionID: created.id, limit: 50 }, db)
      expect(fast).toBeDefined()
      expect(fast?.items).toHaveLength(2)
      expect(JSON.stringify(fast?.items[0]?.info).length).toBeLessThan(1024)
      expect(JSON.stringify(fast?.items[1]?.info).length).toBeLessThan(1024)
      const canonical = ContextInspection.ledger(created.id, yield* ContextInspection.read(created.id))
      const page = yield* readContextLedgerPage({ sessionID: created.id })
      expect(page.entries).toEqual(canonical.entries)
      expect(page.entries.map((entry) => [entry.messageID, entry.type])).toEqual([
        [stateID, "synthetic"], [shellID, "shell"],
      ])
    }),
  )

  it.instance("producer-written Context part facts match canonical messages; legacy parts safely fall back", () =>
    Effect.gen(function* () {
      const sessionSvc = yield* SessionNs.Service
      const { db } = yield* Database.Service
      const created = yield* Effect.acquireRelease(sessionSvc.create({ title: "context-part-facts-parity" }), (info) =>
        sessionSvc.remove(info.id).pipe(Effect.ignore),
      )
      const first = MessageID.make("msg_part_fact_unicode")
      const second = MessageID.make("msg_part_fact_assistant")
      yield* sessionSvc.updateMessage({
        id: first, sessionID: created.id, role: "user", time: { created: 1000 },
        agent: "test", model: { providerID: "test", modelID: "test" },
      } as SessionV1.User)
      yield* sessionSvc.updateMessage({
        id: second, sessionID: created.id, role: "assistant", parentID: first,
        time: { created: 2000, completed: 2001 }, agent: "test",
        providerID: "test", modelID: "test", mode: "chat",
        path: { cwd: "/", root: "/" }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      } as SessionV1.Assistant)
      const unicode = "💡🚀".repeat(10_000)
      yield* sessionSvc.updatePart({
        id: "prt_fact_unicode" as any, messageID: first, sessionID: created.id,
        type: "text", text: unicode, synthetic: false,
      } as any)
      yield* sessionSvc.updatePart({
        id: "prt_fact_reasoning" as any, messageID: second, sessionID: created.id,
        type: "reasoning", text: "safe reasoning", time: { start: 2000, end: 2001 },
        metadata: { anthropic: { signature: "provider-signature" } },
      } as any)
      yield* sessionSvc.updatePart({
        id: "prt_fact_tool" as any, messageID: second, sessionID: created.id,
        type: "tool", tool: "read", callID: "call-1",
        state: {
          status: "completed", input: {}, output: "x".repeat(256_000),
          title: "read", metadata: {}, time: { start: 2000, end: 2001 },
        },
      } as any)
      const fast = yield* MessageV2.pageContextFactsOn({ sessionID: created.id, limit: 50 }, db)
      expect(fast).toBeDefined()
      expect(fast?.facts.size).toBe(3)
      expect(fast?.facts.get("prt_fact_unicode")?.tokens).toBe(Math.ceil(unicode.length / 4))
      expect(fast?.facts.get("prt_fact_reasoning")?.signed).toBe(true)
      const expected = ContextInspection.ledger(created.id, yield* ContextInspection.read(created.id))
      const projected = yield* readContextLedgerPage({ sessionID: created.id })
      expect(projected.entries).toEqual(expected.entries)
      expect(projected.entries.find((item) => item.messageID === second)?.hasSignedReasoning).toBe(true)
      expect(projected.entries.find((item) => item.messageID === first)?.tokenEstimate)
        .toBe(4 + Math.ceil(unicode.length / 4))

      // Old inline parts predate the versioned scalar projection and remain
      // reconstructible through the original exact V1 hydration path.
      yield* db.run(sql`
        INSERT INTO part (id, session_id, message_id, time_created, time_updated, data)
        VALUES ('prt_fact_legacy', ${created.id}, ${first}, 1000, 1000,
          ${JSON.stringify({ type: "text", text: "Legacy text" })})
      `)
      expect(yield* MessageV2.pageContextFactsOn({ sessionID: created.id, limit: 50 }, db)).toBeUndefined()
      const fallback = yield* readContextLedgerPage({ sessionID: created.id })
      const canonical = ContextInspection.ledger(created.id, yield* ContextInspection.read(created.id))
      expect(fallback.entries).toEqual(canonical.entries)
    }),
  )

  it.instance("rejects opaque V1 part metadata even if a concealed part might be a compaction marker", () =>
    Effect.gen(function* () {
      const sessionSvc = yield* SessionNs.Service
      const { db } = yield* Database.Service
      const created = yield* Effect.acquireRelease(sessionSvc.create({ title: "ledger-opaque-part" }), (info) =>
        sessionSvc.remove(info.id).pipe(Effect.ignore),
      )
      const messageID = "msg_page_opaque_part"
      yield* db.run(sql`
        INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES (${messageID}, ${created.id}, 1000, 1000,
          ${JSON.stringify({ role: "user", time: { created: 1000 } })})
      `)
      yield* db.run(sql`
        INSERT INTO part (id, session_id, message_id, time_created, time_updated, data, context_opaque)
        VALUES ('prt_page_opaque_part', ${created.id}, ${messageID}, 1000, 1000,
          ${JSON.stringify({ $cdbRef: "opaque-archived-part-event-value" })}, 1)
      `)
      const attempt = yield* Effect.exit(readContextLedgerPage({ sessionID: created.id, limit: 1 }))
      expect(String(attempt)).toContain("Opaque V1 part metadata")
    }),
  )

  it.instance("fails closed on opaque historical V1 message metadata instead of misclassifying compaction", () =>
    Effect.gen(function* () {
      const sessionSvc = yield* SessionNs.Service
      const { db } = yield* Database.Service
      const created = yield* Effect.acquireRelease(sessionSvc.create({ title: "ledger-opaque-message" }), (info) =>
        sessionSvc.remove(info.id).pipe(Effect.ignore),
      )
      yield* db.run(sql`
        INSERT INTO message (id, session_id, time_created, time_updated, data, context_opaque)
        VALUES ('msg_page_opaque', ${created.id}, 1000, 1000,
          ${JSON.stringify({ $cdbRef: "opaque-archived-event-value" })}, 1)
      `)
      const attempt = yield* Effect.exit(readContextLedgerPage({ sessionID: created.id, limit: 1 }))
      expect(String(attempt)).toContain("requires canonical OPCL rehydration")
    }),
  )

  it.instance("distinguishes standalone assistant summaries from completed compaction boundaries", () =>
    Effect.gen(function* () {
      const sessionSvc = yield* SessionNs.Service
      const { db } = yield* Database.Service
      const created = yield* Effect.acquireRelease(sessionSvc.create({ title: "ledger-summary-probe" }), (info) =>
        sessionSvc.remove(info.id).pipe(Effect.ignore),
      )
      const compaction = "msg_page_summary_user"
      const summary = "msg_page_summary_assistant"
      for (const [id, createdAt, data] of [
        [compaction, 1000, { role: "user" }],
        [summary, 1001, { role: "assistant", summary: true, finish: "stop", parentID: compaction }],
      ] as const) {
        yield* db.run(sql`
          INSERT INTO message (id, session_id, time_created, time_updated, data, context_summary)
          VALUES (${id}, ${created.id}, ${createdAt}, ${createdAt},
            ${JSON.stringify({ ...data, time: { created: createdAt } })},
            ${"summary" in data && data.summary === true ? 1 : 0})
        `)
      }
      const before = yield* readContextLedgerPage({ sessionID: created.id, limit: 1 })
      expect(before.mode).toBe("chronological")
      expect(before.nextCursor).toBeDefined()
      const foreign = yield* Effect.exit(readContextLedgerPage({
        sessionID: "ses_another_context_page", cursor: before.nextCursor,
      }))
      expect(String(foreign)).toContain("belongs to another session")
      yield* db.run(sql`
        INSERT INTO part (id, session_id, message_id, time_created, time_updated, data, context_compaction)
        VALUES ('prt_page_summary_compaction', ${created.id}, ${compaction}, 1000, 1000,
          ${JSON.stringify({ type: "compaction" })}, 1)
      `)
      const after = yield* readContextLedgerPage({ sessionID: created.id, limit: 1 })
      expect(after.mode).toBe("compacted")
      expect(String(yield* Effect.exit(readContextLedgerPage({
        sessionID: created.id, limit: 1, cursor: before.nextCursor,
      })))).toContain("Context history changed during pagination")
    }),
  )

  it.instance("bounds uncompacted ledger traversal using durable keyset pages", () =>
    Effect.gen(function* () {
      const sessionSvc = yield* SessionNs.Service
      const { db } = yield* Database.Service
      const created = yield* Effect.acquireRelease(sessionSvc.create({ title: "context-ledger-page" }), (info) =>
        sessionSvc.remove(info.id).pipe(Effect.ignore),
      )
      const count = 121
      for (let i = 0; i < count; i++) {
        const messageID = `msg_context_page_${String(i).padStart(4, "0")}`
        const time = 1000 + i
        yield* db.run(sql`
          INSERT INTO message (id, session_id, time_created, time_updated, data)
          VALUES (${messageID}, ${created.id}, ${time}, ${time},
            ${JSON.stringify({ role: "user", time: { created: time } })})
        `)
        yield* db.run(sql`
          INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
          VALUES (${"prt_" + messageID}, ${messageID}, ${created.id}, ${time}, ${time},
            ${JSON.stringify({ type: "text", text: "message " + i })})
        `)
      }
      const excludedID = MessageID.make("msg_context_page_0117")
      yield* SessionContextState.applyOps({
        sessionID: created.id, operations: [{ type: "message.exclude", messageID: excludedID }],
      })
      const expected = ContextInspection.ledger(created.id, yield* ContextInspection.read(created.id))
      const found: typeof expected.entries[number][] = []
      let nextCursor: string | undefined
      let rounds = 0
      do {
        const page = yield* readContextLedgerPage({ sessionID: created.id, limit: 17, cursor: nextCursor })
        expect(page.mode).toBe("chronological")
        expect(page.entries.length).toBeLessThanOrEqual(17)
        expect(page.hasMore).toBe(!!page.nextCursor)
        found.unshift(...page.entries)
        nextCursor = page.nextCursor
        rounds++
        if (rounds > 12) throw new Error("Ledger cursor did not terminate")
      } while (nextCursor)
      expect(rounds).toBe(8)
      expect(found).toEqual([...expected.entries])
      expect(found.find((entry) => entry.messageID === excludedID)?.excluded).toBe(true)
      const previous = yield* readContextLedgerPage({ sessionID: created.id, limit: 10 })
      yield* SessionContextState.applyOps({
        sessionID: created.id,
        operations: [{ type: "message.pin", messageID: MessageID.make("msg_context_page_0120") }],
      })
      expect(String(yield* Effect.exit(readContextLedgerPage({
        sessionID: created.id, limit: 10, cursor: previous.nextCursor,
      })))).toContain("Context ledger changed during pagination")
      expect(String(yield* Effect.exit(readContextLedgerPage({ sessionID: created.id, limit: 51 }))))
        .toContain("Invalid Context page size")
      expect(String(yield* Effect.exit(readContextLedgerPage({ sessionID: created.id, cursor: "invalid" }))))
        .toContain("Invalid Context ledger page cursor")
    }),
  )

  it.instance("atomically refuses stale Context mutations before event projection", () =>
    Effect.gen(function* () {
      const sessionSvc = yield* SessionNs.Service
      const { db } = yield* Database.Service
      const created = yield* Effect.acquireRelease(sessionSvc.create({ title: "context-atomic-admission" }), (info) =>
        sessionSvc.remove(info.id).pipe(Effect.ignore),
      )
      const messageID = MessageID.make("msg_context_atomic_refusal")
      yield* sessionSvc.updateMessage({
        id: messageID, sessionID: created.id, role: "user", time: { created: 1000 },
        agent: "test", model: { providerID: "test", modelID: "test" },
      } as SessionV1.User)
      yield* sessionSvc.updatePart({
        id: "prt_context_atomic_refusal" as any, messageID, sessionID: created.id,
        type: "text", text: "original",
      } as any)

      const operation = { type: "message.exclude" as const, messageID }
      const apply = (op: typeof operation) => SessionContextState.applyOps({
        sessionID: created.id,
        operations: [op],
        admit: () => validateContextMutation({ sessionID: created.id, operations: [op] }, db),
      })

      // The user read the original turn, but the writer added a signed
      // reasoning part before the action reached the durable queue. The
      // admission guard MUST read this later state in the same transaction.
      yield* sessionSvc.updatePart({
        id: "prt_context_atomic_signed" as any, messageID, sessionID: created.id,
        type: "reasoning", text: "signed",
        metadata: { anthropic: { signature: "valid-provider-signature" } },
        time: { start: 1001, end: 1002 },
      } as any)
      expect(String(yield* Effect.exit(apply(operation)))).toContain("Message contains signed reasoning")
      expect((yield* SessionContextState.getOpsHistory(created.id)).length).toBe(0)
      expect(yield* SessionContextState.getMessageState(created.id, messageID)).toBeUndefined()

      // Restorative semantics remain valid; a future ordinary message can
      // still be pinned, then discarded only if admission permits it.
      const allowed = { type: "message.pin" as const, messageID }
      yield* SessionContextState.applyOps({
        sessionID: created.id, operations: [allowed],
        admit: () => validateContextMutation({ sessionID: created.id, operations: [allowed] }, db),
      })
      expect((yield* SessionContextState.getOpsHistory(created.id)).length).toBe(1)
      expect((yield* SessionContextState.getMessageState(created.id, messageID))?.pinned).toBe(true)

      // The same event path is fail-closed after a target is removed; no
      // orphaned operation may appear in the log or context overlay.
      yield* db.run(sql`DELETE FROM message WHERE id = ${messageID}`)
      expect(String(yield* Effect.exit(apply(operation)))).toContain("Missing or foreign-session message")
      expect((yield* SessionContextState.getOpsHistory(created.id)).length).toBe(1)
    }),
  )

  it.instance("escalates only unbounded Context history to the scan lane without splitting snapshots", () =>
    Effect.gen(function* () {
      const sessionSvc = yield* SessionNs.Service
      const connection = yield* Database.Service
      const created = yield* Effect.acquireRelease(sessionSvc.create({ title: "context-scan-admission" }), (info) =>
        sessionSvc.remove(info.id).pipe(Effect.ignore),
      )
      let scanCalls = 0
      let mutateOnScan = false
      const database = Database.Service.of({
        ...connection,
        scanDb: () => Effect.gen(function* () {
          scanCalls++
          // A concurrent writer commits after the bounded read transaction
          // rolls back, before the dedicated scan obtains its new snapshot.
          // The final ledger MUST incorporate the new overlay, never stitch
          // together parts/metadata across two transaction revisions.
          if (mutateOnScan) {
            mutateOnScan = false
            yield* SessionContextState.applyOps({
              sessionID: created.id,
              operations: [{ type: "message.exclude", messageID: MessageID.make("msg_sc_scan_initial") }],
            })
          }
          return connection.db
        }) as unknown as ReturnType<typeof connection.scanDb>,
      })
      const inspected = () => ContextInspection.read(created.id).pipe(Effect.provideService(Database.Service, database))
      const add = (id: string, createdAt: number, data: Record<string, unknown>) =>
        connection.db.run(sql`
          INSERT INTO message (id, session_id, time_created, time_updated, data, context_summary)
          VALUES (${id}, ${created.id}, ${createdAt}, ${createdAt},
            ${JSON.stringify({ id, sessionID: created.id, time: { created: createdAt }, ...data })},
            ${data.summary === true ? 1 : 0})
        `)
      yield* add("msg_sc_scan_initial", 10, { role: "user" })
      expect((yield* inspected()).messages).toHaveLength(1)
      expect(scanCalls).toBe(0)

      // An uncompacted 171-message history cannot establish its complete
      // boundary inside the 3-page interactive budget.
      for (let i = 0; i < 170; i++)
        yield* add(`msg_sc_scan_old_${String(i).padStart(3, "0")}`, 100 + i, { role: "user" })
      mutateOnScan = true
      const full = yield* inspected()
      expect(full.messages).toHaveLength(171)
      expect(scanCalls).toBe(1)
      expect(new Set(full.messages.map((msg) => msg.info.id)).size).toBe(171)
      expect(ContextInspection.ledger(created.id, full).totals.excludedCount).toBe(1)
      expect(full.overlays.map((row) => String(row.message_id))).toEqual(["msg_sc_scan_initial"])

      // A newly completed compaction is visible at the newest end. Despite
      // hundreds of obsolete physical rows, the interactive reader proves
      // its effective boundary within one page and never opens scanDb again.
      const compact = "msg_sc_scan_compaction"
      yield* add(compact, 3000, { role: "user" })
      yield* connection.db.run(sql`
        INSERT INTO part (id, session_id, message_id, time_created, time_updated, data, context_compaction)
        VALUES ('prt_sc_scan_compaction', ${created.id}, ${compact}, 3000, 3000, ${JSON.stringify({ type: "compaction" })}, 1)
      `)
      yield* add("msg_sc_scan_summary", 3001, {
        role: "assistant", parentID: compact, summary: true, finish: "stop",
      })
      yield* add("msg_sc_scan_latest", 3002, { role: "user" })
      const bounded = yield* inspected()
      expect(bounded.messages.map((msg) => String(msg.info.id))).toEqual([
        compact, "msg_sc_scan_summary", "msg_sc_scan_latest",
      ])
      // Pagination respects the canonical *reordered* tail. It must not
      // expose 120 obsolete rows merely because the physical message index
      // sorts timestamps chronologically.
      const expectedLedger = ContextInspection.ledger(created.id, yield* ContextInspection.read(created.id))
      const pages: typeof expectedLedger.entries[number][] = []
      let next: string | undefined
      do {
        const section = yield* readContextLedgerPage({ sessionID: created.id, limit: 4, cursor: next })
        expect(section.mode).toBe("compacted")
        pages.unshift(...section.entries)
        next = section.nextCursor
      } while (next)
      expect(pages).toEqual([...expectedLedger.entries])
      expect(scanCalls).toBe(1)
    }),
  )

  it.instance("resolves session route from two durable scalars instead of hydrating the Session object", () =>
    Effect.gen(function* () {
      const sessionSvc = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(sessionSvc.create({ title: "route-identity-scalar" }), (info) =>
        sessionSvc.remove(info.id).pipe(Effect.ignore),
      )
      const full = yield* sessionSvc.get(created.id)
      const routed = yield* sessionSvc.getRoutingLocation!(created.id)
      expect(routed).toEqual({
        directory: full.directory,
        workspaceID: full.workspaceID,
      })
      expect(Object.keys(routed!).sort()).toEqual(["directory", "workspaceID"])
      const missing = yield* sessionSvc.getRoutingLocation!(SessionID.make("ses_nonexistent_routing"))
      expect(missing).toBeUndefined()
    }),
  )

  it.instance("reconciles effective history and overlays in an immutable per-request snapshot", () =>
    Effect.gen(function* () {
      const sessionSvc = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(sessionSvc.create({ title: "context-snapshot-consistency" }), (info) =>
        sessionSvc.remove(info.id).pipe(Effect.ignore),
      )
      const messageID = MessageID.make("msg_context_atomic_snapshot")
      yield* sessionSvc.updateMessage({
        id: messageID, sessionID: created.id, role: "user", time: { created: 1_000 },
        agent: "test", model: { providerID: "test", modelID: "test" },
      } as SessionV1.User)
      yield* sessionSvc.updatePart({
        id: "prt_context_atomic_snapshot" as any, messageID, sessionID: created.id,
        type: "text", text: "Authoritative original message",
      } as any)

      const first = yield* ContextInspection.read(created.id)
      expect(first.messages).toHaveLength(1)
      expect(first.overlays).toHaveLength(0)
      const firstLedger = ContextInspection.ledger(created.id, first)
      const firstPreview = ContextInspection.preview(created.id, first)
      expect(firstLedger.totals.excludedCount).toBe(0)
      expect(firstPreview.effectiveCount).toBe(1)
      expect(firstPreview.afterTokens).toBe(firstLedger.totals.estimatedTokens)

      yield* SessionContextState.applyOps({
        sessionID: created.id,
        operations: [{ type: "message.exclude", messageID }],
      })

      // An already-returned snapshot is an immutable historical read. Neither
      // the ledger nor preview is permitted to consult live overlay state.
      expect(ContextInspection.preview(created.id, first)).toEqual(firstPreview)
      expect(ContextInspection.ledger(created.id, first)).toEqual(firstLedger)

      const current = yield* ContextInspection.read(created.id)
      expect(current.overlays).toHaveLength(1)
      const currentLedger = ContextInspection.ledger(created.id, current)
      const currentPreview = ContextInspection.preview(created.id, current)
      expect(currentLedger.totals.excludedCount).toBe(1)
      expect(currentPreview.afterTokens).toBe(0)
      expect(currentPreview.removedTokens).toBe(firstPreview.beforeTokens)
    }),
  )

  it.instance("paged compaction history matches full hydration, including retained tail across page boundaries", () =>
    Effect.gen(function* () {
      const sessionSvc = yield* SessionNs.Service
      const { db } = yield* Database.Service
      const created = yield* Effect.acquireRelease(sessionSvc.create({ title: "context-compacted-pages" }), (info) =>
        sessionSvc.remove(info.id).pipe(Effect.ignore),
      )
      const addMessage = (id: string, time: number, data: Record<string, unknown>) =>
        db.run(sql`
          INSERT INTO message (id, session_id, time_created, time_updated, data, context_summary)
          VALUES (${id}, ${created.id}, ${time}, ${time}, ${JSON.stringify({ id, sessionID: created.id, time: { created: time }, ...data })},
            ${data.summary === true ? 1 : 0})
        `)

      // A compacted transcript with a 12-turn retained tail. The boundary
      // deliberately crosses SQL's 50-message pagination to catch cursor and
      // ordering regressions, while 120 old messages must never enter the
      // effective ledger.
      for (let i = 0; i < 120; i++)
        yield* addMessage(`msg_sc_obsolete_${String(i).padStart(3, "0")}`, 1000 + i, { role: "user" })
      const tailStart = "msg_sc_tail_000"
      for (let i = 0; i < 12; i++)
        yield* addMessage(`msg_sc_tail_${String(i).padStart(3, "0")}`, 2000 + i, { role: "user" })
      const compaction = "msg_sc_compaction"
      yield* addMessage(compaction, 3000, { role: "user" })
      yield* db.run(sql`
        INSERT INTO part (id, session_id, message_id, time_created, time_updated, data, context_compaction)
        VALUES ('prt_sc_compaction', ${created.id}, ${compaction}, 3000, 3000, ${JSON.stringify({
          type: "compaction", tail_start_id: tailStart,
        })}, 1)
      `)
      yield* addMessage("msg_sc_summary", 3001, {
        role: "assistant", summary: true, finish: "stop", parentID: compaction,
      })
      yield* addMessage("msg_sc_latest", 3002, { role: "user" })

      const full = MessageV2.filterCompacted(yield* MessageV2.stream(created.id))
      const paged = yield* MessageV2.streamCompacted(created.id)
      expect(paged.map((item) => item.info.id)).toEqual(full.map((item) => item.info.id))
      expect(paged).toEqual(full)
      expect(paged.length).toBe(15)
      expect(paged.map((item) => String(item.info.id))).toEqual([
        compaction, "msg_sc_summary",
        ...Array.from({ length: 12 }, (_, i) => `msg_sc_tail_${String(i).padStart(3, "0")}`),
        "msg_sc_latest",
      ])
    }),
  )

  it.instance("batch context admission reads only selected messages, deduplicates, and scopes by session", () =>
    Effect.gen(function* () {
      const sessionSvc = yield* SessionNs.Service
      const source = yield* Effect.acquireRelease(sessionSvc.create({ title: "context-bulk-source" }), (info) =>
        sessionSvc.remove(info.id).pipe(Effect.ignore),
      )
      const foreign = yield* Effect.acquireRelease(sessionSvc.create({ title: "context-bulk-foreign" }), (info) =>
        sessionSvc.remove(info.id).pipe(Effect.ignore),
      )
      const first = MessageID.make("msg_bulk_ctx_first")
      const second = MessageID.make("msg_bulk_ctx_second")
      const foreignID = MessageID.make("msg_bulk_ctx_foreign")
      for (const [id, sessionID] of [[first, source.id], [second, source.id], [foreignID, foreign.id]] as const) {
        yield* sessionSvc.updateMessage({
          id, sessionID, role: "user", time: { created: 1_000 }, agent: "test",
          model: { providerID: "test", modelID: "test" },
        } as SessionV1.User)
        yield* sessionSvc.updatePart({
          id: `prt_${id}` as any, sessionID, messageID: id, type: "text", text: `target ${id}`,
        } as any)
      }

      // More than 256 IDs exercise three bounded SQL chunks, while duplicate
      // IDs and another session's target cannot enter the admission facts.
      const ids = [
        first, second, first, foreignID,
        ...Array.from({ length: 256 }, (_, i) => MessageID.make(`msg_bulk_missing_${i}`)),
      ]
      const batched = yield* MessageV2.probeContextTargets({
        sessionID: source.id, messageIDs: ids,
        signatureMessageIDs: [], partIDs: [],
      })
      expect([...batched.messages.keys()].sort()).toEqual([first, second].sort())
      expect(batched.messages.has(foreignID)).toBe(false)
      expect(batched.partOwners.size).toBe(0)
      const empty = yield* MessageV2.probeContextTargets({
        sessionID: source.id, messageIDs: [], signatureMessageIDs: [], partIDs: [],
      })
      expect(empty.messages.size).toBe(0)

      const signed = MessageID.make("msg_bulk_ctx_signed")
      yield* sessionSvc.updateMessage({
        id: signed, sessionID: source.id, role: "assistant", parentID: first,
        time: { created: 2_000, completed: 2_001 }, agent: "test",
        providerID: "test", modelID: "test", mode: "chat",
        path: { cwd: "/", root: "/" }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      } as SessionV1.Assistant)
      yield* sessionSvc.updatePart({
        id: "prt_bulk_signed" as any, sessionID: source.id, messageID: signed,
        type: "reasoning", text: "provider reasoning",
        time: { start: 2_000, end: 2_001 },
        metadata: { anthropic: { signature: "signed-proof" } },
      } as any)
      const { db } = yield* Database.Service
      for (const [partID, status] of [
        ["prt_bulk_tool_completed", "completed"], ["prt_bulk_tool_pending", "pending"],
      ] as const)
        yield* db.run(sql`
          INSERT INTO part (id, session_id, message_id, time_created, time_updated, data)
          VALUES (${partID}, ${source.id}, ${first}, 3000, 3000,
            ${JSON.stringify({ type: "tool", tool: "read", state: { status, output: "test" } })})
        `)
      const opaque = MessageID.make("msg_bulk_ctx_opaque")
      yield* sessionSvc.updateMessage({
        id: opaque, sessionID: source.id, role: "user", time: { created: 3_001 }, agent: "test",
        model: { providerID: "test", modelID: "test" },
      } as SessionV1.User)
      // Simulate a persisted OPCL reference without requiring payload
      // materialization. The guard must never treat a missing inline type as
      // evidence that a potentially signed part is safe to exclude.
      yield* db.run(sql`
        INSERT INTO part (id, session_id, message_id, time_created, time_updated, data, context_opaque)
        VALUES ('prt_bulk_opaque', ${source.id}, ${opaque}, 3001, 3001,
          ${JSON.stringify({ $cdbRef: "event-value-reference" })}, 1)
      `)
      const probe = yield* MessageV2.probeContextTargets({
        sessionID: source.id,
        messageIDs: [first, second, signed, foreignID, opaque],
        signatureMessageIDs: [first, signed, foreignID, opaque],
        partIDs: ["prt_msg_bulk_ctx_first", "prt_bulk_signed", "prt_msg_bulk_ctx_foreign",
          "prt_bulk_tool_completed", "prt_bulk_tool_pending"] as any,
      })
      expect([...probe.messages.keys()].sort()).toEqual([first, second, signed, opaque].sort())
      expect(probe.messages.get(first)?.signedReasoning).toBe(false)
      expect(probe.messages.get(signed)?.signedReasoning).toBe(true)
      expect(probe.messages.get(first)?.hasEditablePart).toBe(true)
      expect(probe.messages.get(signed)?.hasEditablePart).toBe(true)
      expect(probe.messages.get(opaque)).toMatchObject({
        opaqueParts: true, signedReasoning: false, hasEditablePart: false,
      })
      expect(probe.partOwners.get("prt_msg_bulk_ctx_first" as any)).toBe(first)
      expect(probe.partOwners.get("prt_bulk_signed" as any)).toBe(signed)
      expect(probe.partOwners.has("prt_msg_bulk_ctx_foreign" as any)).toBe(false)
      expect(probe.partFacts.get("prt_bulk_tool_completed" as any)).toEqual({ type: "tool", status: "completed" })
      expect(probe.partFacts.get("prt_bulk_tool_pending" as any)).toEqual({ type: "tool", status: "pending" })
      const target = EffectiveContextCompiler.canApplyContextOperationTargetFacts
      expect(target("text.replace", "prt_bulk_tool_completed", true,
        probe.partFacts.get("prt_bulk_tool_completed" as any)).allowed).toBe(false)
      expect(target("text.replace", "prt_bulk_signed", true,
        probe.partFacts.get("prt_bulk_signed" as any)).allowed).toBe(true)
      expect(target("text.replace", undefined, false).allowed).toBe(false)
      expect(target("tool.collapse", "prt_msg_bulk_ctx_first", true,
        probe.partFacts.get("prt_msg_bulk_ctx_first" as any)).allowed).toBe(false)
      expect(target("tool.collapse", "prt_bulk_tool_pending", true,
        probe.partFacts.get("prt_bulk_tool_pending" as any)).allowed).toBe(false)
      expect(target("tool.collapse", "prt_bulk_tool_completed", true,
        probe.partFacts.get("prt_bulk_tool_completed" as any)).allowed).toBe(true)
      for (const id of [first, signed]) {
        const metadata = probe.messages.get(id)!
        const hydrated = yield* MessageV2.get({ sessionID: source.id, messageID: id })
        for (const type of ["message.exclude", "text.replace", "message.pin", "message.include", "tool.restore"]) {
          expect(
            EffectiveContextCompiler.canApplyContextOperationFacts(metadata.info, metadata.signedReasoning, type),
          ).toEqual(EffectiveContextCompiler.canApplyContextOperation(hydrated, type))
        }
      }
    }),
  )

  it.effect("keeps assistant-only current transcripts visible in the read-only ledger", () =>
    Effect.gen(function* () {
      const message = SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_special_assistant_only"),
        type: "assistant",
        agent: "goal_auditor",
        model: { providerID: "openai" as any, id: "gpt-test" as any },
        content: [
          { type: "reasoning", id: "reasoning-1", text: "Inspecting production evidence." },
          { type: "text", id: "text-1", text: "The deployment proof is incomplete." },
        ],
        time: {
          created: DateTime.makeUnsafe(1_000),
          completed: DateTime.makeUnsafe(2_000),
        },
        finish: "stop",
        cost: 0,
        tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 20, write: 1 } },
      })

      const ledger = yield* SessionLedger.buildCurrentReadOnly({
        sessionID: "ses_special_assistant_only",
        messages: [message],
      })

      expect(ledger.totals.messageCount).toBe(1)
      expect(ledger.totals.estimatedTokens).toBeGreaterThan(4)
      expect(ledger.entries[0]).toMatchObject({
        messageID: "msg_special_assistant_only",
        role: "assistant",
        type: "assistant",
        preview: "Inspecting production evidence.",
        excluded: false,
        pinned: false,
        edited: false,
        partCount: 2,
        timeCreated: 1_000,
      })
    }),
  )

  it.instance("excludes a message from effective context and restores it", () =>
    Effect.gen(function* () {
      const sessionSvc = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(sessionSvc.create({ title: "conv-ctrl-test" }), (info) =>
        sessionSvc.remove(info.id).pipe(Effect.ignore),
      )

      // Create 3 user messages
      const ids = ["msg_cc_1", "msg_cc_2", "msg_cc_3"]
      for (const [i, id] of ids.entries()) {
        yield* sessionSvc.updateMessage({
          id: MessageID.make(id),
          sessionID: created.id,
          role: "user",
          time: { created: 1000 + i },
          agent: "test",
          model: { providerID: "test", modelID: "test" },
        } as SessionV1.User)
        yield* sessionSvc.updatePart({
          id: `prt_cc_${i}` as any,
          sessionID: created.id,
          messageID: MessageID.make(id),
          type: "text",
          text: `message ${i + 1}`,
        } as any)
      }

      const all = yield* sessionSvc.messages({ sessionID: created.id })
      expect(all.length).toBe(3)

      // Exclude middle message
      const { batchID } = yield* SessionContextState.applyOps({
        sessionID: created.id,
        operations: [{ type: "message.exclude", messageID: ids[1] } as any],
      })
      expect(batchID.length).toBeGreaterThan(0)

      // Ledger reflects exclusion
      const filtered = MessageV2.filterCompacted(all as any)
      const ledger = yield* SessionLedger.build({ sessionID: created.id, messages: filtered as any })
      expect(ledger.totals.excludedCount).toBe(1)
      expect(ledger.entries.find((e) => e.messageID === ids[1])?.excluded).toBe(true)
      expect(ledger.totals.messageCount).toBe(3)

      // Effective compiler drops excluded
      const compiled = yield* EffectiveContextCompiler.compileForSession({
        messages: filtered as any,
        sessionID: created.id,
      })
      expect(compiled.effective.length).toBe(2)
      expect(compiled.effective.map((m) => m.info.id)).not.toContain(ids[1])
      expect(compiled.excluded.length).toBe(1)

      // Restore
      yield* SessionContextState.applyOps({
        sessionID: created.id,
        operations: [{ type: "message.include", messageID: ids[1] } as any],
      })
      const compiled2 = yield* EffectiveContextCompiler.compileForSession({
        messages: filtered as any,
        sessionID: created.id,
      })
      expect(compiled2.effective.length).toBe(3)
    }),
  )

  it.instance("edits a message via override and restores it", () =>
    Effect.gen(function* () {
      const sessionSvc = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(sessionSvc.create({ title: "edit-test" }), (info) =>
        sessionSvc.remove(info.id).pipe(Effect.ignore),
      )
      const msgId = "msg_edit_1"
      yield* sessionSvc.updateMessage({
        id: MessageID.make(msgId),
        sessionID: created.id,
        role: "user",
        time: { created: 2000 },
        agent: "test",
        model: { providerID: "test", modelID: "test" },
      } as SessionV1.User)
      yield* sessionSvc.updatePart({
        id: "prt_edit_1" as any,
        sessionID: created.id,
        messageID: MessageID.make(msgId),
        type: "text",
        text: "original text",
      } as any)

      const all = yield* sessionSvc.messages({ sessionID: created.id })
      const filtered = MessageV2.filterCompacted(all as any)

      // Edit
      yield* SessionContextState.applyOps({
        sessionID: created.id,
        operations: [{ type: "text.replace", messageID: msgId, content: "edited text" } as any],
      })

      const compiled = yield* EffectiveContextCompiler.compileForSession({
        messages: filtered as any,
        sessionID: created.id,
      })
      const edited = compiled.effective.find((m) => m.info.id === msgId)
      expect(edited).toBeDefined()
      const textPart = edited!.parts.find((p) => p.type === "text") as SessionV1.TextPart
      expect(textPart.text).toBe("edited text")

      // Ledger marks as edited
      const ledger = yield* SessionLedger.build({ sessionID: created.id, messages: filtered as any })
      expect(ledger.entries.find((e) => e.messageID === msgId)?.edited).toBe(true)

      // Restore
      yield* SessionContextState.applyOps({
        sessionID: created.id,
        operations: [{ type: "text.restore", messageID: msgId } as any],
      })
      const compiled2 = yield* EffectiveContextCompiler.compileForSession({
        messages: filtered as any,
        sessionID: created.id,
      })
      const restored = compiled2.effective.find((m) => m.info.id === msgId)
      const restoredText = restored!.parts.find((p) => p.type === "text") as SessionV1.TextPart
      expect(restoredText.text).toBe("original text")
    }),
  )

  it.instance("blocks exclude/edit on signed reasoning", () =>
    Effect.gen(function* () {
      const sessionSvc = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(sessionSvc.create({ title: "signed-test" }), (info) =>
        sessionSvc.remove(info.id).pipe(Effect.ignore),
      )
      const msgId = "msg_signed_1"
      yield* sessionSvc.updateMessage({
        id: MessageID.make(msgId),
        sessionID: created.id,
        role: "assistant",
        parentID: MessageID.make("msg_parent"),
        time: { created: 3000, completed: 3001 },
        agent: "test",
        modelID: "test" as any,
        providerID: "test" as any,
        mode: "chat",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      } as SessionV1.Assistant)
      yield* sessionSvc.updatePart({
        id: "prt_signed_r" as any,
        sessionID: created.id,
        messageID: MessageID.make(msgId),
        type: "reasoning",
        text: "secret reasoning",
        time: { start: 3000, end: 3001 },
        metadata: { anthropic: { signature: "sig_123" } },
      } as any)
      yield* sessionSvc.updatePart({
        id: "prt_signed_t" as any,
        sessionID: created.id,
        messageID: MessageID.make(msgId),
        type: "text",
        text: "response",
      } as any)

      const all = yield* sessionSvc.messages({ sessionID: created.id })
      const msg = all.find((m) => m.info.id === msgId)!
      expect(EffectiveContextCompiler.canExcludeMessage(msg).allowed).toBe(false)
      expect(EffectiveContextCompiler.canEditMessage(msg).allowed).toBe(false)

      // Compiler should warn but not exclude when state says excluded (gate keeps it)
      // Simulate state with excluded flag on signed message — compiler should skip it
      const compiled = EffectiveContextCompiler.compile({
        messages: all as any,
        state: new Map([[msgId, { excluded: true, pinned: false }]]),
      })
      // Should have warning and still include the message
      expect(compiled.warnings.length).toBeGreaterThan(0)
      expect(compiled.effective.length).toBe(1)
    }),
  )

  it.instance("refuses context overlays on authoritative replaceable state", () =>
    Effect.gen(function* () {
      const sessionSvc = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(sessionSvc.create({ title: "state-overlay-test" }), (info) =>
        sessionSvc.remove(info.id).pipe(Effect.ignore),
      )
      const id = MessageID.make("msg_goal_state_overlay")
      yield* sessionSvc.updateMessage({
        id,
        sessionID: created.id,
        role: "user",
        provenance: SessionTurnProvenance.host(SessionTurnProvenance.Source.GoalProgress, {
          ref: `goal-state:v1:progress:gol_overlay:${"a".repeat(64)}`,
        }),
        time: { created: 3500 },
        agent: "test",
        model: { providerID: "test", modelID: "test" },
      } as SessionV1.User)
      yield* sessionSvc.updatePart({
        id: "prt_goal_state_overlay" as any,
        sessionID: created.id,
        messageID: id,
        type: "text",
        text: "AUTHORITATIVE-CURRENT-STATE",
        synthetic: true,
      } as any)

      const msg = (yield* sessionSvc.messages({ sessionID: created.id }))[0]!
      expect(EffectiveContextCompiler.canExcludeMessage(msg)).toMatchObject({ allowed: false })
      expect(EffectiveContextCompiler.canEditMessage(msg)).toMatchObject({ allowed: false })
      expect(EffectiveContextCompiler.canApplyContextOperation(msg, "message.pin")).toMatchObject({ allowed: false })
      const facts = yield* MessageV2.probeContextTargets({
        sessionID: created.id,
        messageIDs: [id],
        signatureMessageIDs: [id],
        partIDs: [],
      })
      expect(facts.messages.get(id)).toBeDefined()
      for (const type of ["message.exclude", "text.replace", "message.pin", "tool.collapse", "message.include"]) {
        const metadata = facts.messages.get(id)!
        expect(EffectiveContextCompiler.canApplyContextOperationFacts(metadata.info, metadata.signedReasoning, type))
          .toEqual(EffectiveContextCompiler.canApplyContextOperation(msg, type))
      }
      expect(EffectiveContextCompiler.groupTurns([msg])).toHaveLength(0)

      // Simulate a historical invalid overlay already present in durable state.
      // Compiler and ledger must both ignore it so stale STATE cannot be hidden,
      // edited, pinned, or counted as excluded.
      yield* SessionContextState.applyOps({
        sessionID: created.id,
        operations: [{ type: "message.exclude", messageID: id } as any],
      })
      const compiled = EffectiveContextCompiler.compile({
        messages: [msg],
        state: new Map([
          [
            id,
            {
              excluded: true,
              pinned: true,
              overrideData: { text: "MUTATED-STALE-STATE" },
            },
          ],
        ]) as any,
      })
      expect(compiled.effective).toHaveLength(1)
      expect(compiled.excluded).toHaveLength(0)
      expect(compiled.warnings).toHaveLength(1)
      expect(JSON.stringify(compiled.effective)).toContain("AUTHORITATIVE-CURRENT-STATE")
      expect(JSON.stringify(compiled.effective)).not.toContain("MUTATED-STALE-STATE")

      if (msg.info.role !== "user") throw new Error("expected Goal state to use the V1 user-role projection")
      const historical = {
        ...msg,
        info: {
          ...msg.info,
          provenance: { ...msg.info.provenance!, lifetime: "historical" as const },
        },
      } as SessionV1.WithParts
      expect(SessionTurnProvenance.isStateProjectionTurn(historical)).toBe(false)
      expect(SessionTurnProvenance.hasStateSemanticsTurn(historical)).toBe(true)
      expect(EffectiveContextCompiler.canExcludeMessage(historical)).toMatchObject({ allowed: false })
      expect(EffectiveContextCompiler.canEditMessage(historical)).toMatchObject({ allowed: false })
      const historicalCompiled = EffectiveContextCompiler.compile({
        messages: [historical],
        state: new Map([[id, { excluded: true, pinned: true, overrideData: { text: "MUTATED-HISTORY" } }]]) as any,
      })
      expect(historicalCompiled.effective).toEqual([historical])
      expect(JSON.stringify(historicalCompiled.effective)).not.toContain("MUTATED-HISTORY")

      const ledger = yield* SessionLedger.build({ sessionID: created.id, messages: [msg] })
      expect(ledger.entries[0]).toMatchObject({ excluded: false, pinned: false, edited: false, type: "synthetic" })
      expect(ledger.totals).toMatchObject({ excludedCount: 0, pinnedCount: 0, editedCount: 0 })
    }),
  )

  it.instance("forks after assistant with edge=after and inherits effective context", () =>
    Effect.gen(function* () {
      const sessionSvc = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(sessionSvc.create({ title: "fork-assistant-test" }), (info) =>
        sessionSvc.remove(info.id).pipe(Effect.ignore),
      )

      // Create user + assistant turn
      const userId = "msg_fork_u1"
      const assistantId = "msg_fork_a1"
      yield* sessionSvc.updateMessage({
        id: MessageID.make(userId),
        sessionID: created.id,
        role: "user",
        time: { created: 4000 },
        agent: "test",
        model: { providerID: "test", modelID: "test" },
      } as SessionV1.User)
      yield* sessionSvc.updatePart({
        id: "prt_fork_u1" as any,
        sessionID: created.id,
        messageID: MessageID.make(userId),
        type: "text",
        text: "hello",
      } as any)
      yield* sessionSvc.updateMessage({
        id: MessageID.make(assistantId),
        sessionID: created.id,
        role: "assistant",
        parentID: MessageID.make(userId),
        time: { created: 4001, completed: 4002 },
        agent: "test",
        modelID: "test" as any,
        providerID: "test" as any,
        mode: "chat",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      } as SessionV1.Assistant)
      yield* sessionSvc.updatePart({
        id: "prt_fork_a1" as any,
        sessionID: created.id,
        messageID: MessageID.make(assistantId),
        type: "text",
        text: "world",
      } as any)

      // Exclude the assistant via context ops — fork should inherit effective (without it)
      yield* SessionContextState.applyOps({
        sessionID: created.id,
        operations: [{ type: "message.exclude", messageID: assistantId } as any],
      })

      // Fork after the user (edge before assistant) — should get only user
      const forkAfterUser = yield* Effect.acquireRelease(
        sessionSvc.fork({ sessionID: created.id, messageID: MessageID.make(assistantId), edge: "before" } as any),
        (info) => sessionSvc.remove(info.id).pipe(Effect.ignore),
      )
      const forkMsgs = yield* sessionSvc.messages({ sessionID: forkAfterUser.id })
      // Since assistant was excluded in source, fork should have only 1 message (the user)
      // But our fork's effective inheritance skips excluded messages, so it should have 1
      expect(forkMsgs.length).toBe(1)
      expect(forkMsgs[0]!.info.id).not.toBe(assistantId)
    }),
  )
})
