import { Effect, Schema } from "effect"
import fs from "node:fs/promises"
import path from "path"
import { and, asc, desc, eq } from "drizzle-orm"
import { Hash } from "@opencode-ai/core/util/hash"
import { Database } from "@opencode-ai/core/database/database"
import { SessionCheckpointTable } from "@opencode-ai/core/session/sql"
import { InstanceState } from "@/effect/instance-state"
import { Snapshot } from "@/snapshot"
import { TurnCheckpoint } from "@/session/checkpoint"
import * as Tool from "./tool"
import DESCRIPTION from "./checkpoint.txt"

// Agent-facing checkpoint tool. Read modes are permission-free and never touch
// git or the filesystem beyond reading the shared shadow repo. `restore` is the
// only mutating mode: dry-run preview by default, explicit confirm token,
// permission ask, automatic pre-revert safety point, filesystem-only scope.

export const Parameters = Schema.Struct({
  mode: Schema.optional(
    Schema.Literals(["help", "list", "search", "view", "diff", "restore"]),
  ).annotate({ description: "Operation to run (default: list)" }),
  query: Schema.optional(Schema.String).annotate({
    description: "search: free text matched against changed file paths and message IDs",
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
    description: "view/diff/restore: target checkpoint number from the timeline",
  }),
  checkpointID: Schema.optional(Schema.String).annotate({
    description: "view/diff/restore: target by full ID (ordinal preferred)",
  }),
  scope: Schema.optional(Schema.Literals(["turn", "session"])).annotate({
    description: 'diff: "turn" = this checkpoint\'s own changes (default); "session" = everything up to it',
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
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

const RESTORABLE = new Set(["ready", "partial", "aborted"])

type Row = typeof SessionCheckpointTable.$inferSelect

function shortId(id: string): string {
  return id.slice(0, 8)
}

/** Compact one-line timeline entry; paths come from the persisted diff cache (no git). */
function renderRow(row: Row): string {
  const paths = (row.diff ?? []).map((d) => d.path)
  const shown = paths.slice(0, 3).join(", ")
  const more = paths.length > 3 ? ` +${paths.length - 3} more` : ""
  const pathBit = shown ? `\n    paths: ${escapeXml(shown)}${more}` : ""
  return `  <cp ordinal="${row.ordinal}" id="${shortId(row.id)}" status="${row.status}" kind="${row.kind}" files="${row.files}" add="+${row.additions}" del="-${row.deletions}" msg="${escapeXml(row.user_message_id ?? "-")}"${pathBit} />`
}

const HINT =
  '<hint>next: mode:"view" ordinal:N · changes: mode:"diff" ordinal:N (scope:"session" for cumulative) · undo work: mode:"restore" ordinal:N (preview first)</hint>'

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

    /** Resolve a target with a helpful miss-error that lists valid ordinals. */
    const resolveTarget = Effect.fn("CheckpointTool.resolveTarget")(function* (
      sessionID: string,
      params: { ordinal?: number; checkpointID?: string },
      action: string,
    ) {
      const rows = yield* sessionRows(sessionID)
      if (rows.length === 0) {
        throw new Error(`No checkpoints exist yet for this session — they appear after your first turn completes. Nothing to ${action}.`)
      }
      const row = params.ordinal
        ? rows.find((r) => r.ordinal === params.ordinal)
        : params.checkpointID
          ? rows.find((r) => r.id === params.checkpointID || r.id.startsWith(params.checkpointID!))
          : undefined
      if (!row) {
        const ordinals = rows.map((r) => r.ordinal).join(", ")
        throw new Error(
          `No checkpoint matches ${params.ordinal ? `ordinal ${params.ordinal}` : `id "${params.checkpointID}"`}. Valid ordinals: ${ordinals}. Run mode:"list" to see the timeline.`,
        )
      }
      return row
    })

    const currentEpoch = Effect.fn("CheckpointTool.currentEpoch")(function* () {
      const ctx = yield* InstanceState.context
      return Hash.fast(`${ctx.project.id}:${ctx.worktree}`)
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
          `Refusing to restore checkpoint ${row.ordinal}: it was captured against a different worktree identity (the repository or worktree was recreated). Restoring it would corrupt the current workspace.`,
        )
      }
    })

    /** Budgeted per-file patch rendering; reports truncation. */
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
          const sessionID = ctx.sessionID as unknown as string
          const mode = params.mode ?? "list"
          const maxBytes = params.maxBytes ?? 80_000

          const render = (output: string, extra: Partial<Metadata> = {}): Tool.ExecuteResult<Metadata> => ({
            title: `checkpoint ${mode}`,
            output,
            metadata: { mode, ok: true, ...extra },
          })

          if (mode === "help") return render(DESCRIPTION)

          if (mode === "list" || mode === "search") {
            let rows = yield* sessionRows(sessionID)
            if (params.status) rows = rows.filter((r) => r.status === params.status)
            if (params.kind) rows = rows.filter((r) => r.kind === params.kind)
            if (mode === "search") {
              // Newest first: search answers "what did I do recently".
              rows = [...rows].reverse()
              const q = params.query?.toLowerCase()
              const t = params.touchedPath?.replaceAll("\\", "/")
              rows = rows.filter((row) => {
                const paths = (row.diff ?? []).map((d) => d.path.replaceAll("\\", "/"))
                if (t) {
                  const hit = paths.some((p) => p === t || p.endsWith(`/${t}`) || t.endsWith(`/${p}`))
                  if (!hit) return false
                }
                if (q) {
                  const haystack = `${paths.join("\n")}\n${row.user_message_id ?? ""}\n${row.kind} ${row.status} ${row.ordinal}`.toLowerCase()
                  if (!haystack.includes(q)) return false
                }
                return true
              })
            }
            const limited = rows.slice(0, params.limit ?? 50)
            if (limited.length === 0) {
              const anyRows = yield* sessionRows(sessionID)
              const why =
                anyRows.length === 0
                  ? "no checkpoints yet — they appear after your first turn completes"
                  : "no checkpoints match your filters — loosen query/touchedPath/status/kind"
              return render(`<checkpoints count="0">\n  ${why}\n</checkpoints>\n${HINT}`, { count: 0 })
            }
            const body = limited.map(renderRow).join("\n")
            return render(`<checkpoints count="${limited.length}"${rows.length > limited.length ? ` total="${rows.length}"` : ""}>\n${body}\n</checkpoints>\n${HINT}`, {
              count: limited.length,
            })
          }

          const row = yield* resolveTarget(sessionID, params, mode)

          if (mode === "view") {
            const paths = (row.diff ?? []).map((d) => d.path)
            const excluded = (row.excluded ?? []).map((e) => e.path)
            const body = [
              `  <ordinal>${row.ordinal}</ordinal>`,
              `  <id>${row.id}</id>`,
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
            ]
              .filter(Boolean)
              .join("\n")
            return render(`<checkpoint>\n${body}\n</checkpoint>\n${HINT}`)
          }

          if (mode === "diff") {
            const scope = params.scope ?? "turn"
            let fromTree: string | null
            let toTree: string | null
            if (scope === "turn") {
              fromTree = row.before_snapshot
              toTree = row.after_snapshot
            } else {
              const rows = yield* sessionRows(sessionID)
              const first = rows[0]
              // t3 §44: cumulative = FIRST BASELINE → selected after-tree, so
              // turn 1's own changes are included ("everything up to here").
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
                `<diff ordinal="${row.ordinal}" scope="${scope}" files="${diffs.length}" add="+${diffs.reduce((s, f) => s + (f.additions ?? 0), 0)}" del="-${diffs.reduce((s, f) => s + (f.deletions ?? 0), 0)}">\n${text}\n</diff>`,
                { truncated },
              ),
            }
          }

          if (mode === "restore") {
            yield* assertRestorable(row)
            const target = row.after_snapshot!
            // Never race an in-flight finalize for the shadow index.
            yield* turnCheckpoint.quiesce(ctx.sessionID)
            const current = yield* snapshot.track()
            const preview = current
              ? yield* snapshot.diffFull(current, target).pipe(Effect.catch(() => Effect.succeed([] as Snapshot.FileDiff[])))
              : []
            const willDelete = preview.filter((d) => d.status === "deleted")
            const sections = [
              `<restore-preview ordinal="${row.ordinal}" status="${row.status}" files="${preview.length}" add="+${preview.reduce((s, f) => s + (f.additions ?? 0), 0)}" del="-${preview.reduce((s, f) => s + (f.deletions ?? 0), 0)}">`,
              willDelete.length
                ? `  <willDelete note="these exist now but not at checkpoint ${row.ordinal} — they WILL be removed">\n${willDelete.map((d) => `    <path>${escapeXml(d.file ?? "")}</path>`).join("\n")}\n  </willDelete>`
                : "  <willDelete nothing=\"true\" />",
              preview.length
                ? `  <sample>${escapeXml(preview.slice(0, 8).map((d) => d.file ?? "").join(", "))}${preview.length > 8 ? ` +${preview.length - 8} more` : ""}</sample>`
                : "  <identical note=\"workspace already matches this checkpoint\" />",
              "</restore-preview>",
              'Apply with: mode:"restore" ordinal:' +
                `${row.ordinal} dryRun:false confirm:"RESTORE_CHECKPOINT"` +
                "\nA pre-revert safety checkpoint is recorded automatically on apply (undo = restore to that ordinal). Conversation history is never modified.",
            ].join("\n")

            if (params.dryRun !== false) {
              return render(sections, { changed: false })
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
              metadata: { ordinal: row.ordinal },
            })

            // Safety net FIRST so the restore itself is undoable (t3 §40.2).
            const safety = yield* turnCheckpoint.safetyPoint(ctx.sessionID)

            // Deterministic restore: remove files the target lacks (preview
            // flagged them), then materialize the target tree through the
            // shadow repo index.
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

            // Best-effort verification: re-capture and compare against target.
            const verified = yield* snapshot.track().pipe(Effect.catch(() => Effect.succeed(undefined)))

            return render(
              `<restored ordinal="${row.ordinal}" files="${preview.length}"${
                safety ? ` safetyOrdinal="${safety.ordinal}"` : ' safety="unavailable"'
              }${verified === target ? ' verified="true"' : ''}>\n  Workspace restored to checkpoint ${row.ordinal}. Conversation untouched.${
                safety ? `\n  Undo: mode:"restore" ordinal:${safety.ordinal}` : ""
              }\n</restored>`,
              { changed: true, restored: true, safetyOrdinal: safety?.ordinal },
            )
          }

          throw new Error(`Unsupported mode: ${mode}`)
        }).pipe(Effect.orDie),
    }
  }),
)
