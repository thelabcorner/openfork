import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionAttachment } from "@opencode-ai/core/session/attachment"
import { SessionAttachmentTable } from "@opencode-ai/core/session/attachment.sql"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionAttachment as Contract } from "@opencode-ai/schema/session-attachment"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node]), [[Database.node, Database.layerFromPath(":memory:")]]),
)

const encoder = new TextEncoder()

function seed(db: Database.Interface["db"], projectID: Project.ID, sessionID: SessionSchema.ID, slug: string) {
  return db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: projectID,
      slug,
      directory: `/tmp/${slug}`,
      title: slug,
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
}

describe("SessionAttachment owner", () => {
  it.effect("deduplicates bytes but never merges access rights", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const projectID = Project.ID.global
      const a = SessionSchema.ID.make("ses_attachment_a")
      const b = SessionSchema.ID.make("ses_attachment_b")
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make("/tmp/attach"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* seed(db, projectID, a, "attachment-a")
      yield* seed(db, projectID, b, "attachment-b")

      const bytes = encoder.encode("same-bytes")
      const first = yield* SessionAttachment.registerUpload(db, {
        sessionID: a,
        messageID: "msg_a_1",
        partID: "prt_a_1",
        origin: "user-upload",
        mime: "text/plain",
        filename: "one.txt",
        bytes,
      })
      const second = yield* SessionAttachment.registerUpload(db, {
        sessionID: b,
        messageID: "msg_b_1",
        partID: "prt_b_1",
        origin: "user-upload",
        mime: "text/plain",
        filename: "two.txt",
        bytes,
      })

      // Equal content => one shared blob row, two distinct logical uploads.
      expect(second.blobID).toBe(first.blobID)
      expect(second.id).not.toBe(first.id)
      expect(second.filename).toBe("two.txt")
      expect(second.handle).toBe(Contract.Handle.make("upload-1"))

      // A handle in session A cannot resolve session B's upload.
      const crossSession = yield* SessionAttachment.resolveSelection(db, {
        handles: ["upload-1"],
        scope: { kind: "index", sessionID: b },
      })
      expect(crossSession).toHaveLength(1)
      expect(crossSession[0]!.upload.id).toBe(second.id)
    }),
  )

  it.effect("resolves a handle only for the exact triggering turn, index, or active grant", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const projectID = Project.ID.global
      const session = SessionSchema.ID.make("ses_attachment_scope")
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make("/tmp/attach-scope"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* seed(db, projectID, session, "attachment-scope")

      const upload = yield* SessionAttachment.registerUpload(db, {
        sessionID: session,
        messageID: "msg_turn_1",
        partID: "prt_turn_1",
        origin: "user-upload",
        mime: "image/png",
        bytes: encoder.encode("png"),
      })

      // Wrong turn: same session, different message => no resolution.
      const wrongTurn = yield* SessionAttachment.resolveSelection(db, {
        handles: [upload.handle],
        scope: { kind: "current-turn", sessionID: session, messageID: "msg_turn_2" },
      })
      expect(wrongTurn).toHaveLength(0)

      // Exact turn => resolves.
      const exact = yield* SessionAttachment.resolveSelection(db, {
        handles: [upload.handle],
        scope: { kind: "current-turn", sessionID: session, messageID: "msg_turn_1" },
      })
      expect(exact).toHaveLength(1)

      // A foreign, unknown handle never resolves.
      const foreign = yield* SessionAttachment.resolveSelection(db, {
        handles: ["upload-999"],
        scope: { kind: "index", sessionID: session },
      })
      expect(foreign).toHaveLength(0)
    }),
  )

  it.effect("does not treat a workspace-file origin as handoff-eligible", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const projectID = Project.ID.global
      const session = SessionSchema.ID.make("ses_attachment_origin")
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make("/tmp/attach-origin"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* seed(db, projectID, session, "attachment-origin")

      const workspaceFile = yield* SessionAttachment.registerUpload(db, {
        sessionID: session,
        messageID: "msg_turn_1",
        partID: "prt_turn_1",
        origin: "workspace-file",
        mime: "image/png",
        bytes: encoder.encode("png"),
      })

      // It exists as a durable fact, but the index (eligible discovery) omits it.
      const page = yield* SessionAttachment.indexPage(db, { sessionID: session })
      expect(page.items).toHaveLength(0)

      // And an explicit selection cannot resolve it either.
      const selected = yield* SessionAttachment.resolveSelection(db, {
        handles: [workspaceFile.handle],
        scope: { kind: "index", sessionID: session },
      })
      expect(selected).toHaveLength(0)
    }),
  )

  it.effect("is idempotent on the delegation idempotency key and never duplicates grants", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const projectID = Project.ID.global
      const parent = SessionSchema.ID.make("ses_attachment_parent")
      const child = SessionSchema.ID.make("ses_attachment_child")
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make("/tmp/attach-grant"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* seed(db, projectID, parent, "attachment-parent")
      yield* seed(db, projectID, child, "attachment-child")

      const upload = yield* SessionAttachment.registerUpload(db, {
        sessionID: parent,
        messageID: "msg_parent_1",
        partID: "prt_parent_1",
        origin: "user-upload",
        mime: "image/png",
        bytes: encoder.encode("png"),
      })
      const [selected] = yield* SessionAttachment.resolveSelection(db, {
        handles: [upload.handle],
        scope: { kind: "current-turn", sessionID: parent, messageID: "msg_parent_1" },
      })
      const target: Contract.GrantTarget = {
        kind: "task",
        sourceSessionID: parent,
        assistantMessageID: "msg_assistant",
        toolCallID: "call_1",
        toolPartID: "prt_tool_1",
        childSessionID: child,
      }
      const key = `${parent}:msg_assistant:call_1:prt_tool_1:${child}`
      const grant1 = yield* SessionAttachment.createGrant(db, { attachment: selected!, target, idempotencyKey: key })
      const grant2 = yield* SessionAttachment.createGrant(db, { attachment: selected!, target, idempotencyKey: key })
      expect(grant2.id).toBe(grant1.id)

      const rows = yield* db.select().from(SessionAttachmentTable).all().pipe(Effect.orDie)
      expect(rows).toHaveLength(1)
    }),
  )

  it.effect("cascades asset revocation to every grant and blocks later reads", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const projectID = Project.ID.global
      const parent = SessionSchema.ID.make("ses_attachment_revoke")
      const childA = SessionSchema.ID.make("ses_attachment_revoke_a")
      const childB = SessionSchema.ID.make("ses_attachment_revoke_b")
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make("/tmp/attach-revoke"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* seed(db, projectID, parent, "attachment-revoke")
      yield* seed(db, projectID, childA, "attachment-revoke-a")
      yield* seed(db, projectID, childB, "attachment-revoke-b")

      const upload = yield* SessionAttachment.registerUpload(db, {
        sessionID: parent,
        messageID: "msg_parent_1",
        partID: "prt_parent_1",
        origin: "user-upload",
        mime: "image/png",
        bytes: encoder.encode("png"),
      })
      const [selected] = yield* SessionAttachment.resolveSelection(db, {
        handles: [upload.handle],
        scope: { kind: "index", sessionID: parent },
      })
      const targetFor = (child: SessionSchema.ID, call: string): Contract.GrantTarget => ({
        kind: "task",
        sourceSessionID: parent,
        assistantMessageID: "msg_assistant",
        toolCallID: call,
        toolPartID: `prt_${call}`,
        childSessionID: child,
      })
      const grantA = yield* SessionAttachment.createGrant(db, {
        attachment: selected!,
        target: targetFor(childA, "call_a"),
        idempotencyKey: `${parent}:msg_assistant:call_a:prt_call_a:${childA}`,
      })
      const grantB = yield* SessionAttachment.createGrant(db, {
        attachment: selected!,
        target: targetFor(childB, "call_b"),
        idempotencyKey: `${parent}:msg_assistant:call_b:prt_call_b:${childB}`,
      })

      const revoked = yield* SessionAttachment.revokeAsset(db, upload.id, "operator-delete")
      expect(revoked).toBe(2)

      const checkA = yield* SessionAttachment.checkGrant(db, grantA.id)
      const checkB = yield* SessionAttachment.checkGrant(db, grantB.id)
      expect(checkA.ok).toBe(false)
      expect(checkB.ok).toBe(false)
      if (!checkA.ok) expect(checkA.reason).toBe("revoked")

      const bytes = yield* SessionAttachment.resolveBytes(db, [grantA.id, grantB.id])
      expect(bytes).toHaveLength(0)
    }),
  )

  it.effect("scoped grant revoke blocks that child and its descendants only", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const projectID = Project.ID.global
      const parent = SessionSchema.ID.make("ses_attachment_desc")
      const child = SessionSchema.ID.make("ses_attachment_desc_child")
      const grandchild = SessionSchema.ID.make("ses_attachment_desc_grandchild")
      const sibling = SessionSchema.ID.make("ses_attachment_desc_sibling")
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make("/tmp/attach-desc"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      for (const [id, slug] of [
        [parent, "desc"],
        [child, "desc-child"],
        [grandchild, "desc-grandchild"],
        [sibling, "desc-sibling"],
      ] as const)
        yield* seed(db, projectID, id, slug)

      const upload = yield* SessionAttachment.registerUpload(db, {
        sessionID: parent,
        messageID: "msg_parent_1",
        partID: "prt_parent_1",
        origin: "user-upload",
        mime: "image/png",
        bytes: encoder.encode("png"),
      })
      const [selected] = yield* SessionAttachment.resolveSelection(db, {
        handles: [upload.handle],
        scope: { kind: "index", sessionID: parent },
      })
      const taskTarget = (childSession: SessionSchema.ID, call: string): Contract.GrantTarget => ({
        kind: "task",
        sourceSessionID: parent,
        assistantMessageID: "msg_assistant",
        toolCallID: call,
        toolPartID: `prt_${call}`,
        childSessionID: childSession,
      })
      const parentGrant = yield* SessionAttachment.createGrant(db, {
        attachment: selected!,
        target: taskTarget(child, "call_child"),
        idempotencyKey: `${parent}:${child}:root`,
      })
      const descendantGrant = yield* SessionAttachment.createGrant(db, {
        attachment: selected!,
        target: taskTarget(grandchild, "call_grandchild"),
        idempotencyKey: `${parent}:${grandchild}:child`,
        parentGrantID: parentGrant.id,
      })
      const siblingGrant = yield* SessionAttachment.createGrant(db, {
        attachment: selected!,
        target: taskTarget(sibling, "call_sibling"),
        idempotencyKey: `${parent}:${sibling}:sibling`,
      })

      yield* SessionAttachment.revokeGrant(db, parentGrant.id, "scoped")

      expect((yield* SessionAttachment.checkGrant(db, parentGrant.id)).ok).toBe(false)
      expect((yield* SessionAttachment.checkGrant(db, descendantGrant.id)).ok).toBe(false)
      // The unrelated sibling grant is untouched.
      expect((yield* SessionAttachment.checkGrant(db, siblingGrant.id)).ok).toBe(true)
    }),
  )

  it.effect("expires stale grants by retention without deleting the upload", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const projectID = Project.ID.global
      const parent = SessionSchema.ID.make("ses_attachment_expire")
      const child = SessionSchema.ID.make("ses_attachment_expire_child")
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make("/tmp/attach-expire"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* seed(db, projectID, parent, "attachment-expire")
      yield* seed(db, projectID, child, "attachment-expire-child")

      const upload = yield* SessionAttachment.registerUpload(db, {
        sessionID: parent,
        messageID: "msg_parent_1",
        partID: "prt_parent_1",
        origin: "user-upload",
        mime: "image/png",
        bytes: encoder.encode("png"),
        now: 0,
      })
      const [selected] = yield* SessionAttachment.resolveSelection(db, {
        handles: [upload.handle],
        scope: { kind: "index", sessionID: parent },
      })
      const grant = yield* SessionAttachment.createGrant(db, {
        attachment: selected!,
        target: {
          kind: "task",
          sourceSessionID: parent,
          assistantMessageID: "msg_assistant",
          toolCallID: "call",
          toolPartID: "prt_call",
          childSessionID: child,
        },
        idempotencyKey: `${parent}:${child}:expire`,
        now: 0,
      })

      const expired = yield* SessionAttachment.expireStaleGrants(db, SessionAttachment.Policy.grantRetentionMs + 1)
      expect(expired).toBe(1)
      expect((yield* SessionAttachment.checkGrant(db, grant.id)).ok).toBe(false)
      // Bytes remain durable; only the grant expired.
      expect((yield* SessionAttachment.listForSession(db, parent)).length).toBe(1)
    }),
  )

  it.effect("records inclusion as a separate fact from authorization", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const projectID = Project.ID.global
      const parent = SessionSchema.ID.make("ses_attachment_status")
      const child = SessionSchema.ID.make("ses_attachment_status_child")
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make("/tmp/attach-status"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* seed(db, projectID, parent, "attachment-status")
      yield* seed(db, projectID, child, "attachment-status-child")

      const upload = yield* SessionAttachment.registerUpload(db, {
        sessionID: parent,
        messageID: "msg_parent_1",
        partID: "prt_parent_1",
        origin: "user-upload",
        mime: "image/png",
        bytes: encoder.encode("png"),
      })
      const [selected] = yield* SessionAttachment.resolveSelection(db, {
        handles: [upload.handle],
        scope: { kind: "index", sessionID: parent },
      })
      const grant = yield* SessionAttachment.createGrant(db, {
        attachment: selected!,
        target: {
          kind: "task",
          sourceSessionID: parent,
          assistantMessageID: "msg_assistant",
          toolCallID: "call",
          toolPartID: "prt_call",
          childSessionID: child,
        },
        idempotencyKey: `${parent}:${child}:status`,
      })

      // Freshly granted: authorized, not yet resolved or included.
      let statuses = yield* SessionAttachment.recipientStatuses(db, child)
      expect(statuses[0]!.status.authorized).toBe(true)
      expect(statuses[0]!.status.includedInProviderRequest).toBe(false)

      yield* SessionAttachment.recordInclusion(db, {
        grantID: grant.id,
        resolved: true,
        includedInProviderRequest: true,
        providerID: "provider-a",
        modelID: "model-a",
      })
      statuses = yield* SessionAttachment.recipientStatuses(db, child)
      expect(statuses[0]!.status.resolved).toBe(true)
      expect(statuses[0]!.status.includedInProviderRequest).toBe(true)
    }),
  )

  it.effect("returns a bounded index page independent of transcript length", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const projectID = Project.ID.global
      const session = SessionSchema.ID.make("ses_attachment_index")
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make("/tmp/attach-index"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* seed(db, projectID, session, "attachment-index")

      for (let i = 0; i < 7; i++) {
        yield* SessionAttachment.registerUpload(db, {
          sessionID: session,
          messageID: `msg_${i}`,
          partID: `prt_${i}`,
          origin: "user-upload",
          mime: "text/plain",
          filename: `f${i}.txt`,
          bytes: encoder.encode(`bytes-${i}`),
          now: 1000 + i,
        })
      }

      const first = yield* SessionAttachment.indexPage(db, { sessionID: session, limit: 3 })
      expect(first.items).toHaveLength(3)
      expect(first.nextCursor).toBeDefined()
      // Newest first.
      expect(first.items[0]!.filename).toBe("f6.txt")

      const second = yield* SessionAttachment.indexPage(db, {
        sessionID: session,
        limit: 3,
        cursor: first.nextCursor,
      })
      expect(second.items).toHaveLength(3)
      expect(second.items[0]!.filename).toBe("f3.txt")
    }),
  )

  test("classifies MIME eligibility from the allowlist", () => {
    expect(SessionAttachment.classifyMime("image/png")).toBe("eligible")
    expect(SessionAttachment.classifyMime("application/zip")).toBe("unsupported-mime")
  })

  it.effect("binds a swarm grant to the exact task run and member session", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const projectID = Project.ID.global
      const coordinator = SessionSchema.ID.make("ses_attachment_swarm_coord")
      const member = SessionSchema.ID.make("ses_attachment_swarm_member")
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make("/tmp/attach-swarm"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* seed(db, projectID, coordinator, "attachment-swarm-coord")
      yield* seed(db, projectID, member, "attachment-swarm-member")

      const upload = yield* SessionAttachment.registerUpload(db, {
        sessionID: coordinator,
        messageID: "msg_coord_1",
        partID: "prt_coord_1",
        origin: "user-upload",
        mime: "application/pdf",
        filename: "spec.pdf",
        bytes: encoder.encode("%PDF-1.4"),
      })
      const [selected] = yield* SessionAttachment.resolveSelection(db, {
        handles: [upload.handle],
        scope: { kind: "index", sessionID: coordinator },
      })
      const target: Contract.GrantTarget = {
        kind: "swarm",
        taskID: "swt_1",
        runID: "swrn_1",
        sessionInputID: "msg_run_input_1" as never,
        memberSessionID: member,
      }
      const idempotencyKey = "swrn_1:upload-1"
      const first = yield* SessionAttachment.createGrant(db, { attachment: selected!, target, idempotencyKey })
      const retry = yield* SessionAttachment.createGrant(db, { attachment: selected!, target, idempotencyKey })
      // Delivery retry reuses the same immutable grant.
      expect(retry.id).toBe(first.id)

      // Resolution is scoped to the member session; a different session cannot see it.
      const memberGrants = yield* SessionAttachment.activeGrantsForChild(db, member)
      expect(memberGrants).toHaveLength(1)
      const otherGrants = yield* SessionAttachment.activeGrantsForChild(db, coordinator)
      expect(otherGrants).toHaveLength(0)

      const [resolved] = yield* SessionAttachment.resolveBytes(db, [first.id])
      expect(resolved?.url.startsWith("data:application/pdf;base64,")).toBe(true)
    }),
  )

  it.effect("renders a bounded manifest with current-turn and active-grant entries", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const projectID = Project.ID.global
      const parent = SessionSchema.ID.make("ses_attachment_manifest")
      const child = SessionSchema.ID.make("ses_attachment_manifest_child")
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make("/tmp/attach-manifest"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* seed(db, projectID, parent, "attachment-manifest")
      yield* seed(db, projectID, child, "attachment-manifest-child")

      const upload = yield* SessionAttachment.registerUpload(db, {
        sessionID: parent,
        messageID: "msg_turn_1",
        partID: "prt_turn_1",
        origin: "user-upload",
        mime: "image/png",
        filename: "diagram.png",
        bytes: encoder.encode("png"),
      })
      const manifest = yield* SessionAttachment.buildManifest(db, {
        sessionID: parent,
        currentTurnMessageID: "msg_turn_1",
        workerSessionID: child,
      })
      expect(manifest.currentTurn).toHaveLength(1)
      expect(manifest.activeGrants).toHaveLength(0)
      expect(manifest.currentTurn[0]!.handle).toBe(upload.handle)
      const rendered = SessionAttachment.renderManifest(manifest)
      expect(rendered).toContain("upload-1")
      expect(rendered).toContain("diagram.png")
      // The rendered manifest is orchestration context and never inlines bytes.
      expect(rendered).not.toContain("base64")
    }),
  )
})
