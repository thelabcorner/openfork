import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Deferred, Effect, Fiber } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { OfxpIdentity } from "@opencode-ai/core/ofxp-peer/identity"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionSearch } from "@opencode-ai/core/session/search"
import { partSearchText } from "@opencode-ai/core/session/search-text"
import {
  MessageTable,
  PartSearchBackfillTable,
  PartTable,
  SearchBackfillTable,
  SessionTable,
} from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { OfxpRoot } from "@/ofxp/root"
import { OfxpSessionSearch } from "@/ofxp/supervision/session-search"
import { tmpdir } from "../fixture/fixture"

/**
 * Lane D read-side evidence for the OFXP supervision adapter on a REAL
 * file-backed database (the in-memory adapter suite remains authoritative for
 * grant/revocation semantics).
 *
 * Production wiring discovery: `OfxpSessionSearch.execute` has no registered
 * OFXP dispatcher today; OXP's `session.search` is the wired caller and leases
 * `withScanDb` (`packages/opencode/src/oxp/session.ts`). These tests exercise
 * the adapter through that same pooled-lease shape so any future dispatcher
 * inherits executable lane-separation evidence.
 */

// Test-owned real workload. Not a reproduction of any incident SQL.
const ladder = (n: number) =>
  `WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM r WHERE x < ${n}) SELECT sum(x) AS total FROM r`

function identity(label: string) {
  const key = OfxpIdentity.generateKeyPair()
  return {
    key,
    identity: {
      id: key.peerID,
      realmID: "realm:" + label.toLowerCase().replaceAll(" ", "-"),
      label,
      publicKeySpki: key.publicKeySpki,
      fingerprint: key.fingerprint,
    } satisfies Ofxp.PeerIdentity,
  }
}

const seedSearchCoverage = Effect.fnUntraced(function* () {
  const db = (yield* Database.Service).db
  yield* db
    .insert(SearchBackfillTable)
    .values({ id: 1, watermark_rowid: -1, done: 1 })
    .onConflictDoUpdate({ target: SearchBackfillTable.id, set: { done: 1 } })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(PartSearchBackfillTable)
    .values({ id: 1, watermark_rowid: -1, done: 1 })
    .onConflictDoUpdate({ target: PartSearchBackfillTable.id, set: { done: 1 } })
    .run()
    .pipe(Effect.orDie)
})

const insertText = Effect.fnUntraced(function* (
  sessionID: SessionSchema.ID,
  messageID: SessionV1.MessageID,
  partID: SessionV1.PartID,
  text: string,
  created: number,
) {
  const db = (yield* Database.Service).db
  yield* db
    .insert(MessageTable)
    .values({
      id: messageID,
      session_id: sessionID,
      time_created: created,
      data: { role: "user", time: { created } } as never,
    })
    .run()
    .pipe(Effect.orDie)
  const part = SessionV1.TextPart.make({
    id: partID,
    sessionID,
    messageID,
    type: "text",
    text,
    time: { start: created },
  })
  const { id, messageID: _, sessionID: __, ...data } = part
  yield* db
    .insert(PartTable)
    .values({
      id,
      message_id: messageID,
      session_id: sessionID,
      time_created: created,
      data: data as never,
      search_text: partSearchText(part),
    })
    .run()
    .pipe(Effect.orDie)
})

const prepare = (tempPath: string) =>
  Effect.gen(function* () {
    const repo = path.join(tempPath, "repo")
    const outside = path.join(tempPath, "outside")
    const project = path.join(repo, "project")
    yield* Effect.promise(() => Promise.all([
      fs.mkdir(project, { recursive: true }),
      fs.mkdir(outside, { recursive: true }),
    ]))
    const db = (yield* Database.Service).db
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const remote = identity("File-backed Supervision Reader")
    const trusted = yield* peers.trust({ identity: remote.identity })
    const granted = yield* peers.setGrant({
      peerID: remote.key.peerID,
      expectedRevision: trusted.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, sessionSupervision: "approved-roots" },
    })
    const root = yield* roots.approve(remote.key.peerID, repo, "repo", "manual", granted.info.grantRevision)
    yield* db
      .insert(ProjectTable)
      .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make(repo), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    const approvedID = SessionSchema.ID.make("ses_ofxp_file_backed_approved")
    const outsideID = SessionSchema.ID.make("ses_ofxp_file_backed_outside")
    yield* db
      .insert(SessionTable)
      .values([
        {
          id: approvedID,
          project_id: ProjectV2.ID.global,
          slug: "approved",
          directory: project,
          title: "Approved session",
          version: "test",
          time_created: 100,
          time_updated: 100,
        },
        {
          id: outsideID,
          project_id: ProjectV2.ID.global,
          slug: "outside",
          directory: outside,
          title: "Outside session",
          version: "test",
          time_created: 200,
          time_updated: 200,
        },
      ])
      .run()
      .pipe(Effect.orDie)
    yield* insertText(
      approvedID,
      SessionV1.MessageID.make("msg_ofxp_file_backed_approved"),
      SessionV1.PartID.make("prt_ofxp_file_backed_approved"),
      "needle authorized evidence",
      100,
    )
    yield* insertText(
      outsideID,
      SessionV1.MessageID.make("msg_ofxp_file_backed_outside"),
      SessionV1.PartID.make("prt_ofxp_file_backed_outside"),
      "needle needle needle needle needle stronger outside evidence",
      200,
    )
    yield* seedSearchCoverage()
    yield* SessionSearch.repairChunk(db, { maxRows: 32 })
    return { db, peers, roots, remote, root, approvedID, outsideID, repo, outside, grantRevision: granted.info.grantRevision }
  })

