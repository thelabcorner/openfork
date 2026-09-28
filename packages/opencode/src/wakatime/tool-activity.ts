import { Effect } from "effect"
import * as path from "path"

import { CodingActivity } from "@opencode-ai/core/coding-activity"
import type { Hooks } from "@opencode-ai/plugin"

import type { EffectBridge } from "@/effect/bridge"

/**
 * Thin `tool.execute.after` producer adapter.
 *
 * Mutation tools already return the exact facts a heartbeat needs in their own
 * result metadata, so this adapter only projects that metadata onto
 * `CodingActivity`. It deliberately never re-reads files, never parses diff
 * text, and never derives a line count the tool did not report.
 *
 * This adapter is also pure projection code with no I/O at all: `plan` performs
 * no stat, realpath, Git, or directory walk, because the paths it reports are
 * already authoritative. A heartbeat must never cost a filesystem round trip,
 * and a relative result path with no authoritative base is dropped rather than
 * resolved against the host cwd.
 *
 * Truthfulness rules encoded here:
 * - `read` is already reported directly by the read tool. Reporting it again
 *   here would double-count every read, so this adapter is silent for it.
 * - `write` reports the path the tool actually wrote. A full-file write has no
 *   meaningful "lines changed", so no line count is claimed.
 * - `edit`/`patch`/`apply_patch` report only the counts their result metadata
 *   states, as a signed net delta (additions minus deletions) so a deletion-heavy
 *   edit reports a negative number exactly as it happened. A patch that was
 *   planned but not applied is not a write.
 * - Tools that orchestrate rather than mutate (bash, task, search, fetch, ...)
 *   are silent.
 */

export interface PluginContext {
  readonly directory: string
  readonly worktree: string
  readonly project?: unknown
}

export interface HookInput {
  readonly tool: string
  readonly sessionID: string
  readonly callID: string
}

export interface HookOutput {
  readonly metadata: unknown
}

interface Target {
  entity: string
  lineChanges: number | undefined
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const count = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0
  return Math.max(0, Math.trunc(value))
}

/**
 * Signed net line change exactly as the tool reported it: additions minus
 * deletions. This is the same arithmetic the shared exchange kernel and the
 * checkpoint finalizer use, so a deletion-heavy edit is negative rather than
 * inflated into a count of touched lines.
 */
const changed = (additions: unknown, deletions: unknown) => count(additions) - count(deletions)

const fileEntries = (value: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(value)) return []
  const entries: Record<string, unknown>[] = []
  for (const item of value) {
    const record = asRecord(item)
    if (record) entries.push(record)
  }
  return entries
}

/**
 * `write` reports the file it actually wrote. A whole-file write is not a line
 * diff, so no line count is claimed even when the tool reports diagnostics.
 */
function writeTarget(metadata: unknown): Target[] {
  const record = asRecord(metadata)
  if (record === undefined) return []
  const filepath = text(record["filepath"])
  if (filepath === undefined) return []
  return [{ entity: filepath, lineChanges: undefined }]
}

/** `edit` reports either a single `filediff` or a bulk `files` list. */
function editTarget(metadata: unknown): Target[] {
  const record = asRecord(metadata)
  if (record === undefined) return []
  const targets: Target[] = []

  const filediff = asRecord(record["filediff"])
  if (filediff !== undefined) {
    const file = text(filediff["file"])
    if (file !== undefined) {
      targets.push({ entity: file, lineChanges: changed(filediff["additions"], filediff["deletions"]) })
    }
  }

  for (const entry of fileEntries(record["files"])) {
    const filePath = text(entry["filePath"])
    if (filePath === undefined) continue
    targets.push({ entity: filePath, lineChanges: changed(entry["additions"], entry["deletions"]) })
  }

  return targets
}

/**
 * `patch` and `apply_patch` share one executor and one metadata shape. A plan
 * that was validated but not applied is not activity, so `applied` must be
 * exactly true.
 */
function patchTarget(metadata: unknown): Target[] {
  const record = asRecord(metadata)
  if (record === undefined || record["applied"] !== true) return []
  const targets: Target[] = []
  for (const entry of fileEntries(record["files"])) {
    const filePath = text(entry["filePath"])
    if (filePath === undefined) continue
    targets.push({ entity: filePath, lineChanges: changed(entry["additions"], entry["deletions"]) })
  }
  return targets
}

const TARGETS = new Map<string, (metadata: unknown) => Target[]>([
  ["write", writeTarget],
  ["edit", editTarget],
  ["patch", patchTarget],
  ["apply_patch", patchTarget],
])

/**
 * Read is intentionally absent: the read tool already records it directly, so
 * reporting it here would double-count every read.
 */
export const REPORTED_TOOLS = [...TARGETS.keys()]

export function supports(tool: string): boolean {
  return TARGETS.has(tool)
}

/**
 * The authoritative base for a relative result path.
 *
 * `context.directory` is the executing instance's own root, so it is the base.
 * `worktree` is only consulted when `directory` is absent, and never when it
 * carries the non-VCS `"/"` sentinel: that value matches any absolute path, so
 * resolving against it would be meaningless. A base must be a real absolute
 * directory; the host cwd is never a fallback.
 */
