import { Effect, Schema } from "effect"
import fs from "node:fs/promises"
import path from "path"
import { and, asc, desc, eq, inArray } from "drizzle-orm"
import { Hash } from "@opencode-ai/core/util/hash"
import { Database } from "@opencode-ai/core/database/database"
import { SessionCheckpointTable, SessionTable } from "@opencode-ai/core/session/sql"
import { InstanceState } from "@/effect/instance-state"
import { Snapshot } from "@/snapshot"
import { TurnCheckpoint } from "@/session/checkpoint"
import * as Tool from "./tool"
import DESCRIPTION from "./checkpoint.txt"

export const Parameters = Schema.Struct({
  mode: Schema.optional(
    Schema.Literals(["help", "list", "search", "view", "diff", "restore"]),
  ).annotate({ description: "Operation to run (default: list)" }),
  query: Schema.optional(Schema.String).annotate({
    description: "search: free text matched against paths, session title/agent, and message IDs",
  }),
  touchedPath: Schema.optional(Schema.String).annotate({
    description: "search: only checkpoints whose diff includes this path (exact or path-suffix match)",
  }),
  status: Schema.optional(
    Schema.Literals(["capturing", "ready", "partial", "aborted", "error"]),
  ).annotate({ description: "list/search: filter by checkpoint status" }),
  kind: Schema.optional(Schema.Literals(["turn", "manual", "pre-revert", "baseline"])).annotate({
    description: "list/search: filter by checkpoint kind",
  }),
  ordinal: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 }))).annotate({
    description: "view/diff/restore: ordinal in a session timeline. Ambiguous across sessions — pair with from, or use checkpointID.",
  }),
  checkpointID: Schema.optional(Schema.String).annotate({
    description: "view/diff/restore: globally unique checkpoint id (the only safe pointer to another session's checkpoint)",
  }),
  from: Schema.optional(Schema.String).annotate({
    description: "Session id (or unique prefix) whose timeline to use. Omit = this chat. list/search/view/diff/restore.",
  }),
  across: Schema.optional(Schema.Literals(["session", "worktree"])).annotate({
    description:
      'list/search breadth. session = this chat (list default). worktree = every session on this disk (search default). Isolated worktrees are not restorable here.',
  }),
  scope: Schema.optional(Schema.Literals(["turn", "session"])).annotate({
    description: 'diff: "turn" = this checkpoint\'s own changes (default); "session" = everything up to it in THAT session',
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))).annotate({
    description: "list/search: max entries (default 50)",
  }),
  maxBytes: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 2000, maximum: 500_000 }))).annotate({
    description: "Output cap in bytes (default 80000, max 500000)",
  }),
  dryRun: Schema.optional(Schema.Boolean).annotate({
    description: "restore: preview without touching files (default true)",
  }),
  confirm: Schema.optional(Schema.Literals(["RESTORE_CHECKPOINT"])).annotate({
    description: 'restore: required to apply — pass confirm:"RESTORE_CHECKPOINT"',
  }),
})