const layerFor = (file: string) =>
  AppNodeBuilder.build(
    LayerNode.group([Database.node, FSUtil.node, OfxpPeer.node, OfxpRoot.node]),
    [[Database.node, Database.layerFromPath(file)]],
  )

describe("lane D: OFXP supervision read on a file-backed pooled scanner", () => {
  test("a pooled scan lease serves rooted supervision search while the primary and interactive lanes stay untouched", async () => {
    await using tmp = await tmpdir()
    const outcomes = await Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const prepared = yield* prepare(tmp.path)
        const database = yield* Database.Service
        // The production Database must expose the pooled lease on file-backed
        // storage; a fallback to the single scan connection would not prove
        // two-reader separation.
        expect(database.withScanDb).toBeDefined()
        expect(database.scanDb).toBeDefined()
        const result = yield* database.withScanDb!((reader) =>
          OfxpSessionSearch.execute(
            { db: reader, peers: prepared.peers, roots: prepared.roots },
            prepared.remote.key.peerID,
            { rootID: prepared.root.id, query: "needle", limit: 1 },
          ),
        )
        const structured = result.structured as {
          sessions: Array<{ sessionId: string; directory: string }>
        }
        return { result, structured, prepared }
      }).pipe(
        Effect.provide(layerFor(path.join(tmp.path, "supervision.sqlite"))),
      ),
    ))
    expect(outcomes.structured.sessions).toEqual([
      expect.objectContaining({
        sessionId: outcomes.prepared.approvedID,
        directory: "/repo/project",
      }),
    ])
    expect(outcomes.result.metadata).toMatchObject({
      count: 1,
      grantRevision: outcomes.prepared.grantRevision,
      authorizedRoots: 1,
    })
    expect(outcomes.result.output).not.toContain(outcomes.prepared.outsideID)
    expect(outcomes.result.output).not.toContain(outcomes.prepared.repo)
    expect(outcomes.result.output).not.toContain(outcomes.prepared.outside)
    expect(outcomes.result.mutation).toEqual({ attempted: false, committed: false })
  }, 30_000)

  test("a pinned pooled long read does not delay supervision search or the interactive history lane", async () => {
    await using tmp = await tmpdir()
    const observed = await Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const prepared = yield* prepare(tmp.path)
        const database = yield* Database.Service
        const pinnedStarted = yield* Deferred.make<void>()
        const releasePinned = yield* Deferred.make<void>()
        // One pooled reader is genuinely pinned by a real native statement and
        // then held beyond it; the other reader must remain independently
        // eligible for a supervision search and the interactive lane.
        const pinned = yield* database.withScanDb!((reader) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(pinnedStarted, undefined)
            const row = yield* reader.get<{ total: number }>(ladder(3_000_000)).pipe(Effect.orDie)
            yield* Deferred.await(releasePinned)
            return Number(row?.total ?? 0)
          }),
        ).pipe(Effect.forkChild)
        yield* Deferred.await(pinnedStarted)
        yield* Effect.sleep("50 millis")
        const searchStarted = performance.now()
        const result = yield* database.withScanDb!((reader) =>
          OfxpSessionSearch.execute(
            { db: reader, peers: prepared.peers, roots: prepared.roots },
            prepared.remote.key.peerID,
            { rootID: prepared.root.id, query: "needle", limit: 1 },
          ),
        )
        const searchMs = performance.now() - searchStarted
        const interactive = yield* database.readDb
          .get<{ n: number }>("SELECT count(*) AS n FROM session")
          .pipe(Effect.orDie)
        yield* Deferred.succeed(releasePinned, undefined)
        const pinnedTotal = yield* Fiber.join(pinned)
        const structured = result.structured as { sessions: Array<{ sessionId: string }> }
        return { searchMs, structured, pinnedTotal, prepared, interactive }
      }).pipe(
        Effect.provide(layerFor(path.join(tmp.path, "supervision-concurrent.sqlite"))),
      ),
    ))
    expect(observed.structured.sessions).toEqual([
      expect.objectContaining({ sessionId: observed.prepared.approvedID }),
    ])
    expect(observed.searchMs).toBeLessThan(1_500)
    expect(Number(observed.interactive?.n)).toBe(2)
    expect(observed.pinnedTotal).toBe((3_000_000 * 3_000_001) / 2)
  }, 40_000)
})
