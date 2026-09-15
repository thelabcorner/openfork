import { pathKey } from "@/utils/path-key"

export type StartupSessionProject = {
  worktree: string
  expanded?: boolean
}

export function planStartupSessionHydration<T extends StartupSessionProject>(projects: readonly T[], last?: string) {
  if (projects.length === 0) return { foreground: undefined as T | undefined, background: [] as T[] }

  const lastKey = last ? pathKey(last) : undefined
  const foreground =
    (lastKey ? projects.find((project) => pathKey(project.worktree) === lastKey) : undefined) ??
    projects.find((project) => project.expanded) ??
    projects[0]
  const background = projects
    .filter((project) => project !== foreground)
    .map((project, index) => ({ project, index }))
    .sort((a, b) => Number(Boolean(b.project.expanded)) - Number(Boolean(a.project.expanded)) || a.index - b.index)
    .map((entry) => entry.project)

  return { foreground, background }
}