function baseDirectory(context: PluginContext): string | undefined {
  for (const candidate of [context.directory, context.worktree]) {
    const value = text(candidate)
    if (value === undefined || value === "/" || !path.isAbsolute(value)) continue
    return value
  }
  return undefined
}

/**
 * Absolute, lexically normalized entity path. Pure: no filesystem access.
 *
 * The tool's result metadata is authoritative, so this only normalizes spelling
 * (`..`, `.`, separators, duplicates) — it never re-derives the entity from disk,
 * which is what `FSUtil.normalizePath` would do on Windows via `realpathSync`.
 * An absolute target keeps its own absolute semantics; a relative one needs an
 * authoritative base or it names nothing.
 */
function canonical(target: string, context: PluginContext): string | undefined {
  const value = text(target)
  if (value === undefined) return undefined
  if (path.isAbsolute(value)) return path.resolve(value)
  const base = baseDirectory(context)
  if (base === undefined) return undefined
  return path.resolve(base, value)
}

const projectName = (context: PluginContext): string | undefined => {
  const named = asRecord(context.project)
  const name = named === undefined ? undefined : text(named["name"])
  if (name !== undefined) return name
  const fallback = path.basename(context.worktree) || path.basename(context.directory)
  return text(fallback)
}

/**
 * The canonical absolute project folder this plugin context proves.
 *
 * `worktree` is the executing instance's own root, so it is the one directory
 * this adapter is entitled to name — with one exception. A non-VCS/global
 * instance carries the `"/"` sentinel in `worktree` (see `Project.fromDirectory`
 * and `containsPath` in `@/project/instance-context`): it matches any absolute
 * path, so it names no directory at all and must never be reported as one. In
 * that case `directory` is the only real root. Otherwise the worktree wins, and
 * `directory` remains the fallback for a context that carries no worktree.
 *
 * Because the folder comes from the instance and not from the entity, a file
 * sitting directly in the root and a file nested several directories under it
 * report one identical folder.
 *
 * A relative root names nothing and is rejected rather than resolved against the
 * host cwd: a cwd fallback would attribute activity to whatever process happened
 * to launch, which is the exact truthfulness failure this adapter avoids. The
 * display name above stays a separate field and is never turned into this.
 *
 * Stamping a folder is pure O(1) metadata on a value already in memory. This
 * therefore performs no filesystem discovery, and it deliberately does not reuse
 * `canonical`, whose normalization can touch the disk on some platforms.
 */
function projectFolder(context: PluginContext): string | undefined {
  const candidates = context.worktree === "/" ? [context.directory] : [context.worktree, context.directory]
  for (const candidate of candidates) {
    const base = text(candidate)
    if (base === undefined || !path.isAbsolute(base)) continue
    return path.resolve(base)
  }
  return undefined
}

/**
 * Project hook output onto `CodingActivity` inputs. Pure: no file access, no
 * Effect, no I/O. Returns nothing for read, for orchestration tools, for
 * unapplied patches, and for missing or malformed result metadata.
 */
export function plan(
  input: Pick<HookInput, "tool" | "sessionID" | "callID">,
  output: HookOutput,
  context: PluginContext,
): readonly CodingActivity.Input[] {
  const project = projectName(context)
  const folder = projectFolder(context)
  const targets = TARGETS.get(input.tool)
  if (targets === undefined) return []

  const merged = new Map<string, Target>()
  for (const target of targets(output.metadata)) {
    const entity = canonical(target.entity, context)
    if (entity === undefined) continue
    const existing = merged.get(entity)
    if (existing === undefined) {
      merged.set(entity, { entity, lineChanges: target.lineChanges })
      continue
    }
    if (existing.lineChanges === undefined && target.lineChanges === undefined) continue
    existing.lineChanges = (existing.lineChanges ?? 0) + (target.lineChanges ?? 0)
  }

  return [...merged.values()].map((target) => ({
    entity: target.entity,
    kind: "write",
    aiSession: input.sessionID,
    sourceRef: input.callID,
    source: "session",
    ...(project === undefined ? {} : { project }),
    ...(folder === undefined ? {} : { projectFolder: folder }),
    ...(target.lineChanges === undefined ? {} : { aiLineChanges: target.lineChanges }),
  }))
}

const record = (inputs: readonly CodingActivity.Input[]) =>
  Effect.forEach(inputs, (input) => CodingActivity.record(input), { discard: true }).pipe(Effect.ignore)

/**
 * The `tool.execute.after` hook. `Plugin.trigger` dispatches by hook name, so
 * registering this makes it a producer without touching the plugin surface.
 * Recording is best-effort and must never fail a completed tool call.
 */
export function hooks(context: PluginContext, bridge: EffectBridge.Shape): Hooks {
  return {
    "tool.execute.after": async (input, output) => {
      const planned = plan(input, output, context)
      if (planned.length === 0) return
      try {
        await bridge.promise(record(planned))
      } catch {
        // Activity is telemetry. A heartbeat failure must not fail the tool.
      }
    },
  }
}

export * as ToolActivity from "./tool-activity"
