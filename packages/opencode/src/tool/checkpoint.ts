import { Effect, Schema } from "effect"
import fs from "node:fs/promises"
import path from "path"
import { Hash } from "@opencode-ai/core/util/hash"
import { Checkpoint } from "@opencode-ai/core/checkpoint"
import { InstanceState } from "@/effect/instance-state"
import { Snapshot } from "@/snapshot"
import { TurnCheckpoint } from "@/session/checkpoint"
import { Git } from "@/git"
import * as Utf8 from "@/util/utf8"
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

function shortId(id: string): string {
  return id.slice(0, 8)
}

function renderRow(row: Checkpoint.ReadSummary, mine: string): string {
  const paths = row.paths
  const shown = paths.slice(0, 3).join(", ")
  const more = row.files > paths.length ? ` +${row.files - paths.length} more` : ""
  const pathBit = shown ? `\n    paths: ${escapeXml(shown)}${more}` : ""
  const foreign = row.sessionID !== mine
  const sessionBit = foreign
    ? ` session="${escapeXml(row.sessionID)}" title="${escapeXml(row.sessionTitle ?? "")}" agent="${escapeXml(row.sessionAgent ?? "-")}" mine="false"`
    : ""
  return `  <cp ordinal="${row.ordinal}" id="${row.id}" status="${row.status}" kind="${row.kind}" files="${row.files}" add="+${row.additions}" del="-${row.deletions}" msg="${escapeXml(row.userMessageID ?? "-")}"${sessionBit}${pathBit} />`
}

function renderPatches(
  diffs: readonly { file?: string; patch?: string }[],
  maxBytes: number,
  totalFiles = diffs.length,
  producerTruncated = false,
  producerPatchTruncated = false,
  reportedMaxBytes = maxBytes,
) {
  const parts: string[] = []
  let used = 0
  let renderTruncated = false
  let partialCurrent = false
  let nextIndex = diffs.length

  // Reserve a worst-case marker so a late truncation never requires retracting
  // an already-emitted block. maxBytes is a UTF-8 byte budget, not UTF-16 units.
  const markerReserve = `<truncated current="true" remaining="${totalFiles}" bytes="${reportedMaxBytes}" />`
  const markerReserveBytes = Utf8.byteLength(markerReserve) + 1
  const contentBudget = Math.max(0, maxBytes - markerReserveBytes)

  for (let i = 0; i < diffs.length; i++) {
    const d = diffs[i]!
    const separator = parts.length > 0 ? "\n" : ""
    const separatorBytes = separator ? 1 : 0
    const open = `<file path="${escapeXml(d.file ?? "")}">\n`
    const patch = escapeXml(d.patch ?? "(binary or empty)")
    const close = "\n</file>"
    const block = open + patch + close
    const blockBytes = Utf8.byteLength(block)

    if (used + separatorBytes + blockBytes <= contentBudget) {
      parts.push(separator + block)
      used += separatorBytes + blockBytes
      continue
    }

    renderTruncated = true
    nextIndex = i
    const available = Math.max(0, contentBudget - used - separatorBytes)
    const fileMarker = "\n…[file truncated]"
    const fixed = open + fileMarker + close
    const fixedBytes = Utf8.byteLength(fixed)
    if (available >= fixedBytes) {
      const cut = Utf8.truncate(patch, available - fixedBytes)
      parts.push(separator + open + cut.text + fileMarker + close)
      used += separatorBytes + fixedBytes + cut.bytes
      partialCurrent = true
      nextIndex = i + 1
    }
    break
  }

  const truncated = renderTruncated || producerTruncated
  if (truncated) {
    const current = partialCurrent || (!renderTruncated && producerPatchTruncated)
    const remaining = Math.max(0, totalFiles - nextIndex)
    const marker = `<truncated${current ? ' current="true"' : ""} remaining="${remaining}" bytes="${reportedMaxBytes}" />`
    const separator = parts.length > 0 ? "\n" : ""
    const remainingBudget = Math.max(0, maxBytes - used - (separator ? 1 : 0))
    const cut = Utf8.truncate(marker, remainingBudget)
    parts.push(separator + cut.text)
    used += (separator ? 1 : 0) + cut.bytes
  }

  return { text: parts.join(""), truncated, bytes: used }
}

const HINT =
  '<hint>this session: mode:"view" ordinal:N · another session: mode:"search" across:"worktree" then mode:"restore" checkpointID:"…" (never ordinal alone) · preview first</hint>'

