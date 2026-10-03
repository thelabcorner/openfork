import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
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
import { testEffect } from "../lib/effect"

const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, FSUtil.node, OfxpPeer.node, OfxpRoot.node]),
  [[Database.node, Database.layerFromPath(":memory:")]],
)
const it = testEffect(layer)

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

describe("OFXP Session search supervision adapter", () => {
  it.effect("pushes approved-root scope before FTS ranking and virtualizes every returned directory", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (item) => Effect.promise(() => item[Symbol.asyncDispose]()),
      )
      const repo = path.join(tmp.path, "repo")
      const outside = path.join(tmp.path, "outside")
      const project = path.join(repo, "project")
      yield* Effect.promise(() =>
        Promise.all([
          fs.mkdir(project, { recursive: true }),
          fs.mkdir(outside, { recursive: true }),
        ]),
      )

      const db = (yield* Database.Service).db
      const peers = yield* OfxpPeer.Service
      const roots = yield* OfxpRoot.Service
      const remote = identity("Session Search Reader")
      const trusted = yield* peers.trust({ identity: remote.identity })
      const granted = yield* peers.setGrant({
        peerID: remote.key.peerID,
        expectedRevision: trusted.info.grantRevision,
        grant: { ...Ofxp.DENY_GRANT, sessionSupervision: "approved-roots" },
      })
      const root = yield* roots.approve(
        remote.key.peerID,
        repo,
        "repo",
        "manual",
        granted.info.grantRevision,
      )

      yield* db
        .insert(ProjectTable)
        .values({
          id: ProjectV2.ID.global,
          worktree: AbsolutePath.make(repo),
          sandboxes: [],
        })
        .run()
        .pipe(Effect.orDie)

      const approvedID = SessionSchema.ID.make("ses_ofxp_search_approved")
      const outsideID = SessionSchema.ID.make("ses_ofxp_search_outside")
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
        SessionV1.MessageID.make("msg_ofxp_search_approved"),
        SessionV1.PartID.make("prt_ofxp_search_approved"),
        "needle authorized evidence",
        100,
      )
      yield* insertText(
        outsideID,
        SessionV1.MessageID.make("msg_ofxp_search_outside"),
        SessionV1.PartID.make("prt_ofxp_search_outside"),
        "needle needle needle needle needle stronger outside evidence",
        200,
      )

      const toolMessageID = SessionV1.MessageID.make("msg_ofxp_search_tool")
      yield* db
        .insert(MessageTable)
        .values({
          id: toolMessageID,
          session_id: approvedID,
          time_created: 150,
          data: { role: "assistant", time: { created: 150 } } as never,
        })
        .run()
        .pipe(Effect.orDie)
      const fakeToolText = SessionV1.TextPart.make({
        id: SessionV1.PartID.make("prt_ofxp_fake_tool_text"),
        sessionID: approvedID,
        messageID: toolMessageID,
        type: "text",
        text: "tool:read needle fake prose",
        time: { start: 150 },
      })
      const realTool = SessionV1.ToolPart.make({
        id: SessionV1.PartID.make("prt_ofxp_real_tool"),
        sessionID: approvedID,
        messageID: toolMessageID,
        type: "tool",
        callID: "call_ofxp_read",
        tool: "read",
        state: {
          status: "completed",
          input: { path: "needle.txt" },
          output: "ok",
          title: "read",
          metadata: {},
          time: { start: 151, end: 152 },
        },
      })
      for (const part of [fakeToolText, realTool] as SessionV1.Part[]) {
        const { id, messageID, sessionID: _, ...data } = part
        yield* db
          .insert(PartTable)
          .values({
            id,
            message_id: messageID,
            session_id: approvedID,
            time_created: 150,
            data: data as never,
            search_text: partSearchText(part),
          })
          .run()
          .pipe(Effect.orDie)
      }

      yield* seedSearchCoverage()

      const result = yield* OfxpSessionSearch.execute(
        { db, peers, roots },
        remote.key.peerID,
        { rootID: root.id, query: "needle", limit: 1 },
      )
      const structured = result.structured as {
        sessions: Array<{ sessionId: string; directory: string }>
      }

      expect(structured.sessions).toEqual([
        expect.objectContaining({
          sessionId: approvedID,
          directory: "/repo/project",
        }),
      ])
      expect(result.metadata).toMatchObject({
        count: 1,
        grantRevision: granted.info.grantRevision,
        authorizedRoots: 1,
      })
      expect(result.output).not.toContain(outsideID)
      expect(result.output).not.toContain(repo)
      expect(result.output).not.toContain(outside)
      expect(result.mutation).toEqual({ attempted: false, committed: false })

      const toolResult = yield* OfxpSessionSearch.execute(
        { db, peers, roots },
        remote.key.peerID,
        { rootID: root.id, query: "needle", tool: "read", limit: 5 },
      )
      const toolHits = (toolResult.structured as {
        hits: { tools: Array<{ partId?: string; tool: string }> }
      }).hits.tools
      expect(toolHits).toEqual([
        expect.objectContaining({
          partId: "prt_ofxp_real_tool",
          tool: "read",
        }),
      ])
      const partHits = (toolResult.structured as {
        hits: { parts: Array<{ partId: string; partType: string }> }
      }).hits.parts
      expect(partHits).toContainEqual(
        expect.objectContaining({
          partId: "prt_ofxp_fake_tool_text",
          partType: "text",
        }),
      )
      expect(toolHits.some((hit) => hit.partId === "prt_ofxp_fake_tool_text")).toBe(false)
    }),
  )

  it.effect("fails egress on a grant-revision change instead of returning stale authorized results", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (item) => Effect.promise(() => item[Symbol.asyncDispose]()),
      )
      const repo = path.join(tmp.path, "repo")
      yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))

      const db = (yield* Database.Service).db
      const peers = yield* OfxpPeer.Service
      const roots = yield* OfxpRoot.Service
      const remote = identity("Session Search Revocation")
      const trusted = yield* peers.trust({ identity: remote.identity })
      const granted = yield* peers.setGrant({
        peerID: remote.key.peerID,
        expectedRevision: trusted.info.grantRevision,
        grant: { ...Ofxp.DENY_GRANT, sessionSupervision: "approved-roots" },
      })
      const root = yield* roots.approve(
        remote.key.peerID,
        repo,
        "repo",
        "manual",
        granted.info.grantRevision,
      )

      yield* db
        .insert(ProjectTable)
        .values({
          id: ProjectV2.ID.global,
          worktree: AbsolutePath.make(repo),
          sandboxes: [],
        })
        .run()
        .pipe(Effect.orDie)
      const sessionID = SessionSchema.ID.make("ses_ofxp_search_revision")
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: ProjectV2.ID.global,
          slug: "revision",
          directory: repo,
          title: "Revision search",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* insertText(
        sessionID,
        SessionV1.MessageID.make("msg_ofxp_search_revision"),
        SessionV1.PartID.make("prt_ofxp_search_revision"),
        "needle revision evidence",
        100,
      )
      yield* seedSearchCoverage()

      let firstAuthorization = true
      const fencedPeers: OfxpPeer.Interface = {
        ...peers,
        authorize: (input) =>
          Effect.gen(function* () {
            const authorization = yield* peers.authorize(input)
            if (firstAuthorization) {
              firstAuthorization = false
              const current = yield* peers.get(remote.key.peerID)
              yield* peers
                .setGrant({
                  peerID: remote.key.peerID,
                  expectedRevision: current.info.grantRevision,
                  grant: {
                    ...Ofxp.DENY_GRANT,
                    sessionSupervision: "approved-roots",
                    read: true,
                  },
                })
                .pipe(Effect.orDie)
            }
            return authorization
          }),
      }

      const error = yield* OfxpSessionSearch.execute(
        { db, peers: fencedPeers, roots },
        remote.key.peerID,
        { rootID: root.id, query: "needle", limit: 1 },
      ).pipe(Effect.flip)

      expect(error._tag).toBe("OfxpPeer.StaleRevisionError")
    }),
  )

  it.effect("rejects Session search when the peer has no approved supervision roots", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const peers = yield* OfxpPeer.Service
      const roots = yield* OfxpRoot.Service
      const remote = identity("Session Search No Roots")
      const trusted = yield* peers.trust({ identity: remote.identity })
      yield* peers.setGrant({
        peerID: remote.key.peerID,
        expectedRevision: trusted.info.grantRevision,
        grant: { ...Ofxp.DENY_GRANT, sessionSupervision: "approved-roots" },
      })

      const error = yield* OfxpSessionSearch.execute(
        { db, peers, roots },
        remote.key.peerID,
        { query: "needle", limit: 1 },
      ).pipe(Effect.flip)

      expect(error._tag).toBe("Exchange.AuthorityDenied")
    }),
  )
})
