import type { Session, SessionGroupMember } from "@opencode-ai/sdk/v2/client"

type MemberRevision = {
  id: string
  slug: string
  projectID: string
  directory: string
  parentID?: string
  title: string
  version: string
  created: number
  updated: number
  archived?: number
  session: Session
}

/**
 * The group roster is reconciled by Solid's store without changing the proxy
 * object identity when a member field changes. A WeakMap keyed by proxy alone
 * would return STALE titles/updated times. Validate every copied scalar first,
 * then return the old immutable Session projection only when it is unchanged.
 *
 * Weak keys ensure that disappearing group members do not leak cache entries.
 * Group membership/position/lock fields deliberately do not affect the Session
 * projection and do not force a row's runtime/DOM to be rebuilt.
 */
const projections = new WeakMap<SessionGroupMember, MemberRevision>()

export function sessionGroupMemberSession(member: SessionGroupMember): Session | undefined {
  const { slug, projectID, directory, parentID, title, version, time } = member
  if (!slug || !projectID || !directory || !version || !time) return undefined
  const created = time.created
  const updated = time.updated
  const archived = time.archived
  const prior = projections.get(member)
  if (
    prior &&
    prior.id === member.id &&
    prior.slug === slug &&
    prior.projectID === projectID &&
    prior.directory === directory &&
    prior.parentID === parentID &&
    prior.title === title &&
    prior.version === version &&
    prior.created === created &&
    prior.updated === updated &&
    prior.archived === archived
  ) return prior.session

  const session: Session = {
    id: member.id,
    slug,
    projectID,
    directory,
    parentID,
    title,
    version,
    time: { created, updated, ...(archived === undefined ? {} : { archived }) },
  }
  projections.set(member, {
    id: member.id,
    slug,
    projectID,
    directory,
    parentID,
    title,
    version,
    created,
    updated,
    archived,
    session,
  })
  return session
}