export const CheckpointTool = Tool.define<
  typeof Parameters,
  Metadata,
  Checkpoint.ReadService | Snapshot.Service | TurnCheckpoint.Service | Git.Service
>(
  "checkpoint",
  Effect.gen(function* () {
    const checkpoint = yield* Checkpoint.ReadService
    const snapshot = yield* Snapshot.Service
    const turnCheckpoint = yield* TurnCheckpoint.Service
    const git = yield* Git.Service

    const currentEpoch = Effect.fn("CheckpointTool.currentEpoch")(function* () {
      const ctx = yield* InstanceState.context
      return Hash.fast(`${ctx.project.id}:${ctx.worktree}`)
    })

    const resolveFrom = Effect.fn("CheckpointTool.resolveFrom")(function* (from: string | undefined, mine: string) {
      if (!from) return mine
      if (from === mine) return mine
      const hits = yield* checkpoint.resolveSession(from)
      if (hits.length === 1) return hits[0]!
      if (hits.length === 0) throw new Error(`No session matches from="${from}". Use a session id (or unique prefix).`)
      throw new Error(
        `from="${from}" is ambiguous (${hits.length >= 9 ? "at least 9" : hits.length} sessions). Use a longer prefix. Candidates: ${hits
          .slice(0, 8)
          .join(", ")}`,
      )
    })

    const resolveTarget = Effect.fn("CheckpointTool.resolveTarget")(function* (
      mine: string,
      params: { ordinal?: number; checkpointID?: string; from?: string },
      action: string,
    ) {
      if (params.checkpointID) {
        const hits = yield* checkpoint.resolveCheckpoint(params.checkpointID)
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
        const hit = hits[0]!
        if (params.from) {
          const from = yield* resolveFrom(params.from, mine)
          if (hit.sessionID !== from) {
            throw new Error(`Checkpoint ${hit.id} belongs to session ${hit.sessionID}, not from="${from}".`)
          }
        }
        return hit
      }

      const sessionID = yield* resolveFrom(params.from, mine)
      if (params.ordinal === undefined) {
        const ordinals = yield* checkpoint.ordinals(sessionID)
        if (ordinals.length === 0) {
          throw new Error(
            sessionID === mine
              ? `No checkpoints exist yet for this session — they appear after your first turn completes. Nothing to ${action}.`
              : `Session ${sessionID} has no checkpoints. Nothing to ${action}.`,
          )
        }
        throw new Error(
          `Specify checkpointID (required for another session) or ordinal (this session / from=). Valid ordinals here: ${ordinals.join(", ")}.`,
        )
      }
      const row = yield* checkpoint.targetByOrdinal(sessionID, params.ordinal)
      if (!row) {
        const ordinals = yield* checkpoint.ordinals(sessionID)
        if (ordinals.length === 0) {
          throw new Error(
            sessionID === mine
              ? `No checkpoints exist yet for this session — they appear after your first turn completes. Nothing to ${action}.`
              : `Session ${sessionID} has no checkpoints. Nothing to ${action}.`,
          )
        }
        throw new Error(
          `No checkpoint matches ordinal ${params.ordinal} in session ${sessionID}. Valid ordinals: ${ordinals.join(", ")}. Foreign sessions: use checkpointID, never ordinal alone.`,
        )
      }
      return row
    })

    const assertRestorable = Effect.fn("CheckpointTool.assertRestorable")(function* (row: Checkpoint.ReadTarget) {
      if (!RESTORABLE.has(row.status)) {
        throw new Error(
          `Checkpoint ${row.ordinal} has status "${row.status}" — only ready/partial/aborted checkpoints can be restored.`,
        )
      }
      if (!row.afterSnapshot) {
        throw new Error(`Checkpoint ${row.ordinal} has no captured after-state to restore.`)
      }
      const epoch = yield* currentEpoch()
      if (row.epoch !== epoch) {
        throw new Error(
          `Refusing to restore checkpoint ${row.id}: it was captured against a different worktree identity. Isolated-agent trees cannot be checked out onto this disk.`,
        )
      }
    })

    return {
      exposure: "lazy" as const,
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
            const scope: Checkpoint.ReadScope =
              across === "worktree" && !params.from ? { epoch: yield* currentEpoch() } : { sessionID: target }
            const input = {
              scope,
              status: params.status,
              kind: params.kind,
              limit: params.limit ?? 50,
            } satisfies Checkpoint.ReadListInput
            const page =
              mode === "search"
                ? yield* checkpoint.search({
                    ...input,
                    query: params.query,
                    touchedPath: params.touchedPath,
                  })
                : yield* checkpoint.list(input)
            const rows = page.rows
            if (rows.length === 0) {
              const why =
                !(yield* checkpoint.exists(scope))
                  ? "no checkpoints yet — they appear after a turn completes"
                  : "no checkpoints match your filters — loosen query/touchedPath/status/kind/across"
              return render(`<checkpoints count="0" across="${across}">\n  ${why}\n</checkpoints>\n${HINT}`, { count: 0 })
            }
            const body = rows.map((row) => renderRow(row, mine)).join("\n")
            let footer = ""
            if (mode === "list" && across === "session" && !params.from) {
              const stats = yield* checkpoint.worktreeStats(yield* currentEpoch(), mine)
              if (stats.sessions > 0) {
                footer = `\n  <other sessions="${stats.sessions}" checkpoints="${stats.checkpoints}" hint="across:&quot;worktree&quot; to inspect them. Restore foreign cps by checkpointID, never ordinal." />`
              }
            }
            return render(
              `<checkpoints count="${rows.length}" across="${across}"${page.total > rows.length ? ` total="${page.total}"` : ""}>\n${body}${footer}\n</checkpoints>\n${HINT}`,
              { count: rows.length },
            )
          }

          const row = yield* resolveTarget(mine, params, mode)
          const foreign = row.sessionID !== mine

          if (mode === "view") {
            const detail = yield* checkpoint.view(row.id)
            if (!detail) throw new Error(`Checkpoint ${row.id} disappeared while being viewed.`)
            const paths = detail.paths
            const excluded = detail.excluded.map((e) => e.path)
            const body = [
              `  <ordinal>${row.ordinal}</ordinal>`,
              `  <id>${row.id}</id>`,
              `  <session id="${escapeXml(row.sessionID)}" title="${escapeXml(detail.sessionTitle ?? "")}" agent="${escapeXml(detail.sessionAgent ?? "-")}" mine="${foreign ? "false" : "true"}" />`,
              `  <status>${row.status}</status>`,
              `  <kind>${row.kind}</kind>`,
              `  <userMessage>${escapeXml(row.userMessageID ?? "-")}</userMessage>`,
              `  <changes files="${row.files}" additions="+${row.additions}" deletions="-${row.deletions}" />`,
              paths.length
                ? `  <files>\n${paths.map((p) => `    <path>${escapeXml(p)}</path>`).join("\n")}\n  </files>`
                : "  <files />",
              excluded.length
                ? `  <excluded note="too large for snapshots">\n${excluded.map((p) => `    <path>${escapeXml(p)}</path>`).join("\n")}\n  </excluded>`
                : "",
              detail.error ? `  <error>${escapeXml(JSON.stringify(detail.error))}</error>` : "",
              foreign
                ? `  <note>Foreign checkpoint. Restore with checkpointID="${row.id}" — ordinal ${row.ordinal} is meaningless in this chat.</note>`
                : "",
            ]
              .filter(Boolean)
              .join("\n")
            return render(`<checkpoint>\n${body}\n</checkpoint>\n${HINT}`, { foreign, fromSession: row.sessionID })
          }

          if (mode === "diff") {
            const scope = params.scope ?? "turn"
            let fromTree: string | null
            let toTree: string | null
            if (scope === "turn") {
              fromTree = row.beforeSnapshot
              toTree = row.afterSnapshot
            } else {
              const first = yield* checkpoint.firstSnapshots(row.sessionID)
              fromTree = first?.beforeSnapshot ?? first?.afterSnapshot ?? null
              toTree = row.afterSnapshot
            }
            if (!toTree || !fromTree) {
              return render(
                `<diff ordinal="${row.ordinal}" scope="${scope}" empty="true" />\n(nothing to diff — checkpoint status is "${row.status}"${row.status === "capturing" ? ", still in progress" : ""})`,
              )
            }
            const materialized = yield* snapshot.diffFullBounded(fromTree, toTree, maxBytes).pipe(
              Effect.catch(() =>
                Effect.succeed<Snapshot.BoundedDiff>({
                  summary: [],
                  diffs: [],
                  truncated: false,
                  patchTruncated: false,
                }),
              ),
            )
            const summary = materialized.summary
            if (summary.length === 0) {
              return render(`<diff ordinal="${row.ordinal}" scope="${scope}" empty="true">\n  (no file changes)\n</diff>`)
            }
            const additions = summary.reduce((sum, file) => sum + (file.additions ?? 0), 0)
            const deletions = summary.reduce((sum, file) => sum + (file.deletions ?? 0), 0)
            const open = `<diff ordinal="${row.ordinal}" id="${row.id}" session="${escapeXml(row.sessionID)}" mine="${foreign ? "false" : "true"}" scope="${scope}" files="${summary.length}" add="+${additions}" del="-${deletions}">\n`
            const close = "\n</diff>"
            const bodyBudget = Math.max(0, maxBytes - Utf8.byteLength(open) - Utf8.byteLength(close))
            const rendered = renderPatches(
              materialized.diffs,
              bodyBudget,
              summary.length,
              materialized.truncated,
              materialized.patchTruncated,
              maxBytes,
            )
            const output = open + rendered.text + close
            return {
              ...render(output, { truncated: rendered.truncated, foreign, fromSession: row.sessionID }),
            }
          }

          if (mode === "restore") {
            if (foreign && !params.checkpointID) {
              throw new Error(
                `Refusing to restore another session's checkpoint by ordinal. Session ${row.sessionID} ordinal ${row.ordinal} is not this chat's ordinal ${row.ordinal}. Pass checkpointID="${row.id}".`,
              )
            }
            yield* assertRestorable(row)
            const target = row.afterSnapshot!
            yield* turnCheckpoint.quiesce(ctx.sessionID)
            if (foreign) yield* turnCheckpoint.quiesce(row.sessionID as typeof ctx.sessionID)
            const current = yield* snapshot.track()
            const preview = current
              ? yield* snapshot
                  .diffSummary(current, target)
                  .pipe(Effect.catch(() => Effect.succeed([] as Snapshot.FileDiff[])))
              : []
            const willDelete = preview.filter((d) => d.status === "deleted")
            const ep = yield* currentEpoch()
            const siblingSessions = yield* checkpoint.siblingSessionIDs(ep, [mine, row.sessionID])
            const info = foreign ? yield* checkpoint.metadata(row.sessionID) : undefined
            const sections = [
              `<restore-preview ordinal="${row.ordinal}" id="${row.id}" status="${row.status}" files="${preview.length}" add="+${preview.reduce((s, f) => s + (f.additions ?? 0), 0)}" del="-${preview.reduce((s, f) => s + (f.deletions ?? 0), 0)}">`,
              foreign
                ? `  <foreign session="${escapeXml(row.sessionID)}" title="${escapeXml(info?.title ?? "")}" agent="${escapeXml(info?.agent ?? "-")}" note="not this chat — restore rewrites the SHARED worktree" />`
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
              return render(sections, { changed: false, foreign, fromSession: row.sessionID })
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
              metadata: { ordinal: row.ordinal, checkpointID: row.id, fromSession: row.sessionID, foreign },
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
            yield* Effect.forEach(
              willDelete,
              (d) =>
                d.file
                  ? Effect.promise(() => fs.rm(path.join(instance.worktree, d.file!), { force: true })).pipe(
                      Effect.catch(() => Effect.void),
                    )
                  : Effect.void,
              { concurrency: 8, discard: true },
            )
            const readTree = yield* git.run(["--git-dir", gitdirPath, "read-tree", target], { cwd: instance.worktree })
            const checkout = yield* git.run(
              ["--git-dir", gitdirPath, "--work-tree", instance.worktree, "checkout-index", "-a", "-f"],
              { cwd: instance.worktree },
            )
            if (readTree.exitCode !== 0 || checkout.exitCode !== 0) {
              throw new Error(
                `Restore subprocesses failed (readTree=${readTree.exitCode}, checkout=${checkout.exitCode}). Workspace left unchanged.`,
              )
            }

            const verified = yield* snapshot.track().pipe(Effect.catch(() => Effect.succeed(undefined)))

            return render(
              `<restored ordinal="${row.ordinal}" id="${row.id}" session="${escapeXml(row.sessionID)}" mine="${foreign ? "false" : "true"}" files="${preview.length}"${
                safety ? ` safetyOrdinal="${safety.ordinal}"` : ' safety="unavailable"'
              }${verified === target ? ' verified="true"' : ''}>\n  Workspace restored to checkpoint ${row.id}. Conversation untouched.${
                safety ? `\n  Undo: mode:"restore" ordinal:${safety.ordinal}` : ""
              }\n</restored>`,
              { changed: true, restored: true, safetyOrdinal: safety?.ordinal, foreign, fromSession: row.sessionID },
            )
          }

          throw new Error(`Unsupported mode: ${mode}`)
        }).pipe(Effect.orDie),
    }
  }),
)
