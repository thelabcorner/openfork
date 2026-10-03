export * as UsageRevision from "./revision"

/**
 * Monotonic in-process durable-usage history revision.
 *
 * Live module state, deliberately isolated in a leaf module so every durable
 * usage writer can advance it without an import cycle between `record` and
 * `yield`. Only a successfully committed settlement or projection rewrite
 * advances the counter; observability storage failures stay fail-open to
 * execution.
 *
 * This is the local half of a usage cache watermark. It structurally cannot
 * observe another process's commits, so a reader that memoizes durable usage
 * state must combine it with `PRAGMA data_version` rather than trusting it alone.
 */
let revision = 0

export const current = () => revision

export const advance = () => {
  revision += 1
}
