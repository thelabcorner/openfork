import type { Session } from "@opencode-ai/sdk/v2/client"

export type MobileEventChannel = "current" | "compatibility"

export function activeReconcilePlan(sessions: Session[], channel: MobileEventChannel) {
  if (channel === "current") return { currentSnapshot: true as const, legacyDirectories: [] as string[] }

  const directories = new Set<string>()
  for (const session of sessions) {
    // Native rows are covered by the one server-global V2 snapshot even if a
    // caller accidentally hands a mixed list to this compatibility planner.
    if (session.version === "v2" || !session.directory) continue
    directories.add(session.directory)
    const subpath = (session as any).path
    if (!subpath) continue
    const separator = session.directory.includes("\\") && !session.directory.includes("/") ? "\\" : "/"
    directories.add(`${session.directory.replace(/[\\/]$/, "")}${separator}${String(subpath).replace(/^[\\/]/, "")}`)
  }
  return { currentSnapshot: false as const, legacyDirectories: [...directories] }
}

/** Ordered, bounded async fanout for old per-directory compatibility APIs. */
export async function mapBounded<T, R>(items: readonly T[], concurrency: number, task: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workerCount = Math.min(Math.max(1, concurrency), items.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = cursor++
        if (index >= items.length) return
        results[index] = await task(items[index]!)
      }
    }),
  )
  return results
}
