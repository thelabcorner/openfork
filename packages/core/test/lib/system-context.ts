import { Effect } from "effect"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemSurface } from "@opencode-ai/core/system-surface"

/** Test-only adapter through the same producer -> semantic-surface path as runtime. */
export const observeReady = (context: SystemContext.SystemContext, previous?: SystemSurface.Snapshot) =>
  SystemContext.observeSurface(context).pipe(
    Effect.map((input) => {
      const result = SystemSurface.reconcile(input, previous)
      if (result._tag === "Blocked") throw new Error(`Unexpected blocked SystemSurface: ${result.keys.join(", ")}`)
      return result
    }),
  )

export const renderReady = (context: SystemContext.SystemContext, previous?: SystemSurface.Snapshot) =>
  observeReady(context, previous).pipe(Effect.map((result) => SystemSurface.render(result.snapshot)))

