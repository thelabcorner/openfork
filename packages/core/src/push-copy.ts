/**
 * Small, dependency-free notification copy helpers shared by the server push
 * producer and its tests. Keeping formatting here prevents every delivery
 * channel from inventing a different, generic message for the same session.
 */

export type PushSessionContext = {
  title?: string | null
  projectName?: string | null
  directory?: string | null
}

export type PushSessionCopy = {
  title: string
  body: string
  sessionTitle: string
  projectLabel?: string
}

const FALLBACK_TITLE = "Untitled chat"

export function sessionTitle(context: PushSessionContext | undefined, sessionID: string) {
  const title = clean(context?.title, 96)
  return title || `${FALLBACK_TITLE} · ${shortID(sessionID)}`
}

export function projectLabel(context: PushSessionContext | undefined) {
  const named = clean(context?.projectName, 64)
  if (named) return named
  const directory = clean(context?.directory, 240)
  if (!directory) return undefined
  const leaf = directory.split(/[\\/]/).filter(Boolean).at(-1)
  return leaf ? clean(leaf, 64) : undefined
}

export function completedCopy(context: PushSessionContext | undefined, sessionID: string): PushSessionCopy {
  const title = sessionTitle(context, sessionID)
  const project = projectLabel(context)
  return {
    title: truncate(`Completed · ${title}`, 120),
    body: project ? `${project} · Your agent finished this chat.` : "Your agent finished this chat.",
    sessionTitle: title,
    ...(project ? { projectLabel: project } : {}),
  }
}

export function failedCopy(
  context: PushSessionContext | undefined,
  sessionID: string,
  error?: unknown,
): PushSessionCopy {
  const title = sessionTitle(context, sessionID)
  const project = projectLabel(context)
  const reason = errorText(error) || "The agent hit an error and stopped."
  return {
    title: truncate(`Failed · ${title}`, 120),
    body: truncate(project ? `${project} · ${reason}` : reason, 240),
    sessionTitle: title,
    ...(project ? { projectLabel: project } : {}),
  }
}

export function permissionCopy(
  context: PushSessionContext | undefined,
  sessionID: string,
  action: string,
): PushSessionCopy {
  const title = sessionTitle(context, sessionID)
  const project = projectLabel(context)
  const actionText = clean(action, 80) || "An action"
  return {
    title: truncate(`Approval needed · ${title}`, 120),
    body: truncate(
      project ? `${project} · ${actionText} needs your approval.` : `${actionText} needs your approval.`,
      240,
    ),
    sessionTitle: title,
    ...(project ? { projectLabel: project } : {}),
  }
}

export function questionCopy(
  context: PushSessionContext | undefined,
  sessionID: string,
  question?: string,
): PushSessionCopy {
  const title = sessionTitle(context, sessionID)
  const project = projectLabel(context)
  const questionText = clean(question, 180) || "Your agent is waiting for an answer."
  return {
    title: truncate(`Question · ${title}`, 120),
    body: truncate(project ? `${project} · ${questionText}` : questionText, 240),
    sessionTitle: title,
    ...(project ? { projectLabel: project } : {}),
  }
}

export function errorText(error: unknown) {
  if (typeof error === "string") return clean(error, 220)
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string") return clean(message, 220)
  }
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: unknown }).data
    if (data && typeof data === "object" && "message" in data) {
      const message = (data as { message?: unknown }).message
      if (typeof message === "string") return clean(message, 220)
    }
  }
  return ""
}

function clean(value: string | null | undefined, max: number) {
  if (!value) return ""
  return truncate(value.replace(/\s+/g, " ").trim(), max)
}

function truncate(value: string, max: number) {
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

function shortID(id: string) {
  const value = id.replace(/[^a-zA-Z0-9]/g, "")
  return value.slice(-8) || "session"
}