type Metadata = {
  mode: string
  ok: boolean
  count?: number
  truncated?: boolean
  changed?: boolean
  restored?: boolean
  safetyOrdinal?: number
  foreign?: boolean
  fromSession?: string
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

const RESTORABLE = new Set(["ready", "partial", "aborted"])

type Row = typeof SessionCheckpointTable.$inferSelect
type SessionMeta = { id: string; title: string; agent: string | null }

function shortId(id: string): string {
  return id.slice(0, 8)
}

function renderRow(row: Row, meta: SessionMeta | undefined, mine: string): string {
  const paths = (row.diff ?? []).map((d) => d.path)
  const shown = paths.slice(0, 3).join(", ")
  const more = paths.length > 3 ? ` +${paths.length - 3} more` : ""
  const pathBit = shown ? `\n    paths: ${escapeXml(shown)}${more}` : ""
  const foreign = row.session_id !== mine
  const sessionBit = foreign
    ? ` session="${escapeXml(row.session_id)}" title="${escapeXml(meta?.title ?? "")}" agent="${escapeXml(meta?.agent ?? "-")}" mine="false"`
    : ""
  return `  <cp ordinal="${row.ordinal}" id="${row.id}" status="${row.status}" kind="${row.kind}" files="${row.files}" add="+${row.additions}" del="-${row.deletions}" msg="${escapeXml(row.user_message_id ?? "-")}"${sessionBit}${pathBit} />`
}

const HINT =
  '<hint>this session: mode:"view" ordinal:N · another session: mode:"search" across:"worktree" then mode:"restore" checkpointID:"…" (never ordinal alone) · preview first</hint>'

export const CheckpointTool = Tool.define<typeof Parameters, Metadata, Database.Service | Snapshot.Service | TurnCheckpoint.Service>(
  "checkpoint",
  Effect.gen(function* () {
    const database = yield* Database.Service
    const snapshot = yield* Snapshot.Service
    const turnCheckpoint = yield* TurnCheckpoint.Service
    const { db } = database

    const sessionRows = Effect.fn("CheckpointTool.sessionRows")(function* (sessionID: string) {
      return yield* db
        .select()
        .from(SessionCheckpointTable)
        .where(eq(SessionCheckpointTable.session_id, sessionID as Row["session_id"]))
        .orderBy(asc(SessionCheckpointTable.ordinal))
        .all()
        .pipe(Effect.orDie)
    })

    const currentEpoch = Effect.fn("CheckpointTool.currentEpoch")(function* () {
      const ctx = yield* InstanceState.context
      return Hash.fast(`${ctx.project.id}:${ctx.worktree}`)
    })

    const worktreeRows = Effect.fn("CheckpointTool.worktreeRows")(function* () {
      const epoch = yield* currentEpoch()
      return yield* db
        .select()
        .from(SessionCheckpointTable)
        .where(eq(SessionCheckpointTable.epoch, epoch))
        .orderBy(desc(SessionCheckpointTable.created_at))
        .all()
        .pipe(Effect.orDie)
    })

    const loadSessionMeta = Effect.fn("CheckpointTool.loadSessionMeta")(function* (ids: string[]) {
      const unique = [...new Set(ids)]
      if (unique.length === 0) return new Map<string, SessionMeta>()
      const rows = yield* db
        .select({
          id: SessionTable.id,
          title: SessionTable.title,
          agent: SessionTable.agent,
        })
        .from(SessionTable)
        .where(inArray(SessionTable.id, unique as any))
        .all()
        .pipe(Effect.orDie)
      return new Map(rows.map((row) => [row.id as string, { id: row.id as string, title: row.title, agent: row.agent }]))
    })

    const resolveFrom = Effect.fn("CheckpointTool.resolveFrom")(function* (from: string | undefined, mine: string) {
      if (!from) return mine
      if (from === mine) return mine
      const sessions = yield* db.select({ id: SessionTable.id }).from(SessionTable).all().pipe(Effect.orDie)
      const hits = sessions.filter((s) => s.id === from || (s.id as string).startsWith(from))
      if (hits.length === 1) return hits[0].id as string
      if (hits.length === 0) throw new Error(`No session matches from="${from}". Use a session id (or unique prefix).`)
      throw new Error(
        `from="${from}" is ambiguous (${hits.length} sessions). Use a longer prefix. Candidates: ${hits
          .slice(0, 8)
          .map((s) => s.id)
          .join(", ")}`,
      )
    })

    const resolveTarget = Effect.fn("CheckpointTool.resolveTarget")(function* (
      mine: string,
      params: { ordinal?: number; checkpointID?: string; from?: string },
      action: string,
    ) {
      if (params.checkpointID) {
        const all = yield* db.select().from(SessionCheckpointTable).all().pipe(Effect.orDie)
        const hits = all.filter((r) => r.id === params.checkpointID || r.id.startsWith(params.checkpointID!))
        if (hits.length === 0) {
          throw new Error(`No checkpoint id matches "${params.checkpointID}". Search across:"worktree" to list restorable ids.`)
        }
        if (hits.length > 1) {
          throw new Error(
            `checkpointID "${params.checkpointID}" is ambiguous (${hits.length} hits). Use the full id. Matches: ${hits
              .slice(0, 5)
              .map((r) => r.id)
              .join(", ")}`,
          )
        }
        const hit = hits[0]
        if (params.from) {
          const from = yield* resolveFrom(params.from, mine)
          if (hit.session_id !== from) {
            throw new Error(`Checkpoint ${hit.id} belongs to session ${hit.session_id}, not from="${from}".`)
          }
        }
        return hit
      }

      const sessionID = yield* resolveFrom(params.from, mine)
      const rows = yield* sessionRows(sessionID)
      if (rows.length === 0) {
        throw new Error(
          sessionID === mine
            ? `No checkpoints exist yet for this session — they appear after your first turn completes. Nothing to ${action}.`
            : `Session ${sessionID} has no checkpoints. Nothing to ${action}.`,
        )
      }
      if (params.ordinal === undefined) {
        throw new Error(
          `Specify checkpointID (required for another session) or ordinal (this session / from=). Valid ordinals here: ${rows.map((r) => r.ordinal).join(", ")}.`,
        )
      }
      const row = rows.find((r) => r.ordinal === params.ordinal)
      if (!row) {
        throw new Error(
          `No checkpoint matches ordinal ${params.ordinal} in session ${sessionID}. Valid ordinals: ${rows.map((r) => r.ordinal).join(", ")}. Foreign sessions: use checkpointID, never ordinal alone.`,
        )
      }
      return row
    })

    const assertRestorable = Effect.fn("CheckpointTool.assertRestorable")(function* (row: Row) {
      if (!RESTORABLE.has(row.status)) {
        throw new Error(
          `Checkpoint ${row.ordinal} has status "${row.status}" — only ready/partial/aborted checkpoints can be restored.`,
        )
      }
      if (!row.after_snapshot) {
        throw new Error(`Checkpoint ${row.ordinal} has no captured after-state to restore.`)
      }
      const epoch = yield* currentEpoch()
      if (row.epoch !== epoch) {
        throw new Error(
          `Refusing to restore checkpoint ${row.id}: it was captured against a different worktree identity. Isolated-agent trees cannot be checked out onto this disk.`,
        )
      }
    })

    const renderPatches = Effect.fn("CheckpointTool.renderPatches")(function* (
      diffs: readonly { file?: string; patch?: string }[],
      maxBytes: number,
    ) {
      const parts: string[] = []
      let used = 0
      let truncated = false
      for (let i = 0; i < diffs.length; i++) {
        const d = diffs[i]!
        const block = `<file path="${escapeXml(d.file ?? "")}">\n${escapeXml(d.patch ?? "(binary or empty)")}\n</file>`
        if (used + block.length > maxBytes && parts.length > 0) {
          truncated = true
          parts.push(`<truncated remaining="${diffs.length - i}" bytes="${maxBytes}" />`)
          break
        }
        parts.push(block.length > maxBytes ? `${block.slice(0, maxBytes)}…[file truncated]` : block)
        used += Math.min(block.length, maxBytes)
      }
      return { text: parts.join("\n"), truncated }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const mine = ctx.sessionID as unknown as string
          const mode = params.mode ?? "list"
          const maxBytes = params.maxBytes ?? 80_000
          const across = params.across ?? (mode === "search" ? "worktree" : "session")

          const render = (output: string, extra: Partial<Metadata> = {}): Tool.ExecuteResult<Metadata> => ({
            title: `checkpoint ${mode}`,
            output,
            metadata: { mode, ok: true, ...extra },
          })

          if (mode === "help") return render(DESCRIPTION)

          if (mode === "list" || mode === "search") {
            const target = params.from ? yield* resolveFrom(params.from, mine) : mine
            let rows =
              across === "worktree" && !params.from ? yield* worktreeRows() : yield* sessionRows(target)
            if (params.status) rows = rows.filter((r) => r.status === params.status)
            if (params.kind) rows = rows.filter((r) => r.kind === params.kind)
            if (mode === "search") {
              if (across !== "worktree" || params.from) rows = [...rows].reverse()
              const q = params.query?.toLowerCase()
              const t = params.touchedPath?.replaceAll("\\", "/")
              const meta = yield* loadSessionMeta(rows.map((r) => r.session_id))
              rows = rows.filter((row) => {
                const paths = (row.diff ?? []).map((d) => d.path.replaceAll("\\", "/"))
                if (t) {
                  const hit = paths.some((p) => p === t || p.endsWith(`/${t}`) || t.endsWith(`/${p}`))
                  if (!hit) return false
                }
                if (q) {
                  const info = meta.get(row.session_id)
                  const haystack =
                    `${paths.join("\n")}\n${row.user_message_id ?? ""}\n${row.kind} ${row.status} ${row.ordinal} ${row.session_id} ${info?.title ?? ""} ${info?.agent ?? ""}`.toLowerCase()
                  if (!haystack.includes(q)) return false
                }
                return true
              })
            }
            const limited = rows.slice(0, params.limit ?? 50)
            const meta = yield* loadSessionMeta(limited.map((r) => r.session_id))
            if (limited.length === 0) {
              const anyMine = yield* sessionRows(mine)
              const anyTree = across === "worktree" ? yield* worktreeRows() : anyMine
              const why =
                anyTree.length === 0
                  ? "no checkpoints yet — they appear after a turn completes"
                  : "no checkpoints match your filters — loosen query/touchedPath/status/kind/across"
              return render(`<checkpoints count="0" across="${across}">\n  ${why}\n</checkpoints>\n${HINT}`, { count: 0 })
            }
            const body = limited.map((row) => renderRow(row, meta.get(row.session_id), mine)).join("\n")
            let footer = ""
            if (mode === "list" && across === "session" && !params.from) {
              const tree = yield* worktreeRows()
              const others = tree.filter((r) => r.session_id !== mine)
              const otherSessions = new Set(others.map((r) => r.session_id)).size
              if (otherSessions > 0) {
                footer = `\n  <other sessions="${otherSessions}" checkpoints="${others.length}" hint="across:&quot;worktree&quot; to inspect them. Restore foreign cps by checkpointID, never ordinal." />`
              }
            }
            return render(
              `<checkpoints count="${limited.length}" across="${across}"${rows.length > limited.length ? ` total="${rows.length}"` : ""}>\n${body}${footer}\n</checkpoints>\n${HINT}`,
              { count: limited.length },
            )
          }

          const row = yield* resolveTarget(mine, params, mode)
          const foreign = row.session_id !== mine
          const [info] = [...(yield* loadSessionMeta([row.session_id])).values()]

          if (mode === "view") {
            const paths = (row.diff ?? []).map((d) => d.path)
            const excluded = (row.excluded ?? []).map((e) => e.path)
            const body = [
              `  <ordinal>${row.ordinal}</ordinal>`,
              `  <id>${row.id}</id>`,
              `  <session id="${escapeXml(row.session_id)}" title="${escapeXml(info?.title ?? "")}" agent="${escapeXml(info?.agent ?? "-")}" mine="${foreign ? "false" : "true"}" />`,
              `  <status>${row.status}</status>`,
              `  <kind>${row.kind}</kind>`,
              `  <userMessage>${escapeXml(row.user_message_id ?? "-")}</userMessage>`,
              `  <changes files="${row.files}" additions="+${row.additions}" deletions="-${row.deletions}" />`,
              paths.length
                ? `  <files>\n${paths.map((p) => `    <path>${escapeXml(p)}</path>`).join("\n")}\n  </files>`
                : "  <files />",
              excluded.length
                ? `  <excluded note="too large for snapshots">\n${excluded.map((p) => `    <path>${escapeXml(p)}</path>`).join("\n")}\n  </excluded>`
                : "",
              row.error ? `  <error>${escapeXml(JSON.stringify(row.error))}</error>` : "",
              foreign
                ? `  <note>Foreign checkpoint. Restore with checkpointID="${row.id}" — ordinal ${row.ordinal} is meaningless in this chat.</note>`
                : "",
            ]
              .filter(Boolean)
              .join("\n")
            return render(`<checkpoint>\n${body}\n</checkpoint>\n${HINT}`, { foreign, fromSession: row.session_id })
          }

          if (mode === "diff") {
            const scope = params.scope ?? "turn"
            let fromTree: string | null
            let toTree: string | null
            if (scope === "turn") {
              fromTree = row.before_snapshot
              toTree = row.after_snapshot
            } else {
              const rows = yield* sessionRows(row.session_id)
              const first = rows[0]
              fromTree = first?.before_snapshot ?? first?.after_snapshot ?? null
              toTree = row.after_snapshot
            }
            if (!toTree || !fromTree) {
              return render(
                `<diff ordinal="${row.ordinal}" scope="${scope}" empty="true" />\n(nothing to diff — checkpoint status is "${row.status}"${row.status === "capturing" ? ", still in progress" : ""})`,
              )
            }
            const diffs = yield* snapshot.diffFull(fromTree, toTree).pipe(Effect.catch(() => Effect.succeed([] as Snapshot.FileDiff[])))
            if (diffs.length === 0) {
              return render(`<diff ordinal="${row.ordinal}" scope="${scope}" empty="true">\n  (no file changes)\n</diff>`)
            }
            const { text, truncated } = yield* renderPatches(diffs, maxBytes)
            return {
              ...render(
                `<diff ordinal="${row.ordinal}" id="${row.id}" session="${escapeXml(row.session_id)}" mine="${foreign ? "false" : "true"}" scope="${scope}" files="${diffs.length}" add="+${diffs.reduce((s, f) => s + (f.additions ?? 0), 0)}" del="-${diffs.reduce((s, f) => s + (f.deletions ?? 0), 0)}">\n${text}\n</diff>`,
                { truncated, foreign, fromSession: row.session_id },
              ),
            }
          }

          if (mode === "restore") {
            if (foreign && !params.checkpointID) {
              throw new Error(
                `Refusing to restore another session's checkpoint by ordinal. Session ${row.session_id} ordinal ${row.ordinal} is not this chat's ordinal ${row.ordinal}. Pass checkpointID="${row.id}".`,
              )
            }
            yield* assertRestorable(row)
            const target = row.after_snapshot!
            yield* turnCheckpoint.quiesce(ctx.sessionID)
            if (foreign) yield* turnCheckpoint.quiesce(row.session_id as typeof ctx.sessionID)
            const current = yield* snapshot.track()
            const preview = current
              ? yield* snapshot.diffFull(current, target).pipe(Effect.catch(() => Effect.succeed([] as Snapshot.FileDiff[])))
              : []
            const willDelete = preview.filter((d) => d.status === "deleted")
            const siblings = (yield* worktreeRows()).filter((r) => r.session_id !== mine && r.session_id !== row.session_id)
            const siblingSessions = [...new Set(siblings.map((r) => r.session_id))]
            const sections = [
              `<restore-preview ordinal="${row.ordinal}" id="${row.id}" status="${row.status}" files="${preview.length}" add="+${preview.reduce((s, f) => s + (f.additions ?? 0), 0)}" del="-${preview.reduce((s, f) => s + (f.deletions ?? 0), 0)}">`,
              foreign
                ? `  <foreign session="${escapeXml(row.session_id)}" title="${escapeXml(info?.title ?? "")}" agent="${escapeXml(info?.agent ?? "-")}" note="not this chat — restore rewrites the SHARED worktree" />`
                : "  <foreign none=\"true\" />",
              siblingSessions.length
                ? `  <siblings note="other sessions on this worktree; their unsaved files will be overwritten">${siblingSessions.map(escapeXml).join(", ")}</siblings>`
                : "  <siblings none=\"true\" />",
              willDelete.length
                ? `  <willDelete note="these exist now but not at this checkpoint — they WILL be removed">\n${willDelete.map((d) => `    <path>${escapeXml(d.file ?? "")}</path>`).join("\n")}\n  </willDelete>`
                : "  <willDelete nothing=\"true\" />",
              preview.length
                ? `  <sample>${escapeXml(preview.slice(0, 8).map((d) => d.file ?? "").join(", "))}${preview.length > 8 ? ` +${preview.length - 8} more` : ""}</sample>`
                : "  <identical note=\"workspace already matches this checkpoint\" />",
              "</restore-preview>",
              'Apply with: mode:"restore" checkpointID:"' +
                row.id +
                '" dryRun:false confirm:"RESTORE_CHECKPOINT"' +
                "\nA pre-revert safety checkpoint is recorded on THIS session (undo = restore to that ordinal). Conversation history is never modified.",
            ].join("\n")

            if (params.dryRun !== false) {
              return render(sections, { changed: false, foreign, fromSession: row.session_id })
            }

            if (params.confirm !== "RESTORE_CHECKPOINT") {
              throw new Error(
                `Applying a restore requires confirm:"RESTORE_CHECKPOINT" (you provided ${params.confirm ? `"${params.confirm}"` : "none"}). Preview above was NOT applied.`,
              )
            }

            yield* ctx.ask({
              permission: "checkpoint",
              patterns: [`checkpoint:restore:${row.ordinal}`],
              always: [`checkpoint:restore:*`],
              metadata: { ordinal: row.ordinal, checkpointID: row.id, fromSession: row.session_id, foreign },
            })

            const safety = yield* turnCheckpoint.safetyPoint(ctx.sessionID)

            const instance = yield* InstanceState.context
            const { Global } = yield* Effect.promise(() => import("@opencode-ai/core/global"))
            const gitdirPath = path.join(
              Global.Path.data,
              "snapshot",
              instance.project.id,
              Hash.fast(instance.worktree),
            )
            for (const d of willDelete) {
              if (!d.file) continue
              yield* Effect.promise(() => fs.rm(path.join(instance.worktree, d.file!), { force: true })).pipe(
                Effect.catch(() => Effect.void),
              )
            }
            const readTree = yield* Effect.tryPromise(() =>
              Bun.$`git --git-dir ${gitdirPath} read-tree ${target}`.quiet(),
            ).pipe(Effect.catch(() => Effect.succeed(null)))
            const checkout = yield* Effect.tryPromise(() =>
              Bun.$`git --git-dir ${gitdirPath} --work-tree ${instance.worktree} checkout-index -a -f`.quiet(),
            ).pipe(Effect.catch(() => Effect.succeed(null)))
            if (!readTree || !checkout) {
              throw new Error(`Restore subprocesses failed (readTree=${!!readTree}, checkout=${!!checkout}). Workspace left unchanged.`)
            }

            const verified = yield* snapshot.track().pipe(Effect.catch(() => Effect.succeed(undefined)))

            return render(
              `<restored ordinal="${row.ordinal}" id="${row.id}" session="${escapeXml(row.session_id)}" mine="${foreign ? "false" : "true"}" files="${preview.length}"${
                safety ? ` safetyOrdinal="${safety.ordinal}"` : ' safety="unavailable"'
              }${verified === target ? ' verified="true"' : ''}>\n  Workspace restored to checkpoint ${row.id}. Conversation untouched.${
                safety ? `\n  Undo: mode:"restore" ordinal:${safety.ordinal}` : ""
              }\n</restored>`,
              { changed: true, restored: true, safetyOrdinal: safety?.ordinal, foreign, fromSession: row.session_id },
            )
          }

          throw new Error(`Unsupported mode: ${mode}`)
        }).pipe(Effect.orDie),
    }
  }),
)
