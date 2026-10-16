import type { Session } from "@opencode-ai/sdk/v2/client"

type BackfillEntry = {
  directory: string
  session: Session
  aliases?: Map<string, Session>
}

// Server directory indexes may expose the SAME original Session object through
// multiple worktree/project aliases, including a missing directory field.
// A WeakMap<Session, Session> incorrectly stuck the FIRST caller's directory
// onto all subsequent aliases. Scope the cached projection to both the
// original identity and the requested directory; retain the single-entry
// fast path (no Map allocation) for the overwhelmingly common case.
const backfills = new WeakMap<Session, BackfillEntry>()

/** A reconciled Solid Session proxy may mutate in place without changing its
 * identity. A cached wrapper must invalidate when any sidebar-relevant scalar
 * changes, including the nested timestamp, model or token counts. */
function sameProjection(source: Session, projected: Session): boolean {
  return (
    source.id === projected.id &&
    source.slug === projected.slug &&
    source.projectID === projected.projectID &&
    source.workspaceID === projected.workspaceID &&
    source.path === projected.path &&
    source.parentID === projected.parentID &&
    source.title === projected.title &&
    source.agent === projected.agent &&
    source.version === projected.version &&
    source.humanInterjection === projected.humanInterjection &&
    source.cost === projected.cost &&
    source.pausedAt === projected.pausedAt &&
    source.time?.created === projected.time?.created &&
    source.time?.updated === projected.time?.updated &&
    source.time?.archived === projected.time?.archived &&
    source.time?.compacting === projected.time?.compacting &&
    source.summary?.additions === projected.summary?.additions &&
    source.summary?.deletions === projected.summary?.deletions &&
    source.summary?.files === projected.summary?.files &&
    source.summary?.diffs === projected.summary?.diffs &&
    source.tokens?.input === projected.tokens?.input &&
    source.tokens?.output === projected.tokens?.output &&
    source.tokens?.reasoning === projected.tokens?.reasoning &&
    source.tokens?.cache?.read === projected.tokens?.cache?.read &&
    source.tokens?.cache?.write === projected.tokens?.cache?.write &&
    source.share?.url === projected.share?.url &&
    source.model?.id === projected.model?.id &&
    source.model?.providerID === projected.model?.providerID &&
    source.model?.accountID === projected.model?.accountID &&
    source.model?.variant === projected.model?.variant &&
    source.model?.routeIntent === projected.model?.routeIntent &&
    source.metadata === projected.metadata &&
    source.permission === projected.permission &&
    source.revert === projected.revert
  )
}

function snapshot(source: Session, directory: string): Session {
  return {
    ...source,
    directory,
    time: source.time ? { ...source.time } : source.time,
    summary: source.summary ? { ...source.summary } : undefined,
    tokens: source.tokens ? { ...source.tokens, cache: { ...source.tokens.cache } } : undefined,
    share: source.share ? { ...source.share } : undefined,
    model: source.model ? { ...source.model } : undefined,
  }
}

export function withChatSidebarDirectory(session: Session, directory: string): Session {
  if (session.directory) return session
  const entry = backfills.get(session)
  if (entry?.directory === directory && sameProjection(session, entry.session)) return entry.session
  const alias = entry?.aliases?.get(directory)
  if (alias && sameProjection(session, alias)) return alias
  const wrapped = snapshot(session, directory)
  if (!entry) {
    backfills.set(session, { directory, session: wrapped })
    return wrapped
  }
  if (entry.directory === directory) {
    entry.session = wrapped
    return wrapped
  }
  entry.aliases ??= new Map()
  entry.aliases.set(directory, wrapped)
  return wrapped
}