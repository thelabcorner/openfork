import type { Project, Session } from "@opencode-ai/sdk/v2/client"
import { pathKey } from "@/utils/path-key"

export type SessionProjectIndex = Pick<Project, "id" | "worktree" | "sandboxes">

/**
 * Resolve the loaded directory store that should own a session row for
 * location-scoped consumers. Exact project roots and sandboxes stay local;
 * generated/other project-owned directories fall back to the canonical
 * worktree.
 */
export function sessionIndexDirectory(
  info: Pick<Session, "directory" | "projectID">,
  projects: readonly SessionProjectIndex[],
) {
  const project = info.projectID ? projects.find((item) => item.id === info.projectID) : undefined
  if (!project) return info.directory

  const directory = pathKey(info.directory)
  if (pathKey(project.worktree) === directory) return project.worktree
  const sandbox = project.sandboxes?.find((item) => pathKey(item) === directory)
  return sandbox ?? project.worktree
}

/**
 * The canonical worktree store doubles as the bounded project-wide root index.
 * Only exact worktree loads receive project scope; sandbox/detail stores remain
 * physical-directory slices.
 */
export function rootSessionProjectID(directory: string, projects: readonly SessionProjectIndex[]) {
  const key = pathKey(directory)
  return projects.find((project) => pathKey(project.worktree) === key)?.id
}

/**
 * Root Session metadata events must converge into the project-wide root index
 * even when the producer executes in another directory. Mirror into the
 * physical directory too when that child store already exists; callers remain
 * bounded to at most two stores and perform no fetch.
 *
 * Child Sessions intentionally stay physical-directory scoped so subagent /
 * structural grouping semantics are unchanged.
 */
export function sessionEventIndexDirectories(
  info: Pick<Session, "directory" | "projectID" | "parentID">,
  eventDirectory: string,
  projects: readonly SessionProjectIndex[],
) {
  if (info.parentID) return [eventDirectory]
  const project = info.projectID ? projects.find((item) => item.id === info.projectID) : undefined
  if (!project) return [eventDirectory]

  const result = [project.worktree]
  if (pathKey(project.worktree) !== pathKey(eventDirectory)) result.push(eventDirectory)
  return result
}

